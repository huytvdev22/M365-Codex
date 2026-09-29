import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * Test tích hợp toàn trình /v1/responses: Route → Service → State machine → Dispatcher → Kết nối thật → Mock Sydney upstream.
 * Không chạm mạng thật và thông tin xác thực thật.
 */

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await server?.close();
  server = undefined;
});

async function setup(
  behaviorChunks: string[] = ['你好', '，世界'],
): Promise<{ h: TestHarness; apiKey: string; accountId: string }> {
  server = await startMockSydneyServer({ kind: 'normal', chunks: behaviorChunks });
  harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
  const account = harness.context.accounts.upsert({
    tid: 'tenant-1',
    oid: 'user-1',
    email: 'user@office.example.invalid',
    displayName: 'user',
    source: 'oauth',
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 },
  });
  const key = harness.context.apiKeys.create({ name: 'codex' });
  return { h: harness, apiKey: key.key, accountId: account.id };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** Phân tích văn bản SSE thành mảng sự kiện. */
function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of body.split('\n\n')) {
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue;
    events.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
    });
  }
  return events;
}

describe('GET /v1/models', () => {
  it('返回模型列表', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/v1/models', headers: auth(apiKey) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { object: string; data: { id: string }[] };
    expect(body.object).toBe('list');
    expect(body.data.some((m) => m.id === 'gpt-5-codex')).toBe(true);
  });

  it('无 API Key 返回 401', async () => {
    const { h } = await setup();
    expect((await h.app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401);
  });
});

describe('POST /v1/responses 非流式', () => {
  it('返回完整 Response 对象与拼接文本', async () => {
    const { h, apiKey } = await setup(['你好', '，世界']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: '在吗' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      object: string;
      status: string;
      model: string;
      output: { type: string; content?: { text: string }[] }[];
    };
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('gpt-5-codex');
    expect(body.id.startsWith('resp_')).toBe(true);
    const message = body.output.find((i) => i.type === 'message');
    expect(message?.content?.[0]?.text).toBe('你好，世界');
    // Upstream đã nhận được input của người dùng (M6: văn bản tái tạo ngữ cảnh theo vai trò, xem responses/schema.ts)
    expect(server?.invocationTexts).toEqual(['【用户】\n在吗']);
  });

  it('透传 model 与 reasoning.effort 给上游', async () => {
    const { h, apiKey } = await setup(['ok']);
    await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: 'q', reasoning: { effort: 'high' } },
    });
    // Thông tin requested được ghi vào database
    const row = h.db.prepare('SELECT requested_model, requested_reasoning_effort FROM responses').get() as {
      requested_model: string;
      requested_reasoning_effort: string;
    };
    expect(row.requested_model).toBe('gpt-5-codex');
    expect(row.requested_reasoning_effort).toBe('high');
  });

  it('没有账号时返回 503 account_pool_exhausted', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['x'] });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    const key = harness.context.apiKeys.create({ name: 'codex' });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: 'q' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { type: string } }).error.type).toBe('account_pool_exhausted');
  });

  it('图片输入返回清晰错误，不静默', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { type: string } }).error.type).toBe('unsupported_feature');
  });
});

describe('POST /v1/responses 流式 (SSE)', () => {
  it('SSE 事件齐全、序号单调、response_id 稳定', async () => {
    const { h, apiKey } = await setup(['Hello', ' world']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: 'hi', stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.body);
    const eventNames = events.map((e) => e.event);
    expect(eventNames[0]).toBe('response.created');
    expect(eventNames).toContain('response.output_text.delta');
    expect(eventNames.at(-1)).toBe('response.completed');

    // Số thứ tự đơn điệu
    const seqs = events.map((e) => e.data.sequence_number as number);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }
    // response_id ổn định xuyên suốt
    const ids = new Set(events.map((e) => e.data.response_id));
    expect(ids.size).toBe(1);

    // Ghép các phần tăng dần thành văn bản hoàn chỉnh
    const text = events
      .filter((e) => e.event === 'response.output_text.delta')
      .map((e) => e.data.delta as string)
      .join('');
    expect(text).toBe('Hello world');
  });
});

describe('GET /v1/responses/:id', () => {
  it('可取回已完成的 Response', async () => {
    const { h, apiKey } = await setup(['答案']);
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q' },
      })
    ).json() as { id: string };

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/responses/${created.id}`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }).id).toBe(created.id);
  });

  it('不存在返回 404', async () => {
    const { h, apiKey } = await setup();
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/responses/resp_nope', headers: auth(apiKey) })).statusCode,
    ).toBe(404);
  });

  it('别的 API Key 看不到（返回 404）', async () => {
    const { h, apiKey } = await setup(['x']);
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q' },
      })
    ).json() as { id: string };

    const otherKey = h.context.apiKeys.create({ name: 'other' });
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/responses/${created.id}`,
      headers: auth(otherKey.key),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('previous_response_id 粘性', () => {
  it('续接时复用上一轮的账号', async () => {
    const { h, apiKey } = await setup(['第一轮']);
    // Thêm một tài khoản nữa để tạo môi trường đa tài khoản
    const second = h.context.accounts.upsert({
      tid: 'tenant-1',
      oid: 'user-2',
      email: 'u2@office.example.invalid',
      displayName: 'u2',
      source: 'oauth',
      tokens: { accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
    });
    void second;

    const first = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q1' },
      })
    ).json() as { id: string };

    const firstAccount = (
      h.db.prepare('SELECT account_id FROM responses WHERE id = ?').get(first.id) as { account_id: string }
    ).account_id;

    const second2 = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q2', previous_response_id: first.id },
      })
    ).json() as { id: string };

    const secondAccount = (
      h.db.prepare('SELECT account_id FROM responses WHERE id = ?').get(second2.id) as { account_id: string }
    ).account_id;

    expect(secondAccount).toBe(firstAccount);
  });
});

describe('取消', () => {
  it('DELETE 与 cancel 对已完成的 response 的处理', async () => {
    const { h, apiKey } = await setup(['done']);
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: auth(apiKey),
        payload: { model: 'm', input: 'q' },
      })
    ).json() as { id: string };

    // Đã hoàn thành, cancel trả về 400
    const cancel = await h.app.inject({
      method: 'POST',
      url: `/v1/responses/${created.id}/cancel`,
      headers: auth(apiKey),
    });
    expect(cancel.statusCode).toBe(400);

    // delete idempotent trả về deleted
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/v1/responses/${created.id}`,
      headers: auth(apiKey),
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: boolean }).deleted).toBe(true);
  });
});

describe('上游失败', () => {
  it('completion 带错误 → 非流式返回 502', async () => {
    server = await startMockSydneyServer({ kind: 'completion-error', message: '模型拒答' });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    harness.context.accounts.upsert({
      tid: 't',
      oid: 'o',
      email: null,
      displayName: null,
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const key = harness.context.apiKeys.create({ name: 'k' });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: 'q' },
    });
    // upstream_error trong stream (không thể thử lại) → state machine kết thúc failed → non-stream ném lỗi
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});
