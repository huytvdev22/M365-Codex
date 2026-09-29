import { afterEach, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@m365-codex/shared';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GET /healthz', () => {
  it('返回存活状态与版本', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; version: string; uptime_ms: number };
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('响应带请求 ID 头', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^req_[0-9a-f]{24}$/);
  });
});

describe('GET /readyz', () => {
  it('主密钥与迁移就绪时返回 200', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      schema_version: number;
      checks: { name: string; ok: boolean }[];
    };
    expect(body.status).toBe('ready');
    expect(body.schema_version).toBeGreaterThanOrEqual(1);
    expect(body.checks.every((check) => check.ok)).toBe(true);
    expect(body.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['master_key', 'schema_migrations', 'database_writable']),
    );
  });

  it('迁移未执行时返回 503', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const { createContext } = await import('../src/context.js');
    const { buildApp } = await import('../src/app.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { pino } = await import('pino');
    const { testEnv } = await import('./helpers/testApp.js');

    const config = loadConfig(testEnv());
    const db = openDatabase(':memory:'); // Cố ý không thực thi migration
    const context = createContext({ config, db, logger: pino({ level: 'silent' }) });
    const app = buildApp(context);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    const body = response.json() as { status: string; checks: { name: string; ok: boolean }[] };
    expect(body.status).toBe('not_ready');
    expect(body.checks.find((check) => check.name === 'schema_migrations')?.ok).toBe(false);

    await app.close();
    db.close();
  });
});

describe('未知路由', () => {
  it('返回统一错误体', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/not-exist' });
    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: { type: string; code: string; request_id: string } };
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.code).toBe('404');
    expect(body.error.request_id).toMatch(/^req_/);
  });
});
