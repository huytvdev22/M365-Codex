import { describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import {
  buildConversationText,
  buildPassthrough,
  extractInputText,
  extractReasoningEffort,
  parseResponsesRequest,
} from '../src/responses/schema.js';

describe('parseResponsesRequest', () => {
  it('接受最小请求', () => {
    const req = parseResponsesRequest({ model: 'gpt-5-codex', input: '你好' });
    expect(req.model).toBe('gpt-5-codex');
    expect(req.stream).toBe(false);
  });

  it('缺少 model 报错', () => {
    expect(() => parseResponsesRequest({ input: 'x' })).toThrow(ApiError);
  });

  it('缺少 input 报错', () => {
    expect(() => parseResponsesRequest({ model: 'm' })).toThrow(ApiError);
  });

  it('保留未知字段（透传友好）', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x', custom_field: 1 });
    expect((req as Record<string, unknown>).custom_field).toBe(1);
  });

  it('接受完整字段集', () => {
    const req = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      instructions: '你是助手',
      stream: true,
      tools: [{ type: 'function', name: 'foo' }],
      previous_response_id: 'resp_prev',
      metadata: { k: 'v' },
      max_output_tokens: 100,
      temperature: 0.5,
      reasoning: { effort: 'high' },
    });
    expect(req.stream).toBe(true);
    expect(req.reasoning?.effort).toBe('high');
  });

  it('temperature 越界报错', () => {
    expect(() => parseResponsesRequest({ model: 'm', input: 'x', temperature: 5 })).toThrow(ApiError);
  });

  it('放行 Codex 会发的 tool_choice / include / prompt_cache_key / client_metadata', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: 'x',
      tool_choice: 'auto',
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-abc',
      client_metadata: { session: 'abc' },
    });
    expect(req.tool_choice).toBe('auto');
    expect((req as Record<string, unknown>).include).toEqual(['reasoning.encrypted_content']);
    expect((req as Record<string, unknown>).prompt_cache_key).toBe('session-abc');
  });
});

describe('extractInputText：基础拼装', () => {
  it('字符串 input 标注为用户轮次', () => {
    const req = parseResponsesRequest({ model: 'm', input: '直接文本' });
    expect(extractInputText(req).text).toBe('【用户】\n直接文本');
  });

  it('数组 input 里每条消息各自成一轮，按顺序拼接', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '第一段' }] },
        { role: 'user', content: '第二段' },
      ],
    });
    expect(extractInputText(req).text).toBe('【用户】\n第一段\n\n【用户】\n第二段');
  });

  it('assistant 的历史回复现在会计入上下文（不再丢弃），并带上角色标注', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'assistant', content: '上轮回答' },
        { role: 'user', content: '新问题' },
      ],
    });
    expect(extractInputText(req).text).toBe('【助手】\n上轮回答\n\n【用户】\n新问题');
  });

  it('developer/system 角色也各自标注', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'developer', content: '开发者指令内容' },
        { role: 'system', content: '系统内容' },
        { role: 'user', content: '你好' },
      ],
    });
    expect(extractInputText(req).text).toBe(
      '【开发者指令】\n开发者指令内容\n\n【系统消息】\n系统内容\n\n【用户】\n你好',
    );
  });

  it('instructions 作为开头的系统段落合入正文（此前会被丢弃，现已修复）', () => {
    const req = parseResponsesRequest({ model: 'm', input: '你好', instructions: '你是一个助手' });
    const extracted = extractInputText(req);
    expect(extracted.text.startsWith('【系统指令】\n你是一个助手')).toBe(true);
    expect(extracted.text).toContain('【用户】\n你好');
    expect(extracted.instructions).toBe('你是一个助手');
  });
});

