import type { AdminApi } from './adminApi';
import {
  ApiRequestError,
  type AccountStatus,
  type AccountView,
  type ApiKeyCreated,
  type ApiKeyView,
  type AuditLogEntry,
  type BackupInfo,
  type CreateApiKeyRequest,
  type CreateProxyRequest,
  type DiagnosticsReport,
  type FileListItem,
  type OverviewResponse,
  type ProxyView,
  type RequestDetail,
  type RequestListItem,
  type RestoreResult,
  type SettingsResponse,
  type UpdateApiKeyRequest,
} from './types';

/**
 * Dữ liệu giả lập trong giai đoạn phát triển (kích hoạt khi `VITE_USE_MOCK=1`), dùng để chạy UI độc lập trước khi server hoàn thiện.
 * Mọi dữ liệu đều là hư cấu: tên miền dùng *.example.invalid, không chứa thông tin nhạy cảm thật.
 */

const LATENCY_MS = 260;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

function notFound(message: string): never {
  throw new ApiRequestError(404, {
    error: { type: 'not_found_error', message, param: null, request_id: `mock_${Date.now()}` },
  });
}

// ---- Dữ liệu trong bộ nhớ ----

let accounts: AccountView[] = [
  {
    id: 'acc_1',
    tid: 'tid-aaaa',
    oid: 'oid-1111',
    email: 'demo.user1@tenant.example.invalid',
    display_name: 'Tài khoản demo 1',
    status: 'online',
    source: 'oauth_pkce',
    created_at: Date.now() - 86_400_000 * 10,
    updated_at: Date.now() - 3_600_000,
    token_expires_at: Date.now() + 3_600_000,
    token_rotated_at: Date.now() - 3_600_000,
    has_refresh_token: true,
    consecutive_failures: 0,
    cooldown_until: null,
    last_ok_at: Date.now() - 60_000,
    last_error_type: null,
    proxy_id: null,
  },
  {
    id: 'acc_2',
    tid: 'tid-bbbb',
    oid: 'oid-2222',
    email: 'demo.user2@tenant.example.invalid',
    display_name: 'Tài khoản demo 2',
    status: 'cooldown',
    source: 'oauth_pkce',
    created_at: Date.now() - 86_400_000 * 5,
    updated_at: Date.now() - 600_000,
    token_expires_at: Date.now() + 1_800_000,
    token_rotated_at: Date.now() - 1_800_000,
    has_refresh_token: true,
    consecutive_failures: 3,
    cooldown_until: Date.now() + 300_000,
    last_ok_at: Date.now() - 900_000,
    last_error_type: 'rate_limited',
    proxy_id: 'proxy_1',
  },
  {
    id: 'acc_3',
    tid: 'tid-cccc',
    oid: 'oid-3333',
    email: 'demo.user3@tenant.example.invalid',
    display_name: 'Tài khoản demo 3',
    status: 'reauth_required',
    source: 'oauth_pkce',
    created_at: Date.now() - 86_400_000 * 20,
    updated_at: Date.now() - 7_200_000,
    token_expires_at: null,
    token_rotated_at: null,
    has_refresh_token: false,
    consecutive_failures: 5,
    cooldown_until: null,
    last_ok_at: Date.now() - 86_400_000,
    last_error_type: 'invalid_grant',
    proxy_id: null,
  },
];

let apiKeys: ApiKeyView[] = [
  {
    id: 'key_1',
    name: 'Phát triển hàng ngày',
    masked_key: 'sk-Ab12************************wxYZ',
    enabled: true,
    created_at: Date.now() - 86_400_000 * 30,
    starts_at: null,
    expires_at: null,
    revoked_at: null,
    last_used_at: Date.now() - 120_000,
    rpm_limit: 60,
    daily_limit: 5000,
    max_concurrency: 4,
    allowed_endpoints: null,
    allowed_models: null,
  },
];

const proxies: ProxyView[] = [
  {
    id: 'proxy_1',
    name: 'Node egress-A',
    url_masked: 'socks5://***:***@198.51.100.10:1080',
    protocol: 'socks5',
    enabled: true,
    weight: 10,
    priority: 1,
    status: 'healthy',
    latency_ms: 82,
    last_check_at: Date.now() - 60_000,
    failure_count: 0,
    cooldown_until: null,
    bound_accounts: ['acc_2'],
  },
];

