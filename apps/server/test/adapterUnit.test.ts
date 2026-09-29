import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPSTREAM_PATH_TEMPLATE,
  DEFAULT_UPSTREAM_WS_BASE,
  type UpstreamConfig,
} from '../src/config/index.js';
import { buildUpstreamUrl, redactWsUrl } from '../src/adapter/endpoint.js';
import { classifyCloseCode, classifyHttpStatus, parseRetryAfter } from '../src/adapter/errors.js';
import {
  FrameReassembler,
  parseFrame,
  RECORD_SEPARATOR,
  splitFrames,
} from '../src/adapter/protocol.js';
import { SydneyCodecV1, selectCodec } from '../src/adapter/codecV1.js';
import { AsyncQueue } from '../src/adapter/asyncQueue.js';

const upstreamConfig: UpstreamConfig = {
  wsBase: DEFAULT_UPSTREAM_WS_BASE,
  pathTemplate: DEFAULT_UPSTREAM_PATH_TEMPLATE,
  protocolVersion: 'sydney-json-v1',
  heartbeatIntervalMs: 15000,
  handshakeTimeoutMs: 15000,
  idleTimeoutMs: 60000,
  maxReconnects: 2,
  scenario: 'officeweb',
};

describe('buildUpstreamUrl', () => {
  it('填充 oid/tid 并附加 access_token', () => {
    const url = new URL(
      buildUpstreamUrl({ config: upstreamConfig, oid: 'OID1', tid: 'TID1', accessToken: 'tok' }),
    );
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toContain('OID1@TID1');
    expect(url.searchParams.get('access_token')).toBe('tok');
  });

  it('对 oid/tid 做 URL 编码', () => {
    const url = buildUpstreamUrl({
      config: upstreamConfig,
      oid: 'a/b',
      tid: 'c d',
      accessToken: 'tok',
    });
    expect(url).not.toContain('a/b');
    expect(url).toContain('a%2Fb');
  });

  it('尊重配置的自定义基址（应对端点漂移）', () => {
    const drifted = { ...upstreamConfig, wsBase: 'wss://substrate.svc.cloud.microsoft' };
    expect(buildUpstreamUrl({ config: drifted, oid: 'o', tid: 't', accessToken: 'k' })).toContain(
      'substrate.svc.cloud.microsoft',
    );
  });
});

describe('redactWsUrl', () => {
  it('抹掉 access_token', () => {
    const url = buildUpstreamUrl({ config: upstreamConfig, oid: 'o', tid: 't', accessToken: 'SECRET-TOKEN' });
    const redacted = redactWsUrl(url);
    expect(redacted).not.toContain('SECRET-TOKEN');
    expect(redacted).toContain('access_token=%5B');
  });

  it('非法 URL 也能兜底脱敏', () => {
    expect(redactWsUrl('not a url?access_token=SECRET')).not.toContain('SECRET');
  });
});

describe('parseRetryAfter', () => {
  it('解析秒数', () => {
    expect(parseRetryAfter('30')).toBe(30000);
  });

  it('解析 HTTP 日期', () => {
    const now = Date.parse('2026-07-26T00:00:00Z');
    const future = new Date(now + 45000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(45000);
  });

  it('无法解析返回 null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('随便')).toBeNull();
  });
});

describe('classifyHttpStatus', () => {
  it('401 → 刷新重试', () => {
    expect(classifyHttpStatus(401).disposition).toBe('refresh_and_retry');
  });
  it('403 → 账号禁用', () => {
    expect(classifyHttpStatus(403).disposition).toBe('account_forbidden');
  });
  it('429 → 限流并带冷却', () => {
    const error = classifyHttpStatus(429, '60');
    expect(error.disposition).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(60000);
  });
  it('5xx → 重试或切换', () => {
    expect(classifyHttpStatus(503).disposition).toBe('retry_or_switch');
  });
  it('其他 4xx → 致命', () => {
    expect(classifyHttpStatus(400).disposition).toBe('fatal_client');
  });
});