describe('extractInputText：Codex 风格的多轮历史回放（真实抓包结构）', () => {
  it('message + function_call + function_call_output 混排：全部转成带标注的轮次，工具结果同时进 toolResults', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '你是编码助手' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '运行一下测试' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell_command',
          arguments: '{"command":"npm test"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'Exit code: 0\nOutput:\nok' },
      ],
    });
    const extracted = extractInputText(req);

    expect(extracted.text).toContain('【开发者指令】\n你是编码助手');
    expect(extracted.text).toContain('【用户】\n运行一下测试');
    expect(extracted.text).toContain('【工具 shell_command 的调用】\n{"command":"npm test"}');
    expect(extracted.text).toContain('【工具结果】\nExit code: 0\nOutput:\nok');
    expect(extracted.toolResults).toEqual([{ callId: 'call_1', output: 'Exit code: 0\nOutput:\nok' }]);

    // Thứ tự cũng phải chính xác: developer ở đầu tiên, kết quả công cụ ở cuối cùng
    const order = [
      extracted.text.indexOf('【开发者指令】'),
      extracted.text.indexOf('【用户】'),
      extracted.text.indexOf('【工具 shell_command 的调用】'),
      extracted.text.indexOf('【工具结果】'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('function_call 缺少 id/status（真实抓包形态）也能正常解析', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{}' }],
    });
    expect(() => extractInputText(req)).not.toThrow();
  });

  it('reasoning 回放静默跳过，不进入正文，也不报错', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' },
        { role: 'user', content: '继续' },
      ],
    });
    const extracted = extractInputText(req);
    expect(extracted.text).toBe('【用户】\n继续');
  });

  it('assistant 历史消息用 output_text 承载文本也能正确提取', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: '这是我上次的回答' }] },
        { role: 'user', content: '继续' },
      ],
    });
    const extracted = extractInputText(req);
    expect(extracted.text).toBe('【助手】\n这是我上次的回答\n\n【用户】\n继续');
  });

  it('未识别的 item 类型不导致 400，跳过并记录类型供上层记 warn', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { type: 'some_future_item_type', foo: 'bar' },
        { role: 'user', content: '你好' },
      ],
    });
    const extracted = extractInputText(req);
    expect(extracted.text).toBe('【用户】\n你好');
    expect(extracted.skippedItemTypes).toEqual(['some_future_item_type']);
  });

  it('未识别的 content part 类型同样跳过，不影响其余内容', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        {
          role: 'user',
          content: [
            { type: 'some_future_part_type', data: 'x' },
            { type: 'input_text', text: '正文' },
          ],
        },
      ],
    });
    expect(extractInputText(req).text).toBe('【用户】\n正文');
  });
});

describe('extractInputText：图片输入', () => {
  it('图片输入默认未启用时返回清晰的 unsupported_feature 错误', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://img.example.invalid/a.png' }] }],
    });
    try {
      extractInputText(req);
      throw new Error('本应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).type).toBe('unsupported_feature');
      expect((error as ApiError).message).toContain('UPSTREAM_IMAGE_INPUT');
    }
  });

  it('图片输入启用后按 image_url 收集，不进入正文', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '看看这张图' },
            { type: 'input_image', image_url: 'https://img.example.invalid/a.png', detail: 'low' },
          ],
        },
      ],
    });
    const extracted = extractInputText(req, { imageInputEnabled: true });
    expect(extracted.text).toBe('【用户】\n看看这张图');
    expect(extracted.images).toEqual([{ url: 'https://img.example.invalid/a.png', detail: 'low' }]);
  });

  it('图片输入启用但既无 image_url 也无 file_id 时报错', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_image' }] }],
    });
    expect(() => extractInputText(req, { imageInputEnabled: true })).toThrow(ApiError);
  });
});

describe('extractInputText：文件输入', () => {
  it('文件输入按 file_id 取已提取文本，拼进正文并注明来源文件名', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }],
    });
    const extracted = extractInputText(req, {
      files: {
        resolveText: (id) => (id === 'file_1' ? { filename: 'report.txt', text: '报告内容' } : null),
        resolveImageDataUrl: () => null,
      },
    });
    expect(extracted.text).toContain('report.txt');
    expect(extracted.text).toContain('报告内容');
  });

  it('文件输入引用不存在或未提取到文本的文件时明确报错，不发空内容', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'missing' }] }],
    });
    try {
      extractInputText(req, { files: { resolveText: () => null, resolveImageDataUrl: () => null } });
      throw new Error('本应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).type).toBe('invalid_request_error');
      expect((error as ApiError).status).toBe(404);
    }
  });
});