const files: FileListItem[] = [
  {
    id: 'file_1',
    filename: 'design-notes.pdf',
    mime_type: 'application/pdf',
    kind: 'document',
    bytes: 245_760,
    status: 'ready',
    api_key_id: 'key_1',
    created_at: Date.now() - 3_600_000,
    expires_at: Date.now() + 86_400_000,
  },
];

const REQUEST_STATUS_CYCLE = ['completed', 'completed', 'failed', 'in_progress'] as const;

const requests: RequestListItem[] = Array.from({ length: 8 }, (_, i) => ({
  id: `resp_${i + 1}`,
  status: REQUEST_STATUS_CYCLE[i % REQUEST_STATUS_CYCLE.length] ?? 'completed',
  requested_model: i % 2 === 0 ? 'gpt-5-codex' : 'gpt-5',
  requested_reasoning_effort: i % 2 === 0 ? 'high' : null,
  api_key_id: 'key_1',
  account_id: `acc_${(i % 3) + 1}`,
  tool_round: i % 3,
  tool_calls_total: i % 3,
  created_at: Date.now() - i * 600_000,
  updated_at: Date.now() - i * 500_000,
  error_message: i % 4 === 2 ? 'Upstream trả về 502' : null,
}));

let settings: SettingsResponse = {
  network: {
    public_api_base_url: { value: 'http://192.168.0.5:8080/v1', source: 'db', editable: true, requires_restart: true },
    public_admin_url: { value: 'http://192.168.0.5:8080/admin', source: 'db', editable: true, requires_restart: true },
    trust_proxy: { value: false, source: 'default', editable: true, requires_restart: true },
    http_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
    https_proxy: { value: '', source: 'default', editable: true, requires_restart: true },
    no_proxy: { value: '', source: 'env', editable: false, requires_restart: true },
  },
  scheduler: {
    cleanup_interval_ms: { value: 300_000, source: 'default', editable: true, requires_restart: true },
    response_retention_ms: { value: 604_800_000, source: 'default', editable: true, requires_restart: true },
    audit_log_retention_ms: { value: 2_592_000_000, source: 'default', editable: true, requires_restart: true },
    idempotency_retention_ms: { value: 86_400_000, source: 'default', editable: true, requires_restart: true },
    files_retention_ms: { value: 259_200_000, source: 'default', editable: true, requires_restart: true },
    files_upload_ttl_ms: { value: 3_600_000, source: 'default', editable: true, requires_restart: true },
  },
  logging: {
    log_level: { value: 'info', source: 'default', editable: true, requires_restart: false },
    log_privacy_mode: { value: 'strict', source: 'default', editable: true, requires_restart: true },
  },
  oauth: {
    client_id: { value: 'c0ab8ce9-0000-0000-0000-33d422df41f1', source: 'env', editable: false, requires_restart: true },
    redirect_uri: { value: 'https://login.microsoftonline.com/common/oauth2/nativeclient', source: 'default', editable: true, requires_restart: true },
    authorize_url: { value: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', source: 'default', editable: true, requires_restart: true },
    token_url: { value: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', source: 'default', editable: true, requires_restart: true },
    scopes: {
      value: ['sydney/M365Chat.Read', 'sydney/sydney.readwrite', 'offline_access', 'openid', 'profile'],
      source: 'default',
      editable: true,
      requires_restart: true,
    },
  },
  tools: {
    mode: { value: 'auto', source: 'default', editable: true, requires_restart: true },
    max_calls_per_round: { value: 4, source: 'default', editable: true, requires_restart: true },
    max_rounds: { value: 8, source: 'default', editable: true, requires_restart: true },
    max_total_calls: { value: 32, source: 'default', editable: true, requires_restart: true },
    max_result_bytes: { value: 65_536, source: 'default', editable: true, requires_restart: true },
    max_arg_repairs: { value: 2, source: 'default', editable: true, requires_restart: true },
    allow_parallel: { value: true, source: 'default', editable: true, requires_restart: true },
  },
  files: {
    max_file_bytes: { value: 20_971_520, source: 'default', editable: true, requires_restart: true },
    max_request_bytes: { value: 52_428_800, source: 'default', editable: true, requires_restart: true },
    max_total_bytes_per_key: { value: 524_288_000, source: 'default', editable: true, requires_restart: true },
  },
};

const auditLogs: AuditLogEntry[] = [
  { id: 'log_1', actor: 'admin', action: 'admin.login.success', created_at: Date.now() - 500_000 },
  { id: 'log_2', actor: 'admin', action: 'api_key.create', target: 'key_1', created_at: Date.now() - 400_000 },
];

let requestIdSeq = 100;

let backups: BackupInfo[] = [];
let backupSeq = 1;

function makeBackupId(): string {
  const seq = (backupSeq++).toString(16).padStart(8, '0');
  return `bkp_${Date.now()}_${seq}`;
}

export const mockAdminApi: AdminApi = {
  login: (password) => {
    if (password.trim().length === 0) {
      throw new ApiRequestError(401, {
        error: { type: 'authentication_error', message: 'Mật khẩu quản trị không đúng', param: null, request_id: `mock_${requestIdSeq++}` },
      });
    }
    return delay({ token: 'mock-session-token', expires_at: Date.now() + 3_600_000 });
  },
  logout: () => delay(undefined),
  getSession: () =>
    delay({
      created_at: Date.now() - 60_000,
      expires_at: Date.now() + 3_600_000,
      public_api_base_url: 'http://192.168.0.5:8080/v1',
      public_admin_url: 'http://192.168.0.5:8080/admin',
    }),

  getOverview: () =>
    delay<OverviewResponse>({
      system_status: 'normal',
      version: '0.7.0-mock',
      uptime_ms: 3_723_000,
      accounts: { total: accounts.length, online: 1, cooldown: 1, reauth_required: 1, disabled: 0 },
      requests: { in_flight: 1, last_hour: 42, failed_last_hour: 2 },
      tools: { calls_last_hour: 7, arg_pass_rate: 0.93 },
      upstream: { protocol_version: 'sydney-json-v1', ws_base: 'wss://substrate.office.com', image_input: false },
      storage: { db_bytes: 1_048_576, files_bytes: 2_097_152, files_count: files.length },
      public_api_base_url: 'http://192.168.0.5:8080/v1',
      pending_restart: ['PORT'],
    }),

  listAccounts: () => delay([...accounts]),
  getAccount: (id) => {
    const found = accounts.find((a) => a.id === id);
    if (found === undefined) notFound('Tài khoản không tồn tại');
    return delay(found);
  },
  setAccountStatus: (id, status: AccountStatus) => {
    const found = accounts.find((a) => a.id === id);
    if (found === undefined) notFound('Tài khoản không tồn tại');
    found.status = status;
    found.updated_at = Date.now();
    return delay(found);
  },
  refreshAccount: (id) => {
    const found = accounts.find((a) => a.id === id);
    if (found === undefined) notFound('Tài khoản không tồn tại');
    found.token_rotated_at = Date.now();
    found.token_expires_at = Date.now() + 3_600_000;
    return delay(found);
  },
  deleteAccount: (id) => {
    accounts = accounts.filter((a) => a.id !== id);
    return delay(undefined);
  },
  bindAccountProxy: (id, proxyId) => {
    const found = accounts.find((a) => a.id === id);
    if (found === undefined) notFound('Tài khoản không tồn tại');
    found.proxy_id = proxyId;
    return delay(found);
  },

  createAuthorizeUrl: () =>
    delay({
      authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?mock=1',
      state: 'mock-state-value',
      expires_at: Date.now() + 600_000,
    }),
  submitOAuthCallback: () => {
    const created: AccountView = {
      id: `acc_${accounts.length + 1}`,
      tid: 'tid-new',
      oid: 'oid-new',
      email: 'new.user@tenant.example.invalid',
      display_name: 'Tài khoản mới ủy quyền',
      status: 'probing',
      source: 'oauth_pkce',
      created_at: Date.now(),
      updated_at: Date.now(),
      token_expires_at: Date.now() + 3_600_000,
      token_rotated_at: Date.now(),
      has_refresh_token: true,
      consecutive_failures: 0,
      cooldown_until: null,
      last_ok_at: null,
      last_error_type: null,
      proxy_id: null,
    };
    accounts = [...accounts, created];
    return delay({ account: created, existing: false });
  },
  getOAuthSessions: () => delay({ pending: 0 }),

  listRequests: ({ limit }) => delay({ items: requests.slice(0, limit ?? requests.length), total: requests.length }),
  getRequest: (id) => {
    const found = requests.find((r) => r.id === id);
    if (found === undefined) notFound('Yêu cầu không tồn tại');
    const detail: RequestDetail = { ...found, tool_calls: [] };
    return delay(detail);
  },

  listApiKeys: () => delay([...apiKeys]),
  createApiKey: (payload: CreateApiKeyRequest) => {
    const id = `key_${apiKeys.length + 1}`;
    const plaintext = `sk-${cryptoRandom()}`;
    const created: ApiKeyCreated = {
      id,
      name: payload.name,
      masked_key: maskKey(plaintext),
      enabled: true,
      created_at: Date.now(),
      starts_at: payload.starts_at ?? null,
      expires_at: payload.expires_at ?? null,
      revoked_at: null,
      last_used_at: null,
      rpm_limit: payload.rpm_limit ?? null,
      daily_limit: payload.daily_limit ?? null,
      max_concurrency: payload.max_concurrency ?? null,
      allowed_endpoints: payload.allowed_endpoints ?? null,
      allowed_models: payload.allowed_models ?? null,
      key: plaintext,
    };
    apiKeys = [...apiKeys, created];
    return delay(created);
  },
  updateApiKey: (id, payload: UpdateApiKeyRequest) => {
    const found = apiKeys.find((k) => k.id === id);
    if (found === undefined) notFound('API Key không tồn tại');
    Object.assign(found, payload);
    return delay(found);
  },
  revokeApiKey: (id) => {
    const found = apiKeys.find((k) => k.id === id);
    if (found === undefined) notFound('API Key không tồn tại');
    found.enabled = false;
    found.revoked_at = Date.now();
    return delay(found);
  },

  getCapabilities: () =>
    delay({
      models: [
        { id: 'gpt-5-codex', source: 'upstream' },
        { id: 'gpt-5', source: 'upstream' },
      ],
      matrix: [
        { feature: 'tool_calls', status: 'native', detail: 'Kênh đôi khai báo công cụ gốc và prompt dự phòng' },
        { feature: 'image_input', status: 'upstream_decided', detail: 'Phụ thuộc vào kết quả probe M0' },
        { feature: 'parallel_tool_calls', status: 'experimental', detail: 'Chưa được kiểm chứng trên upstream thực tế' },
        { feature: 'embeddings', status: 'unsupported', detail: 'Phụ thuộc backend OpenAI, dự án này không hỗ trợ' },
      ],
    }),

  listFiles: ({ limit }) => delay({ items: files.slice(0, limit ?? files.length), total_bytes: 2_097_152 }),
  deleteFile: () => delay(undefined),
  cleanupFiles: () => delay({ deleted_files: 0, deleted_uploads: 0, freed_bytes: 0 }),

  listProxies: () => delay([...proxies]),
  createProxy: (payload: CreateProxyRequest) => {
    const created: ProxyView = {
      id: `proxy_${proxies.length + 1}`,
      name: payload.name,
      url_masked: maskProxyUrl(payload.url),
      protocol: guessProtocol(payload.url),
      enabled: payload.enabled,
      weight: payload.weight,
      priority: payload.priority,
      status: 'unknown',
      latency_ms: null,
      last_check_at: null,
      failure_count: 0,
      cooldown_until: null,
      bound_accounts: [],
    };
    proxies.push(created);
    return delay(created);
  },
  bulkImportProxies: (payload) => {
    const lines = payload.urls.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const results = lines.map((line) => ({ line, ok: true, id: `proxy_${proxies.length + 1}` }));
    return delay({ created: lines.length, failed: 0, results });
  },
  updateProxy: (id, payload) => {
    const found = proxies.find((p) => p.id === id);
    if (found === undefined) notFound('Proxy không tồn tại');
    if (payload.name !== undefined) found.name = payload.name;
    if (payload.weight !== undefined) found.weight = payload.weight;
    if (payload.priority !== undefined) found.priority = payload.priority;
    if (payload.enabled !== undefined) found.enabled = payload.enabled;
    return delay(found);
  },
  deleteProxy: (id) => {
    const idx = proxies.findIndex((p) => p.id === id);
    if (idx >= 0) proxies.splice(idx, 1);
    return delay(undefined);
  },
  checkProxy: () => delay({ ok: true, latency_ms: 76, detail: 'Kết nối bình thường' }),

  getSettings: () => delay(settings),
  updateSettings: (group, values) => {
    const groupSettings = settings[group] as unknown as Record<
      string,
      { value: unknown; source: string; editable: boolean; requires_restart: boolean }
    >;
    for (const [key, value] of Object.entries(values)) {
      const item = groupSettings[key];
      if (item === undefined) continue;
      if (!item.editable) {
        throw new ApiRequestError(400, {
          error: { type: 'invalid_request_error', message: `${key} hiện được cố định bởi biến môi trường, không thể sửa trên giao diện`, param: key, request_id: `mock_${requestIdSeq++}` },
        });
      }
      item.value = value;
    }
    settings = { ...settings, [group]: groupSettings };
    return delay(settings);
  },

  getCodexConfig: (apiKeyEnv) =>
    delay({
      base_url: 'http://192.168.0.5:8080/v1',
      toml: [
        'model = "gpt-5-codex"',
        'model_reasoning_effort = "high"',
        'model_provider = "m365-codex"',
        '',
        '[model_providers.m365-codex]',
        'name = "M365-Codex (Responses compatible)"',
        'base_url = "http://192.168.0.5:8080/v1"',
        `env_key = "${apiKeyEnv}"`,
        'wire_api = "responses"',
      ].join('\n'),
      notes: [
        'wire_api cố định là "responses": Codex từ tháng 2/2026 chỉ hỗ trợ responses, chat đã bị loại bỏ.',
        `Vui lòng thiết lập khóa sk- vừa tạo vào biến môi trường ${apiKeyEnv} trước khi khởi động Codex.`,
      ],
    }),

  getAuditLogs: (limit) => delay(auditLogs.slice(0, limit ?? auditLogs.length)),

  createBackup: (options) => {
    const includeFiles = options?.includeFiles ?? true;
    const created: BackupInfo = {
      id: makeBackupId(),
      bytes: includeFiles ? 3_251_200 : 1_048_576,
      created_at: Date.now(),
    };
    backups = [created, ...backups];
    return delay(created);
  },
  listBackups: () => delay([...backups]),
  downloadBackup: (id) => {
    const found = backups.find((b) => b.id === id);
    if (found === undefined) notFound('Gói sao lưu không tồn tại');
    return delay(new Blob([`mock-backup:${id}`], { type: 'application/gzip' }));
  },
  restoreBackup: () =>
    delay<RestoreResult>({
      restored: true,
      requires_restart: true,
      message: 'Bản sao lưu đã được kiểm tra và ghi vào thư mục dữ liệu, cần khởi động lại dịch vụ để có hiệu lực',
      manifest: {
        format_version: 1,
        app_version: '0.8.0-mock',
        schema_version: 8,
        master_key_version: 1,
        created_at: Date.now() - 3_600_000,
        includes_files: true,
        file_count: files.length,
      },
    }),
  getDiagnostics: () =>
    delay<DiagnosticsReport>({
      generated_at: Date.now(),
      app_version: '0.8.0-mock',
      system_status: 'normal',
      uptime_ms: 3_723_000,
      schema: { current: 8, expected: 8, ok: true },
      accounts: {
        probing: 0,
        online: 1,
        busy: 0,
        cooldown: 1,
        reauth_required: 1,
        disabled: 0,
        unsupported: 0,
        error: 0,
      },
      accounts_usable: 1,
      in_flight_requests: 1,
      recent_errors: { rate_limited: 2 },
      storage: { db_bytes: 1_048_576, files_bytes: 2_097_152, file_count: files.length },
      maintenance: [{ name: 'files_cleanup', last_run_at: Date.now() - 300_000, last_error: null }],
      readiness: [{ name: 'db', ok: true }],
      config: { log_privacy_mode: 'strict' },
      notes: [],
    }),
};

function maskKey(plaintext: string): string {
  return `${plaintext.slice(0, 6)}${'*'.repeat(24)}${plaintext.slice(-4)}`;
}

function cryptoRandom(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 48; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = parsed.username.length > 0 ? '***:***@' : '';
    return `${parsed.protocol}//${auth}${parsed.hostname}:${parsed.port || '—'}`;
  } catch {
    return '（Định dạng địa chỉ không hợp lệ, từ chối hiển thị dạng văn bản rõ）';
  }
}

function guessProtocol(url: string): ProxyView['protocol'] {
  if (url.startsWith('socks5')) return 'socks5';
  if (url.startsWith('https')) return 'https';
  return 'http';
}
