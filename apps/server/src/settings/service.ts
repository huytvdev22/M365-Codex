import { ApiError, LOG_PRIVACY_MODES, type LogPrivacyMode } from '@m365-codex/shared';
import type { Logger } from 'pino';
import { MAX_ARG_REPAIRS_CEILING, type AppConfig, type RawEnv } from '../config/index.js';
import type { AuditLogRepository } from '../repo/auditLogs.js';
import type { SettingsRepository } from '../repo/settings.js';
import type { PrivacyModeHolder } from '../observability/privacyMode.js';

/**
 * Ngữ nghĩa phân nhóm khi đọc và ghi cài đặt (tương ứng kế hoạch triển khai §M7, hợp đồng §2.3).
 *
 * Quy tắc cốt lõi: Các mục đã thiết lập rõ ràng qua biến môi trường sẽ có `source: "env"`, `editable: false` — bộ điều phối
 * container là nguồn chân lý duy nhất, UI không thể âm thầm ghi đè; các mục còn lại được lưu vào bảng `settings`, mục nào có `requires_restart`
 * là true sẽ phải đợi lần khởi động lại tiến trình tiếp theo (`server.ts` tổng hợp nội dung bảng settings thành lớp ghi đè env,
 * chạy lại `loadConfig`) mới có hiệu lực, trước đó sẽ thể hiện trong danh sách `pending_restart` của `/admin/overview`;
 * chỉ có `logging.log_level` là mục thực sự có hiệu lực nóng (hot-reload).
 */

export type SettingGroup = 'network' | 'scheduler' | 'logging' | 'oauth' | 'tools' | 'files';
export const SETTING_GROUPS: readonly SettingGroup[] = [
  'network',
  'scheduler',
  'logging',
  'oauth',
  'tools',
  'files',
];

export type SettingValueType = 'string' | 'number' | 'boolean' | 'string_list';

export interface SettingFieldView {
  value: unknown;
  source: 'env' | 'db' | 'default';
  editable: boolean;
  requires_restart: boolean;
}

interface FieldDef {
  field: string;
  envVar: string;
  type: SettingValueType;
  requiresRestart: boolean;
  /** Giá trị hiệu lực hiện tại: Lấy từ `AppConfig` đã khóa khi tiến trình này khởi động. */
  readConfig: (config: AppConfig) => unknown;
  /** Xác thực ngữ nghĩa bổ sung (ngoài kiểm tra kiểu dữ liệu), ví dụ ràng buộc giới hạn trên. */
  validate?: (value: unknown) => string | null;
}

