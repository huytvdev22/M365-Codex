import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, loginAdmin, type TestHarness } from './helpers/testApp.js';

/**
 * Các endpoint admin bổ sung ở M7 (hợp đồng §2): Tổng quan, bản ghi yêu cầu, cài đặt, pool proxy gửi đi,
 * sinh cấu hình Codex, góc nhìn quản lý file, ma trận năng lực.
 */

let harness: TestHarness | undefined;
let extraServer: Server | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  if (extraServer !== undefined) {
    await new Promise<void>((resolve) => extraServer?.close(() => resolve()));
    extraServer = undefined;
  }
});

async function setup(): Promise<{ harness: TestHarness; token: string }> {
  harness = await createTestHarness();
  const token = await loginAdmin(harness.app);
  return { harness, token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('GET /admin/overview', () => {
  it('返回系统状态、版本、账号与请求统计', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/admin/overview', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.system_status).toBe('normal');
    expect(typeof body.version).toBe('string');
    expect(body.accounts).toEqual({ total: 0, online: 0, cooldown: 0, reauth_required: 0, disabled: 0 });
    expect(body.requests.in_flight).toBe(0);
    expect(Array.isArray(body.pending_restart)).toBe(true);
    expect(body.upstream.protocol_version).toBeDefined();
  });

  it('无管理会话返回 401', async () => {
    harness = await createTestHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/admin/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('全部账号都不可用时报 upstream_unavailable', async () => {
    const { harness: h, token } = await setup();
    h.context.accounts.upsert({
      tid: 't1',
      oid: 'o1',
      email: null,
      displayName: null,
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: null, expiresAt: null },
    });
    const account = h.context.accounts.listViews()[0];
    if (account !== undefined) h.context.accounts.forceStatus(account.id, 'disabled');

    const res = await h.app.inject({ method: 'GET', url: '/admin/overview', headers: auth(token) });
    expect(res.json().system_status).toBe('upstream_unavailable');
  });
});

describe('GET /admin/requests 与 /admin/requests/:id', () => {
  it('列表不含提示词与输出正文，详情带 tool_calls', async () => {
    const { harness: h, token } = await setup();
    h.context.responseRepo.create({
      id: 'resp_1',
      apiKeyId: null,
      status: 'completed',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: 'medium',
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });
    h.context.toolCalls.recordEmitted({
      responseId: 'resp_1',
      callId: 'call_1',
      name: 'shell',
      arguments: '{"cmd":"ls"}',
      sideEffect: true,
    });

    const list = await h.app.inject({ method: 'GET', url: '/admin/requests', headers: auth(token) });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(listBody.total).toBe(1);
    expect(listBody.items[0].id).toBe('resp_1');
    expect(JSON.stringify(listBody)).not.toContain('"cmd":"ls"');

    const detail = await h.app.inject({ method: 'GET', url: '/admin/requests/resp_1', headers: auth(token) });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.tool_calls).toHaveLength(1);
    expect(detailBody.tool_calls[0]).toEqual({
      call_id: 'call_1',
      name: 'shell',
      status: 'emitted',
      side_effect: true,
      created_at: expect.any(Number),
    });
    expect(JSON.stringify(detailBody)).not.toContain('"cmd":"ls"');
  });

  it('不存在的 id 返回 404', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/admin/requests/nope', headers: auth(token) });
    expect(res.statusCode).toBe(404);
  });

  it('按 status 过滤', async () => {
    const { harness: h, token } = await setup();
    h.context.responseRepo.create({
      id: 'resp_a',
      apiKeyId: null,
      status: 'failed',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: null,
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });
    h.context.responseRepo.create({
      id: 'resp_b',
      apiKeyId: null,
      status: 'completed',
      requestedModel: 'gpt-5-codex',
      requestedReasoningEffort: null,
      upstreamModelParameter: 'gpt-5-codex',
      previousResponseId: null,
      idempotencyKey: null,
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/requests?status=failed',
      headers: auth(token),
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe('resp_a');
  });
});

describe('GET/PATCH /admin/settings', () => {
  it('返回六个分组，未设置的项 source=default', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/admin/settings', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const group of ['network', 'scheduler', 'logging', 'oauth', 'tools', 'files']) {
      expect(body[group]).toBeDefined();
    }
    expect(body.tools.mode.source).toBe('default');
  });

  it('PATCH 写入后立刻反映为 source=db', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'tools', values: { max_rounds: 3 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tools.max_rounds).toEqual({
      value: 3,
      source: 'db',
      editable: true,
      requires_restart: true,
    });
  });

  it('env 显式设置的项 PATCH 返回 403', async () => {
    harness = await createTestHarness({ LOG_LEVEL: 'warn' });
    const token = await loginAdmin(harness.app);
    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'logging', values: { log_level: 'debug' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('未知分组返回 400', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'nope', values: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('debug 日志隐私模式自动过期（§15.3）', () => {
  it('切到 debug 后 /admin/settings 能读到 debug_expires_at，调度器注册了到期检查任务', async () => {
    const { harness: h, token } = await setup();
    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'logging', values: { log_privacy_mode: 'debug' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().logging.log_privacy_mode).toMatchObject({ value: 'debug', requires_restart: false });
    const expiresAt = patch.json().logging.debug_expires_at.value as number;
    expect(expiresAt).toBeGreaterThan(Date.now());

    const overview = await h.app.inject({ method: 'GET', url: '/admin/settings', headers: auth(token) });
    expect(overview.json().logging.debug_expires_at.value).toBe(expiresAt);

    expect(h.context.scheduler.statuses().some((s) => s.name === 'log_privacy_debug_expiry')).toBe(true);
  });

  it('过期后自动恢复 strict，热生效到 privacyMode，并写审计日志', async () => {
    const { harness: h, token } = await setup();
    await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'logging', values: { log_privacy_mode: 'debug' } },
    });
    expect(h.context.privacyMode.current).toBe('debug');

    const expiresAt = h.context.settings.getGroup('logging').debug_expires_at?.value as number;
    const affected = h.context.settings.enforceDebugExpiry(expiresAt + 1);
    expect(affected).toBe(1);
    expect(h.context.privacyMode.current).toBe('strict');
    expect(h.context.settings.getGroup('logging').log_privacy_mode?.value).toBe('strict');
    expect(h.context.settings.getGroup('logging').debug_expires_at?.value).toBeNull();

    const logs = await h.app.inject({ method: 'GET', url: '/admin/audit-logs', headers: auth(token) });
    const actions = (logs.json() as { data: { action: string; actor: string }[] }).data;
    const entry = actions.find((a) => a.action === 'settings.log_privacy_mode.debug_expired');
    expect(entry?.actor).toBe('system');
  });

  it('切回 strict 时清掉 debug_expires_at', async () => {
    const { harness: h, token } = await setup();
    await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'logging', values: { log_privacy_mode: 'debug' } },
    });
    const back = await h.app.inject({
      method: 'PATCH',
      url: '/admin/settings',
      headers: auth(token),
      payload: { group: 'logging', values: { log_privacy_mode: 'strict' } },
    });
    expect(back.json().logging.debug_expires_at.value).toBeNull();
  });
});

