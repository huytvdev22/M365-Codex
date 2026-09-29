import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { ApiError, type AccountStatus } from '@m365-codex/shared';
import { loadConfig, type UpstreamConfig } from '../src/config/index.js';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { SydneyCodecV1 } from '../src/adapter/codecV1.js';
import type { SydneyConnection } from '../src/adapter/connection.js';
import { UpstreamError, type UpstreamDisposition } from '../src/adapter/errors.js';
import type { UpstreamEvent } from '../src/adapter/protocol.js';
import { TokenManager } from '../src/oauth/tokenManager.js';
import { AccountRepository } from '../src/repo/accounts.js';
import { AccountPool } from '../src/scheduler/accountPool.js';
import { UpstreamDispatcher } from '../src/scheduler/dispatcher.js';
import { FakeOAuthClient } from './helpers/fakeOAuth.js';
import { testEnv } from './helpers/testApp.js';

/** Dùng kết nối giả dạng script để test chính xác state machine chuyển đổi khi thất bại. */

type Script =
  | { kind: 'success'; chunks: string[] }
  | { kind: 'fail'; disposition: UpstreamDisposition; retryAfterMs?: number }
  | { kind: 'fail-after-content'; chunks: string[]; disposition: UpstreamDisposition };

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const upstreamConfig: UpstreamConfig = {
  wsBase: 'wss://mock.invalid',
  pathTemplate: '/chat/{oid}@{tid}',
  protocolVersion: 'sydney-json-v1',
  heartbeatIntervalMs: 15000,
  handshakeTimeoutMs: 15000,
  idleTimeoutMs: 60000,
  maxReconnects: 2,
  scenario: 'officeweb',
};

/** Khởi tạo factory kết nối giả phản hồi tuần tự theo hàng đợi script, ghi nhận URL dùng cho mỗi kết nối. */
function scriptedFactory(scripts: Script[], connectionUrls: string[]) {
  let index = 0;
  return (deps: unknown): SydneyConnection => {
    void deps;
    return {
      run(input: { url: string }): AsyncGenerator<UpstreamEvent> {
        connectionUrls.push(input.url);
        const script = scripts[index] ?? { kind: 'fail', disposition: 'unknown' };
        index += 1;
        return (async function* () {
          if (script.kind === 'success') {
            for (const chunk of script.chunks) yield { kind: 'text_delta', text: chunk };
            yield { kind: 'completed', stopReason: null };
            return;
          }
          if (script.kind === 'fail-after-content') {
            for (const chunk of script.chunks) yield { kind: 'text_delta', text: chunk };
            throw new UpstreamError('内容后失败', script.disposition);
          }
          throw new UpstreamError('脚本失败', script.disposition, {
            retryAfterMs: script.retryAfterMs ?? null,
          });
        })();
      },
    } as unknown as SydneyConnection;
  };
}

interface Harness {
  accounts: AccountRepository;
  pool: AccountPool;
  tokens: TokenManager;
  client: FakeOAuthClient;
  makeDispatcher: (scripts: Script[], urls?: string[]) => UpstreamDispatcher;
}

function setup(): Harness {
  const config = loadConfig(testEnv());
  db = openDatabase(':memory:');
  runMigrations(db);
  const accounts = new AccountRepository(db, new Cryptor(config.masterKey, config.masterKeyVersion));
  const pool = new AccountPool(accounts);
  const client = new FakeOAuthClient();
  const tokens = new TokenManager({ accounts, client, logger: pino({ level: 'silent' }) });

  return {
    accounts,
    pool,
    tokens,
    client,
    makeDispatcher: (scripts, urls = []) =>
      new UpstreamDispatcher({
        config: upstreamConfig,
        codec: new SydneyCodecV1(),
        accounts,
        pool,
        tokens,
        logger: pino({ level: 'silent' }),
        connectionFactory: scriptedFactory(scripts, urls),
      }),
  };
}

function seed(accounts: AccountRepository, oid: string, status: AccountStatus = 'online'): string {
  const view = accounts.upsert({
    tid: 'tenant-1',
    oid,
    email: `${oid}@office.example.invalid`,
    displayName: oid,
    source: 'oauth',
    tokens: { accessToken: 'a', refreshToken: `fake-refresh-${oid}-v1`, expiresAt: Date.now() + 3600_000 },
  });
  if (status !== 'probing') accounts.forceStatus(view.id, status);
  return view.id;
}