const FIELD_DEFS: Record<SettingGroup, FieldDef[]> = {
  network: [
    {
      field: 'public_api_base_url',
      envVar: 'PUBLIC_API_BASE_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.publicApiBaseUrl,
    },
    {
      field: 'public_admin_url',
      envVar: 'PUBLIC_ADMIN_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.publicAdminUrl,
    },
    {
      field: 'trust_proxy',
      envVar: 'TRUST_PROXY',
      type: 'boolean',
      requiresRestart: true,
      readConfig: (c) => c.trustProxy,
    },
    {
      field: 'http_proxy',
      envVar: 'HTTP_PROXY',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.httpProxy,
    },
    {
      field: 'https_proxy',
      envVar: 'HTTPS_PROXY',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.httpsProxy,
    },
    {
      field: 'no_proxy',
      envVar: 'NO_PROXY',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.noProxy,
    },
  ],
  scheduler: [
    {
      field: 'cleanup_interval_ms',
      envVar: 'CLEANUP_INTERVAL_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.intervalMs,
    },
    {
      field: 'response_retention_ms',
      envVar: 'CLEANUP_RESPONSE_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.responseRetentionMs,
    },
    {
      field: 'audit_log_retention_ms',
      envVar: 'CLEANUP_AUDIT_LOG_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.auditLogRetentionMs,
    },
    {
      field: 'idempotency_retention_ms',
      envVar: 'CLEANUP_IDEMPOTENCY_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.cleanup.idempotencyRetentionMs,
    },
    {
      field: 'files_retention_ms',
      envVar: 'FILES_RETENTION_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.retentionMs,
    },
    {
      field: 'files_upload_ttl_ms',
      envVar: 'FILES_UPLOAD_TTL_MS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.uploadTtlMs,
    },
  ],
  logging: [
    {
      field: 'log_level',
      envVar: 'LOG_LEVEL',
      type: 'string',
      requiresRestart: false,
      readConfig: (c) => c.logLevel,
    },
    {
      field: 'log_privacy_mode',
      envVar: 'LOG_PRIVACY_MODE',
      type: 'string',
      // Cùng là ngoại lệ có hiệu lực nóng giống log_level: debug tự động hết hạn phải ngay lập tức siết chặt về
      // strict, không thể chờ đến lần khởi động lại tiếp theo (xem #applyHot và
      // chú thích đầu file observability/privacyMode.ts)
      requiresRestart: false,
      readConfig: (c) => c.logPrivacyMode,
      validate: (v) =>
        typeof v === 'string' && (LOG_PRIVACY_MODES as readonly string[]).includes(v)
          ? null
          : `必须是 ${LOG_PRIVACY_MODES.join('/')} 之一`,
    },
  ],
  oauth: [
    {
      field: 'client_id',
      envVar: 'OAUTH_CLIENT_ID',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.clientId,
    },
    {
      field: 'redirect_uri',
      envVar: 'OAUTH_REDIRECT_URI',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.redirectUri,
    },
    {
      field: 'authorize_url',
      envVar: 'OAUTH_AUTHORIZE_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.authorizeUrl,
    },
    {
      field: 'token_url',
      envVar: 'OAUTH_TOKEN_URL',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.oauth.tokenUrl,
    },
    {
      field: 'scopes',
      envVar: 'OAUTH_SCOPES',
      type: 'string_list',
      requiresRestart: true,
      readConfig: (c) => c.oauth.scopes,
    },
  ],
  tools: [
    {
      field: 'mode',
      envVar: 'TOOLS_MODE',
      type: 'string',
      requiresRestart: true,
      readConfig: (c) => c.tools.mode,
      validate: (v) => (v === 'native' || v === 'prompt' || v === 'auto' ? null : '必须是 native/prompt/auto 之一'),
    },
    {
      field: 'max_calls_per_round',
      envVar: 'TOOLS_MAX_CALLS_PER_ROUND',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxCallsPerRound,
    },
    {
      field: 'max_rounds',
      envVar: 'TOOLS_MAX_ROUNDS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxRounds,
    },
    {
      field: 'max_total_calls',
      envVar: 'TOOLS_MAX_TOTAL_CALLS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxTotalCalls,
    },
    {
      field: 'max_result_bytes',
      envVar: 'TOOLS_MAX_RESULT_BYTES',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxResultBytes,
    },
    {
      field: 'max_arg_repairs',
      envVar: 'TOOLS_MAX_ARG_REPAIRS',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.tools.maxArgRepairs,
      // Giới hạn trên bị quy tắc giao thức khóa cứng ở mức 2 (§7.3), mục cài đặt không thể vượt quá trần này
      validate: (v) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_ARG_REPAIRS_CEILING
          ? null
          : `必须是 0-${MAX_ARG_REPAIRS_CEILING} 的整数`,
    },
    {
      field: 'allow_parallel',
      envVar: 'TOOLS_ALLOW_PARALLEL',
      type: 'boolean',
      requiresRestart: true,
      readConfig: (c) => c.tools.allowParallel,
    },
  ],
  files: [
    {
      field: 'max_file_bytes',
      envVar: 'FILES_MAX_FILE_BYTES',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.maxFileBytes,
    },
    {
      field: 'max_request_bytes',
      envVar: 'FILES_MAX_REQUEST_BYTES',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.maxRequestBytes,
    },
    {
      field: 'max_total_bytes_per_key',
      envVar: 'FILES_MAX_TOTAL_BYTES_PER_KEY',
      type: 'number',
      requiresRestart: true,
      readConfig: (c) => c.files.maxTotalBytesPerKey,
    },
  ],
};

