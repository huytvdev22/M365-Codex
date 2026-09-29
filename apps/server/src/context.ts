import type { Logger } from 'pino';
import type { AppConfig } from './config/index.js';
import { BackupService } from './backup/service.js';
import { BackupStore } from './backup/store.js';
import { Cryptor } from './crypto/index.js';
import { hashPassword } from './crypto/password.js';
import type { Database } from './db/index.js';
import { selectCodec } from './adapter/codecV1.js';
import type { ProtocolCodec } from './adapter/protocol.js';
import { HttpOAuthClient, type OAuthClient } from './oauth/client.js';
import { OAuthService } from './oauth/service.js';
import { TokenManager } from './oauth/tokenManager.js';
import { AccountRepository } from './repo/accounts.js';
import { AccountPool } from './scheduler/accountPool.js';
import { UpstreamDispatcher } from './scheduler/dispatcher.js';
import { defaultProxyChecker, type ProxyChecker } from './scheduler/proxyHealth.js';
import { AdminSessionRepository } from './repo/adminSessions.js';
import { ApiKeyRepository } from './repo/apiKeys.js';
import { AuditLogRepository } from './repo/auditLogs.js';
import { FileRepository, UploadRepository } from './repo/files.js';
import { OAuthSessionRepository } from './repo/oauthSessions.js';
import { ProxyNodeRepository } from './repo/proxyNodes.js';
import { ResponseRepository } from './repo/responses.js';
import { SettingsRepository } from './repo/settings.js';
import { ToolCallRepository } from './repo/toolCalls.js';
import { FilesService } from './files/service.js';
import { cleanupExpiredFiles, cleanupExpiredUploads } from './files/cleanup.js';
import { FileStorage } from './files/storage.js';
import { IdempotencyStore } from './gateway/idempotency.js';
import { RateLimiter } from './gateway/rateLimit.js';
import { MaintenanceScheduler } from './maintenance/scheduler.js';
import { Metrics } from './observability/metrics.js';
import { PrivacyModeHolder } from './observability/privacyMode.js';
import { InFlightRegistry } from './responses/inFlight.js';
import { ResponsesService } from './responses/service.js';
import { SettingsService } from './settings/service.js';
import { APP_VERSION } from './version.js';

/**
 * Ngữ cảnh thực thi (Runtime Context): Truyền tập trung cấu hình, cơ sở dữ liệu, bộ mã hóa, logger và các dịch vụ,
 * giúp dễ dàng inject in-memory database, logger yên lặng và mock upstream trong kiểm thử.
 */
export interface AppContext {
  readonly config: AppConfig;
  readonly db: Database;
  readonly cryptor: Cryptor;
  readonly logger: Logger;
  readonly adminPasswordHash: string;
  readonly apiKeys: ApiKeyRepository;
  readonly adminSessions: AdminSessionRepository;
  readonly auditLogs: AuditLogRepository;
  readonly accounts: AccountRepository;
  readonly oauthSessions: OAuthSessionRepository;
  readonly oauthClient: OAuthClient;
  readonly oauth: OAuthService;
  readonly tokens: TokenManager;
  readonly codec: ProtocolCodec;
  readonly pool: AccountPool;
  readonly dispatcher: UpstreamDispatcher;
  readonly responses: ResponsesService;
  readonly responseRepo: ResponseRepository;
  readonly toolCalls: ToolCallRepository;
  readonly inFlight: InFlightRegistry;
  readonly fileRepo: FileRepository;
  readonly uploadRepo: UploadRepository;
  readonly fileStorage: FileStorage;
  readonly files: FilesService;
  /** M7: Tính bất biến / Idempotency yêu cầu (§18), tích hợp vào /v1/responses và /v1/chat/completions */
  readonly idempotency: IdempotencyStore;
  /** M7: Giới hạn mức API Key (§10), đếm trong tiến trình, điều kiện tiên quyết đơn container */
  readonly rateLimiter: RateLimiter;
  /** M7: Nhóm proxy outbound (§13.1) */
  readonly proxyNodes: ProxyNodeRepository;
  /** M7: Kiểm tra sức khỏe proxy, có thể inject mock implementation khi kiểm thử */
  readonly proxyChecker: ProxyChecker;
  /** M7: Đọc/ghi cài đặt (Hợp đồng §2.3) */
  readonly settingsRepo: SettingsRepository;
  readonly settings: SettingsService;
  /** Chế độ bảo mật log hiện đang có hiệu lực; chuyển đổi động log_privacy_mode (gồm tự hết hạn debug) đều cập nhật tại đây */
  readonly privacyMode: PrivacyModeHolder;
  /** M7: Lập lịch tác vụ dọn dẹp định kỳ (§18), đã đăng ký sẵn các job dọn dẹp, chưa start (do server.ts quyết định thời điểm bật) */
  readonly scheduler: MaintenanceScheduler;
  /** Bảng đăng ký metrics, tích hợp GET /metrics (M8, §17) */
  readonly metrics: Metrics;
  /** M8: Tạo / khôi phục gói sao lưu (§15.4) */
  readonly backup: BackupService;
  /** M8: Lưu trữ và dọn dẹp gói sao lưu trên ổ đĩa (Hợp đồng §3) */
  readonly backupStore: BackupStore;
  readonly startedAt: number;
}

