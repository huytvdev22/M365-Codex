import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, loginAdmin, TEST_ADMIN_PASSWORD, type TestHarness } from './helpers/testApp.js';

/**
 * Hành vi fallback của Content-Type.
 *
 * Nguyên nhân: Client thật (như Invoke-RestMethod của PowerShell) khi POST không có body
 * vẫn kèm application/x-www-form-urlencoded, dẫn đến endpoint vốn không cần body lại trả về 415.
 */

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('无请求体的 POST', () => {
  it('带 form-urlencoded 头但没有请求体时正常放行', async () => {
    harness = await createTestHarness();
    const token = await loginAdmin(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/oauth/authorize-url',
      headers: { ...auth(token), 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { state: string }).state).toBeTypeOf('string');
  });

  it('登出同样不受 Content-Type 影响', async () => {
    harness = await createTestHarness();
    const token = await loginAdmin(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/logout',
      headers: { ...auth(token), 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('完全不带 Content-Type 也能调用', async () => {
    harness = await createTestHarness();
    const token = await loginAdmin(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/oauth/authorize-url',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('不支持的 Content-Type 且有请求体', () => {
  it('返回 415 与统一错误体', async () => {
    harness = await createTestHarness();
    const token = await loginAdmin(harness.app);

    // application/xml không có parser, sẽ rơi vào parser dự phòng `*`
    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: { ...auth(token), 'content-type': 'application/xml' },
      payload: '<name>不是 JSON</name>',
    });
    expect(response.statusCode).toBe(415);
    const body = response.json() as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('415');
    expect(body.error.message).toContain('application/json');
  });

  it('form-urlencoded 带非空请求体同样返回 415', async () => {
    harness = await createTestHarness();
    const token = await loginAdmin(harness.app);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/admin/api-keys',
      headers: { ...auth(token), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=test',
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('JSON 请求体照常工作', () => {
  it('登录仍然要求合法 JSON', async () => {
    harness = await createTestHarness();
    const ok = await harness.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    });
    expect(ok.statusCode).toBe(200);

    const broken = await harness.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/json' },
      payload: '{ 不是合法 json',
    });
    expect(broken.statusCode).toBe(400);
    expect((broken.json() as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });
});
