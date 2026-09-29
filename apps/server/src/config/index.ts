import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  LOG_PRIVACY_MODES,
  MASTER_KEY_BYTES,
  type LogPrivacyMode,
} from '@m365-codex/shared';

/**
 * Tải và kiểm tra cấu hình (tương ứng kế hoạch triển khai §3).
 *
 * Ràng buộc cứng:
 * - `M365_CODEX_MASTER_KEY` không có giá trị mặc định, thiếu hoặc không đủ 32 byte đều từ chối khởi động;
 * - Nghiêm cấm đưa bất kỳ Microsoft Token / thông tin xác thực OAuth nào qua biến môi trường;
 * - Địa chỉ upstream, scope v.v. đều đi qua cấu hình, không hardcode vào logic nghiệp vụ.
 */

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`配置校验失败：\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Danh sách tên biến môi trường bị cấm tuyệt đối. Xuất hiện là từ chối khởi động ngay,
 * tránh việc vận hành tiện tay nhét token thật vào môi trường container,
 * từ đó vượt qua lưu trữ mã hóa và kiểm toán.
 */
export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  'M365_ACCESS_TOKEN',
  'M365_REFRESH_TOKEN',
  'M365_CODEX_ACCESS_TOKEN',
  'M365_CODEX_REFRESH_TOKEN',
  'MICROSOFT_ACCESS_TOKEN',
  'MICROSOFT_REFRESH_TOKEN',
  'AAD_ACCESS_TOKEN',
  'AAD_REFRESH_TOKEN',
  'SUBSTRATE_ACCESS_TOKEN',
  'SYDNEY_ACCESS_TOKEN',
  'COPILOT_ACCESS_TOKEN',
  'BIZCHAT_ACCESS_TOKEN',
];

/**
 * Tham số upstream OAuth.
 *
 * Toàn bộ đi qua cấu hình: endpoint upstream có thể thay đổi (đã quan sát thấy hai dạng
 * substrate.office.com và substrate.svc.cloud.microsoft), CLIENT_ID và scope cũng có thể điều chỉnh theo,
 * do đó ở đây chỉ cung cấp giá trị mặc định, không hardcode trong logic nghiệp vụ.
 */
export interface OAuthConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
}

/** Giá trị mặc định lấy từ quy trình PKCE client native công khai của Microsoft, đều không phải bí mật. */
export const DEFAULT_OAUTH_CLIENT_ID = 'c0ab8ce9-e9a0-42e7-b064-33d422df41f1';
export const DEFAULT_OAUTH_REDIRECT_URI =
  'https://login.microsoftonline.com/common/oauth2/nativeclient';
export const DEFAULT_OAUTH_AUTHORIZE_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const DEFAULT_OAUTH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  'https://substrate.office.com/sydney/M365Chat.Read',
  'https://substrate.office.com/sydney/sydney.readwrite',
  'offline_access',
  'openid',
  'profile',
];

/**
 * Tham số WebSocket upstream Sydney / BizChat.
 *
 * Endpoint upstream có thể thay đổi (đã quan sát thấy hai dạng substrate.office.com và substrate.svc.cloud.microsoft),
 * vì vậy base URL, template đường dẫn, phiên bản giao thức đều đi qua cấu hình. Placeholder trong template đường dẫn:
 *   {oid} {tid} sẽ được thay thế bằng Object ID và Tenant ID của tài khoản.
 * access_token được gắn qua query param, không ghi vào template (tránh vô tình lọt vào log).
 */
export interface UpstreamConfig {
  readonly wsBase: string;
  readonly pathTemplate: string;
  /** Phiên bản tầng adapter giao thức, độc lập với phiên bản nghiệp vụ; có thể chuyển đổi sau khi probe M0 xác nhận giao thức thực tế */
  readonly protocolVersion: string;
  /** Khoảng thời gian heartbeat (mili-giây) */
  readonly heartbeatIntervalMs: number;
  /** Timeout bắt tay (mili-giây) */
  readonly handshakeTimeoutMs: number;
  /** Timeout rảnh rỗi cho từng tin nhắn (mili-giây): quá thời gian này mà không nhận được frame upstream nào thì coi là bị treo */
  readonly idleTimeoutMs: number;
  /** Số lần kết nối lại tối đa sau khi WS bị ngắt (trong cùng một tài khoản) */
  readonly maxReconnects: number;
  /**
   * Header `X-Scenario` bắt buộc phải có khi bắt tay WebSocket.
   *
   * Đã kiểm thử thực tế với tài khoản thật vào ngày 27-07-2026: header này là **điều kiện cứng duy nhất để upstream chấp thuận** — không có nó,
   * dù token đúng đến đâu, đặt ở query param hay header Authorization, đều trả về 403 (body rỗng,
   * không có WWW-Authenticate, trông giống như "tài khoản không có quyền", cực kỳ dễ gây nhầm lẫn). Giá trị phải khớp chính xác,
   * `bizchat` / `M365Chat` / bất kỳ giá trị nào khác đều bị 403.
   *
   * Đưa thành mục cấu hình vì nó rõ ràng thuộc về thứ có thể thay đổi theo upstream; giá trị mặc định lấy từ thực nghiệm.
   */
  readonly scenario: string;
}

export const DEFAULT_UPSTREAM_WS_BASE = 'wss://substrate.office.com';
export const DEFAULT_UPSTREAM_PATH_TEMPLATE = '/m365Copilot/Chathub/{oid}@{tid}';
export const DEFAULT_UPSTREAM_PROTOCOL_VERSION = 'sydney-json-v1';
/** Giá trị thực nghiệm: upstream chỉ chấp nhận một giá trị duy nhất này, đổi sang giá trị khác đều bị 403 (xem chú thích UpstreamConfig.scenario). */
export const DEFAULT_UPSTREAM_SCENARIO = 'officeweb';

/**
 * Giới hạn toàn cục cho gọi công cụ và vòng lặp agent (tương ứng kế hoạch triển khai §7.4).
 *
 * Đây là **mức trần toàn cục**, giới hạn ở cấp API Key chỉ có thể nghiêm ngặt hơn chứ không thể vượt qua (§10, triển khai ở M7).
 * `mode` quyết định cách thức chuyển danh mục công cụ cho upstream:
 *   native —— chỉ gửi khai báo công cụ có cấu trúc trong invocation (khi upstream hỗ trợ gốc);
 *   prompt —— chỉ dùng prompt để ràng buộc đầu ra JSON `<tool_call>` (khi upstream không hỗ trợ công cụ gốc);
 *   auto   —— áp dụng cả hai và đồng thời phân tích hai dạng phản hồi. Giá trị mặc định trước khi có kết luận từ probe M0.
 */
export type ToolsMode = 'native' | 'prompt' | 'auto';

export interface ToolsConfig {
  readonly mode: ToolsMode;
  /** Số lượng lệnh gọi công cụ tối đa được chấp nhận trong một vòng */
  readonly maxCallsPerRound: number;
  /** Số vòng gọi công cụ tối đa trên một chuỗi hội thoại */
  readonly maxRounds: number;
  /** Tổng số lệnh gọi công cụ tích lũy tối đa trên một chuỗi hội thoại */
  readonly maxTotalCalls: number;
  /** Kích thước byte tối đa cho kết quả của một công cụ */
  readonly maxResultBytes: number;
  /** Số lần yêu cầu upstream sửa lại tối đa khi tham số không hợp lệ (mức trần §7.3 là 2) */
  readonly maxArgRepairs: number;
  /** Cho phép xuất hiện nhiều lệnh gọi công cụ trong một vòng hay không */
  readonly allowParallel: boolean;
}

export const MAX_ARG_REPAIRS_CEILING = 2;

/**
 * Hạn ngạch của hệ thống con tệp (tương ứng kế hoạch triển khai §11, §M6).
 *
 * Toàn bộ đi qua cấu hình và đều là **mức trần**: ba tầng giới hạn gồm đơn tệp, đơn yêu cầu, dung lượng tích lũy theo Key,
 * vượt quá bất kỳ tầng nào đều trả về lỗi rõ ràng, không âm thầm cắt ngắn.
 */
export interface FilesConfig {
  /** Số byte tối đa của một tệp đơn (hoặc một part đơn của Upload) */
  readonly maxFileBytes: number;
  /** Số byte tối đa của một yêu cầu multipart đơn (phải ≥ maxFileBytes, dùng cho route thiết lập bodyLimit của Fastify) */
  readonly maxRequestBytes: number;
  /** Giới hạn dung lượng lưu trữ tích lũy cho một API Key (tổng số byte của các tệp chưa xóa) */
  readonly maxTotalBytesPerKey: number;
  /** Thời gian lưu giữ tệp (mili-giây), vượt quá created_at + giá trị này được coi là hết hạn; 0 nghĩa là không tự động hết hạn */
  readonly retentionMs: number;
  /** Thời gian tồn tại của Upload chưa hoàn thành (mili-giây), quá hạn coi như hết hạn và dọn dẹp các chunk đã nhận */
  readonly uploadTtlMs: number;
}

/**
 * **Mức trần toàn cục** cho hạn ngạch API Key (tương ứng câu cuối §10 kế hoạch: "Giới hạn của API Key không được vượt quá
 * giới hạn toàn cục của hệ thống"). rpm_limit / daily_limit / max_concurrency của từng Key chỉ có thể
 * nghiêm ngặt hơn ở đây, tuyệt đối không được phép vượt qua — logic cắt giảm cụ thể nằm tại `gateway/rateLimit.ts`.
 */
export interface RateLimitConfig {
  readonly globalRpmLimit: number;
  readonly globalDailyLimit: number;
  readonly globalMaxConcurrency: number;
}

/**
 * Khoảng thời gian và chu kỳ lưu giữ cho tác vụ dọn dẹp định kỳ (tương ứng kế hoạch triển khai §18).
 * Thời gian lưu giữ của tệp/Upload tái sử dụng `FilesConfig`, ở đây chỉ đặt các mục riêng cho tác vụ dọn dẹp M7.
 */
export interface CleanupConfig {
  /** Khoảng thời gian chạy dùng chung cho các tác vụ dọn dẹp */
  readonly intervalMs: number;
  /** Response đã kết thúc (completed/failed/cancelled/incomplete) được giữ lại trong bao lâu */
  readonly responseRetentionMs: number;
  /** Nhật ký kiểm toán được giữ lại trong bao lâu */
  readonly auditLogRetentionMs: number;
  /** Bản ghi idempotent được giữ lại trong bao lâu */
  readonly idempotencyRetentionMs: number;
}

/**
 * Metrics và sao lưu (tương ứng kế hoạch triển khai §17, §15.4, bổ sung ở M8).
 *
 * `metricsRequireAuth` mặc định bật: `/metrics` sẽ để lộ thông tin như số lượng tài khoản, phân bố lỗi,
 * không nên công khai mà không có xác thực; khi chuyển rõ ràng thành false thì không cần xác thực (thích hợp đưa vào bộ thu thập nội bộ).
 */
export interface MetricsConfig {
  readonly enabled: boolean;
  readonly requireAuth: boolean;
}

/** Số bản sao lưu giữ lại: khi các gói do `POST /admin/backup` tạo ra vượt quá số này, dọn dẹp định kỳ sẽ xóa bản cũ nhất. */
export interface BackupConfig {
  readonly retentionCount: number;
}

export interface AppConfig {
  readonly port: number;
  readonly dataDir: string;
  readonly masterKey: Buffer;
  readonly masterKeyVersion: number;
  readonly adminPassword: string;
  readonly publicApiBaseUrl: string | null;
  readonly publicAdminUrl: string | null;
  readonly trustProxy: boolean;
  readonly logPrivacyMode: LogPrivacyMode;
  /**
   * Thời gian tự động hết hạn mặc định của chế độ riêng tư `debug` (mili-giây, tương ứng kế hoạch §15.3).
   * debug sẽ ghi lại nhiều thông tin yêu cầu hơn, không được duy trì vô thời hạn ở mức này; khi chuyển sang debug sẽ dựa vào
   * khoảng thời gian này để tự động tính `logging.debug_expires_at`, hết hạn sẽ được cron trong `settings/service.ts`
   * tự động khôi phục về strict.
   */
  readonly logPrivacyDebugTtlMs: number;
  readonly logLevel: string;
  readonly upstreamWsBase: string | null;
  readonly httpProxy: string | null;
  readonly httpsProxy: string | null;
  readonly noProxy: string | null;
  readonly oauth: OAuthConfig;
  readonly upstream: UpstreamConfig;
  readonly tools: ToolsConfig;
  readonly files: FilesConfig;
  readonly rateLimit: RateLimitConfig;
  readonly cleanup: CleanupConfig;
  /** Timeout kiểm tra sức khỏe proxy gửi đi (mili-giây, hợp đồng §2.4 `POST /admin/proxies/:id/check`) */
  readonly proxyCheckTimeoutMs: number;
  /** M8: Bật/tắt và yêu cầu xác thực của endpoint `/metrics` */
  readonly metrics: MetricsConfig;
  /** M8: Số bản sao lưu giữ lại */
  readonly backup: BackupConfig;
  /**
   * Tên các key xuất hiện rõ ràng trong biến môi trường ban đầu khi khởi động (giá trị không rỗng).
   * `/admin/settings` dựa vào đây để xác định mục nào có `source: "env"` — điều phối container là nguồn chân lý duy nhất,
   * một khi biến môi trường đã được đặt tường minh thì UI không thể âm thầm ghi đè (xem kế hoạch §M7, hợp đồng §2.3).
   */
  readonly envKeysPresent: ReadonlySet<string>;
  /**
   * Upstream có thực sự hỗ trợ đầu vào hình ảnh hay không. Mặc định false — năng lực upstream phải chờ probe M0 thực tế hiệu chuẩn,
   * trước khi có kết luận từ probe thì từ chối toàn bộ và trả về unsupported_feature, không giả vờ hỗ trợ.
   */
  readonly upstreamImageInput: boolean;
  /**
   * Ngữ cảnh đối thoại tái tạo vượt quá bao nhiêu ký tự thì bắt đầu cắt ngắn từ lịch sử cũ nhất (xem
   * `extractInputText` trong `responses/schema.ts`). Các client `store:false` như Codex mỗi vòng sẽ gửi kèm
   * hàng chục nghìn ký tự chỉ thị hệ thống + toàn bộ lịch sử, mặc định đặt một giá trị rộng rãi.
   */
  readonly contextMaxChars: number;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Phân tích cú pháp và kiểm tra khóa chính Base64, ném ra lý do dễ đọc khi thất bại. */
export function parseMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error('主密钥为空');
  }
  if (!BASE64_PATTERN.test(value)) {
    throw new Error('主密钥不是合法的 Base64 字符串');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== MASTER_KEY_BYTES) {
    throw new Error(`主密钥解码后为 ${decoded.byteLength} 字节，要求正好 ${MASTER_KEY_BYTES} 字节`);
  }
  return decoded;
}

const optionalTrimmed = z
  .string()
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  })
  .optional();

const booleanFromEnv = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['true', 'false', '1', '0', 'yes', 'no', ''].includes(value), {
    message: '只接受 true/false/1/0/yes/no',
  })
  .transform((value) => value === 'true' || value === '1' || value === 'yes')
  .optional();

const optionalUrl = optionalTrimmed.refine(
  (value) => {
    if (value === undefined) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: '必须是 http/https URL' },
);

const optionalWsUrl = optionalTrimmed.refine(
  (value) => {
    if (value === undefined) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
      return false;
    }
  },
  { message: '必须是 ws/wss URL' },
);

const envSchema = z.object({
  M365_CODEX_MASTER_KEY: z.string({ required_error: '必填：未设置主加密密钥' }),
  M365_CODEX_ADMIN_PASSWORD: z
    .string({ required_error: '必填：未设置管理端密码' })
    .min(12, '管理端密码至少 12 位'),
  PORT: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? DEFAULT_PORT : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 1 && value <= 65535, {
      message: '必须是 1-65535 的整数',
    }),
  DATA_DIR: optionalTrimmed,
  PUBLIC_API_BASE_URL: optionalUrl,
  PUBLIC_ADMIN_URL: optionalUrl,
  TRUST_PROXY: booleanFromEnv,
  LOG_PRIVACY_MODE: z.enum(LOG_PRIVACY_MODES).optional(),
  // Mặc định thận trọng 1 giờ: chế độ debug ghi lại nhiều thông tin yêu cầu hơn, không nên duy trì vô hạn
  LOG_PRIVACY_DEBUG_TTL_MS: positiveIntFromEnv(60 * 60 * 1000, 60_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  UPSTREAM_WS_BASE: optionalWsUrl,
  HTTP_PROXY: optionalTrimmed,
  HTTPS_PROXY: optionalTrimmed,
  NO_PROXY: optionalTrimmed,
  MASTER_KEY_VERSION: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 1 : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 1, { message: '必须是 ≥1 的整数' }),
  OAUTH_CLIENT_ID: optionalTrimmed,
  OAUTH_REDIRECT_URI: optionalUrl,
  OAUTH_AUTHORIZE_URL: optionalUrl,
  OAUTH_TOKEN_URL: optionalUrl,
  OAUTH_SCOPES: optionalTrimmed,
  UPSTREAM_PATH_TEMPLATE: optionalTrimmed,
  UPSTREAM_PROTOCOL_VERSION: optionalTrimmed,
  UPSTREAM_SCENARIO: optionalTrimmed,
  UPSTREAM_HEARTBEAT_INTERVAL_MS: positiveIntFromEnv(15_000, 1_000),
  UPSTREAM_HANDSHAKE_TIMEOUT_MS: positiveIntFromEnv(15_000, 1_000),
  UPSTREAM_IDLE_TIMEOUT_MS: positiveIntFromEnv(60_000, 1_000),
  UPSTREAM_MAX_RECONNECTS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 2 : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= 10, {
      message: '必须是 0-10 的整数',
    }),
  TOOLS_MODE: z.enum(['native', 'prompt', 'auto']).optional(),
  TOOLS_MAX_CALLS_PER_ROUND: positiveIntFromEnv(8, 1),
  TOOLS_MAX_ROUNDS: positiveIntFromEnv(16, 1),
  TOOLS_MAX_TOTAL_CALLS: positiveIntFromEnv(64, 1),
  TOOLS_MAX_RESULT_BYTES: positiveIntFromEnv(256 * 1024, 1024),
  TOOLS_MAX_ARG_REPAIRS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? MAX_ARG_REPAIRS_CEILING : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_ARG_REPAIRS_CEILING, {
      message: `必须是 0-${MAX_ARG_REPAIRS_CEILING} 的整数`,
    }),
  TOOLS_ALLOW_PARALLEL: booleanFromEnv,
  FILES_MAX_FILE_BYTES: positiveIntFromEnv(25 * 1024 * 1024, 1024),
  FILES_MAX_REQUEST_BYTES: positiveIntFromEnv(26 * 1024 * 1024, 1024),
  FILES_MAX_TOTAL_BYTES_PER_KEY: positiveIntFromEnv(200 * 1024 * 1024, 1024),
  // 0 biểu thị không tự động hết hạn, do đó hạ giới hạn dưới xuống 0 (không dùng positiveIntFromEnv vì giới hạn dưới của nó là min)
  FILES_RETENTION_MS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? 30 * 24 * 60 * 60 * 1000 : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= 0, { message: '必须是 ≥0 的整数' }),
  FILES_UPLOAD_TTL_MS: positiveIntFromEnv(24 * 60 * 60 * 1000, 60_000),
  UPSTREAM_IMAGE_INPUT: booleanFromEnv,
  CONTEXT_MAX_CHARS: positiveIntFromEnv(400_000, 10_000),
  // --- Mức trần toàn cục cho hạn ngạch API Key (§10) ---
  RATE_LIMIT_GLOBAL_RPM: positiveIntFromEnv(600, 1),
  RATE_LIMIT_GLOBAL_DAILY: positiveIntFromEnv(50_000, 1),
  RATE_LIMIT_GLOBAL_MAX_CONCURRENCY: positiveIntFromEnv(50, 1),
  // --- Dọn dẹp định kỳ (§18) ---
  CLEANUP_INTERVAL_MS: positiveIntFromEnv(10 * 60 * 1000, 30_000),
  CLEANUP_RESPONSE_RETENTION_MS: positiveIntFromEnv(7 * 24 * 60 * 60 * 1000, 60_000),
  CLEANUP_AUDIT_LOG_RETENTION_MS: positiveIntFromEnv(90 * 24 * 60 * 60 * 1000, 60_000),
  CLEANUP_IDEMPOTENCY_RETENTION_MS: positiveIntFromEnv(24 * 60 * 60 * 1000, 60_000),
  PROXY_CHECK_TIMEOUT_MS: positiveIntFromEnv(5_000, 500),
  // --- Metrics và sao lưu (M8, §17, §15.4) ---
  METRICS_ENABLED: booleanFromEnv,
  // Mặc định bật: /metrics sẽ để lộ số lượng tài khoản và phân bố lỗi, không nên mở công khai khi chưa xác thực
  METRICS_REQUIRE_AUTH: booleanFromEnv,
  BACKUP_RETENTION_COUNT: positiveIntFromEnv(7, 1),
});

/** Tạo một parser env "số nguyên dương tùy chọn, có giá trị mặc định và giới hạn dưới". */
function positiveIntFromEnv(defaultValue: number, min: number) {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= min, {
      message: `必须是 ≥${min} 的整数`,
    });
}

/** scope cho phép phân tách bằng dấu cách hoặc dấu phẩy, tương thích với cả hai cách viết phổ biến. */
function parseScopes(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_OAUTH_SCOPES;
  const parsed = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  return parsed.length === 0 ? DEFAULT_OAUTH_SCOPES : parsed;
}

export type RawEnv = Record<string, string | undefined>;

/**
 * Tải cấu hình từ biến môi trường. Bất kỳ mục nào không hợp lệ đều được tổng hợp và ném ra ConfigError một lần,
 * tránh việc vận hành phải thử đi thử lại. Thông tin lỗi không phản hồi lại giá trị nhạy cảm.
 */
export function loadConfig(env: RawEnv = process.env): AppConfig {
  const issues: string[] = [];

  for (const key of FORBIDDEN_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') {
      issues.push(
        `${key}: 禁止通过环境变量注入 Microsoft 凭据，请改用管理界面的 PKCE 授权流程`,
      );
    }
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      issues.push(`${path}: ${issue.message}`);
    }
  }

  let masterKey: Buffer | undefined;
  const rawMasterKey = env.M365_CODEX_MASTER_KEY;
  if (typeof rawMasterKey === 'string' && rawMasterKey.trim() !== '') {
    try {
      masterKey = parseMasterKey(rawMasterKey);
    } catch (error) {
      issues.push(`M365_CODEX_MASTER_KEY: ${(error as Error).message}`);
    }
  } else if (rawMasterKey !== undefined) {
    issues.push('M365_CODEX_MASTER_KEY: 不能为空');
  }

  if (parsed.success && parsed.data.FILES_MAX_REQUEST_BYTES < parsed.data.FILES_MAX_FILE_BYTES) {
    issues.push('FILES_MAX_REQUEST_BYTES: 不能小于 FILES_MAX_FILE_BYTES');
  }

  if (issues.length > 0 || !parsed.success || masterKey === undefined) {
    throw new ConfigError(issues.length > 0 ? issues : ['未知的配置错误']);
  }

  const data = parsed.data;

  return Object.freeze({
    port: data.PORT,
    dataDir: data.DATA_DIR ?? DEFAULT_DATA_DIR,
    masterKey,
    masterKeyVersion: data.MASTER_KEY_VERSION,
    adminPassword: data.M365_CODEX_ADMIN_PASSWORD,
    publicApiBaseUrl: data.PUBLIC_API_BASE_URL ?? null,
    publicAdminUrl: data.PUBLIC_ADMIN_URL ?? null,
    trustProxy: data.TRUST_PROXY ?? false,
    logPrivacyMode: data.LOG_PRIVACY_MODE ?? 'strict',
    logPrivacyDebugTtlMs: data.LOG_PRIVACY_DEBUG_TTL_MS,
    logLevel: data.LOG_LEVEL ?? 'info',
    upstreamWsBase: data.UPSTREAM_WS_BASE ?? null,
    httpProxy: data.HTTP_PROXY ?? null,
    httpsProxy: data.HTTPS_PROXY ?? null,
    noProxy: data.NO_PROXY ?? null,
    oauth: Object.freeze({
      clientId: data.OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID,
      redirectUri: data.OAUTH_REDIRECT_URI ?? DEFAULT_OAUTH_REDIRECT_URI,
      authorizeUrl: data.OAUTH_AUTHORIZE_URL ?? DEFAULT_OAUTH_AUTHORIZE_URL,
      tokenUrl: data.OAUTH_TOKEN_URL ?? DEFAULT_OAUTH_TOKEN_URL,
      scopes: Object.freeze(parseScopes(data.OAUTH_SCOPES)),
    }),
    upstream: Object.freeze({
      wsBase: data.UPSTREAM_WS_BASE ?? DEFAULT_UPSTREAM_WS_BASE,
      pathTemplate: data.UPSTREAM_PATH_TEMPLATE ?? DEFAULT_UPSTREAM_PATH_TEMPLATE,
      protocolVersion: data.UPSTREAM_PROTOCOL_VERSION ?? DEFAULT_UPSTREAM_PROTOCOL_VERSION,
      scenario: data.UPSTREAM_SCENARIO ?? DEFAULT_UPSTREAM_SCENARIO,
      heartbeatIntervalMs: data.UPSTREAM_HEARTBEAT_INTERVAL_MS,
      handshakeTimeoutMs: data.UPSTREAM_HANDSHAKE_TIMEOUT_MS,
      idleTimeoutMs: data.UPSTREAM_IDLE_TIMEOUT_MS,
      maxReconnects: data.UPSTREAM_MAX_RECONNECTS,
    }),
    tools: Object.freeze({
      mode: data.TOOLS_MODE ?? 'auto',
      maxCallsPerRound: data.TOOLS_MAX_CALLS_PER_ROUND,
      maxRounds: data.TOOLS_MAX_ROUNDS,
      maxTotalCalls: data.TOOLS_MAX_TOTAL_CALLS,
      maxResultBytes: data.TOOLS_MAX_RESULT_BYTES,
      maxArgRepairs: data.TOOLS_MAX_ARG_REPAIRS,
      allowParallel: data.TOOLS_ALLOW_PARALLEL ?? true,
    }),
    files: Object.freeze({
      maxFileBytes: data.FILES_MAX_FILE_BYTES,
      maxRequestBytes: data.FILES_MAX_REQUEST_BYTES,
      maxTotalBytesPerKey: data.FILES_MAX_TOTAL_BYTES_PER_KEY,
      retentionMs: data.FILES_RETENTION_MS,
      uploadTtlMs: data.FILES_UPLOAD_TTL_MS,
    }),
    rateLimit: Object.freeze({
      globalRpmLimit: data.RATE_LIMIT_GLOBAL_RPM,
      globalDailyLimit: data.RATE_LIMIT_GLOBAL_DAILY,
      globalMaxConcurrency: data.RATE_LIMIT_GLOBAL_MAX_CONCURRENCY,
    }),
    cleanup: Object.freeze({
      intervalMs: data.CLEANUP_INTERVAL_MS,
      responseRetentionMs: data.CLEANUP_RESPONSE_RETENTION_MS,
      auditLogRetentionMs: data.CLEANUP_AUDIT_LOG_RETENTION_MS,
      idempotencyRetentionMs: data.CLEANUP_IDEMPOTENCY_RETENTION_MS,
    }),
    proxyCheckTimeoutMs: data.PROXY_CHECK_TIMEOUT_MS,
    envKeysPresent: computeEnvKeysPresent(env),
    upstreamImageInput: data.UPSTREAM_IMAGE_INPUT ?? false,
    contextMaxChars: data.CONTEXT_MAX_CHARS,
    metrics: Object.freeze({
      enabled: data.METRICS_ENABLED ?? true,
      requireAuth: data.METRICS_REQUIRE_AUTH ?? true,
    }),
    backup: Object.freeze({
      retentionCount: data.BACKUP_RETENTION_COUNT,
    }),
  });
}

/** Ghi nhận các biến môi trường nào được gán giá trị không rỗng rõ ràng khi khởi động, để `/admin/settings` xác định `source: "env"`. */
function computeEnvKeysPresent(env: RawEnv): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') keys.add(key);
  }
  return keys;
}

/** Tạo bản tóm tắt cấu hình an toàn để ghi log: không chứa khóa bí mật và mật khẩu. */
export function summarizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    port: config.port,
    dataDir: config.dataDir,
    masterKeyVersion: config.masterKeyVersion,
    masterKeyConfigured: true,
    adminPasswordConfigured: config.adminPassword.length > 0,
    publicApiBaseUrl: config.publicApiBaseUrl,
    publicAdminUrl: config.publicAdminUrl,
    trustProxy: config.trustProxy,
    logPrivacyMode: config.logPrivacyMode,
    logLevel: config.logLevel,
    upstreamWsBaseConfigured: config.upstreamWsBase !== null,
    egressProxyConfigured: config.httpProxy !== null || config.httpsProxy !== null,
    oauthClientId: config.oauth.clientId,
    oauthScopeCount: config.oauth.scopes.length,
    upstreamWsBase: config.upstream.wsBase,
    upstreamProtocolVersion: config.upstream.protocolVersion,
    toolsMode: config.tools.mode,
    toolsMaxRounds: config.tools.maxRounds,
    toolsMaxCallsPerRound: config.tools.maxCallsPerRound,
    filesMaxFileBytes: config.files.maxFileBytes,
    filesMaxTotalBytesPerKey: config.files.maxTotalBytesPerKey,
    upstreamImageInput: config.upstreamImageInput,
    contextMaxChars: config.contextMaxChars,
    metricsEnabled: config.metrics.enabled,
    metricsRequireAuth: config.metrics.requireAuth,
    backupRetentionCount: config.backup.retentionCount,
  };
}
