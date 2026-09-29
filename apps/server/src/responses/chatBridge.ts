import { ApiError, type ResponseStatus } from '@m365-codex/shared';
import { z } from 'zod';
import type { SseEvent } from './types.js';
import type { ResponseObject } from './types.js';

/**
 * Chuyển đổi hai chiều `/v1/chat/completions` ↔ Responses (tương ứng kế hoạch triển khai §M6).
 *
 * Ràng buộc cứng: **Không xây dựng bộ logic suy luận thứ hai**. Ở đây chỉ làm chuyển đổi giao thức: yêu cầu Chat được chuyển thành một
 * đối tượng yêu cầu Responses (giao cho `parseResponsesRequest` + `ResponsesService` hiện có
 * xử lý suy luận/vòng lặp công cụ/điều phối tài khoản), rồi chuyển kết quả/luồng sự kiện của Responses quay lại hình thái Chat.
 *
 * `model`, `temperature`, `max_tokens`, `tools`, `tool_choice`,
 * `parallel_tool_calls` được truyền nguyên bản sang yêu cầu Responses, không đặt tên định danh mới, không viết lại giá trị.
 */

const chatContentPart = z.object({ type: z.string() }).passthrough();

const chatToolCall = z
  .object({
    id: z.string(),
    type: z.literal('function').optional(),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })
  .passthrough();

const chatMessage = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(chatContentPart)]).nullish(),
    tool_calls: z.array(chatToolCall).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    messages: z.array(chatMessage).min(1, 'messages 不能为空'),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    // Một số client tương thích OpenAI (như dòng mô hình o) dùng key này để truyền mức độ tư duy (reasoning level);
    // Được map nguyên trạng sang reasoning.effort của Responses, không enum hóa, không sửa đổi giá trị.
    reasoning_effort: z.string().optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessage>;

export function parseChatCompletionRequest(payload: unknown): ChatCompletionRequest {
  const result = chatCompletionRequestSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
  }
  return result.data;
}

/** Chuyển content của Chat (string hoặc mảng part) thành hình thái content của Responses. */
function mapContent(content: ChatMessage['content']): string | Record<string, unknown>[] {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'input_text', text: part.text };
    }
    if (part.type === 'image_url') {
      const imageUrl = part.image_url as { url?: string } | string | undefined;
      const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url;
      return { type: 'input_image', image_url: url };
    }
    // Loại part chưa nhận diện: giữ nguyên chuyển tiếp, giao cho logic fallback của Responses ("part chưa nhận diện không đoán mò, không báo lỗi")
    return part;
  });
}

function contentToPlainText(content: ChatMessage['content']): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * messages → Responses `input` (tương ứng kế hoạch triển khai §M6 "ánh xạ messages sang input bao phủ
 * cả 5 loại role system/developer/user/assistant/tool").
 *
 * - Tin nhắn `tool` chuyển thành `function_call_output`;
 * - Tin nhắn trợ lý kèm `tool_calls`, mỗi tool_call chuyển thành một mục
 *   lịch sử `function_call` (phía Responses vốn đã hỗ trợ phân tích, xem tái dựng lịch sử nhiều lượt ở schema.ts);
 *   nếu đồng thời còn có nội dung văn bản, phần văn bản sẽ đóng vai trò là một assistant message độc lập đi kèm;
 * - Các vai trò khác chuyển trực tiếp thành mục message theo role tương ứng.
 */
export function chatMessagesToInput(messages: readonly ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: contentToPlainText(message.content),
      });
      continue;
    }

    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      if (message.content !== null && message.content !== undefined && message.content !== '') {
        input.push({ role: message.role, content: mapContent(message.content) });
      }
      continue;
    }

    input.push({ role: message.role, content: mapContent(message.content) });
  }
  return input;
}

/** Lắp ráp đối tượng nguyên bản giao cho `parseResponsesRequest`; các trường truyền nguyên dạng, không tạo bí danh mới. */
export function chatRequestToResponsesPayload(chat: ChatCompletionRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: chat.model,
    input: chatMessagesToInput(chat.messages),
    stream: chat.stream,
  };
  if (chat.temperature !== undefined) payload.temperature = chat.temperature;
  if (chat.max_tokens !== undefined) payload.max_output_tokens = chat.max_tokens;
  if (chat.tools !== undefined) payload.tools = chat.tools;
  if (chat.tool_choice !== undefined) payload.tool_choice = chat.tool_choice;
  if (chat.parallel_tool_calls !== undefined) payload.parallel_tool_calls = chat.parallel_tool_calls;
  if (chat.reasoning_effort !== undefined) payload.reasoning = { effort: chat.reasoning_effort };
  return payload;
}

