import type { HealthResponse, ReadinessCheck, ReadinessResponse } from '@m365-codex/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { CryptoError } from '../crypto/index.js';
import { checkWritable, currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { APP_VERSION } from '../version.js';

/**
 * Probe kiểm tra sống sót (liveness) và sẵn sàng (readiness).
 *
 * - `/healthz`: Tiến trình có còn sống không, luôn gọn nhẹ, không chạm vào database;
 * - `/readyz`: Có thực sự sẵn sàng phục vụ không — khóa chủ dùng được, migration hoàn tất, database có thể ghi.
 *   Bất kỳ mục nào không đạt sẽ trả về 503, bộ điều phối container sẽ dựa vào đây để không điều phối lưu lượng vào.
 */

export function evaluateReadiness(context: AppContext): ReadinessResponse {
  const checks: ReadinessCheck[] = [];

  // 1) Khóa chủ: Thực hiện một lượt mã hóa / giải mã thật thay vì chỉ kiểm tra độ dài
  try {
    const probe = context.cryptor.seal('readiness-probe', 'readyz');
    const restored = context.cryptor.open(probe, 'readyz');
    checks.push({
      name: 'master_key',
      ok: restored === 'readiness-probe',
      detail: restored === 'readiness-probe' ? 'Khóa chủ khả dụng (AES-256-GCM thành công)' : 'Kết quả kiểm tra khóa chủ không khớp',
    });
  } catch (error) {
    const message = error instanceof CryptoError ? error.message : String(error);
    checks.push({ name: 'master_key', ok: false, detail: `Khóa chủ không khả dụng: ${message}` });
  }

  // 2) Phiên bản migration CSDL
  let schemaVersion = 0;
  try {
    schemaVersion = currentSchemaVersion(context.db);
    const ok = schemaVersion === LATEST_SCHEMA_VERSION;
    checks.push({
      name: 'schema_migrations',
      ok,
      detail: ok
        ? `Migration CSDL đã là mới nhất (v${schemaVersion})`
        : `Phiên bản migration không khớp: hiện tại v${schemaVersion}, yêu cầu v${LATEST_SCHEMA_VERSION}`,
    });
  } catch (error) {
    checks.push({
      name: 'schema_migrations',
      ok: false,
      detail: `Không thể đọc phiên bản migration: ${(error as Error).message}`,
    });
  }

  // 3) Cơ sở dữ liệu có thể ghi
  const writable = checkWritable(context.db);
  checks.push({ name: 'database_writable', ok: writable.ok, detail: writable.detail });

  return {
    status: checks.every((check) => check.ok) ? 'ready' : 'not_ready',
    version: APP_VERSION,
    schema_version: schemaVersion,
    checks,
  };
}

export function registerHealthRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/healthz', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      version: APP_VERSION,
      uptime_ms: Date.now() - context.startedAt,
    };
  });

  app.get('/readyz', async (_request, reply) => {
    const result = evaluateReadiness(context);
    reply.code(result.status === 'ready' ? 200 : 503);
    return result;
  });
}
