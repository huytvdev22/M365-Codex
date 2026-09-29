import type { Logger } from 'pino';
import type { ResponseRepository, ResponseRow } from '../repo/responses.js';
import type { ResponseObject } from '../responses/types.js';

/**
 * Phục hồi sau khi khởi động lại dịch vụ (tương ứng kế hoạch triển khai §18).
 *
 * Nguyên tắc xử lý:
 * - `queued` — chưa có bất kỳ tiến trình nào thực sự tiếp nhận thực thi, tự nhiên có thể truy vấn, có thể phục hồi, ở đây chỉ
 *   xác nhận nó vẫn hiển thị, không cần ghi đè bất kỳ trường nào;
 * - `in_progress` — trước khi tiến trình sập có thể đã gửi yêu cầu lên upstream, thậm chí đã thực thi các lệnh gọi công cụ
 *   có tác dụng phụ, sau khi khởi động lại **không thể xác nhận** lần trước cụ thể đã tiến hành tới bước nào. Do đó toàn bộ được đánh dấu
 *   là `incomplete` (kèm `incomplete_details.reason`), chứ không tiếp tục hay phát lại một cách võ đoán: tiếp tục thực thi đồng nghĩa với việc áp đặt kết luận lên trạng thái không chắc chắn, còn phát lại thì có thể khiến công cụ tác dụng phụ đã chạy bị chạy thêm lần nữa;
 * - Lệnh gọi công cụ đã phát ra (`emitted`/`completed` trong bảng `tool_calls`) được giữ nguyên bản,
 *   vẫn có thể liên kết truy vấn qua `GET /v1/responses/:id`, tuyệt đối không tự động phát lại bất kỳ thao tác nào có tác dụng phụ.
 */

export interface RecoveryDeps {
  responses: ResponseRepository;
  logger: Logger;
}

export interface RecoveryResult {
  /** Số bản ghi giữ nguyên queued, có thể tiếp tục được truy vấn */
  queuedKept: number;
  /** Số bản ghi in_progress bị đánh dấu là incomplete */
  inProgressMarkedIncomplete: number;
}

export const RESTART_INCOMPLETE_REASON = 'server_restarted';
/**
 * Lý do incomplete dùng khi tắt êm (graceful shutdown §19), phân biệt với phục hồi khi khởi động lại, thuận tiện cho giao diện quản trị/log
 * khi điều tra phân định rõ bản ghi này là "phát hiện sau khi tiến trình khởi động lại" hay "chủ động dọn dẹp khi tắt lần này";
 * **Cách thức xử lý** lưu DB (trạng thái, cấu trúc `incomplete_details`) hoàn toàn nhất quán với phục hồi khi khởi động lại,
 * chỉ khác chuỗi lý do — không phải là một bộ ngữ nghĩa khác.
 */
export const SHUTDOWN_INCOMPLETE_REASON = 'server_shutting_down';

/**
 * Đánh dấu các bản ghi vẫn đang ở in_progress thành incomplete; phục hồi khi khởi động lại và tắt êm dùng chung một
 * logic xử lý, chỉ khác thời điểm kích hoạt và `reason`, tránh việc viết hai bộ ngữ nghĩa không nhất quán ở hai nơi.
 */
export function markInProgressAsIncomplete(
  responses: ResponseRepository,
  reason: string,
  now = Date.now(),
): ResponseRow[] {
  const inProgress = responses.listByStatus('in_progress');
  for (const row of inProgress) {
    const body = buildIncompleteBody(row, reason);
    responses.complete(
      row.id,
      'incomplete',
      body,
      { reportedUpstreamModel: row.reported_upstream_model, errorMessage: null },
      now,
    );
  }
  return inProgress;
}

export function recoverOnStartup(deps: RecoveryDeps, now = Date.now()): RecoveryResult {
  const queued = deps.responses.listByStatus('queued');
  const inProgress = markInProgressAsIncomplete(deps.responses, RESTART_INCOMPLETE_REASON, now);

  if (inProgress.length > 0) {
    deps.logger.warn(
      { count: inProgress.length },
      '重启恢复：发现上次未正常结束的 in_progress Response，已标记为 incomplete（不自动重放）',
    );
  }
  if (queued.length > 0) {
    deps.logger.info({ count: queued.length }, '重启恢复：queued Response 保持原状，可继续被查询');
  }

  return { queuedKept: queued.length, inProgressMarkedIncomplete: inProgress.length };
}

/**
 * Bổ sung một snapshot Response tối giản, giúp `GET /v1/responses/:id` sau khi khởi động lại vẫn có thể trả về
 * đối tượng có cấu trúc hoàn chỉnh (thay vì thoái hóa thành dạng cứu cánh `{id, object, status}`).
 * Các trường chỉ có thể cố gắng phục hồi: bảng `responses` không lưu trữ metadata / max_output_tokens /
 * temperature các tham số yêu cầu (chỉ lưu kèm body khi hoàn thành), khi phục hồi sau khởi động lại những thông tin nguyên bản này không có sẵn,
 * chỉ có thể trả về null, thuộc về xấp xỉ đã biết trước, không ảnh hưởng tới ràng buộc cứng "trạng thái có thể tra cứu, không võ đoán kết quả thực thi".
 */
function buildIncompleteBody(row: ResponseRow, reason: string): ResponseObject {
  return {
    id: row.id,
    object: 'response',
    created_at: Math.floor(row.created_at / 1000),
    status: 'incomplete',
    model: row.requested_model ?? '',
    output: [],
    usage: null,
    metadata: null,
    previous_response_id: row.previous_response_id,
    reasoning: row.requested_reasoning_effort === null ? null : { effort: row.requested_reasoning_effort },
    max_output_tokens: null,
    temperature: null,
    error: null,
    incomplete_details: { reason },
  };
}
