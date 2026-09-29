import { createHash } from 'node:crypto';
import { ApiError } from '@m365-codex/shared';
import type { Database } from '../db/index.js';
import { asRow } from '../db/index.js';

/**
 * Tính bình đẳng/idempotent của yêu cầu (tương ứng kế hoạch triển khai §18).
 *
 * Quy tắc: Cùng một API Key + endpoint + `Idempotency-Key` sẽ trả về cùng một kết quả tạo.
 * Ràng buộc cốt lõi là **không gửi lặp lại yêu cầu upstream có thể sinh lệnh gọi công cụ** — việc phát lại một lần
 * `POST /v1/responses` đồng nghĩa với việc mô hình có thể quyết định thực thi lại một công cụ có tác dụng phụ.
 *
 * Vân tay của body yêu cầu cũng được lưu: cùng một idempotency key kết hợp với body yêu cầu khác nhau thuộc về lỗi dùng sai key của client,
 * bắt buộc phải báo lỗi thay vì trả về kết quả lần trước (nếu không sẽ âm thầm xem hai yêu cầu khác nhau là một).
 *
 * Trùng key đồng thời: dựa vào unique index để khiến yêu cầu thứ hai chèn thất bại, chuyển sang chờ/tái sử dụng kết quả của yêu cầu thứ nhất,
 * thay vì cả hai cùng đánh lên upstream.
 */

export type IdempotencyState = 'in_progress' | 'completed';

export interface IdempotencyRow {
  key: string;
  api_key_id: string;
  endpoint: string;
  request_fingerprint: string;
  state: IdempotencyState;
  response_id: string | null;
  status_code: number | null;
  body: string | null;
  created_at: number;
  updated_at: number;
}

