import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, loginAdmin, type TestHarness } from './helpers/testApp.js';

/**
 * `GET /metrics` (tương ứng kế hoạch triển khai §17, hợp đồng §3).
 *
 * Độ bao phủ: Mặc định yêu cầu xác thực phiên admin, có thể cấu hình tắt xác thực, có thể cấu hình tắt toàn bộ,
 * định dạng văn bản Prometheus, gauge điền tại thời điểm scrape, không chứa bất kỳ nội dung người dùng nào.
 */

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('鉴权（默认 METRICS_REQUIRE_AUTH=true）', () => {
  it('无管理会话返回 401', async () => {
    harness = await createTestHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('带管理会话返回 Prometheus 文本', async () => {
    harness = await createTestHarness();
    const token = await loginAdmin(harness.app);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# TYPE m365codex_requests_total counter');
  });
});

describe('METRICS_REQUIRE_AUTH=false', () => {
  it('无鉴权也能抓取', async () => {
    harness = await createTestHarness({ METRICS_REQUIRE_AUTH: 'false' });
    const res = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });
});

describe('METRICS_ENABLED=false', () => {
  it('整个端点当作不存在，返回 404', async () => {
    harness = await createTestHarness({ METRICS_ENABLED: 'false' });
    const res = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });
});

describe('抓取时的即时值', () => {
  it('账号按状态分类的 gauge、在途请求数、存储占用都会现填', async () => {
    harness = await createTestHarness({ METRICS_REQUIRE_AUTH: 'false' });
    harness.context.accounts.upsert({
      tid: 't1',
      oid: 'o1',
      email: 'someone@contoso.example.invalid',
      displayName: '张三',
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('m365codex_accounts{status="probing"} 1');
    expect(res.body).toContain('m365codex_requests_in_flight');
    expect(res.body).toContain('m365codex_db_bytes');
    expect(res.body).toContain('m365codex_files_bytes');
  });

  it('请求量与耗时会随着真实调用累积', async () => {
    harness = await createTestHarness({ METRICS_REQUIRE_AUTH: 'false' });
    await harness.app.inject({ method: 'GET', url: '/healthz' });
    const res = await harness.app.inject({ method: 'GET', url: '/metrics' });
    // Làm sạch label thay khoảng trắng bằng gạch dưới (sanitizeLabelValue), "GET /healthz" thành "GET_/healthz"
    expect(res.body).toContain('m365codex_requests_total{endpoint="GET_/healthz",status="200"}');
    expect(res.body).toContain('m365codex_request_duration_seconds_count{endpoint="GET_/healthz"}');
  });
});

describe('隐私', () => {
  it('不含邮箱、姓名等用户内容', async () => {
    harness = await createTestHarness({ METRICS_REQUIRE_AUTH: 'false' });
    harness.context.accounts.upsert({
      tid: 't1',
      oid: 'o1',
      email: 'someone@contoso.example.invalid',
      displayName: '张三',
      source: 'oauth',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).not.toContain('@');
    expect(res.body).not.toContain('张三');
  });
});
