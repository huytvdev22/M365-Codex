import { describe, expect, it } from 'vitest';
import { buildToolInstruction, PromptToolScanner } from '../src/tools/promptProtocol.js';
import { parseTool } from '../src/tools/registry.js';
import type { UpstreamEvent } from '../src/adapter/protocol.js';

/**
 * Giao thức công cụ mô phỏng bằng prompt (§3.5, §7.3): Ràng buộc danh mục công cụ + bóc tách gọi công cụ khỏi nội dung văn bản.
 * Trọng tâm là "JSON công cụ không được xuất lặp lại dưới dạng nội dung văn bản".
 */

// parseTool trả về mảng (nhóm namespace sẽ làm phẳng thành nhiều công cụ), ở đây lấy cái đầu tiên;
// đầu vào là khai báo function đơn lẻ, chắc chắn làm phẳng thành đúng một công cụ, vì vậy ở đây assert không rỗng
const weather = parseTool(
  {
    type: 'function',
    name: 'get_weather',
    description: '查询天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  0,
)[0]!;

/** Gộp kết quả các chunk mà scanner đã nhận, thuận tiện cho việc assert. */
function scan(chunks: string[]): { text: string; events: UpstreamEvent[] } {
  const scanner = new PromptToolScanner();
  let text = '';
  const events: UpstreamEvent[] = [];
  for (const chunk of chunks) {
    const result = scanner.push(chunk);
    text += result.text;
    events.push(...result.events);
  }
  const tail = scanner.flush();
  return { text: text + tail.text, events: [...events, ...tail.events] };
}

function argsOf(events: UpstreamEvent[]): string[] {
  return events.filter((e) => e.kind === 'tool_call_args_delta').map((e) => e.delta);
}

describe('工具目录提示词', () => {
  it('列出工具名、描述与参数 Schema', () => {
    const text = buildToolInstruction([weather]);
    expect(text).toContain('get_weather');
    expect(text).toContain('查询天气');
    expect(text).toContain('"city"');
    expect(text).toContain('<tool_call>');
  });

  it('没有工具时不产生任何约束文本', () => {
    expect(buildToolInstruction([])).toBe('');
  });
});

describe('从正文剥离工具调用', () => {
  it('纯文本原样通过', () => {
    const { text, events } = scan(['今天', '天气不错']);
    expect(text).toBe('今天天气不错');
    expect(events).toHaveLength(0);
  });

  it('解析工具调用并把 JSON 从正文中剥离', () => {
    const { text, events } = scan([
      '好的，我查一下。',
      '<tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>',
      '稍等。',
    ]);
    expect(text).toBe('好的，我查一下。稍等。');
    expect(text).not.toContain('get_weather');
    const begin = events.find((e) => e.kind === 'tool_call_begin');
    expect(begin).toMatchObject({ kind: 'tool_call_begin', name: 'get_weather' });
    expect(argsOf(events)).toEqual(['{"city":"北京"}']);
    expect(events.some((e) => e.kind === 'tool_call_end')).toBe(true);
  });

  it('标记被切成多段时不会漏出半个标记', () => {
    const { text, events } = scan([
      '前言<tool',
      '_call>{"name":"get_weather",',
      '"arguments":{"city":"上海"}}</tool',
      '_call>后语',
    ]);
    expect(text).toBe('前言后语');
    expect(argsOf(events)).toEqual(['{"city":"上海"}']);
  });

  it('一段文本里的多个工具调用都被解析，且 call_id 互不相同', () => {
    const { text, events } = scan([
      '<tool_call>{"name":"get_weather","arguments":{"city":"A"}}</tool_call>',
      '中间',
      '<tool_call>{"name":"get_weather","arguments":{"city":"B"}}</tool_call>',
    ]);
    expect(text).toBe('中间');
    const ids = events.filter((e) => e.kind === 'tool_call_begin').map((e) => e.callId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('上游自带 call_id 时沿用', () => {
    const { events } = scan(['<tool_call>{"call_id":"call_up","name":"get_weather","arguments":{}}</tool_call>']);
    expect(events[0]).toMatchObject({ kind: 'tool_call_begin', callId: 'call_up' });
  });

  it('内容不是合法工具调用时当普通正文返回，不猜测', () => {
    const { text, events } = scan(['<tool_call>这不是 JSON</tool_call>']);
    expect(text).toBe('<tool_call>这不是 JSON</tool_call>');
    expect(events).toHaveLength(0);
  });

  it('标记未闭合时原样交还正文', () => {
    const { text, events } = scan(['<tool_call>{"name":"get_weather"']);
    expect(text).toBe('<tool_call>{"name":"get_weather"');
    expect(events).toHaveLength(0);
  });
});