/** Tạo vân tay ổn định cho body yêu cầu: sắp xếp key rồi băm hash, tránh việc thứ tự field khác nhau bị nhận diện nhầm là yêu cầu khác. */
export function fingerprintRequest(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface BeginResult {
  /** Đã có kết quả hoàn thành, phát lại trực tiếp */
  replay?: { statusCode: number; body: unknown; responseId: string | null };
  /** Yêu cầu cùng key vẫn đang xử lý */
  inProgress?: boolean;
  /** Lần này là lần đầu, bên gọi tiếp tục xử lý bình thường, sau khi hoàn thành gọi complete() */
  fresh?: boolean;
}

export class IdempotencyStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Đăng ký một yêu cầu idempotent.
   * Trả về kết quả: phát lại, chờ đợi, hay thực thi lần đầu.
   */
  begin(input: {
    key: string;
    apiKeyId: string;
    endpoint: string;
    fingerprint: string;
    now?: number;
  }): BeginResult {
    const now = input.now ?? Date.now();
    const existing = this.#find(input.key, input.apiKeyId, input.endpoint);

    if (existing !== undefined) {
      if (existing.request_fingerprint !== input.fingerprint) {
        throw new ApiError({
          type: 'idempotency_error',
          status: 409,
          message: '同一个 Idempotency-Key 被用于内容不同的请求',
        });
      }
      if (existing.state === 'completed' && existing.body !== null) {
        return {
          replay: {
            statusCode: existing.status_code ?? 200,
            body: JSON.parse(existing.body) as unknown,
            responseId: existing.response_id,
          },
        };
      }
      return { inProgress: true };
    }

    try {
      this.#db
        .prepare(
          `INSERT INTO idempotency_keys
             (key, api_key_id, endpoint, request_fingerprint, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
        )
        .run(input.key, input.apiKeyId, input.endpoint, input.fingerprint, now, now);
      return { fresh: true };
    } catch {
      // Khi đồng thời một yêu cầu khác vừa chèn vào: chuyển lượt này sang "đang xử lý", không gọi lặp lại upstream
      return { inProgress: true };
    }
  }

  /** Sau khi xử lý thành công, lưu kết quả cuối cùng vào DB để phát lại cho các yêu cầu cùng key tiếp theo. */
  complete(input: {
    key: string;
    apiKeyId: string;
    endpoint: string;
    statusCode: number;
    body: unknown;
    responseId?: string | null;
    now?: number;
  }): void {
    this.#db
      .prepare(
        `UPDATE idempotency_keys
            SET state = 'completed', status_code = ?, body = ?, response_id = ?, updated_at = ?
          WHERE key = ? AND api_key_id = ? AND endpoint = ?`,
      )
      .run(
        input.statusCode,
        JSON.stringify(input.body),
        input.responseId ?? null,
        input.now ?? Date.now(),
        input.key,
        input.apiKeyId,
        input.endpoint,
      );
  }

  /**
   * Giải phóng key này khi xử lý thất bại.
   * Yêu cầu thất bại không nên chiếm giữ vĩnh viễn key idempotent — client thử lại với cùng key phải được phép thực thi lại.
   */
  release(key: string, apiKeyId: string, endpoint: string): void {
    this.#db
      .prepare("DELETE FROM idempotency_keys WHERE key = ? AND api_key_id = ? AND endpoint = ? AND state = 'in_progress'")
      .run(key, apiKeyId, endpoint);
  }

  /** Dọn dẹp bản ghi hết hạn (dọn dẹp định kỳ §18). */
  purgeOlderThan(cutoff: number): number {
    const result = this.#db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }

  #find(key: string, apiKeyId: string, endpoint: string): IdempotencyRow | undefined {
    return asRow<IdempotencyRow>(
      this.#db
        .prepare('SELECT * FROM idempotency_keys WHERE key = ? AND api_key_id = ? AND endpoint = ?')
        .get(key, apiKeyId, endpoint),
    );
  }
}

/** Sau khi thực thi xong gọi một trong hai: non-stream ghi kết quả có thể phát lại, stream/thất bại giải phóng key này. */
export interface IdempotencyHandle {
  complete: (statusCode: number, body: unknown, responseId: string | null) => void;
  release: () => void;
}

export interface IdempotencyGuardResult {
  /** Khớp phát lại: gửi thẳng cái này về client, không cần chạy lại business logic */
  replay?: { statusCode: number; body: unknown };
  /** Thực thi lần đầu: sau khi chạy xong business logic gọi handle.complete() (thành công) hoặc handle.release() (thất bại) */
  handle?: IdempotencyHandle;
}

/**
 * Cổng vào thống nhất kết nối vào `POST /v1/responses` và `POST /v1/chat/completions`
 * (tương ứng kế hoạch triển khai §18). Không mang `Idempotency-Key` thì cho qua trực tiếp (`{}`).
 *
 * Yêu cầu streaming (`stream:true`) **không phát lại**: SSE là luồng sự kiện đẩy một chiều tới client,
 * sau khi đóng kết nối không có cách nào phát lại nội dung đã bắn ra; nhưng vẫn phải chặn trùng key đồng thời —
 * điểm này được đảm bảo bởi nhánh `inProgress` của `store.begin()`, không liên quan đến việc có stream hay không.
 * Do đó sau khi hoàn thành yêu cầu stream (dù thành công hay thất bại) đều gọi `release()` key này thay vì `complete()`:
 * sau khi key bị xóa, các yêu cầu tiếp theo với cùng key sẽ được xem là một lần thực thi mới tinh, thay vì nhận được kết quả phát lại cũ.
 */
export function beginIdempotency(input: {
  store: IdempotencyStore;
  key: string | null;
  apiKeyId: string | null;
  endpoint: string;
  rawBody: unknown;
  stream: boolean;
}): IdempotencyGuardResult {
  if (input.key === null || input.apiKeyId === null) return {};
  const key = input.key;
  const apiKeyId = input.apiKeyId;
  const fingerprint = fingerprintRequest(input.rawBody);

  const begin = input.store.begin({ key, apiKeyId, endpoint: input.endpoint, fingerprint });
  if (begin.replay !== undefined) {
    return { replay: { statusCode: begin.replay.statusCode, body: begin.replay.body } };
  }
  if (begin.inProgress === true) {
    throw new ApiError({
      type: 'idempotency_error',
      status: 409,
      message: '同一个 Idempotency-Key 的请求正在处理中，请稍候或换一个 Idempotency-Key 重试',
    });
  }

  const release = (): void => input.store.release(key, apiKeyId, input.endpoint);
  if (input.stream) {
    return { handle: { complete: release, release } };
  }
  return {
    handle: {
      complete: (statusCode, body, responseId) =>
        input.store.complete({ key, apiKeyId, endpoint: input.endpoint, statusCode, body, responseId }),
      release,
    },
  };
}
