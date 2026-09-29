import { afterEach, describe, expect, it } from 'vitest';
import { OAuthRequestError } from '../src/oauth/client.js';
import { createTestHarness, loginAdmin, type TestHarness } from './helpers/testApp.js';

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function setup(env: Record<string, string> = {}): Promise<{ h: TestHarness; token: string }> {
  harness = await createTestHarness(env);
  return { h: harness, token: await loginAdmin(harness.app) };
}

function seedAccount(h: TestHarness, oid = 'user-1') {
  return h.context.accounts.upsert({
    tid: 'tenant-1',
    oid,
    email: `${oid}@office.example.invalid`,
    displayName: oid,
    source: 'oauth',
    tokens: {
      accessToken: 'ACCESS-PLAINTEXT',
      refreshToken: `fake-refresh-${oid}-v1`,
      expiresAt: Date.now() + 3600_000,
    },
  });
}

describe('GET /admin/accounts', () => {
  it('列表不含 Token', async () => {
    const { h, token } = await setup();
    seedAccount(h);
    const response = await h.app.inject({
      method: 'GET',
      url: '/admin/accounts',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('ACCESS-PLAINTEXT');
    expect(response.body).not.toContain('fake-refresh');
    const data = (response.json() as { data: { has_refresh_token: boolean }[] }).data;
    expect(data[0]?.has_refresh_token).toBe(true);
  });

  it('未登录返回 401', async () => {
    harness = await createTestHarness();
    expect((await harness.app.inject({ method: 'GET', url: '/admin/accounts' })).statusCode).toBe(401);
  });

  it('查询不存在的账号返回 404', async () => {
    const { h, token } = await setup();
    const response = await h.app.inject({
      method: 'GET',
      url: '/admin/accounts/not-exist',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /admin/accounts/:id/status', () => {
  it('允许的状态迁移返回新状态', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/admin/accounts/${account.id}/status`,
      headers: auth(token),
      payload: { status: 'online' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe('online');
  });

  it('非法迁移返回 400 并说明原因', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    h.context.accounts.forceStatus(account.id, 'disabled');

    const response = await h.app.inject({
      method: 'PATCH',
      url: `/admin/accounts/${account.id}/status`,
      headers: auth(token),
      payload: { status: 'online' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('不允许从 disabled 迁移到 online');
  });

  it('未知状态值返回 400', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'PATCH',
      url: `/admin/accounts/${account.id}/status`,
      headers: auth(token),
      payload: { status: '随便一个状态' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /admin/accounts/:id/refresh', () => {
  it('刷新成功返回账号视图且不含 Token', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/refresh`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const newToken = h.context.accounts.readAccessToken(account.id)?.token ?? '';
    expect(response.body).not.toContain(newToken);
    expect(h.oauth.refreshCount).toBe(1);
  });

  it('刷新凭据失效时返回 409', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    h.oauth.nextRefreshError = new OAuthRequestError(400, 'invalid_grant', '已失效');

    const response = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/refresh`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(409);
    expect(h.context.accounts.findById(account.id)?.status).toBe('reauth_required');
  });

  it('上游临时故障返回 502', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    h.oauth.nextRefreshError = new OAuthRequestError(503, 'temporarily_unavailable', '抖动');

    const response = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/refresh`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(502);
  });
});

describe('DELETE /admin/accounts/:id', () => {
  it('删除账号并写审计', async () => {
    const { h, token } = await setup();
    const account = seedAccount(h);
    const response = await h.app.inject({
      method: 'DELETE',
      url: `/admin/accounts/${account.id}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    expect(h.context.accounts.listViews()).toHaveLength(0);

    const audit = await h.app.inject({
      method: 'GET',
      url: '/admin/audit-logs',
      headers: auth(token),
    });
    expect(audit.body).toContain('account.delete');
    // Trong kiểm toán chỉ có email đã khử nhạy cảm
    expect(audit.body).toContain('us***@office.example.invalid');
  });
});
