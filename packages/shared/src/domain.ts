/** Định nghĩa trạng thái miền và cấu trúc dữ liệu đối ngoại. */

/** Máy trạng thái tài khoản Microsoft. */
export const ACCOUNT_STATUSES = [
  'probing',
  'online',
  'busy',
  'cooldown',
  'reauth_required',
  'disabled',
  'unsupported',
  'error',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Vòng đời trạng thái Responses. */
export const RESPONSE_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/** Chế độ riêng tư của log. */
export const LOG_PRIVACY_MODES = ['strict', 'metadata', 'debug'] as const;
export type LogPrivacyMode = (typeof LOG_PRIVACY_MODES)[number];

/** Phản hồi kiểm tra sức khỏe liveness (Health). */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime_ms: number;
}

/** Kết quả từng mục trong kiểm tra readiness. */
export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  version: string;
  schema_version: number;
  checks: ReadinessCheck[];
}

/** Cấu trúc hiển thị API Key ra ngoài (không bao giờ chứa Key dạng rõ). */
export interface ApiKeyView {
  id: string;
  name: string;
  /** Hiển thị che giấu, ví dụ `sk-Ab12Cd34…` */
  masked_key: string;
  enabled: boolean;
  created_at: number;
  starts_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  rpm_limit: number | null;
  daily_limit: number | null;
  max_concurrency: number | null;
  allowed_endpoints: string[] | null;
  allowed_models: string[] | null;
}

/** Kết quả tạo API Key: Khóa rõ chỉ xuất hiện tại đây một lần duy nhất. */
export interface ApiKeyCreated extends ApiKeyView {
  /** Khóa API dạng rõ, chỉ trả về một lần duy nhất lúc tạo, server không lưu trữ */
  key: string;
}
