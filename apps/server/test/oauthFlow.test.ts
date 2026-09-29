import { afterEach, describe, expect, it } from 'vitest';
import { OAuthRequestError } from '../src/oauth/client.js';
import { parseCallback } from '../src/oauth/service.js';
import { OAUTH_SESSION_TTL_MS } from '../src/repo/oauthSessions.js';
import { makeCallbackUrl } from './helpers/fakeOAuth.js';
import { createTestHarness, loginAdmin, type TestHarness } from './helpers/testApp.js';

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(): Promise<{ h: TestHarness; token: string }> {
  harness = await createTestHarness();
  return { h: harness, token: await loginAdmin(harness.app) };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const ALICE = { tid: 'tenant-1', oid: 'user-alice', email: 'alice@office.example.invalid' };
const BOB = { tid: 'tenant-1', oid: 'user-bob', email: 'bob@office.example.invalid' };

describe('parseCallback', () => {
  it('解析完整回调 URL', () => {
    expect(parseCallback(makeCallbackUrl('CODE1', 'STATE1'))).toEqual({
      code: 'CODE1',
      state: 'STATE1',
    });
  });

  it('解析裸查询串，带不带问号都行', () => {
    expect(parseCallback('code=C&state=S')).toEqual({ code: 'C', state: 'S' });
    expect(parseCallback('?code=C&state=S')).toEqual({ code: 'C', state: 'S' });
  });

  it('缺少 code 或 state 时报错', () => {
    expect(() => parseCallback('state=S')).toThrow(/没有 code 参数/);
    expect(() => parseCallback('code=C')).toThrow(/没有 state 参数/);
  });

  it('把 Microsoft 的 error 回调转成可读错误', () => {
    expect(() =>
      parseCallback('error=access_denied&error_description=用户取消了授权'),
    ).toThrow(/授权未完成（access_denied）/);
  });

  it('空输入报错', () => {
    expect(() => parseCallback('   ')).toThrow(/请粘贴/);
  });
});

describe('授权链接生成', () => {
  it('返回授权地址、state 与 10 分钟有效期', async () => {
    const { h, token } = await setup();
    const before = Date.now();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/authorize-url',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { authorize_url: string; state: string; expires_at: number };
    expect(body.authorize_url).toContain(`state=${encodeURIComponent(body.state)}`);
    expect(body.authorize_url).toContain('code_challenge_method=S256');
    expect(body.expires_at).toBeGreaterThanOrEqual(before + OAUTH_SESSION_TTL_MS - 1000);
  });

  it('响应中不含 code_verifier', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/authorize-url',
      headers: auth(token),
    });
    const state = (response.json() as { state: string }).state;
    const stored = h.context.oauthSessions.find(state);
    expect(stored).toBeDefined();
    // Trong database lưu bản mã, trong body response ngay cả bản mã cũng không được phép xuất hiện
    const verifier = h.context.oauthSessions.consume(state).ok
      ? 'consumed'
      : 'unreachable';
    expect(verifier).toBe('consumed');
    expect(response.body).not.toContain('code_verifier');
  });

  it('code_verifier 在库中是加密存储的', async () => {
    const { h, token } = await setup();
    const state = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };

    const raw = h.db.prepare('SELECT * FROM oauth_sessions WHERE state = ?').get(state.state) as {
      code_verifier_enc: Uint8Array;
      code_verifier_nonce: Uint8Array;
    };
    const consumed = h.context.oauthSessions.consume(state.state);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) throw new Error('unreachable');

    const cipherText = Buffer.from(raw.code_verifier_enc).toString('utf8');
    expect(cipherText).not.toContain(consumed.codeVerifier);
    expect(raw.code_verifier_nonce.length).toBe(12);
  });

  it('未登录不能生成授权链接', async () => {
    harness = await createTestHarness();
    const response = await harness.app.inject({ method: 'POST', url: '/admin/oauth/authorize-url' });
    expect(response.statusCode).toBe(401);
  });
});