export interface CreateContextOptions {
  config: AppConfig;
  db: Database;
  logger: Logger;
  startedAt?: number;
  /** Inject mock upstream, dùng cho integration test; nếu không truyền thì dùng HTTP thật */
  oauthClient?: OAuthClient;
  /** Inject bộ kiểm tra sức khỏe proxy giả lập, dùng cho test; nếu không truyền thì dò quét TCP thật */
  proxyChecker?: ProxyChecker;
}

export function createContext(options: CreateContextOptions): AppContext {
  const { config, db, logger } = options;
  const cryptor = new Cryptor(config.masterKey, config.masterKeyVersion);
  // Khởi tạo sớm: Ba tầng tài khoản / Token / điều phối đều cần gắn metrics (§17), truyền vào ngay khi khởi tạo,
  // không cần bọc thêm một lớp wrapper sau này
  const metrics = new Metrics();

  const accounts = new AccountRepository(db, cryptor, metrics);
  const oauthSessions = new OAuthSessionRepository(db, cryptor);
  const proxyNodes = new ProxyNodeRepository(db, cryptor);
  const oauthClient =
    options.oauthClient ??
    new HttpOAuthClient({
      config: config.oauth,
      proxyUrl: config.httpsProxy ?? config.httpProxy,
      noProxy: config.noProxy,
    });

  // Khi tài khoản gắn proxy outbound chuyên dụng (§13.1), làm mới Token và kết nối dài upstream đều đi qua outbound này,
  // duy trì tính bám dính (sticky); khi node không tồn tại hoặc bị vô hiệu hóa sẽ fallback về proxy mặc định toàn cục
  const resolveProxyForAccount = (accountId: string): string | null => {
    const account = accounts.findById(accountId);
    if (account?.proxy_node_id == null) return null;
    return proxyNodes.resolveActiveUrl(account.proxy_node_id);
  };

  const tokens = new TokenManager({ accounts, client: oauthClient, logger, resolveProxyForAccount, metrics });
  const codec = selectCodec(config.upstream.protocolVersion);
  const pool = new AccountPool(accounts);
  const dispatcher = new UpstreamDispatcher({
    config: config.upstream,
    codec,
    accounts,
    pool,
    tokens,
    logger,
    proxyUrl: config.httpsProxy ?? config.httpProxy,
    noProxy: config.noProxy,
    resolveProxyForAccount,
    metrics,
  });
  const responseRepo = new ResponseRepository(db);
  const toolCallRepo = new ToolCallRepository(db);
  const fileRepo = new FileRepository(db);
  const uploadRepo = new UploadRepository(db);
  const fileStorage = new FileStorage(config.dataDir);
  const filesService = new FilesService({ files: fileRepo, storage: fileStorage, config: config.files });
  const responsesService = new ResponsesService({
    dispatcher,
    responses: responseRepo,
    toolCalls: toolCallRepo,
    tools: config.tools,
    logger,
    // M6 thêm mới: input_file lấy văn bản theo file-id, input_image quyết định cho qua theo cấu hình
    files: filesService,
    upstreamImageInput: config.upstreamImageInput,
    contextMaxChars: config.contextMaxChars,
    metrics,
  });
  const inFlight = new InFlightRegistry();

  const adminSessions = new AdminSessionRepository(db);
  const auditLogs = new AuditLogRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const privacyMode = new PrivacyModeHolder(config.logPrivacyMode);
  const idempotency = new IdempotencyStore(db);
  const backupService = new BackupService({
    db,
    dataDir: config.dataDir,
    appVersion: APP_VERSION,
    masterKeyVersion: config.masterKeyVersion,
  });
  const backupStore = new BackupStore(config.dataDir);
  const settingsService = new SettingsService({ repo: settingsRepo, config, logger, privacyMode, auditLogs });

  const scheduler = new MaintenanceScheduler(logger);
  registerMaintenanceJobs(scheduler, {
    config,
    accounts,
    oauthSessions,
    adminSessions,
    auditLogs,
    idempotency,
    responseRepo,
    fileRepo,
    uploadRepo,
    fileStorage,
    backupStore,
    settings: settingsService,
  });

  return {
    config,
    db,
    cryptor,
    logger,
    adminPasswordHash: hashPassword(config.adminPassword),
    apiKeys: new ApiKeyRepository(db),
    adminSessions,
    auditLogs,
    accounts,
    oauthSessions,
    oauthClient,
    oauth: new OAuthService({ config: config.oauth, client: oauthClient, sessions: oauthSessions, accounts }),
    tokens,
    codec,
    pool,
    dispatcher,
    responses: responsesService,
    responseRepo,
    toolCalls: toolCallRepo,
    inFlight,
    fileRepo,
    uploadRepo,
    fileStorage,
    files: filesService,
    idempotency,
    rateLimiter: new RateLimiter(config.rateLimit),
    proxyNodes,
    proxyChecker: options.proxyChecker ?? defaultProxyChecker,
    settingsRepo,
    settings: settingsService,
    privacyMode,
    scheduler,
    metrics,
    backup: backupService,
    backupStore,
    startedAt: options.startedAt ?? Date.now(),
  };
}

