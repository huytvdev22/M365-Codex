import { describe, expect, it } from 'vitest';
import { ResponseStreamBuilder, type BuilderInit } from '../src/responses/builder.js';
import { SSE_EVENTS, type SseEvent } from '../src/responses/types.js';
import type { UpstreamEvent } from '../src/adapter/protocol.js';

function makeBuilder(overrides: Partial<BuilderInit> = {}): ResponseStreamBuilder {
  return new ResponseStreamBuilder({
    responseId: 'resp_test',
    model: 'gpt-5-codex',
    previousResponseId: null,
    metadata: null,
    reasoningEffort: null,
    maxOutputTokens: null,
    temperature: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  });
}

/** Chạy hết toàn bộ vòng đời, trả về tất cả sự kiện SSE. */
function runFull(events: UpstreamEvent[], init?: Partial<BuilderInit>): SseEvent[] {
  const builder = makeBuilder(init);
  const out: SseEvent[] = [...builder.begin()];
  for (const event of events) out.push(...builder.consume(event));
  out.push(...builder.finish());
  return out;
}

function names(events: SseEvent[]): string[] {
  return events.map((e) => e.event);
}

function seqs(events: SseEvent[]): number[] {
  return events.map((e) => e.data.sequence_number as number);
}

describe('sequence_number 单调', () => {
  it('全程从 0 严格递增 +1', () => {
    const events = runFull([
      { kind: 'text_delta', text: '你好' },
      { kind: 'text_delta', text: '世界' },
    ]);
    const s = seqs(events);
    expect(s[0]).toBe(0);
    for (let i = 1; i < s.length; i += 1) {
      expect(s[i]).toBe((s[i - 1] as number) + 1);
    }
  });

  it('每个事件都带 response_id', () => {
    const events = runFull([{ kind: 'text_delta', text: 'x' }]);
    expect(events.every((e) => e.data.response_id === 'resp_test')).toBe(true);
  });

  // Client thật (thực nghiệm với codex-cli) chỉ phân tích JSON trong data, dispatch theo type bên trong,
  // không nhìn dòng event: của SSE. Thiếu trường này, client sẽ đợi mãi mà không nhận được response.completed.
  it('每个事件的 data 里都有与事件名一致的 type', () => {
    const events = runFull([
      { kind: 'reasoning_delta', text: '想一下' },
      { kind: 'text_delta', text: '你好' },
      { kind: 'citation', url: 'https://example.invalid/a', title: 'A' },
    ]);
    expect(events.length).toBeGreaterThan(5);
    for (const event of events) {
      expect(event.data.type).toBe(event.event);
    }
  });
});

describe('事件顺序', () => {
  it('纯文本响应的事件序列正确', () => {
    const events = runFull([
      { kind: 'text_delta', text: 'Hello' },
      { kind: 'text_delta', text: ' world' },
    ]);
    expect(names(events)).toEqual([
      SSE_EVENTS.CREATED,
      SSE_EVENTS.IN_PROGRESS,
      SSE_EVENTS.OUTPUT_ITEM_ADDED,
      SSE_EVENTS.CONTENT_PART_ADDED,
      SSE_EVENTS.OUTPUT_TEXT_DELTA,
      SSE_EVENTS.OUTPUT_TEXT_DELTA,
      SSE_EVENTS.OUTPUT_TEXT_DONE,
      SSE_EVENTS.CONTENT_PART_DONE,
      SSE_EVENTS.OUTPUT_ITEM_DONE,
      SSE_EVENTS.COMPLETED,
    ]);
  });

  it('reasoning 摘要项在 message 项之前，各自成对开合', () => {
    const events = runFull([
      { kind: 'reasoning_delta', text: '思考' },
      { kind: 'text_delta', text: '答案' },
    ]);
    const n = names(events);
    // reasoning item added đứng trước message item added
    const reasoningAddedIdx = n.indexOf(SSE_EVENTS.OUTPUT_ITEM_ADDED);
    const reasoningDoneIdx = n.indexOf(SSE_EVENTS.OUTPUT_ITEM_DONE);
    const messageAddedIdx = n.lastIndexOf(SSE_EVENTS.OUTPUT_ITEM_ADDED);
    expect(reasoningAddedIdx).toBeLessThan(messageAddedIdx);
    // reasoning hoàn thành trước rồi mới mở message
    expect(reasoningDoneIdx).toBeLessThan(messageAddedIdx);
    expect(n).toContain(SSE_EVENTS.REASONING_SUMMARY_DELTA);
    expect(n).toContain(SSE_EVENTS.REASONING_SUMMARY_DONE);
  });

  it('output_index：reasoning=0, message=1', () => {
    const builder = makeBuilder();
    builder.begin();
    const r = builder.consume({ kind: 'reasoning_delta', text: 't' });
    const added0 = r.find((e) => e.event === SSE_EVENTS.OUTPUT_ITEM_ADDED);
    expect(added0?.data.output_index).toBe(0);
    const t = builder.consume({ kind: 'text_delta', text: 'x' });
    const added1 = t.find((e) => e.event === SSE_EVENTS.OUTPUT_ITEM_ADDED);
    expect(added1?.data.output_index).toBe(1);
  });
});

