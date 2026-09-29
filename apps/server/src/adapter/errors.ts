/**
 * Phân loại lỗi upstream (tương ứng với DoD của Kế hoạch thực hiện §M3).
 *
 * Dispatcher dựa vào phân loại này để quyết định: làm mới Token 1 lần, làm nguội (cool down), thử lại giới hạn số lần, hay chuyển tài khoản.
 * Tập trung ánh xạ "HTTP status / WS close code → chiến lược xử lý" tại đây để tránh rải rác logic.
 */

export type UpstreamDisposition =
  /** 401: Token có thể đã hết hạn, làm mới 1 lần và thử lại trên cùng tài khoản; nếu tiếp tục thất bại mới tính là sự cố */
  | 'refresh_and_retry'
  /** 403: Vấn đề quyền hạn/kiểm soát rủi ro, đổi tài khoản cũng vô ích, đánh dấu tài khoản không khả dụng ngay, không chuyển đổi vô hạn */
  | 'account_forbidden'
  /** 429: Bị giới hạn tốc độ (rate limit), đọc Retry-After để làm nguội tài khoản này, request có thể chuyển sang tài khoản khác */
  | 'rate_limited'
  /** 5xx / WS ngắt kết nối bất thường: Thử lại số lần giới hạn, có thể chuyển tài khoản */
  | 'retry_or_switch'
  /** Yêu cầu từ phía client có vấn đề (4xx, trừ 401/403/429): Không thử lại, báo lỗi trực tiếp */
  | 'fatal_client'
  /** Sự cố upstream chưa phân loại: Thử lại giới hạn số lần */
  | 'unknown';

export class UpstreamError extends Error {
  readonly disposition: UpstreamDisposition;
  /** Mã trạng thái HTTP gốc hoặc mã đóng WS, dùng cho ghi log */
  readonly statusCode: number | null;
  /** Số mili-giây cần làm nguội được parse ra trong tình huống 429 */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    disposition: UpstreamDisposition,
    options: { statusCode?: number | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UpstreamError';
    this.disposition = disposition;
    this.statusCode = options.statusCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Phân loại mã trạng thái HTTP trong giai đoạn bắt tay WebSocket. */
export function classifyHttpStatus(status: number, retryAfterHeader?: string | null): UpstreamError {
  if (status === 401) {
    return new UpstreamError('Upstream trả về 401, Token có thể đã hết hạn', 'refresh_and_retry', { statusCode: 401 });
  }
  if (status === 403) {
    return new UpstreamError('Upstream trả về 403, tài khoản bị từ chối', 'account_forbidden', { statusCode: 403 });
  }
  if (status === 429) {
    return new UpstreamError('Upstream trả về 429, kích hoạt giới hạn tần suất', 'rate_limited', {
      statusCode: 429,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    });
  }
  if (status >= 500) {
    return new UpstreamError(`Upstream trả về ${status}`, 'retry_or_switch', { statusCode: status });
  }
  if (status >= 400) {
    return new UpstreamError(`Upstream trả về ${status}`, 'fatal_client', { statusCode: status });
  }
  return new UpstreamError(`Upstream trả về trạng thái bất thường ${status}`, 'unknown', { statusCode: status });
}

/**
 * Phân tích header Retry-After: hỗ trợ cả số giây lẫn HTTP date.
 * Trả về null khi không thể phân tích, phía gọi sẽ áp dụng thời gian làm nguội mặc định.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (header === null || header === undefined || header.trim() === '') return null;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

/**
 * Phân loại mã đóng (close code) WebSocket.
 * 1000 đóng bình thường không tính là lỗi; các mã khác xử lý theo "thử lại giới hạn có thể chuyển tài khoản".
 */
export function classifyCloseCode(code: number, reason?: string): UpstreamError | null {
  if (code === 1000) return null;
  const detail = reason && reason !== '' ? `: ${reason}` : '';
  if (code === 1008 || code === 4001 || code === 4003) {
    // Vi phạm chính sách / Mã đóng xác thực: Đổi tài khoản cũng vô ích
    return new UpstreamError(`Upstream đóng kết nối với mã ${code}${detail}`, 'account_forbidden', { statusCode: code });
  }
  return new UpstreamError(`Upstream đóng kết nối với mã ${code}${detail}`, 'retry_or_switch', { statusCode: code });
}