describe('extractInputText：工具结果（M5）', () => {
  it('提取 function_call_output 为工具结果', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [{ type: 'function_call_output', call_id: 'c1', output: '结果' }],
    });
    const extracted = extractInputText(req);
    expect(extracted.toolResults).toEqual([{ callId: 'c1', output: '结果' }]);
  });

  it('文本与工具结果混合输入：都进正文，工具结果额外进 toolResults', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'user', content: '继续' },
        { type: 'function_call_output', call_id: 'c2', output: 'ok' },
      ],
    });
    const extracted = extractInputText(req);
    expect(extracted.text).toBe('【用户】\n继续\n\n【工具结果】\nok');
    expect(extracted.toolResults).toEqual([{ callId: 'c2', output: 'ok' }]);
  });
});

describe('extractInputText：上下文长度上限与截断', () => {
  it('未超过上限时不截断', () => {
    const req = parseResponsesRequest({ model: 'm', input: '短文本' });
    expect(extractInputText(req, { contextMaxChars: 1000 }).truncatedChars).toBe(0);
  });

  it('超过上限时从最旧历史开始截断，且报告截断字符数', () => {
    const req = parseResponsesRequest({
      model: 'm',
      input: [
        { role: 'user', content: '很久以前的第一轮，'.repeat(20) },
        { role: 'assistant', content: '第一轮回答，'.repeat(20) },
        { role: 'user', content: '最新一轮问题' },
      ],
    });
    const extracted = extractInputText(req, { contextMaxChars: 60 });
    expect(extracted.truncatedChars).toBeGreaterThan(0);
    // Vòng cũ nhất bị bỏ, vòng mới nhất bắt buộc phải còn
    expect(extracted.text).toContain('最新一轮问题');
    expect(extracted.text).not.toContain('很久以前的第一轮');
  });
});

describe('buildConversationText', () => {
  it('系统段（instructions）永远保留，即便整体超限', () => {
    const longInstructions = '系统段内容'.repeat(50);
    const result = buildConversationText(
      longInstructions,
      [
        { label: '【用户】', text: '很旧的问题'.repeat(20) },
        { label: '【用户】', text: '最新问题' },
      ],
      10, // Giới hạn cực nhỏ, chắc chắn kích hoạt cắt ngắn
    );
    expect(result.text).toContain(longInstructions);
    expect(result.truncatedChars).toBeGreaterThan(0);
  });

  it('至少保留最后一轮，不会把当前请求内容也截没', () => {
    const result = buildConversationText(null, [{ label: '【用户】', text: '当前问题' }], 1);
    expect(result.text).toContain('当前问题');
  });

  it('没有 instructions 且没有轮次时返回空字符串', () => {
    expect(buildConversationText(null, [], 1000)).toEqual({ text: '', truncatedChars: 0 });
  });

  it('未超限时原样拼接，不丢任何一轮', () => {
    const result = buildConversationText('sys', [
      { label: '【用户】', text: 'a' },
      { label: '【助手】', text: 'b' },
    ], 10_000);
    expect(result.text).toBe('【系统指令】\nsys\n\n【用户】\na\n\n【助手】\nb');
    expect(result.truncatedChars).toBe(0);
  });
});

describe('buildPassthrough', () => {
  it('原样带上 model 与 reasoning，不改写', () => {
    const req = parseResponsesRequest({
      model: 'gpt-5-codex',
      input: 'x',
      reasoning: { effort: 'xhigh' },
      temperature: 0.7,
      max_output_tokens: 200,
    });
    const p = buildPassthrough(req);
    expect(p.model).toBe('gpt-5-codex');
    expect(p.reasoning).toEqual({ effort: 'xhigh' });
    expect(p.temperature).toBe(0.7);
    expect(p.max_output_tokens).toBe(200);
  });

  it('不注入未提供的字段', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x' });
    const p = buildPassthrough(req);
    expect(p).toEqual({ model: 'm' });
  });
});

describe('extractReasoningEffort', () => {
  it('取出 effort 原值，不枚举校验', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x', reasoning: { effort: '随便什么值' } });
    expect(extractReasoningEffort(req)).toBe('随便什么值');
  });

  it('无 reasoning 时返回 null', () => {
    const req = parseResponsesRequest({ model: 'm', input: 'x' });
    expect(extractReasoningEffort(req)).toBeNull();
  });
});
