import { afterEach, describe, expect, it } from 'vitest';
import type { ApiKeyCreated } from '@m365-codex/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiError } from '@m365-codex/shared';
import { createApiKeyGuard, LoginThrottle } from '../src/gateway/auth.js';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';

/**
 * Test trực tiếp guard của gateway API Key.
 * Ở đây tự dựng một instance Fastify tối thiểu gắn guard, tránh việc thêm endpoint tạm vào bảng định tuyến production chỉ để test.
 */

let harness: TestHarness | undefined;
let probe: FastifyInstance | undefined;

afterEach(async () => {
  await probe?.close();
  probe = undefined;
  await harness?.close();
  harness = undefined;
});

async function buildProbe(): Promise<{ harness: TestHarness; probe: FastifyInstance; key: string }> {
  harness = await createTestHarness();
  const created = harness.context.apiKeys.create({ name: '网关测试' }) as ApiKeyCreated;

  probe = Fastify({ logger: false });
  probe.setErrorHandler<Error>((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.status).send(error.toBody(String(request.id)));
      return;
    }
    reply.code(500).send({ message: error.message });
  });
  probe.get('/guarded', { preHandler: createApiKeyGuard(harness.context) }, async (request) => ({
    api_key_id: request.apiKeyRow?.id,
    limits: request.apiKeyLimits,
  }));
  await probe.ready();

  return { harness, probe, key: created.key };
}

describe('extractApiKey', () => {
  it('同时支持 Authorization 与 X-API-Key', async () => {
    const { probe: p, key } = await buildProbe();
    const viaBearer = await p.inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Bearer ${key}` },
    });
    const viaHeader = await p.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': key } });
    expect(viaBearer.statusCode).toBe(200);
    expect(viaHeader.statusCode).toBe(200);
  });
});

describe('createApiKeyGuard', () => {
  it('缺少 Key 返回 401', async () => {
    const { probe: p } = await buildProbe();
    const response = await p.inject({ method: 'GET', url: '/guarded' });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { type: string } }).error.type).toBe('authentication_error');
  });

  it('格式非法的 Key 返回 401', async () => {
    const { probe: p } = await buildProbe();
    const response = await p.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-api-key': 'not-a-key' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('未知但格式合法的 Key 返回 401', async () => {
    const { probe: p } = await buildProbe();
    const response = await p.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-api-key': `sk-${'a'.repeat(52)}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('停用的 Key 返回 403 并说明原因', async () => {
    const { harness: h, probe: p, key } = await buildProbe();
    const row = h.db.prepare('SELECT id FROM api_keys LIMIT 1').get() as { id: string };
    h.context.apiKeys.update(row.id, { enabled: false });

    const response = await p.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': key } });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { message: string } }).error.message).toContain('停用');
  });

  it('撤销的 Key 返回 403', async () => {
    const { harness: h, probe: p, key } = await buildProbe();
    const row = h.db.prepare('SELECT id FROM api_keys LIMIT 1').get() as { id: string };
    h.context.apiKeys.revoke(row.id);

    const response = await p.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': key } });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { message: string } }).error.message).toContain('撤销');
  });

  it('尚未生效与已过期的 Key 都返回 403', async () => {
    harness = await createTestHarness();
    const future = harness.context.apiKeys.create({ name: '未来', startsAt: Date.now() + 60_000 });
    const expired = harness.context.apiKeys.create({ name: '过期', expiresAt: Date.now() - 1 });

    probe = Fastify({ logger: false });
    probe.setErrorHandler<Error>((error, request, reply) => {
      if (error instanceof ApiError) {
        reply.code(error.status).send(error.toBody(String(request.id)));
        return;
      }
      reply.code(500).send({ message: error.message });
    });
    probe.get('/guarded', { preHandler: createApiKeyGuard(harness.context) }, async () => ({ ok: true }));
    await probe.ready();

    const notYet = await probe.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-api-key': future.key },
    });
    const tooLate = await probe.inject({
      method: 'GET',
      url: '/guarded',
      headers: { 'x-api-key': expired.key },
    });
    expect(notYet.statusCode).toBe(403);
    expect(notYet.body).toContain('尚未生效');
    expect(tooLate.statusCode).toBe(403);
    expect(tooLate.body).toContain('过期');
  });

  it('通过校验后记录最近使用时间，并把累计请求次数 +1（§10.1）', async () => {
    const { harness: h, probe: p, key } = await buildProbe();
    await p.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': key } });
    await p.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': key } });
    const row = h.db.prepare('SELECT last_used_at, request_count FROM api_keys LIMIT 1').get() as {
      last_used_at: number | null;
      request_count: number;
    };
    expect(row.last_used_at).toBeTypeOf('number');
    expect(row.request_count).toBe(2);
  });

  it('apiKeyLimits：Key 未设置时用全局天花板兜底（§10.1）', async () => {
    const { probe: p, key } = await buildProbe();
    const response = await p.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': key } });
    const body = response.json() as { limits: { maxToolCalls: number; maxFileBytes: number } };
    expect(body.limits.maxToolCalls).toBe(harness?.config.tools.maxTotalCalls);
    expect(body.limits.maxFileBytes).toBe(harness?.config.files.maxFileBytes);
  });

  it('apiKeyLimits：Key 设置的值比全局更严时保留 Key 的值，更松时被裁剪', async () => {
    harness = await createTestHarness();
    const strictKey = harness.context.apiKeys.create({ name: '更严', maxToolCalls: 1, maxFileBytes: 100 });
    const looseKey = harness.context.apiKeys.create({
      name: '更松',
      maxToolCalls: 10_000_000,
      maxFileBytes: 10_000_000_000,
    });

    probe = Fastify({ logger: false });
    probe.setErrorHandler<Error>((error, request, reply) => {
      if (error instanceof ApiError) {
        reply.code(error.status).send(error.toBody(String(request.id)));
        return;
      }
      reply.code(500).send({ message: error.message });
    });
    probe.get('/guarded', { preHandler: createApiKeyGuard(harness.context) }, async (request) => ({
      limits: request.apiKeyLimits,
    }));
    await probe.ready();

    const strictRes = await probe.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': strictKey.key } });
    expect((strictRes.json() as { limits: { maxToolCalls: number; maxFileBytes: number } }).limits).toEqual({
      maxToolCalls: 1,
      maxFileBytes: 100,
    });

    const looseRes = await probe.inject({ method: 'GET', url: '/guarded', headers: { 'x-api-key': looseKey.key } });
    const looseLimits = (looseRes.json() as { limits: { maxToolCalls: number; maxFileBytes: number } }).limits;
    expect(looseLimits.maxToolCalls).toBe(harness.config.tools.maxTotalCalls);
    expect(looseLimits.maxFileBytes).toBe(harness.config.files.maxFileBytes);
  });
});

describe('LoginThrottle', () => {
  it('超过阈值后抛出限流错误，重置后恢复', () => {
    const throttle = new LoginThrottle(3, 60_000);
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      throttle.check('1.2.3.4', now);
      throttle.recordFailure('1.2.3.4', now);
    }
    expect(() => throttle.check('1.2.3.4', now)).toThrow(/登录失败次数过多/);
    throttle.reset('1.2.3.4');
    expect(() => throttle.check('1.2.3.4', now)).not.toThrow();
  });

  it('时间窗口过期后自动放行', () => {
    const throttle = new LoginThrottle(1, 1_000);
    const now = Date.now();
    throttle.recordFailure('5.6.7.8', now);
    expect(() => throttle.check('5.6.7.8', now)).toThrow();
    expect(() => throttle.check('5.6.7.8', now + 2_000)).not.toThrow();
  });
});
