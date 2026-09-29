import type { ResponseStatus } from '@m365-codex/shared';
import { asRow, asRows, type Database } from '../db/index.js';
import type { ResponseObject } from '../responses/types.js';

/** Lưu trữ Responses: Bản ghi yêu cầu + ràng buộc dính phiên hội thoại (affinity binding). */

export interface ResponseRow {
  id: string;
  api_key_id: string | null;
  account_id: string | null;
  status: ResponseStatus;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  upstream_model_parameter: string | null;
  reported_upstream_model: string | null;
  previous_response_id: string | null;
  idempotency_key: string | null;
  body: string | null;
  error_message: string | null;
  /** Response này thuộc lượt gọi công cụ thứ mấy trong chuỗi hội thoại (§7.4 số lượt công cụ tối đa) */
  tool_round: number;
  /** Tổng số lệnh gọi công cụ tích lũy phát ra trong chuỗi hội thoại này (§7.4 số lệnh gọi công cụ tích lũy tối đa) */
  tool_calls_total: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationBindingRow {
  response_id: string;
  account_id: string | null;
  upstream_conversation_ref: string | null;
  created_at: number;
}

export interface CreateResponseInput {
  id: string;
  apiKeyId: string | null;
  status: ResponseStatus;
  requestedModel: string;
  requestedReasoningEffort: string | null;
  upstreamModelParameter: string | null;
  previousResponseId: string | null;
  idempotencyKey: string | null;
  /** Kế thừa bộ đếm từ vòng trước; hội thoại mới là 0 */
  toolRound?: number;
  toolCallsTotal?: number;
}

export class ResponseRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateResponseInput, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO responses (
           id, api_key_id, status, requested_model, requested_reasoning_effort,
           upstream_model_parameter, previous_response_id, idempotency_key,
           tool_round, tool_calls_total, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.apiKeyId,
        input.status,
        input.requestedModel,
        input.requestedReasoningEffort,
        input.upstreamModelParameter,
        input.previousResponseId,
        input.idempotencyKey,
        input.toolRound ?? 0,
        input.toolCallsTotal ?? 0,
        now,
        now,
      );
  }

  /** Ghi nhận số lệnh gọi công cụ thực tế phát ra trong lượt này, phục vụ lượt kế tiếp kế thừa bộ đếm. */
  setToolCounters(id: string, round: number, total: number, now = Date.now()): void {
    this.#db
      .prepare('UPDATE responses SET tool_round = ?, tool_calls_total = ?, updated_at = ? WHERE id = ?')
      .run(round, total, now, id);
  }

  findById(id: string): ResponseRow | undefined {
    return asRow<ResponseRow>(this.#db.prepare('SELECT * FROM responses WHERE id = ?').get(id));
  }

  /**
   * Tìm bản ghi gần nhất từng dùng một idempotency key cụ thể dưới một API Key (chỉ phục vụ kiểm toán/truy vết,
   * việc đảm bảo tính duy nhất đã gom về bảng `idempotency_keys`, key ở đây không còn là duy nhất,
   * sau khi request streaming release thì cùng một key có thể tương ứng với nhiều bản ghi lịch sử, lấy bản ghi gần nhất).
   */
  findByIdempotencyKey(apiKeyId: string, key: string): ResponseRow | undefined {
    return asRow<ResponseRow>(
      this.#db
        .prepare(
          'SELECT * FROM responses WHERE api_key_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(apiKeyId, key),
    );
  }

  setAccount(id: string, accountId: string, now = Date.now()): void {
    this.#db
      .prepare('UPDATE responses SET account_id = ?, updated_at = ? WHERE id = ?')
      .run(accountId, now, id);
  }

  updateStatus(id: string, status: ResponseStatus, now = Date.now()): void {
    this.#db.prepare('UPDATE responses SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  /** Khi hoàn thành lưu JSON Response cuối cùng và model do upstream tự báo vào DB. */
  complete(
    id: string,
    status: ResponseStatus,
    body: ResponseObject,
    options: { reportedUpstreamModel?: string | null; errorMessage?: string | null } = {},
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE responses SET status = ?, body = ?, reported_upstream_model = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        JSON.stringify(body),
        options.reportedUpstreamModel ?? null,
        options.errorMessage ?? null,
        now,
        id,
      );
  }

  /** Đọc đối tượng Response sau khi hoàn thành; chưa hoàn thành hoặc không có body trả về null. */
  readBody(id: string): ResponseObject | null {
    const row = this.findById(id);
    if (row?.body == null) return null;
    try {
      return JSON.parse(row.body) as ResponseObject;
    } catch {
      return null;
    }
  }

  upsertBinding(binding: ConversationBindingRow): void {
    this.#db
      .prepare(
        `INSERT INTO conversation_bindings (response_id, account_id, upstream_conversation_ref, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (response_id) DO UPDATE SET
           account_id = excluded.account_id,
           upstream_conversation_ref = excluded.upstream_conversation_ref`,
      )
      .run(binding.response_id, binding.account_id, binding.upstream_conversation_ref, binding.created_at);
  }

  findBinding(responseId: string): ConversationBindingRow | undefined {
    return asRow<ConversationBindingRow>(
      this.#db.prepare('SELECT * FROM conversation_bindings WHERE response_id = ?').get(responseId),
    );
  }

  /** Tìm toàn bộ bản ghi theo trạng thái (dùng cho phục hồi sau khởi động lại, §18). */
  listByStatus(status: ResponseStatus): ResponseRow[] {
    return asRows<ResponseRow>(this.#db.prepare('SELECT * FROM responses WHERE status = ?').all(status));
  }

  /** Danh sách bản ghi yêu cầu phía quản trị (hợp đồng §2.2), sắp xếp giảm dần theo thời gian tạo, tùy chọn lọc theo trạng thái/API Key. */
  listForAdmin(filters: { limit: number; status?: string; apiKeyId?: string }): { items: ResponseRow[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.apiKeyId !== undefined) {
      conditions.push('api_key_id = ?');
      params.push(filters.apiKeyId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = asRow<{ count: number }>(
      this.#db.prepare(`SELECT COUNT(*) AS count FROM responses ${where}`).get(...params),
    );
    const items = asRows<ResponseRow>(
      this.#db
        .prepare(`SELECT * FROM responses ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, filters.limit),
    );
    return { items, total: totalRow?.count ?? 0 };
  }

  /** Số yêu cầu tạo sau một mốc thời gian (cung cấp cho requests.last_hour của /admin/overview). */
  countCreatedSince(sinceMs: number): number {
    const row = asRow<{ count: number }>(
      this.#db.prepare('SELECT COUNT(*) AS count FROM responses WHERE created_at >= ?').get(sinceMs),
    );
    return row?.count ?? 0;
  }

  /** Số yêu cầu thất bại sau một mốc thời gian (cung cấp cho requests.failed_last_hour của /admin/overview). */
  countFailedSince(sinceMs: number): number {
    const row = asRow<{ count: number }>(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM responses WHERE status = 'failed' AND updated_at >= ?")
        .get(sinceMs),
    );
    return row?.count ?? 0;
  }

  /**
   * Dọn dẹp các bản ghi đã kết thúc (completed/failed/cancelled/incomplete) và cũ hơn mốc cutoff
   * (tương ứng dọn dẹp định kỳ trong kế hoạch triển khai §18). Xóa theo tầng cascade `tool_calls` (`ON DELETE CASCADE`)
   * và `conversation_bindings` (tương tự), vì vậy không cần dọn dẹp riêng lần nữa.
   */
  purgeFinishedOlderThan(cutoff: number): number {
    const result = this.#db
      .prepare(
        `DELETE FROM responses
         WHERE status IN ('completed', 'failed', 'cancelled', 'incomplete') AND updated_at < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  /**
   * Dọn dẹp liên kết phiên trỏ tới tài khoản đã bị xóa (liên kết phiên mất hiệu lực, §18).
   * `account_id` không có hành động `ON DELETE`, sau khi tài khoản bị xóa thì liên kết sẽ trở thành tham chiếu treo.
   */
  purgeStaleBindings(): number {
    const result = this.#db
      .prepare(
        `DELETE FROM conversation_bindings
         WHERE account_id IS NOT NULL
           AND account_id NOT IN (SELECT id FROM accounts)`,
      )
      .run();
    return Number(result.changes);
  }
}
