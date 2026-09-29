import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig, type RawEnv } from '../../src/config/index.js';
import { createContext, type AppContext } from '../../src/context.js';
import { openDatabase, runMigrations, type Database } from '../../src/db/index.js';
import { FakeOAuthClient } from './fakeOAuth.js';

/** Scaffold test: DB trong bộ nhớ + log im lặng, không ghi ra bất kỳ file nào. */

export const TEST_ADMIN_PASSWORD = 'test-admin-password-123';

export function testMasterKeyBase64(): string {
  return randomBytes(32).toString('base64');
}

export function testEnv(overrides: RawEnv = {}): RawEnv {
  return {
    M365_CODEX_MASTER_KEY: testMasterKeyBase64(),
    M365_CODEX_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    DATA_DIR: ':memory:',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export interface TestHarness {
  app: FastifyInstance;
  context: AppContext;
  config: AppConfig;
  db: Database;
  /** Mock OAuth client upstream, trong test có thể lập trình inject lỗi và độ trễ */
  oauth: FakeOAuthClient;
  close: () => Promise<void>;
}

export async function createTestHarness(envOverrides: RawEnv = {}): Promise<TestHarness> {
  const config = loadConfig(testEnv(envOverrides));
  const db = openDatabase(':memory:');
  runMigrations(db);
  const logger = pino({ level: 'silent' });
  const oauth = new FakeOAuthClient();
  const context = createContext({ config, db, logger, oauthClient: oauth });
  const app = buildApp(context);
  await app.ready();

  return {
    app,
    context,
    config,
    db,
    oauth,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/** Đăng nhập và trả về token phiên admin. */
export async function loginAdmin(app: FastifyInstance, password = TEST_ADMIN_PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`管理端登录失败：${response.statusCode} ${response.body}`);
  }
  return (response.json() as { token: string }).token;
}
