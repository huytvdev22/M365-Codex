import { afterEach, describe, expect, it } from 'vitest';
import { startMockSydneyServer, type MockSydneyServer } from '../../apps/server/test/helpers/mockSydneyServer.js';
import { caseHandshakeAuth } from '../src/cases/handshake.js';
import { caseBasicTextChat, caseStreamingText } from '../src/cases/conversation.js';
import { caseRequestCancellation } from '../src/cases/control.js';
import { caseSingleToolCall } from '../src/cases/tools.js';
import { ALL_CASES } from '../src/cases/index.js';
import { makeFakeContext } from './helpers/fakeContext.js';

let server: MockSydneyServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('cases 对模拟上游的端到端行为', () => {
  it('caseHandshakeAuth：正常握手判定为 native', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    const result = await caseHandshakeAuth(makeFakeContext(server.url));
    expect(result.status).toBe('native');
    expect(result.index).toBe(1);
  });

  it('caseHandshakeAuth：401 判定为 unknown（未知的握手失败分类，见 classifyHandshakeFailure）', async () => {
    server = await startMockSydneyServer({ kind: 'http-status', status: 401 });
    const result = await caseHandshakeAuth(makeFakeContext(server.url));
    expect(result.status).toBe('unstable');
    expect(result.errorCategory).toBe('refresh_and_retry');
  });

  it('caseBasicTextChat：收到非空回复判定为 native', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['你好，这是模拟回复。'] });
    const result = await caseBasicTextChat(makeFakeContext(server.url));
    expect(result.status).toBe('native');
  });

  it('caseStreamingText：多个分片判定为 native，单个分片判定为 partial', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['a', 'b', 'c'] });
    const multi = await caseStreamingText(makeFakeContext(server.url));
    expect(multi.status).toBe('native');
    await server.close();

    server = await startMockSydneyServer({ kind: 'normal', chunks: ['一次性整段回复'] });
    const single = await caseStreamingText(makeFakeContext(server.url));
    expect(single.status).toBe('partial');
  });

  it('caseRequestCancellation：收到首个分片后取消，判定为 native', async () => {
    server = await startMockSydneyServer({ kind: 'slow', chunks: ['a', 'b', 'c', 'd', 'e'], delayMs: 50 });
    const result = await caseRequestCancellation(makeFakeContext(server.url));
    expect(result.status).toBe('native');
  });

  it('caseSingleToolCall：3 次采样全部一次通过时统计正确', async () => {
    server = await startMockSydneyServer({
      kind: 'tool-call',
      callId: 'call_1',
      name: 'probe_get_time',
      arguments: '{"timezone":"Asia/Shanghai"}',
    });
    const ctx = makeFakeContext(server.url, { repeat: 3, delayMs: 0 });
    const result = await caseSingleToolCall(ctx);
    const stats = result.evidence.tool_call_stats as { trials: number; firstPassSchemaOk: number };
    expect(stats.trials).toBe(3);
    expect(stats.firstPassSchemaOk).toBe(3);
    expect(result.status).toBe('native');
  });

  it('用例内部抛异常时 runCaseSafely 接住转成 unknown，而不是让整轮探测中断（§6）', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['ok'] });
    // ctx.tokenManager là object rỗng, gọi .refresh() sẽ ném trực tiếp TypeError
    const ctx = makeFakeContext(server.url);
    const definition = ALL_CASES.find((c) => c.id === 'access_token_refresh');
    expect(definition).toBeDefined();
    const result = await definition?.run(ctx);
    expect(result?.status).toBe('unknown');
    expect(result?.errorCategory).toBe('probe_internal_error');
  });

  it('ALL_CASES 恰好覆盖 §3.1 的全部 29 项，序号从 1 到 29 且不重复', () => {
    expect(ALL_CASES).toHaveLength(29);
    const indices = ALL_CASES.map((c) => c.index).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    const ids = new Set(ALL_CASES.map((c) => c.id));
    expect(ids.size).toBe(29);
  });
});
