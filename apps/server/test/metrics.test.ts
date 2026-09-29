import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/observability/metrics.js';

/**
 * Metrics: Định dạng chuẩn, có thể tích lũy và **không đưa nội dung người dùng ra ngoài** (§17 yêu cầu rõ ràng
 * Metrics mặc định không chứa email, prompt, văn bản đầu ra hoặc Token).
 */

describe('计数器', () => {
  it('累加并渲染成 Prometheus 文本', () => {
    const m = new Metrics();
    m.requests.inc({ endpoint: '/v1/responses', status: '200' });
    m.requests.inc({ endpoint: '/v1/responses', status: '200' });
    m.requests.inc({ endpoint: '/v1/responses', status: '500' });
    const out = m.render();
    expect(out).toContain('# TYPE m365codex_requests_total counter');
    expect(out).toContain('m365codex_requests_total{endpoint="/v1/responses",status="200"} 2');
    expect(out).toContain('m365codex_requests_total{endpoint="/v1/responses",status="500"} 1');
  });

  it('没有任何观测时也输出一行 0，避免抓取端看不到指标', () => {
    expect(new Metrics().render()).toContain('m365codex_tool_calls_total 0');
  });
});

describe('直方图', () => {
  it('分桶计数与 sum/count 正确', () => {
    const m = new Metrics();
    for (const v of [0.05, 0.3, 3, 45]) m.requestDuration.observe(v, { endpoint: '/v1/responses' });
    const out = m.render();
    expect(out).toContain('m365codex_request_duration_seconds_count{endpoint="/v1/responses"} 4');
    expect(out).toContain('le="0.1"} 1');
    expect(out).toContain('le="+Inf"} 4');
  });
});

describe('隐私', () => {
  it('标签值里的用户内容被清洗，不会原样出现在指标里', () => {
    const m = new Metrics();
    // Cố ý đưa vào những thứ không được phép xuất hiện: email, prompt, dạng Token
    m.upstreamErrors.inc({ account: 'someone@contoso.example.invalid' });
    m.requests.inc({ endpoint: '帮我写一段代码 with spaces' });
    m.tokenRefresh.inc({ result: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' });
    const out = m.render();
    expect(out).not.toContain('@');
    expect(out).not.toContain('帮我写一段代码');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  });

  it('超长标签值被截断，避免时间序列爆炸', () => {
    const m = new Metrics();
    m.requests.inc({ endpoint: 'x'.repeat(500) });
    const line = m.render().split('\n').find((l) => l.startsWith('m365codex_requests_total{')) ?? '';
    expect(line.length).toBeLessThan(150);
  });
});

describe('即时值', () => {
  it('gauge 可覆盖写入并渲染', () => {
    const m = new Metrics();
    m.setGauge('m365codex_accounts', '账号数', 3, { state: 'online' });
    m.setGauge('m365codex_accounts', '账号数', 1, { state: 'cooldown' });
    m.setGauge('m365codex_accounts', '账号数', 2, { state: 'online' });
    const out = m.render();
    expect(out).toContain('# TYPE m365codex_accounts gauge');
    expect(out).toContain('m365codex_accounts{state="online"} 2');
    expect(out).toContain('m365codex_accounts{state="cooldown"} 1');
  });
});