describe('完成授权', () => {
  it('成功换取 Token 并落库为新账号', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);

    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };

    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-ALICE', start.state) },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      existing: boolean;
      account: { tid: string; oid: string; email: string; status: string; has_refresh_token: boolean };
    };
    expect(body.existing).toBe(false);
    expect(body.account.tid).toBe(ALICE.tid);
    expect(body.account.oid).toBe(ALICE.oid);
    expect(body.account.email).toBe(ALICE.email);
    expect(body.account.status).toBe('probing');
    expect(body.account.has_refresh_token).toBe(true);
  });

  it('响应体与数据库中都不出现 Token 明文', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);
    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-ALICE', start.state) },
    });

    const accountId = (response.json() as { account: { id: string } }).account.id;
    const accessToken = h.context.accounts.readAccessToken(accountId)?.token ?? '';
    const refreshToken = h.context.accounts.readRefreshToken(accountId) ?? '';
    expect(accessToken).not.toBe('');
    expect(refreshToken).not.toBe('');

    expect(response.body).not.toContain(accessToken);
    expect(response.body).not.toContain(refreshToken);

    const rawRows = JSON.stringify(h.db.prepare('SELECT * FROM account_tokens').all());
    expect(rawRows).not.toContain(accessToken);
    expect(rawRows).not.toContain(refreshToken);
  });

  it('同一账号重复授权只更新，不产生第二条记录', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-1', ALICE);
    h.oauth.registerCode('CODE-2', ALICE);

    for (const code of ['CODE-1', 'CODE-2']) {
      const start = (
        await h.app.inject({
          method: 'POST',
          url: '/admin/oauth/authorize-url',
          headers: auth(token),
        })
      ).json() as { state: string };
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/callback',
        headers: auth(token),
        payload: { callback: makeCallbackUrl(code, start.state) },
      });
    }

    const list = (
      await h.app.inject({ method: 'GET', url: '/admin/accounts', headers: auth(token) })
    ).json() as { data: unknown[] };
    expect(list.data).toHaveLength(1);
  });

  it('state 不匹配任何会话时拒绝', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-ALICE', 'state-from-nowhere') },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('state 不匹配');
    expect(h.oauth.exchangeCalls).toHaveLength(0);
  });

  it('授权码只能消费一次，重放被拒绝', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);
    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };
    const callback = makeCallbackUrl('CODE-ALICE', start.state);

    const first = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback },
    });
    const second = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('已被使用过');
    // Replay không gọi lại upstream lần nữa
    expect(h.oauth.exchangeCalls).toHaveLength(1);
  });

  it('并发提交同一个授权码时只有一次能成功', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);
    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };
    const callback = makeCallbackUrl('CODE-ALICE', start.state);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/admin/oauth/callback',
          headers: auth(token),
          payload: { callback },
        }),
      ),
    );

    const ok = results.filter((response) => response.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(h.oauth.exchangeCalls).toHaveLength(1);
  });

  it('会话超过 10 分钟后失效', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);
    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string; expires_at: number };

    // Sửa trực tiếp thời gian hết hạn về quá khứ, tương đương thời gian trôi qua
    h.db
      .prepare('UPDATE oauth_sessions SET expires_at = ? WHERE state = ?')
      .run(Date.now() - 1000, start.state);

    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-ALICE', start.state) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('10 分钟');
  });

  it('多个授权会话并行互不干扰', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-ALICE', ALICE);
    h.oauth.registerCode('CODE-BOB', BOB);

    const [startA, startB] = await Promise.all([
      h.app
        .inject({ method: 'POST', url: '/admin/oauth/authorize-url', headers: auth(token) })
        .then((r) => r.json() as { state: string }),
      h.app
        .inject({ method: 'POST', url: '/admin/oauth/authorize-url', headers: auth(token) })
        .then((r) => r.json() as { state: string }),
    ]);
    expect(startA.state).not.toBe(startB.state);

    // Cố ý hoàn thành chéo: Hoàn thành cái mở sau trước
    const resB = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-BOB', startB.state) },
    });
    const resA = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-ALICE', startA.state) },
    });

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    const emails = (
      (await h.app.inject({ method: 'GET', url: '/admin/accounts', headers: auth(token) })).json() as {
        data: { email: string }[];
      }
    ).data.map((account) => account.email);
    expect(emails.sort()).toEqual([ALICE.email, BOB.email].sort());
  });

  it('把 A 会话的 state 配 B 会话的 code 提交，不会串账号', async () => {
    const { h, token } = await setup();
    h.oauth.registerCode('CODE-BOB', BOB);
    const startA = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };

    // Dùng state của A gửi code của BOB: Phiên là của A, đổi ra được lại là BOB,
    // điều này ở upstream thật sẽ thất bại do code_verifier không khớp; ở đây xác minh quyền sở hữu tài khoản căn cứ vào claim của Token
    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('CODE-BOB', startA.state) },
    });
    expect(response.statusCode).toBe(200);
    const account = (response.json() as { account: { oid: string } }).account;
    expect(account.oid).toBe(BOB.oid);
  });

  it('上游拒绝时返回 502 且不落库', async () => {
    const { h, token } = await setup();
    h.oauth.nextExchangeError = new OAuthRequestError(400, 'invalid_grant', '授权码已过期');
    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };

    const response = await h.app.inject({
      method: 'POST',
      url: '/admin/oauth/callback',
      headers: auth(token),
      payload: { callback: makeCallbackUrl('ANY', start.state) },
    });
    expect(response.statusCode).toBe(502);
    expect(h.context.accounts.listViews()).toHaveLength(0);
  });
});

describe('授权会话清理', () => {
  it('清理过期会话', async () => {
    const { h, token } = await setup();
    const start = (
      await h.app.inject({
        method: 'POST',
        url: '/admin/oauth/authorize-url',
        headers: auth(token),
      })
    ).json() as { state: string };

    expect(h.context.oauthSessions.countPending()).toBe(1);
    h.db
      .prepare('UPDATE oauth_sessions SET expires_at = ? WHERE state = ?')
      .run(Date.now() - 1000, start.state);
    expect(h.context.oauthSessions.countPending()).toBe(0);
    expect(h.context.oauthSessions.purge()).toBe(1);
    expect(h.context.oauthSessions.find(start.state)).toBeUndefined();
  });
});
