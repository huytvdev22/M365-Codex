import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, summarizeConfig, type AppConfig } from './config/index.js';
import { createContext, type AppContext } from './context.js';
import { openDatabase, resolveDatabasePath, runMigrations, type Database } from './db/index.js';
import { markInProgressAsIncomplete, recoverOnStartup, SHUTDOWN_INCOMPLETE_REASON } from './maintenance/recovery.js';
import { createLogger } from './observability/logger.js';
import { evaluateReadiness } from './routes/health.js';
import { SettingsRepository } from './repo/settings.js';
import { buildEnvOverridesFromSettings } from './settings/service.js';
import { APP_VERSION } from './version.js';

/**
 * Điểm vào tiến trình: Tải cấu hình → Mở CSDL → Chạy migration → Khởi chạy dịch vụ HTTP.
 * Thoát an toàn khi nhận SIGTERM/SIGINT: dừng nhận request mới trước khi đóng CSDL.
 */

/** Lần đầu tải cấu hình hoàn toàn từ biến môi trường — để lấy dataDir/masterKey mở CSDL. */
function loadConfigOrExit(env: NodeJS.ProcessEnv): AppConfig {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n[M365-Codex] Khởi động thất bại:\n${error.message}\n\nVui lòng tham khảo .env.example để bổ sung cấu hình.\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }
}

/**
 * Lấy các thay đổi lịch sử trong bảng `settings` cần khởi động lại mới có hiệu lực
 * gộp thành lớp ghi đè biến môi trường, tải lại `loadConfig` để cấu hình lưu lần trước
 * qua `/admin/settings` thực sự có hiệu lực. Các mục được đặt trực tiếp qua biến môi trường sẽ không bị ghi đè.
 */
function reloadConfigWithSettings(db: Database, initialConfig: AppConfig): AppConfig {
  const overrides = buildEnvOverridesFromSettings(new SettingsRepository(db), initialConfig.envKeysPresent);
  if (Object.keys(overrides).length === 0) return initialConfig;
  return loadConfigOrExit({ ...process.env, ...overrides });
}

export interface ShutdownDeps {
  context: AppContext;
  app: FastifyInstance;
  db: Database;
  logger: Logger;
}

/**
 * Đóng an toàn (Graceful Shutdown).
 *
 * Thứ tự xử lý:
 * 1. Dừng lịch trình nhiệm vụ định kỳ;
 * 2. Hủy `AbortController` của toàn bộ request đang xử lý — kết thúc sớm kết nối WebSocket/dispatch ngược dòng;
 * 3. Đánh dấu các Response còn `in_progress` thành `incomplete` vào CSDL;
 * 4. Chờ Fastify giải phóng/đóng kết nối HTTP;
 * 5. Đóng cơ sở dữ liệu.
 *
 * Tuyệt đối không tự động phát lại bất kỳ thao tác nào có tác dụng phụ.
 */
export async function gracefulShutdown(deps: ShutdownDeps, signal: string): Promise<void> {
  const { context, app, db, logger } = deps;
  logger.info({ signal }, 'Nhận tín hiệu thoát, bắt đầu đóng an toàn');

  context.scheduler.stop();

  const abortedIds = context.inFlight.cancelAll();
  const markedIncomplete = markInProgressAsIncomplete(context.responseRepo, SHUTDOWN_INCOMPLETE_REASON);
  if (abortedIds.length > 0 || markedIncomplete.length > 0) {
    logger.info(
      { aborted: abortedIds.length, marked_incomplete: markedIncomplete.length },
      'Đã hủy kết nối ngược dòng của các request đang xử lý và lưu bản ghi in_progress thành incomplete',
    );
  }

  await app.close();
  db.close();
  logger.info('Đã hoàn tất đóng an toàn');
}

async function main(): Promise<void> {
  const bootConfig = loadConfigOrExit(process.env);

  const db = openDatabase(resolveDatabasePath(bootConfig.dataDir));
  const migration = runMigrations(db);

  // Sau khi migration chạy xong và bảng settings đọc được, gộp cài đặt đã lưu vào cấu hình
  const config = reloadConfigWithSettings(db, bootConfig);

  const logger = createLogger({
    level: config.logLevel,
    privacyMode: config.logPrivacyMode,
    pretty: process.env.NODE_ENV === 'development',
  });

  logger.info({ version: APP_VERSION, config: summarizeConfig(config) }, 'M365-Codex đang khởi động');
  if (migration.applied.length > 0) {
    logger.info({ applied: migration.applied, schema_version: migration.schemaVersion }, 'Migration CSDL hoàn tất');
  }

  const context = createContext({ config, db, logger });

  const readiness = evaluateReadiness(context);
  if (readiness.status !== 'ready') {
    logger.fatal({ checks: readiness.checks }, 'Kiểm tra readiness không đạt, từ chối khởi động');
    db.close();
    process.exit(78);
  }

  // Khôi phục sau khởi động lại: giữ nguyên queued; đánh dấu in_progress không xác định được tiến độ thành incomplete
  const recovery = recoverOnStartup({ responses: context.responseRepo, logger });
  if (recovery.inProgressMarkedIncomplete > 0 || recovery.queuedKept > 0) {
    logger.info({ recovery }, 'Phục hồi sau khởi động lại hoàn tất');
  }

  const app = buildApp(context);
  context.scheduler.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown({ context, app, db, logger }, signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Đóng an toàn thất bại');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info({ port: config.port }, 'M365-Codex đã sẵn sàng');
}

/**
 * Chỉ khi thực thi trực tiếp tệp này (`node dist/server.js` / `tsx src/server.ts`) mới chạy `main()`;
 * khi được test import để lấy `gracefulShutdown` sẽ không khởi chạy toàn bộ tiến trình.
 */
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(`[M365-Codex] Bất thường khi khởi động: ${String(error)}\n`);
    process.exit(1);
  });
}