async function drain(gen: AsyncGenerator<UpstreamEvent>): Promise<UpstreamEvent[]> {
  const out: UpstreamEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('正常调度', () => {
  it('选中账号并流式返回', async () => {
    const h = setup();
    const id = seed(h.accounts, 'a');
    const result = h.makeDispatcher([{ kind: 'success', chunks: ['你好'] }]).dispatch({ text: 'hi' });
    const events = await drain(result.events);
    expect(result.accountId).toBe(id);
    expect(events).toContainEqual({ kind: 'text_delta', text: '你好' });
    expect(h.accounts.getView(id)?.last_ok_at).toBeTypeOf('number');
  });

  it('空池返回 503 account_pool_exhausted', async () => {
    const h = setup();
    const result = h.makeDispatcher([{ kind: 'success', chunks: ['x'] }]).dispatch({ text: 'hi' });
    await expect(drain(result.events)).rejects.toMatchObject({ type: 'account_pool_exhausted', status: 503 });
  });
});

describe('401 刷新重试', () => {
  it('刷新一次后在同一账号重试成功', async () => {
    const h = setup();
    const id = seed(h.accounts, 'a');
    const result = h
      .makeDispatcher([
        { kind: 'fail', disposition: 'refresh_and_retry' },
        { kind: 'success', chunks: ['ok'] },
      ])
      .dispatch({ text: 'hi' });
    const events = await drain(result.events);
    expect(events).toContainEqual({ kind: 'text_delta', text: 'ok' });
    expect(result.accountId).toBe(id);
    expect(h.client.refreshCount).toBe(1); // Đã refresh một lần
  });

  it('刷新后仍失败则不再无限重试', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    const result = h
      .makeDispatcher([
        { kind: 'fail', disposition: 'refresh_and_retry' },
        { kind: 'fail', disposition: 'refresh_and_retry' },
      ])
      .dispatch({ text: 'hi' });
    await expect(drain(result.events)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('429 限流切换', () => {
  it('冷却当前账号并切到下一个成功', async () => {
    const h = setup();
    const a = seed(h.accounts, 'a');
    const b = seed(h.accounts, 'b');
    const result = h
      .makeDispatcher([
        { kind: 'fail', disposition: 'rate_limited', retryAfterMs: 60_000 },
        { kind: 'success', chunks: ['from-b'] },
      ])
      .dispatch({ text: 'hi' });
    const events = await drain(result.events);
    expect(events).toContainEqual({ kind: 'text_delta', text: 'from-b' });
    // Tài khoản thứ nhất bị làm nguội
    const cooledA = h.accounts.getView(a)?.cooldown_until;
    expect(cooledA).not.toBeNull();
    expect(result.accountId).toBe(b);
  });
});

describe('403 禁用切换', () => {
  it('403 后账号进冷却并切换，不无限切换', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const result = h
      .makeDispatcher([
        { kind: 'fail', disposition: 'account_forbidden' },
        { kind: 'success', chunks: ['ok'] },
      ])
      .dispatch({ text: 'hi' });
    const events = await drain(result.events);
    expect(events).toContainEqual({ kind: 'text_delta', text: 'ok' });
  });

  it('所有账号都 403 后返回错误而非死循环', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const result = h
      .makeDispatcher([
        { kind: 'fail', disposition: 'account_forbidden' },
        { kind: 'fail', disposition: 'account_forbidden' },
      ])
      .dispatch({ text: 'hi' });
    await expect(drain(result.events)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('5xx / 断开有限重试', () => {
  it('retry_or_switch 切到下一个账号', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const result = h
      .makeDispatcher([
        { kind: 'fail', disposition: 'retry_or_switch' },
        { kind: 'success', chunks: ['recovered'] },
      ])
      .dispatch({ text: 'hi' });
    const events = await drain(result.events);
    expect(events).toContainEqual({ kind: 'text_delta', text: 'recovered' });
  });

  it('超过尝试上限后抛出', async () => {
    const h = setup();
    for (const oid of ['a', 'b', 'c', 'd', 'e']) seed(h.accounts, oid);
    const scripts: Script[] = Array.from({ length: 5 }, () => ({
      kind: 'fail' as const,
      disposition: 'retry_or_switch' as const,
    }));
    const result = h.makeDispatcher(scripts).dispatch({ text: 'hi' });
    await expect(drain(result.events)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('致命错误不重试', () => {
  it('fatal_client 直接失败，不切换', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const urls: string[] = [];
    const result = h
      .makeDispatcher([{ kind: 'fail', disposition: 'fatal_client' }, { kind: 'success', chunks: ['x'] }], urls)
      .dispatch({ text: 'hi' });
    await expect(drain(result.events)).rejects.toBeInstanceOf(ApiError);
    // Chỉ thử kết nối 1 lần, không chuyển đổi
    expect(urls).toHaveLength(1);
  });
});

describe('已吐内容后失败不切换', () => {
  it('内容已流出时中途失败如实抛出，不重连造成重复', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const result = h
      .makeDispatcher([
        { kind: 'fail-after-content', chunks: ['部分'], disposition: 'retry_or_switch' },
        { kind: 'success', chunks: ['不应看到'] },
      ])
      .dispatch({ text: 'hi' });

    const collected: UpstreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of result.events) collected.push(event);
      })(),
    ).rejects.toBeInstanceOf(ApiError);
    // Nội dung đã trả về vẫn còn, nhưng không có nội dung lặp lại của tài khoản thứ hai
    expect(collected).toContainEqual({ kind: 'text_delta', text: '部分' });
    expect(collected).not.toContainEqual({ kind: 'text_delta', text: '不应看到' });
  });
});

describe('副作用阶段不跨账号重放', () => {
  it('携带工具结果的请求失败时不换账号重发', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const urls: string[] = [];
    const result = h
      .makeDispatcher([{ kind: 'fail', disposition: 'retry_or_switch' }, { kind: 'success', chunks: ['x'] }], urls)
      .dispatch({
        text: 'hi',
        sideEffect: true,
        toolResults: [{ callId: 'call_1', output: '已删除 3 个文件' }],
      });
    await expect(drain(result.events)).rejects.toBeInstanceOf(ApiError);
    // Cùng là retry_or_switch, yêu cầu không có tác dụng phụ sẽ chuyển sang b; yêu cầu có tác dụng phụ chỉ kết nối 1 lần
    expect(urls).toHaveLength(1);
  });

  it('同样的失败在非副作用请求上会切换账号', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    seed(h.accounts, 'b');
    const urls: string[] = [];
    const result = h
      .makeDispatcher([{ kind: 'fail', disposition: 'retry_or_switch' }, { kind: 'success', chunks: ['x'] }], urls)
      .dispatch({ text: 'hi' });
    await drain(result.events);
    expect(urls).toHaveLength(2);
  });
});

describe('粘性', () => {
  it('优先复用绑定的账号', async () => {
    const h = setup();
    seed(h.accounts, 'a');
    const b = seed(h.accounts, 'b');
    // Để b có ít kết nối hơn vốn sẽ được chọn, nhưng tính dính chỉ định a... ở đây xác minh prefer có hiệu lực: gắn kết với b
    const result = h
      .makeDispatcher([{ kind: 'success', chunks: ['ok'] }])
      .dispatch({ text: 'hi', sticky: { accountId: b, conversationRef: 'conv-1' } });
    await drain(result.events);
    expect(result.accountId).toBe(b);
  });
});

describe('Token 不可用', () => {
  it('账号需重新授权时跳过它，切到可用账号', async () => {
    const h = setup();
    const a = seed(h.accounts, 'a');
    const b = seed(h.accounts, 'b');
    h.accounts.forceStatus(a, 'reauth_required');
    // reauth_required không nằm trong trạng thái có thể điều phối, pool trực tiếp không chọn a; ở đây xác nhận lại có thể chọn được b
    const result = h.makeDispatcher([{ kind: 'success', chunks: ['ok'] }]).dispatch({ text: 'hi' });
    const events = await drain(result.events);
    expect(events).toContainEqual({ kind: 'text_delta', text: 'ok' });
    expect(result.accountId).toBe(b);
  });
});
