import { ApiRequestError, type ApiErrorBody } from './types';

/**
 * Bao bọc fetch tối giản: tự động đính kèm Authorization, phân tích body lỗi thống nhất, thông báo chuyển về trang đăng nhập khi nhận mã 401.
 *
 * Token chỉ được lưu trữ trong biến bộ nhớ của module này (kết hợp AuthContext ghi vào sessionStorage để phục hồi khi tải lại trang),
 * tuyệt đối không ghi vào localStorage và không bao giờ xuất hiện trong console.*.
 */

let authToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** AuthContext đăng ký khi gắn kết: nhận 401 sẽ xóa phiên làm việc và chuyển đến trang đăng nhập. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function buildFallbackError(status: number, message: string): ApiErrorBody {
  return {
    error: {
      type: status === 401 ? 'authentication_error' : 'internal_error',
      message,
      param: null,
      request_id: null,
    },
  };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

function buildQuery(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken !== null) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(options.query)}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    });
  } catch {
    throw new ApiRequestError(0, buildFallbackError(0, 'Không thể kết nối đến máy chủ, vui lòng kiểm tra mạng hoặc dịch vụ có đang chạy không'));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    const errorBody = isApiErrorBody(payload)
      ? payload
      : buildFallbackError(res.status, `Yêu cầu thất bại (HTTP ${res.status})`);
    if (res.status === 401) {
      unauthorizedHandler?.();
    }
    throw new ApiRequestError(res.status, errorBody);
  }

  return payload as T;
}

/**
 * Tải xuống tệp nhị phân (gói sao lưu `.tar.gz`). Dùng chung header xác thực với `request`,
 * nhưng body phản hồi không phải JSON, chỉ parse body lỗi khi request thất bại.
 */
export async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken !== null) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(options.query)}`, { method: options.method ?? 'GET', headers });
  } catch {
    throw new ApiRequestError(0, buildFallbackError(0, 'Không thể kết nối đến máy chủ, vui lòng kiểm tra mạng hoặc dịch vụ có đang chạy không'));
  }

  if (!res.ok) {
    const text = await res.text();
    const payload: unknown = text.length > 0 ? safeJsonParse(text) : undefined;
    const errorBody = isApiErrorBody(payload)
      ? payload
      : buildFallbackError(res.status, `Yêu cầu thất bại (HTTP ${res.status})`);
    if (res.status === 401) {
      unauthorizedHandler?.();
    }
    throw new ApiRequestError(res.status, errorBody);
  }

  return res.blob();
}

/**
 * Tải lên dạng multipart/form-data (phục hồi sao lưu). Không thiết lập thủ công Content-Type —
 * để trình duyệt tự động bổ sung boundary chính xác từ FormData, thiết lập thủ công sẽ làm mất boundary khiến máy chủ không phân tích cú pháp được.
 */
export async function requestMultipart<T>(path: string, fieldName: string, file: File): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken !== null) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const form = new FormData();
  form.append(fieldName, file);

  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers, body: form });
  } catch {
    throw new ApiRequestError(0, buildFallbackError(0, 'Không thể kết nối đến máy chủ, vui lòng kiểm tra mạng hoặc dịch vụ có đang chạy không'));
  }

  const text = await res.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    const errorBody = isApiErrorBody(payload)
      ? payload
      : buildFallbackError(res.status, `Yêu cầu thất bại (HTTP ${res.status})`);
    if (res.status === 401) {
      unauthorizedHandler?.();
    }
    throw new ApiRequestError(res.status, errorBody);
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && 'type' in err && 'message' in err;
}
