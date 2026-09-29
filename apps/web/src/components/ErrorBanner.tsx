import { ApiRequestError } from '../api';

/**
 * Component hiển thị cấu trúc lỗi thống nhất: hiển thị rõ ràng request_id giúp người dùng dễ dàng cung cấp khi báo sự cố.
 * Tương thích với các ngoại lệ thông thường ngoài ApiRequestError (ví dụ mất kết nối mạng hoàn toàn).
 */
export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error === null || error === undefined) return null;

  const isApiError = error instanceof ApiRequestError;
  const title = isApiError ? apiErrorTypeLabel(error.body.error.type) : 'Đã xảy ra lỗi';
  const message = describeUnknownError(error);
  const requestId = isApiError ? error.body.error.request_id : null;
  const param = isApiError ? error.body.error.param : null;

  return (
    <div className="error-banner" role="alert">
      <div className="error-title">{title}</div>
      <div>{message}</div>
      {(requestId !== null || param !== null) && (
        <div className="error-meta">
          {param !== null && <span>Trường liên quan: {param}{'　'}</span>}
          {requestId !== null && <span className="mono">request_id: {requestId}</span>}
        </div>
      )}
      {onRetry !== undefined && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Thử lại
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Chuyển đổi giá trị bất kỳ được catch thành một dòng văn bản dễ đọc.
 * Xử lý riêng biệt theo kiểu dữ liệu thực tế, tránh trường hợp object bị hiển thị thành `[object Object]`.
 */
function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return 'Lỗi không xác định';
  }
}

function apiErrorTypeLabel(type: string): string {
  const map: Record<string, string> = {
    invalid_request_error: 'Yêu cầu không hợp lệ',
    authentication_error: 'Xác thực thất bại',
    permission_error: 'Không có quyền truy cập',
    not_found_error: 'Không tìm thấy tài nguyên',
    rate_limit_error: 'Bị giới hạn tần suất (Rate limit)',
    idempotency_error: 'Xung đột khóa Idempotency',
    unsupported_parameter: 'Tham số chưa được hỗ trợ',
    unsupported_feature: 'Tính năng chưa hỗ trợ',
    account_pool_exhausted: 'Nhóm tài khoản đã cạn kiệt',
    upstream_error: 'Lỗi dịch vụ thượng nguồn (Upstream)',
    upstream_timeout: 'Hết thời gian chờ dịch vụ thượng nguồn',
    service_not_ready: 'Dịch vụ chưa sẵn sàng',
    internal_error: 'Lỗi nội bộ hệ thống',
  };
  return map[type] ?? type;
}
