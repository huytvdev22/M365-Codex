import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { loadConfig } from '../src/config/index.js';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { OAuthRequestError } from '../src/oauth/client.js';
import { TokenManager, TokenUnavailableError, REFRESH_SKEW_MS } from '../src/oauth/tokenManager.js';
import { AccountRepository } from '../src/repo/accounts.js';
import { createLogger } from '../src/observability/logger.js';
import { FakeOAuthClient } from './helpers/fakeOAuth.js';
import { testEnv } from './helpers/testApp.js';

const ALICE = { tid: 'tenant-1', oid: 'user-alice', email: 'alice@office.example.invalid' };

interface Fixture {
  db: Database;
  accounts: AccountRepository;
  client: FakeOAuthClient;
  manager: TokenManager;
  accountId: string;
  close: () => void;
}

function createFixture(options: { logStream?: Writable; expiresAt?: number | null } = {}): Fixture {
  const config = loadConfig(testEnv());
  const db = openDatabase(':memory:');
  runMigrations(db);
  const accounts = new AccountRepository(db, new Cryptor(config.masterKey, config.masterKeyVersion));
  const client = new FakeOAuthClient();
  client.registerCode('irrelevant', ALICE);

  const logger =
    options.logStream === undefined
      ? pino({ level: 'silent' })
      : createLogger({ level: 'info', privacyMode: 'strict', destination: options.logStream });

  const view = accounts.upsert({
    tid: ALICE.tid,
    oid: ALICE.oid,
    email: ALICE.email,
    displayName: 'Alice',
    source: 'oauth',
    tokens: {
      accessToken: 'initial-access-token',
      refreshToken: `fake-refresh-${ALICE.oid}-v1`,
      expiresAt: options.expiresAt === undefined ? Date.now() + 60 * 60 * 1000 : options.expiresAt,
    },
  });

  return {
    db,
    accounts,
    client,
    manager: new TokenManager({ accounts, client, logger }),
    accountId: view.id,
    close: () => db.close(),
  };
}

let fixture: Fixture | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

describe('getAccessToken', () => {
  it('Token 还早时直接返回，不打上游', async () => {
    fixture = createFixture();
    const token = await fixture.manager.getAccessToken(fixture.accountId);
    expect(token).toBe('initial-access-token');
    expect(fixture.client.refreshCount).toBe(0);
  });

  it('Token 进入提前刷新窗口时自动刷新', async () => {
    fixture = createFixture({ expiresAt: Date.now() + REFRESH_SKEW_MS - 1000 });
    const token = await fixture.manager.getAccessToken(fixture.accountId);
    expect(token).not.toBe('initial-access-token');
    expect(fixture.client.refreshCount).toBe(1);
  });

  it('Token 已过期时刷新', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    await fixture.manager.getAccessToken(fixture.accountId);
    expect(fixture.client.refreshCount).toBe(1);
  });

  it('账号无 Token 时抛出明确错误', async () => {
    fixture = createFixture();
    await expect(fixture.manager.getAccessToken('不存在的账号')).rejects.toThrow(TokenUnavailableError);
  });
});

describe('刷新的并发单飞', () => {
  it('同账号并发刷新只打一次上游，且都拿到同一个 Token', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.client.refreshDelayMs = 30;

    const results = await Promise.all(
      Array.from({ length: 8 }, () => fixture!.manager.getAccessToken(fixture!.accountId)),
    );

    expect(fixture.client.refreshCount).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('刷新完成后释放单飞槽位，下次可以再刷', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    await fixture.manager.refresh(fixture.accountId);
    expect(fixture.manager.isRefreshing(fixture.accountId)).toBe(false);
    await fixture.manager.refresh(fixture.accountId);
    expect(fixture.client.refreshCount).toBe(2);
  });

  it('刷新失败也会释放槽位，不会把账号卡死', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.client.nextRefreshError = new OAuthRequestError(503, 'temporarily_unavailable', '上游抖动');
    await expect(fixture.manager.refresh(fixture.accountId)).rejects.toThrow(TokenUnavailableError);
    expect(fixture.manager.isRefreshing(fixture.accountId)).toBe(false);
  });
});