describe('classifyCloseCode', () => {
  it('1000 正常关闭不算错误', () => {
    expect(classifyCloseCode(1000)).toBeNull();
  });
  it('1008 策略违规 → 账号禁用', () => {
    expect(classifyCloseCode(1008)?.disposition).toBe('account_forbidden');
  });
  it('其他异常码 → 重试或切换', () => {
    expect(classifyCloseCode(1011)?.disposition).toBe('retry_or_switch');
  });
});

describe('splitFrames / parseFrame', () => {
  it('按 RS 切帧并保留残片', () => {
    const { frames, rest } = splitFrames(`a${RECORD_SEPARATOR}b${RECORD_SEPARATOR}partial`);
    expect(frames).toEqual(['a', 'b']);
    expect(rest).toBe('partial');
  });

  it('parseFrame 拒绝非法 JSON 与非对象', () => {
    expect(parseFrame('{"type":6}')).toEqual({ type: 6 });
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('123')).toBeNull();
  });
});

describe('FrameReassembler', () => {
  it('跨分片重组完整消息', () => {
    const r = new FrameReassembler();
    expect(r.push('{"type":')).toEqual([]);
    expect(r.push(`6}${RECORD_SEPARATOR}`)).toEqual([{ type: 6 }]);
  });

  it('一次喂入多条消息', () => {
    const r = new FrameReassembler();
    const messages = r.push(`{"type":1}${RECORD_SEPARATOR}{"type":6}${RECORD_SEPARATOR}`);
    expect(messages).toEqual([{ type: 1 }, { type: 6 }]);
  });

  it('跳过粘包中的非法帧但保留合法帧', () => {
    const r = new FrameReassembler();
    const messages = r.push(`{"type":1}${RECORD_SEPARATOR}garbage${RECORD_SEPARATOR}{"type":6}${RECORD_SEPARATOR}`);
    expect(messages).toEqual([{ type: 1 }, { type: 6 }]);
  });
});