/**
 * Đăng ký tất cả các tác vụ dọn dẹp định kỳ (tương ứng với Kế hoạch thực hiện §18). Chỉ đăng ký, không start —
 * việc khởi động timer do `server.ts` quyết định (khi test dùng `createContext` không muốn timer ngầm tự động chạy).
 */
function registerMaintenanceJobs(
  scheduler: MaintenanceScheduler,
  deps: {
    config: AppConfig;
    accounts: AccountRepository;
    oauthSessions: OAuthSessionRepository;
    adminSessions: AdminSessionRepository;
    auditLogs: AuditLogRepository;
    idempotency: IdempotencyStore;
    responseRepo: ResponseRepository;
    fileRepo: FileRepository;
    uploadRepo: UploadRepository;
    fileStorage: FileStorage;
    backupStore: BackupStore;
    settings: SettingsService;
  },
): void {
  const interval = deps.config.cleanup.intervalMs;

  scheduler.register({
    // Kiểm tra hết hạn chế độ riêng tư debug log (§15.3): Tái sử dụng chu kỳ lịch chung của tác vụ dọn dẹp,
    // không cần thêm cấu hình riêng — độ chi tiết hết hạn đến phút không có ý nghĩa thực tế
    name: 'log_privacy_debug_expiry',
    intervalMs: interval,
    run: () => deps.settings.enforceDebugExpiry(),
  });
  scheduler.register({
    name: 'oauth_sessions_cleanup',
    intervalMs: interval,
    run: () => deps.oauthSessions.purge(),
  });
  scheduler.register({
    name: 'admin_sessions_cleanup',
    intervalMs: interval,
    run: () => deps.adminSessions.purgeExpired(),
  });
  scheduler.register({
    name: 'files_cleanup',
    intervalMs: interval,
    run: () =>
      cleanupExpiredFiles({ files: deps.fileRepo, uploads: deps.uploadRepo, storage: deps.fileStorage }),
  });
  scheduler.register({
    name: 'uploads_cleanup',
    intervalMs: interval,
    run: () =>
      cleanupExpiredUploads({ files: deps.fileRepo, uploads: deps.uploadRepo, storage: deps.fileStorage }),
  });
  scheduler.register({
    name: 'responses_cleanup',
    intervalMs: interval,
    // Xóa theo tầng tool_calls và conversation_bindings (khóa ngoại ON DELETE CASCADE),
    // vì vậy "Response hết hạn" và "bản ghi yêu cầu quá hạn" là cùng một việc, không cần tách tác vụ
    run: () => deps.responseRepo.purgeFinishedOlderThan(Date.now() - deps.config.cleanup.responseRetentionMs),
  });
  scheduler.register({
    name: 'stale_conversation_bindings_cleanup',
    intervalMs: interval,
    run: () => deps.responseRepo.purgeStaleBindings(),
  });
  scheduler.register({
    name: 'audit_logs_cleanup',
    intervalMs: interval,
    run: () => deps.auditLogs.purgeOlderThan(Date.now() - deps.config.cleanup.auditLogRetentionMs),
  });
  scheduler.register({
    name: 'idempotency_keys_cleanup',
    intervalMs: interval,
    run: () => deps.idempotency.purgeOlderThan(Date.now() - deps.config.cleanup.idempotencyRetentionMs),
  });
  scheduler.register({
    name: 'backups_cleanup',
    intervalMs: interval,
    // Chỉ giữ lại N bản gần nhất (§15.4), các bản cũ xóa trực tiếp tệp — file sao lưu không lưu trong CSDL,
    // không lo ngại vấn đề "xóa tầng (cascade)"
    run: () => deps.backupStore.prune(deps.config.backup.retentionCount),
  });
}
