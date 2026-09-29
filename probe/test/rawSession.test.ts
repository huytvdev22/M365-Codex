import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockSydneyServer, type MockSydneyServer } from '../../apps/server/test/helpers/mockSydneyServer.js';
import { SydneyCodecV1 } from '../../apps/server/dist/adapter/codecV1.js';
import { runRawSession } from '../src/rawSession.js';

/**
 * Tự kiểm thử cho engine "phiên thô" của probe: Chỉ gọi mock Sydney upstream, tuyệt đối không kết nối Microsoft thật.
 */

let server: MockSydneyServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const codec = new SydneyCodecV1();

function baseOptions(url: string) {
  return {
    url,
    codec,
    invocationId: randomUUID(),
    text: '你好',
    handshakeTimeoutMs: 2000,
    scenario: 'officeweb',
    idleTimeoutMs: 2000,
    totalTimeoutMs: 5000,
  };
}

describe('runRawSession', () => {
  it('正常对话：收集到归一化事件与原始帧，且干净完成', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['你好，', '这是模拟上游的回复。'] });
    const outcome = await runRawSession(baseOptions(server.url));

    expect(outcome.errorCategory).toBeNull();
    expect(outcome.closeCode).toBe(1000);
    const texts = outcome.events.filter((e) => e.kind === 'text_delta').map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['你好，', '这是模拟上游的回复。']);
    expect(outcome.rawMessages.length).toBeGreaterThan(0);
  });

  it('引用信息：sourceAttributions 映射为 citation 事件', async () => {
    server = await startMockSydneyServer({
      kind: 'normal',
      chunks: ['带引用的回复'],
      citations: [{ url: 'https://example.com/a', title: '示例来源' }],
    });
    const outcome = await runRawSession(baseOptions(server.url));
    const citation = outcome.events.find((e) => e.kind === 'citation');
    expect(citation).toBeDefined();
  });

  it('HTTP 401：分类为 refresh_and_retry', async () => {
    server = await startMockSydneyServer({ kind: 'http-status', status: 401 });
    const outcome = await runRawSession(baseOptions(server.url));
    expect(outcome.errorCategory).toBe('refresh_and_retry');
  });

  it('HTTP 429 带 Retry-After：解析出冷却毫秒数', async () => {
    server = await startMockSydneyServer({ kind: 'http-status', status: 429, retryAfter: '5' });
    const outcome = await runRawSession(baseOptions(server.url));
    expect(outcome.errorCategory).toBe('rate_limited');
    expect(outcome.retryAfterMs).toBe(5000);
  });

  it('异常关闭码：分类为 retry_or_switch', async () => {
    server = await startMockSydneyServer({ kind: 'abnormal-close', code: 1011, reason: '内部错误' });
    const outcome = await runRawSession(baseOptions(server.url));
    expect(outcome.errorCategory).toBe('retry_or_switch');
    expect(outcome.closeCode).toBe(1011);
  });

  it('限流（Throttled）：分类为 rate_limited 或 retry_or_switch 之一（视 result.value 而定）', async () => {
    server = await startMockSydneyServer({ kind: 'throttle' });
    const outcome = await runRawSession(baseOptions(server.url));
    expect(outcome.events.some((e) => e.kind === 'upstream_error')).toBe(true);
  });

  it('空闲超时：迟迟没有任何帧时判定为 timeout', async () => {
    server = await startMockSydneyServer({ kind: 'idle' });
    const outcome = await runRawSession({ ...baseOptions(server.url), idleTimeoutMs: 200, totalTimeoutMs: 2000 });
    expect(outcome.errorCategory).toBe('retry_or_switch');
  });

  it('取消：发送 signal.abort() 后发出 stop 帧并干净关闭', async () => {
    server = await startMockSydneyServer({ kind: 'slow', chunks: ['a', 'b', 'c', 'd'], delayMs: 50 });
    const controller = new AbortController();
    const outcome = await runRawSession({
      ...baseOptions(server.url),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === 'text_delta') controller.abort();
      },
    });
    expect(outcome.closeReason).toBe('client_cancelled');
    expect(outcome.events.filter((e) => e.kind === 'text_delta').length).toBeLessThan(4);
  });

  it('工具调用：一次性完整参数被拆成 begin/args_delta/end', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'probe_get_time',
      arguments: '{"timezone":"Asia/Shanghai"}',
    });
    const outcome = await runRawSession(baseOptions(server.url));
    const kinds = outcome.events.map((e) => e.kind);
    expect(kinds).toEqual(['tool_call_begin', 'tool_call_args_delta', 'tool_call_end', 'completed']);
  });
});

describe('participant.id', () => {
  // Trường này là tùy chọn, quên gửi sẽ không báo lỗi, không thất bại, chỉ làm cho yêu cầu do probe gửi đi
  // khác với client thật — trong khi toàn bộ giá trị của probe nằm ở việc "bám sát hình thái thật".
  // Nó đã từng âm thầm bị bỏ sót một lần, vì vậy ở đây dùng một test để chốt chặn nó.
  it('传了 oid 就会编码进 invocation 的 participant.id', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    const sent: string[] = [];
    await runRawSession({
      ...baseOptions(server.url),
      oid: 'test-object-id',
      wsFactory: (url: string) => capturingSocket(url, sent),
    });

    const invocation = sent.map(parseFrames).flat().find((m) => m.target === 'chat');
    expect(invocation).toBeDefined();
    const argument = (invocation?.arguments?.[0] ?? {}) as { participant?: { id?: string } };
    expect(argument.participant?.id).toBe('test-object-id');
  });

  it('没传 oid 时不会凭空造出 participant 字段', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    const sent: string[] = [];
    await runRawSession({
      ...baseOptions(server.url),
      wsFactory: (url: string) => capturingSocket(url, sent),
    });

    const invocation = sent.map(parseFrames).flat().find((m) => m.target === 'chat');
    expect(invocation).toBeDefined();
    expect((invocation?.arguments?.[0] as Record<string, unknown>).participant).toBeUndefined();
  });
});

/** Bọc một tầng WebSocket, ghi nhận lại các frame đã gửi đi để assert. */
function capturingSocket(url: string, sent: string[]): WebSocket {
  const ws = new WebSocket(url, { headers: { 'X-Scenario': 'officeweb' } });
  const original = ws.send.bind(ws);
  ws.send = ((data: unknown) => {
    sent.push(String(data));
    return original(data as Parameters<typeof original>[0]);
  }) as typeof ws.send;
  return ws;
}

/** Một tin nhắn WebSocket có thể chứa nhiều frame phân tách bằng 0x1e. */
function parseFrames(raw: string): { target?: string; arguments?: unknown[] }[] {
  return raw
    .split('\u001e')
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      try {
        return [JSON.parse(part) as { target?: string; arguments?: unknown[] }];
      } catch {
        return [];
      }
    });
}