describe('SydneyCodecV1', () => {
  const codec = new SydneyCodecV1();

  it('握手帧是 json/version 且以 RS 结尾', () => {
    const hs = codec.encodeHandshake();
    expect(hs.endsWith(RECORD_SEPARATOR)).toBe(true);
    expect(JSON.parse(hs.replace(RECORD_SEPARATOR, ''))).toEqual({ protocol: 'json', version: 1 });
  });

  it('识别握手 ack', () => {
    expect(codec.isHandshakeAck('{}')).toBe(true);
    expect(codec.isHandshakeAck(`{}${RECORD_SEPARATOR}`)).toBe(true);
    expect(codec.isHandshakeAck('{"error":"boom"}')).toBe(false);
  });

  it('invocation 携带用户文本、单数 message 对象与透传参数', () => {
    const raw = codec.encodeInvocation({
      invocationId: 'inv1',
      text: '你好',
      participantId: 'oid-1',
      passthrough: { model: 'gpt-5-codex', reasoning: { effort: 'high' } },
    });
    const parsed = JSON.parse(raw.replace(RECORD_SEPARATOR, ''));
    expect(parsed.invocationId).toBe('inv1');
    const arg = parsed.arguments[0];
    // Trường thật: Đối tượng message số ít, không phải mảng messages (xác nhận thực tế qua M0)
    expect(arg.message).toEqual({ author: 'user', inputMethod: 'Keyboard', text: '你好', messageType: 'Chat' });
    expect(arg.participant).toEqual({ id: 'oid-1' });
    expect(arg.isStartOfSession).toBe(true);
    expect(arg.conversationId).toBeUndefined();
    // Giữ nguyên tham số passthrough, không viết lại
    expect(arg.model).toBe('gpt-5-codex');
    expect(arg.reasoning).toEqual({ effort: 'high' });
  });

  it('续接会话时带 conversationId 且 isStartOfSession 为 false', () => {
    const raw = codec.encodeInvocation({ invocationId: 'inv2', text: '继续', conversationRef: 'conv-1' });
    const arg = JSON.parse(raw.replace(RECORD_SEPARATOR, '')).arguments[0];
    expect(arg.conversationId).toBe('conv-1');
    expect(arg.isStartOfSession).toBe(false);
  });

  it('把 stream item 映射为 text_delta（真实响应负载在 item 里）', () => {
    const events = codec.mapMessageToEvents({
      type: 2,
      item: { messages: [{ author: 'bot', text: 'hello' }] },
    });
    expect(events).toEqual([{ kind: 'text_delta', text: 'hello' }]);
  });

  it('跳过回显的用户消息', () => {
    const events = codec.mapMessageToEvents({
      type: 2,
      item: { messages: [{ author: 'user', text: 'echo' }] },
    });
    expect(events).toEqual([]);
  });

  it('映射引用来源', () => {
    const events = codec.mapMessageToEvents({
      type: 2,
      item: {
        messages: [
          {
            author: 'bot',
            text: 'x',
            sourceAttributions: [{ seeMoreUrl: 'https://a.example', providerDisplayName: 'A' }],
          },
        ],
      },
    });
    expect(events).toContainEqual({ kind: 'citation', url: 'https://a.example', title: 'A' });
  });

  it('spokenText 不再当成 reasoning_delta（实测内容与 text 一致，只是语音合成版本）', () => {
    const events = codec.mapMessageToEvents({
      type: 2,
      item: { messages: [{ author: 'bot', text: 'hello', spokenText: 'hello' }] },
    });
    expect(events).toEqual([{ kind: 'text_delta', text: 'hello' }]);
  });

  it('completion 无错误 → completed', () => {
    expect(codec.mapMessageToEvents({ type: 3 })).toEqual([{ kind: 'completed', stopReason: null }]);
    expect(codec.isCompletion({ type: 3 })).toBe(true);
  });

  it('completion 带错误 → upstream_error（不可重试）', () => {
    const events = codec.mapMessageToEvents({ type: 3, error: '出错了' });
    expect(events).toEqual([{ kind: 'upstream_error', message: '出错了', retryable: false }]);
  });

  it('Throttled 结果 → 可重试的 upstream_error（且不下发 bot 的道歉文案）', () => {
    const events = codec.mapMessageToEvents({
      type: 2,
      item: {
        result: { value: 'Throttled', message: '限流' },
        messages: [{ author: 'bot', text: '道歉文案', turnState: 'Failed' }],
      },
    });
    expect(events).toEqual([{ kind: 'upstream_error', message: '限流', retryable: true }]);
  });

  it('真实观察到的 InvalidCopilotLicense 错误 → 不可重试的 upstream_error', () => {
    const events = codec.mapMessageToEvents({
      type: 2,
      item: {
        result: {
          value: 'ForbiddenRequest',
          message: '你似乎没有有效的许可证。',
          errorCode: 'InvalidCopilotLicense',
        },
        messages: [{ author: 'bot', text: '你似乎没有有效的许可证。', turnState: 'Failed' }],
      },
    });
    expect(events).toEqual([
      { kind: 'upstream_error', message: '你似乎没有有效的许可证。', retryable: false },
    ]);
  });

  it('ping/close 不产生业务事件', () => {
    expect(codec.mapMessageToEvents({ type: 6 })).toEqual([]);
    expect(codec.mapMessageToEvents({ type: 7 })).toEqual([]);
  });
});

describe('selectCodec', () => {
  it('已知版本返回对应 codec', () => {
    expect(selectCodec('sydney-json-v1').version).toBe('sydney-json-v1');
  });
  it('未知版本回退到 v1', () => {
    expect(selectCodec('sydney-json-v999').version).toBe('sydney-json-v1');
  });
});

describe('AsyncQueue', () => {
  it('先 push 后消费', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    const out: number[] = [];
    for await (const item of q) out.push(item);
    expect(out).toEqual([1, 2]);
  });

  it('先等待后 push', async () => {
    const q = new AsyncQueue<number>();
    const p = q.next();
    q.push(42);
    expect(await p).toEqual({ value: 42, done: false });
  });

  it('fail 让消费者收到异常', async () => {
    const q = new AsyncQueue<number>();
    const p = q.next();
    q.fail(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });

  it('剩余项取完后才抛出 fail', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error('later'));
    expect(await q.next()).toEqual({ value: 1, done: false });
    await expect(q.next()).rejects.toThrow('later');
  });
});