function mapFinishReason(status: ResponseStatus, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  switch (status) {
    case 'incomplete':
      return 'length';
    case 'cancelled':
      return 'stop';
    case 'failed':
      return 'stop';
    default:
      return 'stop';
  }
}

/** Non-streaming: Đối tượng cuối cùng của Responses → `chat.completion`. */
export function responseToChatCompletion(response: ResponseObject): Record<string, unknown> {
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) textParts.push(part.text);
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    }
    // Mục reasoning: chat.completion không có trường tương ứng để chứa, không thể hiện (không phải vứt bỏ ngữ nghĩa, mà chỉ là giao thức này không có chỗ chứa)
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(response.status, toolCalls.length > 0),
      },
    ],
    usage: null,
  };
}

/**
 * Streaming: Dịch luồng sự kiện SSE của Responses từng cái một thành `chat.completion.chunk`.
 * Có trạng thái (cần ghi nhớ mỗi lệnh gọi công cụ được chia vào index thứ mấy của tool_calls), nên là một class.
 */
export class ChatStreamTranslator {
  readonly #id: string;
  readonly #model: string;
  readonly #createdAt: number;
  readonly #toolCallIndex = new Map<string, number>();
  /** Bản thân `function_call_arguments.delta` không mang tên công cụ, name đến từ output_item.added sớm hơn. */
  readonly #names = new Map<string, string>();
  #nextToolCallIndex = 0;
  #sawToolCall = false;

  constructor(id: string, model: string, createdAt: number) {
    this.#id = id;
    this.#model = model;
    this.#createdAt = createdAt;
  }

  get hasToolCalls(): boolean {
    return this.#sawToolCall;
  }

  /** Chunk đầu tiên: chỉ mang role, nhất quán với hành vi streaming thực tế của OpenAI. */
  start(): Record<string, unknown> {
    return this.#chunk({ role: 'assistant' }, null);
  }

  /** Dịch một sự kiện Responses SSE thành 0 hoặc 1 chat chunk. */
  translate(event: SseEvent): Record<string, unknown> | null {
    switch (event.event) {
      case 'response.output_item.added': {
        // Mục function_call ngay từ đầu đã mang tên công cụ đầy đủ, nhưng sự kiện delta của arguments tự thân nó không mang name,
        // ở đây ghi nhận trước để sau này dịch function_call_arguments.delta thì ghép được vào chunk đầu tiên
        const item = event.data.item as { type?: string; call_id?: string; name?: string } | undefined;
        if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
          this.#names.set(item.call_id, item.name);
        }
        return null;
      }

      case 'response.output_text.delta':
        return this.#chunk({ content: event.data.delta }, null);

      case 'response.function_call_arguments.delta': {
        this.#sawToolCall = true;
        const callId = event.data.call_id as string;
        let index = this.#toolCallIndex.get(callId);
        const isFirst = index === undefined;
        if (index === undefined) {
          index = this.#nextToolCallIndex++;
          this.#toolCallIndex.set(callId, index);
        }
        const toolCallDelta: Record<string, unknown> = { index, function: { arguments: event.data.delta } };
        if (isFirst) {
          toolCallDelta.id = callId;
          toolCallDelta.type = 'function';
          (toolCallDelta.function as Record<string, unknown>).name = this.#functionName(event) ?? '';
        }
        return this.#chunk({ tool_calls: [toolCallDelta] }, null);
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const status = (event.data.response as { status?: ResponseStatus } | undefined)?.status ?? 'completed';
        return this.#chunk({}, mapFinishReason(status, this.#sawToolCall));
      }

      default:
        return null;
    }
  }

  #functionName(event: SseEvent): string | undefined {
    const callId = event.data.call_id as string;
    return this.#names.get(callId);
  }

  #chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
    return {
      id: this.#id,
      object: 'chat.completion.chunk',
      created: this.#createdAt,
      model: this.#model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}