describe('文本累积与完成', () => {
  it('output_text.done 带完整文本，completed 带最终 response', () => {
    const events = runFull([
      { kind: 'text_delta', text: 'abc' },
      { kind: 'text_delta', text: 'def' },
    ]);
    const done = events.find((e) => e.event === SSE_EVENTS.OUTPUT_TEXT_DONE);
    expect(done?.data.text).toBe('abcdef');

    const completed = events.find((e) => e.event === SSE_EVENTS.COMPLETED);
    const response = completed?.data.response as { status: string; output: unknown[] };
    expect(response.status).toBe('completed');
    const message = response.output.find((i) => (i as { type: string }).type === 'message') as {
      content: { text: string }[];
    };
    expect(message.content[0]?.text).toBe('abcdef');
  });

  it('没有任何文本也产出一个空 message，保持 output 非空', () => {
    const events = runFull([]);
    expect(names(events)).toContain(SSE_EVENTS.OUTPUT_ITEM_ADDED);
    const completed = events.find((e) => e.event === SSE_EVENTS.COMPLETED);
    const response = completed?.data.response as { output: unknown[] };
    expect(response.output.length).toBeGreaterThanOrEqual(1);
  });
});

describe('引用映射', () => {
  it('citation → annotation.added，并进入最终 content part', () => {
    const events = runFull([
      { kind: 'text_delta', text: '据来源' },
      { kind: 'citation', url: 'https://src.example', title: '来源A' },
    ]);
    const annotation = events.find((e) => e.event === SSE_EVENTS.OUTPUT_TEXT_ANNOTATION_ADDED);
    expect(annotation?.data.annotation).toMatchObject({
      type: 'url_citation',
      url: 'https://src.example',
      title: '来源A',
    });

    const partDone = events.find((e) => e.event === SSE_EVENTS.CONTENT_PART_DONE);
    const part = partDone?.data.part as { annotations: unknown[] };
    expect(part.annotations).toHaveLength(1);
  });
});

describe('reasoning effort 回显', () => {
  it('response 快照带上 reasoning.effort', () => {
    const events = runFull([{ kind: 'text_delta', text: 'x' }], { reasoningEffort: 'high' });
    const created = events[0];
    const response = created?.data.response as { reasoning: { effort: string } | null };
    expect(response.reasoning?.effort).toBe('high');
  });
});

describe('失败与取消', () => {
  it('流内不可重试错误 → finish 收尾为 failed', () => {
    const builder = makeBuilder();
    const out = [...builder.begin()];
    out.push(...builder.consume({ kind: 'text_delta', text: '部分' }));
    out.push(...builder.consume({ kind: 'upstream_error', message: '模型拒答', retryable: false }));
    out.push(...builder.finish());
    const last = out.at(-1);
    expect(last?.event).toBe(SSE_EVENTS.FAILED);
    const response = last?.data.response as { status: string; error: { message: string } };
    expect(response.status).toBe('failed');
    expect(response.error.message).toBe('模型拒答');
  });

  it('fail() 产出 response.failed 且序号连续', () => {
    const builder = makeBuilder();
    const out = [...builder.begin(), ...builder.fail('上游超时', 'upstream_timeout')];
    expect(out.at(-1)?.event).toBe(SSE_EVENTS.FAILED);
    expect(seqs(out)).toEqual([0, 1, 2]);
  });

  it('cancel() 产出 response.incomplete，状态 cancelled', () => {
    const builder = makeBuilder();
    const out = [...builder.begin(), ...builder.cancel()];
    const last = out.at(-1);
    expect(last?.event).toBe(SSE_EVENTS.INCOMPLETE);
    const response = last?.data.response as { status: string };
    expect(response.status).toBe('cancelled');
  });
});

describe('snapshot', () => {
  it('返回深拷贝，外部改动不影响内部', () => {
    const builder = makeBuilder();
    builder.begin();
    builder.consume({ kind: 'text_delta', text: 'x' });
    const snap = builder.snapshot();
    (snap.output as unknown[]).push({ hacked: true });
    expect(builder.snapshot().output.length).toBe(1);
  });

  it('accumulatedText 反映已消费文本', () => {
    const builder = makeBuilder();
    builder.begin();
    builder.consume({ kind: 'text_delta', text: 'foo' });
    builder.consume({ kind: 'text_delta', text: 'bar' });
    expect(builder.accumulatedText).toBe('foobar');
  });
});