describe('刷新结果写回', () => {
  it('原子替换 access token 并更新过期时间', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    const before = fixture.accounts.readAccessToken(fixture.accountId);
    const refreshed = await fixture.manager.refresh(fixture.accountId);
    const after = fixture.accounts.readAccessToken(fixture.accountId);

    expect(after?.token).toBe(refreshed);
    expect(after?.token).not.toBe(before?.token);
    expect(after?.expiresAt ?? 0).toBeGreaterThan(Date.now());
  });

  it('上游下发新 refresh_token 时一并轮换', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    const before = fixture.accounts.readRefreshToken(fixture.accountId);
    await fixture.manager.refresh(fixture.accountId);
    const after = fixture.accounts.readRefreshToken(fixture.accountId);
    expect(after).not.toBe(before);
    expect(after).not.toBeNull();
  });

  it('上游不下发新 refresh_token 时保留原值', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.client.refreshIssuesNewRefreshToken = false;
    const before = fixture.accounts.readRefreshToken(fixture.accountId);
    await fixture.manager.refresh(fixture.accountId);
    expect(fixture.accounts.readRefreshToken(fixture.accountId)).toBe(before);
  });

  it('刷新成功后清零连续失败计数', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.accounts.recordFailure(fixture.accountId, 'upstream_error');
    expect(fixture.accounts.getView(fixture.accountId)?.consecutive_failures).toBe(1);
    await fixture.manager.refresh(fixture.accountId);
    expect(fixture.accounts.getView(fixture.accountId)?.consecutive_failures).toBe(0);
  });
});

describe('invalid_grant 处理', () => {
  it('转入 reauth_required 并停止自动重试', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.client.nextRefreshError = new OAuthRequestError(400, 'invalid_grant', 'refresh token 已失效');

    await expect(fixture.manager.refresh(fixture.accountId)).rejects.toThrow(/需要重新授权/);
    expect(fixture.accounts.findById(fixture.accountId)?.status).toBe('reauth_required');

    // Tài khoản đã ở trạng thái reauth_required sẽ không gọi lên upstream nữa
    const callsBefore = fixture.client.refreshCount;
    await expect(fixture.manager.getAccessToken(fixture.accountId)).rejects.toThrow(/重新授权/);
    expect(fixture.client.refreshCount).toBe(callsBefore);
  });

  it('interaction_required 同样转入 reauth_required', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.client.nextRefreshError = new OAuthRequestError(400, 'interaction_required', '需要交互');
    await expect(fixture.manager.refresh(fixture.accountId)).rejects.toThrow(TokenUnavailableError);
    expect(fixture.accounts.findById(fixture.accountId)?.status).toBe('reauth_required');
  });

  it('普通网络错误不会误判为需要重新授权', async () => {
    fixture = createFixture({ expiresAt: Date.now() - 1000 });
    fixture.client.nextRefreshError = new OAuthRequestError(503, 'temporarily_unavailable', '上游抖动');
    await expect(fixture.manager.refresh(fixture.accountId)).rejects.toThrow(/刷新失败/);
    expect(fixture.accounts.findById(fixture.accountId)?.status).not.toBe('reauth_required');
    expect(fixture.accounts.getView(fixture.accountId)?.consecutive_failures).toBe(1);
  });

  it('没有 refresh_token 的账号直接要求重新授权', async () => {
    const config = loadConfig(testEnv());
    const db = openDatabase(':memory:');
    runMigrations(db);
    const accounts = new AccountRepository(db, new Cryptor(config.masterKey, config.masterKeyVersion));
    const client = new FakeOAuthClient();
    const view = accounts.upsert({
      tid: 't', oid: 'o', email: null, displayName: null, source: 'oauth',
      tokens: { accessToken: 'only-access', refreshToken: null, expiresAt: Date.now() - 1000 },
    });
    const manager = new TokenManager({ accounts, client, logger: pino({ level: 'silent' }) });

    await expect(manager.refresh(view.id)).rejects.toThrow(/没有 refresh_token/);
    expect(accounts.findById(view.id)?.status).toBe('reauth_required');
    expect(client.refreshCount).toBe(0);
    db.close();
  });
});

describe('日志纪律', () => {
  it('刷新过程的日志里不出现任何 Token', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });

    fixture = createFixture({ expiresAt: Date.now() - 1000, logStream: stream });
    const oldRefresh = fixture.accounts.readRefreshToken(fixture.accountId) ?? '';
    const newAccess = await fixture.manager.refresh(fixture.accountId);
    const newRefresh = fixture.accounts.readRefreshToken(fixture.accountId) ?? '';

    const logs = chunks.join('');
    expect(logs).toContain('Token 刷新成功');
    expect(logs).not.toContain(oldRefresh);
    expect(logs).not.toContain(newAccess);
    expect(logs).not.toContain(newRefresh);
    expect(logs).not.toContain('initial-access-token');
  });

  it('刷新失败的日志只记录错误码，不记 Token', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });

    fixture = createFixture({ expiresAt: Date.now() - 1000, logStream: stream });
    const refreshToken = fixture.accounts.readRefreshToken(fixture.accountId) ?? '';
    fixture.client.nextRefreshError = new OAuthRequestError(400, 'invalid_grant', '失效');
    await expect(fixture.manager.refresh(fixture.accountId)).rejects.toThrow();

    const logs = chunks.join('');
    expect(logs).toContain('invalid_grant');
    expect(logs).not.toContain(refreshToken);
  });
});