function validateType(type: SettingValueType, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : '必须是字符串';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : '必须是数字';
    case 'boolean':
      return typeof value === 'boolean' ? null : '必须是布尔值';
    case 'string_list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : '必须是字符串数组';
    default:
      return null;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SettingsService {
  readonly #repo: SettingsRepository;
  readonly #config: AppConfig;
  readonly #envKeysPresent: ReadonlySet<string>;
  readonly #logger: Logger;
  readonly #privacyMode: PrivacyModeHolder | undefined;
  readonly #auditLogs: AuditLogRepository | undefined;

  constructor(deps: {
    repo: SettingsRepository;
    config: AppConfig;
    logger: Logger;
    /** Dùng để log_privacy_mode thực sự có hiệu lực nóng; nếu không truyền thì ghi nhận mục này chỉ lưu DB, không ảnh hưởng hành vi runtime */
    privacyMode?: PrivacyModeHolder;
    /** Ghi audit log khi debug tự động hết hạn; nếu không truyền sẽ âm thầm bỏ qua (dành cho ngữ cảnh không quan tâm audit, như unit test nhẹ) */
    auditLogs?: AuditLogRepository;
  }) {
    this.#repo = deps.repo;
    this.#config = deps.config;
    this.#envKeysPresent = deps.config.envKeysPresent;
    this.#logger = deps.logger;
    this.#privacyMode = deps.privacyMode;
    this.#auditLogs = deps.auditLogs;
  }

  getGroup(group: SettingGroup): Record<string, SettingFieldView> {
    const out: Record<string, SettingFieldView> = {};
    for (const def of FIELD_DEFS[group]) {
      out[def.field] = this.#view(group, def);
    }
    if (group === 'logging') {
      // debug_expires_at không phải mục cấu hình thông thường (không thể trực tiếp đặt timestamp cụ thể qua PATCH,
      // chỉ sinh ra gián tiếp khi chuyển log_privacy_mode sang debug), do đó không đi qua FIELD_DEFS,
      // được tổng hợp riêng thành một view chỉ đọc để giao diện quản trị hiển thị (mở rộng của hợp đồng §2.3)
      out.debug_expires_at = this.#debugExpiresAtView();
    }
    return out;
  }

  getAll(): Record<SettingGroup, Record<string, SettingFieldView>> {
    const out = {} as Record<SettingGroup, Record<string, SettingFieldView>>;
    for (const group of SETTING_GROUPS) out[group] = this.getGroup(group);
    return out;
  }

  /** Ghi hàng loạt cho một nhóm; bất kỳ mục nào không hợp lệ hoặc chạm vào mục env bị khóa đều từ chối toàn bộ, không để lại cập nhật dở dang. */
  patchGroup(group: SettingGroup, values: Record<string, unknown>): Record<string, SettingFieldView> {
    const defs = FIELD_DEFS[group];
    if (defs === undefined) throw ApiError.badRequest(`未知的设置分组：${group}`, 'group');
    const byField = new Map(defs.map((d) => [d.field, d]));

    for (const field of Object.keys(values)) {
      const def = byField.get(field);
      if (def === undefined) {
        throw ApiError.badRequest(`未知的设置项：${group}.${field}`, field);
      }
      if (this.#envKeysPresent.has(def.envVar)) {
        throw ApiError.forbidden(
          `${group}.${field} 由环境变量 ${def.envVar} 显式设置，容器编排是唯一真源，不能通过管理界面修改`,
        );
      }
      const value = values[field];
      const typeError = validateType(def.type, value);
      const semanticError = typeError === null ? (def.validate?.(value) ?? null) : null;
      const error = typeError ?? semanticError;
      if (error !== null) throw ApiError.badRequest(error, field);
    }

    // Kiểm tra tất cả đều hợp lệ rồi mới ghi DB, tránh việc một nửa ghi được một nửa báo lỗi
    for (const field of Object.keys(values)) {
      const def = byField.get(field);
      if (def === undefined) continue;
      this.#repo.set(`${group}.${field}`, JSON.stringify(values[field]));
      if (!def.requiresRestart) this.#applyHot(group, def, values[field]);
    }

    // Tự động hết hạn debug (§15.3): Chỉ khi lần PATCH này thực sự thay đổi log_privacy_mode mới
    // tính toán lại / xóa bỏ, tránh việc mỗi lần đổi mục log khác (như log_level) đều kích hoạt nhầm
    if (group === 'logging' && Object.prototype.hasOwnProperty.call(values, 'log_privacy_mode')) {
      this.#syncDebugExpiry(values.log_privacy_mode as LogPrivacyMode);
    }
    return this.getGroup(group);
  }

  /**
   * Kiểm tra hết hạn debug (tương ứng kế hoạch triển khai §15.3): Sau khi hết hạn tự động khôi phục strict, xóa bỏ
   * thời gian hết hạn, ghi một dòng nhật ký kiểm toán. Thiết kế để MaintenanceScheduler gọi định kỳ, không cần
   * tạo thêm một timer riêng; giá trị trả về là lần này có phát sinh hành động khôi phục hay không (0 hoặc 1),
   * khớp với quy ước run() của các job bảo trì khác, phục vụ hiển thị "số bản ghi đã xử lý" trong trạng thái lập lịch.
   */
  enforceDebugExpiry(now = Date.now()): number {
    const row = this.#repo.get('logging.debug_expires_at');
    if (row === undefined) return 0;
    const expiresAt = safeParse(row.value);
    if (typeof expiresAt !== 'number' || now < expiresAt) return 0;

    this.#repo.delete('logging.debug_expires_at');
    // Biến môi trường khóa rõ ràng LOG_PRIVACY_MODE thì không động vào giá trị của nó — trong điều kiện bình thường điều này không xảy ra
    // (giai đoạn kiểm tra patchGroup sẽ từ chối đổi mục khóa env thành 'debug'), chỉ khi khởi động lại
    // cơ chế sẵn có "các thay đổi lịch sử trong bảng settings được tổng hợp thành một lớp ghi đè env" (xem
    // reloadConfigWithSettings trong server.ts) có thể khiến nó bị phán đoán nhầm là
    // khóa bởi env sau khi khởi động lại; trong trường hợp biên này chỉ xóa thời gian hết hạn, không báo giả "đã khôi phục strict"
    if (!this.#envKeysPresent.has('LOG_PRIVACY_MODE')) {
      this.#repo.set('logging.log_privacy_mode', JSON.stringify('strict'), now);
      this.#privacyMode?.set('strict');
      this.#auditLogs?.record(
        { actor: 'system', action: 'settings.log_privacy_mode.debug_expired', detail: { restored_to: 'strict' } },
        now,
      );
      this.#logger.info('debug 日志隐私模式已到期，自动恢复 strict');
    } else {
      this.#logger.warn(
        'debug 日志隐私模式已到期，但 LOG_PRIVACY_MODE 当前被环境变量锁定，跳过恢复',
      );
    }
    return 1;
  }

  /**
   * Khi chuyển sang debug, tính toán thời gian hết hạn theo TTL đã cấu hình và lưu DB; khi chuyển về chế độ khác thì xóa
   * thời gian hết hạn, không để lại trạng thái lơ lửng (bản ghi cũ "đã không còn là debug nữa nhưng vẫn còn thời gian hết hạn tương lai"
   * sẽ gây hiểu lầm cho giao diện quản trị).
   */
  #syncDebugExpiry(mode: LogPrivacyMode, now = Date.now()): void {
    if (mode === 'debug') {
      const expiresAt = now + this.#config.logPrivacyDebugTtlMs;
      this.#repo.set('logging.debug_expires_at', JSON.stringify(expiresAt), now);
    } else {
      this.#repo.delete('logging.debug_expires_at');
    }
  }

  #debugExpiresAtView(): SettingFieldView {
    const row = this.#repo.get('logging.debug_expires_at');
    const raw = row === undefined ? null : safeParse(row.value);
    const value = typeof raw === 'number' ? raw : null;
    return { value, source: value === null ? 'default' : 'db', editable: false, requires_restart: false };
  }

  /** Dùng cho /admin/overview: Các mục cấu hình đã thay đổi nhưng phải đợi khởi động lại mới có hiệu lực (biểu thị bằng tên biến môi trường). */
  pendingRestartEnvVars(): string[] {
    const names: string[] = [];
    for (const group of SETTING_GROUPS) {
      for (const def of FIELD_DEFS[group]) {
        if (!def.requiresRestart) continue;
        if (this.#envKeysPresent.has(def.envVar)) continue; // env là nguồn chân lý duy nhất, không có khái niệm "chờ hiệu lực"
        const row = this.#repo.get(`${group}.${def.field}`);
        if (row === undefined) continue;
        const stored = safeParse(row.value);
        const active = def.readConfig(this.#config);
        if (!deepEqual(stored, active)) names.push(def.envVar);
      }
    }
    return names;
  }

  #view(group: SettingGroup, def: FieldDef): SettingFieldView {
    if (this.#envKeysPresent.has(def.envVar)) {
      return {
        value: def.readConfig(this.#config),
        source: 'env',
        editable: false,
        requires_restart: def.requiresRestart,
      };
    }
    const row = this.#repo.get(`${group}.${def.field}`);
    if (row !== undefined) {
      return { value: safeParse(row.value), source: 'db', editable: true, requires_restart: def.requiresRestart };
    }
    return {
      value: def.readConfig(this.#config),
      source: 'default',
      editable: true,
      requires_restart: def.requiresRestart,
    };
  }

  /**
   * Các mục hiệu lực nóng: `logging.log_level` (level của pino có thể sửa đổi tại runtime) và
   * `logging.log_privacy_mode` (debug tự động hết hạn phải lập tức siết chặt, xem
   * observability/privacyMode.ts).
   */
  #applyHot(group: SettingGroup, def: FieldDef, value: unknown): void {
    if (group !== 'logging') return;
    if (def.field === 'log_level' && typeof value === 'string') {
      this.#logger.level = value;
    }
    if (def.field === 'log_privacy_mode' && typeof value === 'string') {
      this.#privacyMode?.set(value as LogPrivacyMode);
    }
  }
}

function toEnvString(type: SettingValueType, value: unknown): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : null;
    case 'number':
      return typeof value === 'number' ? String(value) : null;
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : null;
    case 'string_list':
      return Array.isArray(value) ? value.join(' ') : null;
    default:
      return null;
  }
}

/**
 * Tổng hợp các thay đổi lịch sử "cần khởi động lại mới có hiệu lực" trong bảng settings thành một lớp ghi đè env, để `server.ts`
 * chạy lại `loadConfig()` ở lần khởi động kế tiếp. Các mục đã thiết lập rõ ràng qua biến môi trường sẽ không bao giờ bị ghi đè.
 */
export function buildEnvOverridesFromSettings(
  repo: SettingsRepository,
  envKeysPresent: ReadonlySet<string>,
): RawEnv {
  const overrides: RawEnv = {};
  for (const group of SETTING_GROUPS) {
    for (const def of FIELD_DEFS[group]) {
      if (envKeysPresent.has(def.envVar)) continue;
      const row = repo.get(`${group}.${def.field}`);
      if (row === undefined) continue;
      const str = toEnvString(def.type, safeParse(row.value));
      if (str !== null) overrides[def.envVar] = str;
    }
  }
  return overrides;
}
