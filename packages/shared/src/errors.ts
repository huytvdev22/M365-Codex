/**
 * Cấu trúc lỗi thống nhất.
 *
 * Quy ước:
 * - `type` thể hiện phân loại ngữ nghĩa, client dựa vào đó để rẽ nhánh xử lý;
 * - `code` là chuỗi mã trạng thái HTTP, tương thích với client OpenAI;
 * - `request_id` xuyên suốt log và header `x-request-id`, phục vụ điều tra lỗi.
 */

export const API_ERROR_TYPES = [
  /** Yêu cầu không hợp lệ (thiếu trường, sai kiểu, lỗi parse JSON, v.v.) */
  'invalid_request_error',
  /** Thiếu hoặc không hợp lệ API Key / phiên quản trị */
  'authentication_error',
  /** Đã xác thực nhưng không có quyền truy cập endpoint, model hoặc tài nguyên này */
  'permission_error',
  /** Tài nguyên không tồn tại */
  'not_found_error',
  /** Kích hoạt giới hạn tần suất phía gateway (RPM / hạn ngạch ngày / đồng thời) */
  'rate_limit_error',
  /** Xung đột khóa Idempotency: Cùng Key dùng lại Idempotency-Key nhưng body khác nhau */
  'idempotency_error',
  /** Tham số được nhận diện nhưng upstream hiện tại không hỗ trợ, không tự ý hạ cấp */
  'unsupported_parameter',
  /** Tính năng không nằm trong phạm vi năng lực của dự án */
  'unsupported_feature',
  /** Không có tài khoản Microsoft khả dụng trong pool */
  'account_pool_exhausted',
  /** Upstream (Sydney / BizChat) trả về lỗi hoặc bất thường giao thức */
  'upstream_error',
  /** Upstream quá thời gian chờ (timeout) hoặc kết nối bị ngắt */
  'upstream_timeout',
  /** Dịch vụ chưa sẵn sàng (master key không hợp lệ, migration chưa xong, v.v.) */
  'service_not_ready',
  /** Lỗi nội bộ chưa phân loại */
  'internal_error',
] as const;

export type ApiErrorType = (typeof API_ERROR_TYPES)[number];

export interface ApiErrorBody {
  error: {
    type: ApiErrorType;
    code: string;
    message: string;
    param: string | null;
    request_id: string | null;
  };
}

export interface ApiErrorInit {
  type: ApiErrorType;
  status: number;
  message: string;
  param?: string | null;
  /** Thông tin bổ sung, chỉ ghi log, không trả về cho client */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Lớp cơ sở ngoại lệ nghiệp vụ: được Global Error Handler chuyển thành cấu trúc lỗi thống nhất. */
export class ApiError extends Error {
  readonly type: ApiErrorType;
  readonly status: number;
  readonly param: string | null;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.type = init.type;
    this.status = init.status;
    this.param = init.param ?? null;
    this.details = init.details;
  }

  toBody(requestId: string | null): ApiErrorBody {
    return {
      error: {
        type: this.type,
        code: String(this.status),
        message: this.message,
        param: this.param,
        request_id: requestId,
      },
    };
  }

  static badRequest(message: string, param?: string): ApiError {
    return new ApiError({ type: 'invalid_request_error', status: 400, message, param: param ?? null });
  }

  static unauthorized(message = 'Missing or invalid credentials'): ApiError {
    return new ApiError({ type: 'authentication_error', status: 401, message });
  }

  static forbidden(message = 'Not allowed'): ApiError {
    return new ApiError({ type: 'permission_error', status: 403, message });
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError({ type: 'not_found_error', status: 404, message });
  }

  static rateLimited(message = 'Rate limit exceeded'): ApiError {
    return new ApiError({ type: 'rate_limit_error', status: 429, message });
  }

  static notReady(message = 'Service is not ready'): ApiError {
    return new ApiError({ type: 'service_not_ready', status: 503, message });
  }

  static internal(message = 'Internal server error', cause?: unknown): ApiError {
    return new ApiError({ type: 'internal_error', status: 500, message, cause });
  }
}

/** Xây dựng cấu trúc lỗi thống nhất, dùng cho các ngữ cảnh không tiện throw ngoại lệ (như thất bại giữa chừng trong SSE). */
export function buildErrorBody(
  type: ApiErrorType,
  status: number,
  message: string,
  options: { param?: string | null; requestId?: string | null } = {},
): ApiErrorBody {
  return {
    error: {
      type,
      code: String(status),
      message,
      param: options.param ?? null,
      request_id: options.requestId ?? null,
    },
  };
}
