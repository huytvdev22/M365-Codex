import { randomUUID } from 'node:crypto';
import { asRow, asRows, type Database } from '../db/index.js';

/**
 * Lưu trữ lệnh gọi công cụ (tool call) (§M5).
 *
 * Ràng buộc then chốt: `UNIQUE (response_id, call_id)` + status, đảm bảo cùng một lệnh gọi công cụ không bị
 * phát lại hoặc thực thi lặp lại do SSE kết nối lại hoặc gửi trùng. Công cụ có tác dụng phụ mang side_effect=1.
 *
 * Luồng trạng thái:
 *   emitted   —— Đã gửi function_call tới client, chờ client gửi kết quả về
 *   completed —— Đã nhận function_call_output, kết quả gửi ngược lên upstream để suy luận tiếp
 */

export type ToolCallStatus = 'emitted' | 'completed';

export interface ToolCallRow {
  id: string;
  response_id: string;
  call_id: string;
  name: string;
  arguments: string | null;
  status: ToolCallStatus;
  side_effect: number;
  output: string | null;
  created_at: number;
  updated_at: number;
}

export interface RecordToolCallInput {
  responseId: string;
  callId: string;
  name: string;
  arguments: string;
  sideEffect: boolean;
}

export class ToolCallRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Ghi nhận một lệnh gọi công cụ đã phát ra. Nếu (response_id, call_id) đã tồn tại thì không chèn lặp lại,
   * trả về false (idempotent: kết nối lại không phát trùng lặp).
   */
  recordEmitted(input: RecordToolCallInput, now = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `INSERT INTO tool_calls (id, response_id, call_id, name, arguments, status, side_effect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'emitted', ?, ?, ?)
         ON CONFLICT (response_id, call_id) DO NOTHING`,
      )
      .run(
        randomUUID(),
        input.responseId,
        input.callId,
        input.name,
        input.arguments,
        input.sideEffect ? 1 : 0,
        now,
        now,
      );
    return Number(result.changes) > 0;
  }

  findByCallId(responseId: string, callId: string): ToolCallRow | undefined {
    return asRow<ToolCallRow>(
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE response_id = ? AND call_id = ?')
        .get(responseId, callId),
    );
  }

  /** Tìm bản ghi của một call_id trên toàn bộ response (khi client gửi kết quả về có thể chỉ mang call_id). */
  findAnyByCallId(callId: string): ToolCallRow | undefined {
    return asRow<ToolCallRow>(
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE call_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(callId),
    );
  }

  listByResponse(responseId: string): ToolCallRow[] {
    return asRows<ToolCallRow>(
      this.#db
        .prepare('SELECT * FROM tool_calls WHERE response_id = ? ORDER BY created_at ASC')
        .all(responseId),
    );
  }

  /**
   * Đánh dấu lệnh gọi công cụ đã hoàn thành (đã nhận kết quả).
   * Chỉ ghi vào DB khi chuyển từ emitted → completed, gửi lặp lại cùng kết quả sẽ không thực thi lần hai, trả về false.
   */
  markCompleted(responseId: string, callId: string, output: string, now = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `UPDATE tool_calls SET status = 'completed', output = ?, updated_at = ?
         WHERE response_id = ? AND call_id = ? AND status = 'emitted'`,
      )
      .run(output, now, responseId, callId);
    return Number(result.changes) > 0;
  }

  /** Số lệnh gọi công cụ phát ra sau một mốc thời gian (cung cấp cho tools.calls_last_hour của /admin/overview). */
  countCreatedSince(sinceMs: number): number {
    const row = asRow<{ count: number }>(
      this.#db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE created_at >= ?').get(sinceMs),
    );
    return row?.count ?? 0;
  }

  /** Có tồn tại lệnh gọi công cụ chưa hoàn thành (emitted) hay không. */
  hasPending(responseId: string): boolean {
    const row = asRow<{ count: number }>(
      this.#db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE response_id = ? AND status = 'emitted'")
        .get(responseId),
    );
    return (row?.count ?? 0) > 0;
  }
}