describe('出口代理池', () => {
  it('创建后列表里的 url 打码，不出现明文用户名密码', async () => {
    const { harness: h, token } = await setup();
    const create = await h.app.inject({
      method: 'POST',
      url: '/admin/proxies',
      headers: auth(token),
      payload: { name: '节点 A', url: 'http://alice:s3cr3t@proxy.example.com:8080' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.url_masked).not.toContain('s3cr3t');
    expect(created.url_masked).not.toContain('alice');

    const list = await h.app.inject({ method: 'GET', url: '/admin/proxies', headers: auth(token) });
    const body = JSON.stringify(list.json());
    expect(body).not.toContain('s3cr3t');
    expect(body).not.toContain('alice');
  });

  it('批量导入：合法与非法行分别计数', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/proxies/bulk',
      headers: auth(token),
      payload: { urls: '节点1,http://a.example.com:8080\nhttp://b.example.com:8080\n这不是一个 url' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results).toHaveLength(3);
  });

  it('更新与删除', async () => {
    const { harness: h, token } = await setup();
    const create = await h.app.inject({
      method: 'POST',
      url: '/admin/proxies',
      headers: auth(token),
      payload: { name: 'A', url: 'http://a.example.com:8080' },
    });
    const id = create.json().id as string;

    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/admin/proxies/${id}`,
      headers: auth(token),
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().enabled).toBe(false);

    const del = await h.app.inject({ method: 'DELETE', url: `/admin/proxies/${id}`, headers: auth(token) });
    expect(del.statusCode).toBe(200);

    const get = await h.app.inject({ method: 'GET', url: '/admin/proxies', headers: auth(token) });
    expect(get.json().items).toHaveLength(0);
  });

  it('健康检查：能连通的地址返回 ok，无人监听的地址返回失败', async () => {
    extraServer = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => extraServer?.listen(0, '127.0.0.1', resolve));
    const address = extraServer.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const { harness: h, token } = await setup();
    const healthy = await h.app.inject({
      method: 'POST',
      url: '/admin/proxies',
      headers: auth(token),
      payload: { name: '可用', url: `http://127.0.0.1:${port}` },
    });
    const healthyId = healthy.json().id as string;
    const checkHealthy = await h.app.inject({
      method: 'POST',
      url: `/admin/proxies/${healthyId}/check`,
      headers: auth(token),
    });
    expect(checkHealthy.json().ok).toBe(true);

    const unhealthy = await h.app.inject({
      method: 'POST',
      url: '/admin/proxies',
      headers: auth(token),
      payload: { name: '不可用', url: 'http://127.0.0.1:1' },
    });
    const unhealthyId = unhealthy.json().id as string;
    const checkUnhealthy = await h.app.inject({
      method: 'POST',
      url: `/admin/proxies/${unhealthyId}/check`,
      headers: auth(token),
    });
    expect(checkUnhealthy.json().ok).toBe(false);
  });

  it('绑定账号出口：POST /admin/accounts/:id/proxy', async () => {
    const { harness: h, token } = await setup();
    const account = h.context.accounts.upsert({
      tid: 't1',
      oid: 'o1',
      email: null,
      displayName: null,
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: null, expiresAt: null },
    });
    const proxy = await h.app.inject({
      method: 'POST',
      url: '/admin/proxies',
      headers: auth(token),
      payload: { name: 'A', url: 'http://a.example.com:8080' },
    });
    const proxyId = proxy.json().id as string;

    const bind = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/proxy`,
      headers: auth(token),
      payload: { proxy_id: proxyId },
    });
    expect(bind.statusCode).toBe(200);
    expect(bind.json().proxy_node_id).toBe(proxyId);

    const list = await h.app.inject({ method: 'GET', url: '/admin/proxies', headers: auth(token) });
    expect(list.json().items[0].bound_accounts).toEqual([account.id]);

    const unbind = await h.app.inject({
      method: 'POST',
      url: `/admin/accounts/${account.id}/proxy`,
      headers: auth(token),
      payload: { proxy_id: null },
    });
    expect(unbind.json().proxy_node_id).toBeNull();
  });
});

describe('GET /admin/codex-config', () => {
  it('生成的 TOML 固定 wire_api = "responses"', async () => {
    harness = await createTestHarness({ PUBLIC_API_BASE_URL: 'https://codex.example.com' });
    const token = await loginAdmin(harness.app);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/admin/codex-config?api_key_env=MY_KEY',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.toml).toContain('wire_api = "responses"');
    expect(body.toml).toContain('env_key = "MY_KEY"');
    expect(body.base_url).toBe('https://codex.example.com');
  });
});

describe('文件管理视角', () => {
  it('GET /admin/files 与 DELETE /admin/files/:id', async () => {
    const { harness: h, token } = await setup();
    const apiKey = h.context.apiKeys.create({ name: 'k1' });
    const file = h.context.fileRepo.create({
      id: 'file_1',
      apiKeyId: apiKey.id,
      filename: 'a.txt',
      purpose: 'assistants',
      mimeType: 'text/plain',
      kind: 'text',
      bytes: 10,
      sha256: 'abc',
      status: 'processed',
      extractedText: 'hi',
      extractionNote: null,
      expiresAt: null,
    });

    const list = await h.app.inject({ method: 'GET', url: '/admin/files', headers: auth(token) });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().total_bytes).toBe(10);

    const del = await h.app.inject({ method: 'DELETE', url: `/admin/files/${file.id}`, headers: auth(token) });
    expect(del.statusCode).toBe(200);

    const listAfter = await h.app.inject({ method: 'GET', url: '/admin/files', headers: auth(token) });
    expect(listAfter.json().items).toHaveLength(0);
  });

  it('POST /admin/files/cleanup 返回删除数与释放字节数', async () => {
    const { harness: h, token } = await setup();
    const apiKey = h.context.apiKeys.create({ name: 'k1' });
    h.context.fileRepo.create({
      id: 'file_expired',
      apiKeyId: apiKey.id,
      filename: 'a.txt',
      purpose: 'assistants',
      mimeType: 'text/plain',
      kind: 'text',
      bytes: 100,
      sha256: 'abc',
      status: 'processed',
      extractedText: 'hi',
      extractionNote: null,
      expiresAt: Date.now() - 1000,
    });

    const res = await h.app.inject({ method: 'POST', url: '/admin/files/cleanup', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted_files).toBe(1);
    expect(body.freed_bytes).toBe(100);
  });
});

describe('GET /admin/capabilities', () => {
  it('未标注任何 native，图片输入默认 unsupported', async () => {
    const { harness: h, token } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/admin/capabilities', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.matrix.some((row: { status: string }) => row.status === 'native')).toBe(false);
    const imageRow = body.matrix.find((row: { feature: string }) => row.feature.includes('input_image'));
    expect(imageRow.status).toBe('unsupported');
  });
});
