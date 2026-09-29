/**
 * Định nghĩa các kiểu dữ liệu đã thỏa thuận với máy chủ, tên trường và ngữ nghĩa tuân thủ nghiêm ngặt
 * quy ước API quản trị (tài liệu nội bộ của kho lưu trữ này, là căn cứ giao diện duy nhất cho WebUI).
 *
 * Không tự tạo các trường ngoài tài liệu quy ước; những phần máy chủ chưa triển khai tạm thời khai báo theo mẫu quy ước,
 * khi tích hợp thực tế nếu có khác biệt sẽ căn cứ theo chú thích trong src/api/client.ts để đồng bộ.
 */

// ---- Chung ----

/** Cấu trúc lỗi thống nhất. Phía server có thể trả về thêm trường `code` (chuỗi mã trạng thái HTTP), xử lý dưới dạng tùy chọn. */
export interface ApiErrorBody {
  error: {
    type: string;
    message: string;
    param: string | null;
    request_id: string | null;
    code?: string;
  };
}

/** Ngoại lệ phát sinh khi yêu cầu thất bại, mang theo toàn bộ body lỗi để giao diện hiển thị request_id. */
export class ApiRequestError extends Error {
  readonly body: ApiErrorBody;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

export type SettingSource = 'env' | 'db' | 'default';

export interface SettingItem<T = unknown> {
  value: T;
  source: SettingSource;
  editable: boolean;
  requires_restart: boolean;
}

// ---- Đăng nhập / Phiên làm việc ----

export interface LoginResponse {
  token: string;
  expires_at: number;
}

export interface SessionResponse {
  created_at: number | null;
  expires_at: number | null;
  public_api_base_url: string | null;
  public_admin_url: string | null;
}

// ---- Tài khoản ----

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

export interface AccountView {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  display_name: string | null;
  status: AccountStatus;
  source: string;
  created_at: number;
  updated_at: number;
  token_expires_at: number | null;
  token_rotated_at: number | null;
  has_refresh_token: boolean;
  consecutive_failures: number;
  cooldown_until: number | null;
  last_ok_at: number | null;
  last_error_type: string | null;
  /** Ràng buộc Proxy Egress (M7 thêm mới, triển khai cùng proxy pool). Chưa gán là null. */
  proxy_id: string | null;
}

export interface AuthorizeUrlResponse {
  authorize_url: string;
  state: string;
  expires_at: number;
}

export interface OAuthCallbackResult {
  account: AccountView;
  existing: boolean;
}

export interface OAuthSessionsResponse {
  pending: number;
}

// ---- Khóa API (API Key) ----

export interface ApiKeyView {
  id: string;
  name: string;
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

/** Kết quả tạo mới: Khóa bí mật dạng văn bản rõ chỉ xuất hiện lần này duy nhất, sau đó không API nào trả về nữa. */
export interface ApiKeyCreated extends ApiKeyView {
  key: string;
}

export interface CreateApiKeyRequest {
  name: string;
  starts_at?: number | null;
  expires_at?: number | null;
  rpm_limit?: number | null;
  daily_limit?: number | null;
  max_concurrency?: number | null;
  allowed_endpoints?: string[] | null;
  allowed_models?: string[] | null;
}

export type UpdateApiKeyRequest = Partial<
  Omit<CreateApiKeyRequest, 'name'> & { name: string; enabled: boolean }
>;

// ---- Nhật ký kiểm toán ----

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  client_ip?: string | null;
  created_at: number;
}

// ---- Tổng quan ----

export type SystemStatus = 'normal' | 'degraded' | 'maintenance' | 'upstream_unavailable' | 'migration_failed';

export interface OverviewResponse {
  system_status: SystemStatus;
  version: string;
  uptime_ms: number;
  accounts: {
    total: number;
    online: number;
    cooldown: number;
    reauth_required: number;
    disabled: number;
  };
  requests: {
    in_flight: number;
    last_hour: number;
    failed_last_hour: number;
  };
  tools: {
    calls_last_hour: number;
    arg_pass_rate: number;
  };
  upstream: {
    protocol_version: string;
    ws_base: string;
    image_input: boolean;
  };
  storage: {
    db_bytes: number;
    files_bytes: number;
    files_count: number;
  };
  public_api_base_url: string;
  pending_restart: string[];
}

// ---- Bản ghi yêu cầu ----

export type ResponseStatus = 'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

export interface RequestListItem {
  id: string;
  status: ResponseStatus;
  requested_model: string;
  requested_reasoning_effort: string | null;
  api_key_id: string | null;
  account_id: string | null;
  tool_round: number;
  tool_calls_total: number;
  created_at: number;
  updated_at: number;
  error_message: string | null;
}

export interface RequestListResponse {
  items: RequestListItem[];
  total: number;
}

export interface RequestToolCall {
  call_id: string;
  name: string;
  status: string;
  side_effect: boolean;
  created_at: number;
}

export interface RequestDetail extends RequestListItem {
  tool_calls: RequestToolCall[];
}

// ---- Cài đặt ----

export interface NetworkSettings {
  public_api_base_url: SettingItem<string>;
  public_admin_url: SettingItem<string>;
  trust_proxy: SettingItem<boolean>;
  http_proxy: SettingItem<string>;
  https_proxy: SettingItem<string>;
  no_proxy: SettingItem<string>;
}

/** Toàn bộ là khoảng thời gian chạy/thời gian lưu giữ tác vụ dọn dẹp, đơn vị mili-giây (tương ứng với bộ lập lịch cleanup phía máy chủ). */
export interface SchedulerSettings {
  cleanup_interval_ms: SettingItem<number>;
  response_retention_ms: SettingItem<number>;
  audit_log_retention_ms: SettingItem<number>;
  idempotency_retention_ms: SettingItem<number>;
  files_retention_ms: SettingItem<number>;
  files_upload_ttl_ms: SettingItem<number>;
}

export interface LoggingSettings {
  /** Mục cài đặt duy nhất có requires_restart=false: Có hiệu lực ngay lập tức sau khi lưu. */
  log_level: SettingItem<string>;
  log_privacy_mode: SettingItem<'strict' | 'metadata' | 'debug'>;
}

export interface OAuthSettings {
  client_id: SettingItem<string>;
  redirect_uri: SettingItem<string>;
  authorize_url: SettingItem<string>;
  token_url: SettingItem<string>;
  /** Phía máy chủ có kiểu string_list: Nhiều scope được phân tách bằng dấu cách khi hiển thị/chỉnh sửa. */
  scopes: SettingItem<string[]>;
}

export interface ToolsSettings {
  mode: SettingItem<'native' | 'prompt' | 'auto'>;
  max_calls_per_round: SettingItem<number>;
  max_rounds: SettingItem<number>;
  max_total_calls: SettingItem<number>;
  max_result_bytes: SettingItem<number>;
  /** Quy tắc giao thức giới hạn tối đa là 2, máy chủ sẽ từ chối giá trị lớn hơn. */
  max_arg_repairs: SettingItem<number>;
  allow_parallel: SettingItem<boolean>;
}

export interface FilesSettings {
  max_file_bytes: SettingItem<number>;
  max_request_bytes: SettingItem<number>;
  max_total_bytes_per_key: SettingItem<number>;
}

export interface SettingsResponse {
  network: NetworkSettings;
  scheduler: SchedulerSettings;
  logging: LoggingSettings;
  oauth: OAuthSettings;
  tools: ToolsSettings;
  files: FilesSettings;
}

export type SettingsGroupName = keyof SettingsResponse;

// ---- Pool Proxy Egress ----

export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type ProxyStatus = 'unknown' | 'healthy' | 'unhealthy' | 'cooldown';

export interface ProxyView {
  id: string;
  name: string;
  /** Địa chỉ đã che thông tin nhạy cảm, tên người dùng và mật khẩu không bao giờ xuất hiện dạng thô, ví dụ `socks5://***:***@1.2.3.4:1080`. */
  url_masked: string;
  protocol: ProxyProtocol;
  enabled: boolean;
  weight: number;
  priority: number;
  status: ProxyStatus;
  latency_ms: number | null;
  last_check_at: number | null;
  failure_count: number;
  cooldown_until: number | null;
  bound_accounts: string[];
}

export interface CreateProxyRequest {
  name: string;
  url: string;
  weight: number;
  priority: number;
  enabled: boolean;
}

export interface BulkImportProxyRequest {
  urls: string;
}

/**
 * Tên trường đồng bộ nghiêm ngặt với phản hồi thực tế của `POST /admin/proxies/bulk` trong
 * `apps/server/src/routes/adminOps.ts`: số đếm `created`/`failed`,
 * danh sách `results` theo từng dòng gồm `ok`/`id` (thành công)/`error` (thất bại), không dùng trường `succeeded`/`errors`.
 */
export interface BulkImportProxyResult {
  created: number;
  failed: number;
  results: Array<{ line: string; ok: boolean; id?: string; error?: string }>;
}

export interface ProxyCheckResult {
  ok: boolean;
  latency_ms: number | null;
  detail: string;
}

// ---- Sinh cấu hình Codex ----

export interface CodexConfigResponse {
  toml: string;
  base_url: string;
  notes: string[];
}

// ---- Quản lý Tệp ----

export interface FileListItem {
  id: string;
  filename: string;
  mime_type: string;
  kind: string;
  bytes: number;
  status: string;
  api_key_id: string | null;
  created_at: number;
  expires_at: number | null;
}

export interface FileListResponse {
  items: FileListItem[];
  total_bytes: number;
}

/**
 * Tên trường đồng bộ nghiêm ngặt với phản hồi thực tế của `POST /admin/files/cleanup` trong
 * `apps/server/src/routes/adminOps.ts`: tệp hết hạn và tệp tải lên chưa hoàn tất được đếm riêng biệt,
 * không gộp chung vào một trường `deleted` duy nhất.
 */
export interface FilesCleanupResult {
  deleted_files: number;
  deleted_uploads: number;
  freed_bytes: number;
}

// ---- Mô hình & Ma trận năng lực ----

export type CapabilityStatus = 'native' | 'local' | 'upstream_decided' | 'experimental' | 'unsupported';

export interface CapabilitiesResponse {
  models: Array<{ id: string; source: string }>;
  matrix: Array<{ feature: string; status: CapabilityStatus; detail: string }>;
}

// ---- Sao lưu / Phục hồi / Chẩn đoán (tương ứng apps/server/src/routes/backup.ts) ----

/** Cùng cấu trúc dữ liệu với `BackupStore#save`/`#list` (apps/server/src/backup/store.ts). */
export interface BackupInfo {
  id: string;
  bytes: number;
  created_at: number;
}

export interface BackupListResponse {
  items: BackupInfo[];
}

/** Cùng các trường với `BackupManifest` (apps/server/src/backup/service.ts). */
export interface BackupManifest {
  format_version: number;
  app_version: string;
  schema_version: number;
  master_key_version: number;
  created_at: number;
  includes_files: boolean;
  file_count: number;
}

/**
 * Phản hồi của `POST /admin/restore`. `requires_restart` luôn là true —
 * máy chủ chỉ chịu trách nhiệm kiểm tra và ghi tệp xuống đĩa, tiến trình đang chạy vẫn giữ kết nối CSDL cũ nên bắt buộc phải khởi động lại.
 */
export interface RestoreResult {
  restored: boolean;
  requires_restart: boolean;
  message: string;
  manifest: BackupManifest;
}

/** Cùng các trường với `DiagnosticsReport` (apps/server/src/observability/diagnostics.ts). */
export interface DiagnosticsReport {
  generated_at: number;
  app_version: string;
  system_status: SystemStatus;
  uptime_ms: number;
  schema: { current: number; expected: number; ok: boolean };
  accounts: Record<string, number>;
  accounts_usable: number;
  in_flight_requests: number;
  recent_errors: Record<string, number>;
  storage: { db_bytes: number; files_bytes: number; file_count: number };
  maintenance: Array<{ name: string; last_run_at: number | null; last_error: string | null }>;
  readiness: Array<{ name: string; ok: boolean }>;
  config: Record<string, unknown>;
  notes: string[];
}
