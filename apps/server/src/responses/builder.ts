import { randomBytes } from 'node:crypto';
import type { UpstreamEvent } from '../adapter/protocol.js';
import {
  SSE_EVENTS,
  type OutputItem,
  type ResponseObject,
  type SseEvent,
  type UrlCitationAnnotation,
} from './types.js';

/**
 * State machine cho Responses: Dịch luồng sự kiện chuẩn hóa từ upstream thành các sự kiện SSE của OpenAI Responses.
 *
 * Đảm bảo (tương ứng DoD kế hoạch triển khai §4.3):
 * - Mỗi sự kiện mang một `sequence_number` tăng đơn điệu;
 * - Thứ tự sự kiện chuẩn xác: item added → content part added → deltas → part done → item done → completed;
 * - Mục tóm tắt reasoning đứng trước mục message;
 * - `response_id` ổn định xuyên suốt.
 *
 * M4 chỉ xử lý văn bản + tóm tắt reasoning + trích dẫn (annotation). Tập từ vựng cho sự kiện gọi công cụ đã được
 * định nghĩa trong types, việc sinh thực tế dành cho M5.
 */

interface ReasoningState {
  id: string;
  index: number;
  text: string;
  done: boolean;
}

interface MessageState {
  id: string;
  index: number;
  text: string;
  annotations: UrlCitationAnnotation[];
  contentPartAdded: boolean;
  done: boolean;
}

interface FunctionCallState {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  index: number;
}

export interface BuilderInit {
  responseId: string;
  model: string;
  previousResponseId: string | null;
  metadata: Record<string, string> | null;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  createdAt: number;
}

export class ResponseStreamBuilder {
  readonly #response: ResponseObject;
  #seq = 0;
  #outputIndex = 0;
  #reasoning: ReasoningState | null = null;
  #message: MessageState | null = null;
  readonly #functionCalls: FunctionCallState[] = [];
  #failed = false;

  constructor(init: BuilderInit) {
    this.#response = {
      id: init.responseId,
      object: 'response',
      created_at: Math.floor(init.createdAt / 1000),
      status: 'queued',
      model: init.model,
      output: [],
      usage: null,
      metadata: init.metadata,
      previous_response_id: init.previousResponseId,
      reasoning: init.reasoningEffort === null ? null : { effort: init.reasoningEffort },
      max_output_tokens: init.maxOutputTokens,
      temperature: init.temperature,
      error: null,
      incomplete_details: null,
    };
  }

  get responseId(): string {
    return this.#response.id;
  }

  /** Văn bản assistant tích lũy hiện tại (dùng cho phản hồi non-streaming và lưu trữ). */
  get accumulatedText(): string {
    return this.#message?.text ?? '';
  }

  /** Trả về snapshot đối tượng Response hiện tại (deep copy, tránh bên ngoài làm thay đổi trạng thái nội bộ). */
  snapshot(): ResponseObject {
    return structuredClone({ ...this.#response, output: this.#buildOutput() });
  }

  /** Bắt đầu: response.created + response.in_progress. */
  begin(): SseEvent[] {
    this.#response.status = 'in_progress';
    return [this.#event(SSE_EVENTS.CREATED, {}), this.#event(SSE_EVENTS.IN_PROGRESS, {})];
  }

  /** Tiêu thụ một sự kiện từ upstream, sinh ra 0 hoặc nhiều sự kiện SSE. */
  consume(event: UpstreamEvent): SseEvent[] {
    switch (event.kind) {
      case 'reasoning_delta':
        return this.#onReasoningDelta(event.text);
      case 'text_delta':
        return this.#onTextDelta(event.text);
      case 'citation':
        return this.#onCitation(event.url, event.title);
      case 'upstream_error':
        // Lỗi không thể thử lại trong luồng: ghi nhận, kết thúc bằng failed
        if (!event.retryable) {
          this.#failed = true;
          this.#response.error = { code: 'upstream_error', message: event.message };
        }
        return [];
      case 'tool_call_begin':
      case 'tool_call_args_delta':
      case 'tool_call_end':
        // Lệnh gọi công cụ do tầng service đệm lại, xác thực/sửa đổi rồi mới phát qua emitFunctionCall,
        // không đi trực tiếp qua consume (để có thể xác thực tham số trước khi gửi cho client)
        return [];
      case 'completed':
      case 'raw':
        return [];
    }
  }

  /**
   * Phát ra một lệnh gọi công cụ đã qua kiểm tra (function_call).
   * Đứng sau message dưới dạng một mục output độc lập, kèm delta + done chứa đầy đủ tham số.
   * Do tầng service gọi sau khi việc xác thực/sửa đổi tham số thành công.
   */
  emitFunctionCall(callId: string, name: string, argumentsJson: string): SseEvent[] {
    const events: SseEvent[] = [];
    // Đóng các mục reasoning / message có thể đang mở trước
    events.push(...this.#closeReasoning());
    events.push(...this.#closeMessage());

    const state: FunctionCallState = {
      id: makeId('fc'),
      callId,
      name,
      arguments: argumentsJson,
      index: this.#outputIndex++,
    };
    this.#functionCalls.push(state);

    events.push(
      this.#event(SSE_EVENTS.OUTPUT_ITEM_ADDED, {
        output_index: state.index,
        item: {
          id: state.id,
          type: 'function_call',
          call_id: state.callId,
          name: state.name,
          arguments: '',
          status: 'in_progress',
        },
      }),
    );
    events.push(
      this.#event(SSE_EVENTS.FUNCTION_CALL_ARGS_DELTA, {
        item_id: state.id,
        output_index: state.index,
        call_id: state.callId,
        delta: argumentsJson,
      }),
    );
    events.push(
      this.#event(SSE_EVENTS.FUNCTION_CALL_ARGS_DONE, {
        item_id: state.id,
        output_index: state.index,
        call_id: state.callId,
        arguments: argumentsJson,
      }),
    );
    events.push(
      this.#event(SSE_EVENTS.OUTPUT_ITEM_DONE, {
        output_index: state.index,
        item: this.#functionCallItem(state),
      }),
    );
    return events;
  }

  /** Kết thúc bình thường: đóng các mục đã mở + response.completed. */
  finish(): SseEvent[] {
    if (this.#failed) {
      return this.fail(this.#response.error?.message ?? '上游返回错误');
    }
    const events: SseEvent[] = [];
    events.push(...this.#closeReasoning());
    // Khi không có văn bản và cũng không có gọi công cụ, mới bù một message rỗng để output không rỗng;
    // Khi có gọi công cụ thì output đã không rỗng rồi, không nhồi thêm message rỗng
    if (this.#message === null && this.#functionCalls.length === 0) {
      events.push(...this.#openMessage());
    }
    events.push(...this.#closeMessage());
    this.#response.status = 'completed';
    events.push(this.#event(SSE_EVENTS.COMPLETED, {}));
    return events;
  }

  /** Kết thúc thất bại: response.failed. */
  fail(message: string, code = 'upstream_error'): SseEvent[] {
    this.#response.status = 'failed';
    this.#response.error = { code, message };
    return [this.#event(SSE_EVENTS.FAILED, {})];
  }

  /** Client hủy yêu cầu. */
  cancel(): SseEvent[] {
    this.#response.status = 'cancelled';
    this.#response.incomplete_details = { reason: 'cancelled' };
    return [this.#event(SSE_EVENTS.INCOMPLETE, {})];
  }

  // ---- Nội bộ ----

  #onReasoningDelta(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.#reasoning === null) {
      this.#reasoning = { id: makeId('rs'), index: this.#outputIndex++, text: '', done: false };
      events.push(
        this.#event(SSE_EVENTS.OUTPUT_ITEM_ADDED, {
          output_index: this.#reasoning.index,
          item: { id: this.#reasoning.id, type: 'reasoning', summary: [] },
        }),
      );
    }
    this.#reasoning.text += text;
    events.push(
      this.#event(SSE_EVENTS.REASONING_SUMMARY_DELTA, {
        item_id: this.#reasoning.id,
        output_index: this.#reasoning.index,
        summary_index: 0,
        delta: text,
      }),
    );
    return events;
  }

  #onTextDelta(text: string): SseEvent[] {
    const events: SseEvent[] = [];
    events.push(...this.#closeReasoning());
    if (this.#message === null) {
      events.push(...this.#openMessage());
    }
    const message = this.#message as MessageState;
    message.text += text;
    events.push(
      this.#event(SSE_EVENTS.OUTPUT_TEXT_DELTA, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        delta: text,
      }),
    );
    return events;
  }

  #onCitation(url: string, title: string | null): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.#message === null) {
      events.push(...this.#openMessage());
    }
    const message = this.#message as MessageState;
    const annotation: UrlCitationAnnotation = {
      type: 'url_citation',
      url,
      title,
      // M4 tạm lấy độ dài văn bản hiện tại làm mỏ neo; khoảng chính xác chờ hiệu chuẩn năng lực upstream
      start_index: message.text.length,
      end_index: message.text.length,
    };
    message.annotations.push(annotation);
    events.push(
      this.#event(SSE_EVENTS.OUTPUT_TEXT_ANNOTATION_ADDED, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        annotation_index: message.annotations.length - 1,
        annotation,
      }),
    );
    return events;
  }

  #openMessage(): SseEvent[] {
    this.#message = {
      id: makeId('msg'),
      index: this.#outputIndex++,
      text: '',
      annotations: [],
      contentPartAdded: false,
      done: false,
    };
    const events: SseEvent[] = [
      this.#event(SSE_EVENTS.OUTPUT_ITEM_ADDED, {
        output_index: this.#message.index,
        item: {
          id: this.#message.id,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }),
      this.#event(SSE_EVENTS.CONTENT_PART_ADDED, {
        item_id: this.#message.id,
        output_index: this.#message.index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ];
    this.#message.contentPartAdded = true;
    return events;
  }

  #closeMessage(): SseEvent[] {
    if (this.#message === null || this.#message.done) return [];
    const message = this.#message;
    message.done = true;
    return [
      this.#event(SSE_EVENTS.OUTPUT_TEXT_DONE, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        text: message.text,
      }),
      this.#event(SSE_EVENTS.CONTENT_PART_DONE, {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        part: { type: 'output_text', text: message.text, annotations: message.annotations },
      }),
      this.#event(SSE_EVENTS.OUTPUT_ITEM_DONE, {
        output_index: message.index,
        item: this.#messageItem(message, 'completed'),
      }),
    ];
  }

  #closeReasoning(): SseEvent[] {
    if (this.#reasoning === null || this.#reasoning.done) return [];
    const reasoning = this.#reasoning;
    reasoning.done = true;
    return [
      this.#event(SSE_EVENTS.REASONING_SUMMARY_DONE, {
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        text: reasoning.text,
      }),
      this.#event(SSE_EVENTS.OUTPUT_ITEM_DONE, {
        output_index: reasoning.index,
        item: { id: reasoning.id, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning.text }] },
      }),
    ];
  }

  #messageItem(message: MessageState, status: 'in_progress' | 'completed'): OutputItem {
    return {
      id: message.id,
      type: 'message',
      role: 'assistant',
      status,
      content: [{ type: 'output_text', text: message.text, annotations: message.annotations }],
    };
  }

  #functionCallItem(state: FunctionCallState): OutputItem {
    return {
      id: state.id,
      type: 'function_call',
      call_id: state.callId,
      name: state.name,
      arguments: state.arguments,
      status: 'completed',
    };
  }

  #buildOutput(): OutputItem[] {
    const output: OutputItem[] = [];
    if (this.#reasoning !== null) {
      output.push({
        id: this.#reasoning.id,
        type: 'reasoning',
        summary: this.#reasoning.text === '' ? [] : [{ type: 'summary_text', text: this.#reasoning.text }],
      });
    }
    if (this.#message !== null) {
      output.push(this.#messageItem(this.#message, this.#message.done ? 'completed' : 'in_progress'));
    }
    for (const call of this.#functionCalls) {
      output.push(this.#functionCallItem(call));
    }
    return output;
  }

  /** Lắp ráp một sự kiện SSE có sequence_number đơn điệu và response_id. */
  #event(name: SseEvent['event'], data: Record<string, unknown>): SseEvent {
    const payload: Record<string, unknown> = {
      // `type` bắt buộc phải ghi vào trong data: SSE chuẩn của OpenAI gửi như vậy, và client thực tế
      // (thực nghiệm trên codex-cli) chỉ phân tích JSON của data rồi dispatch theo type bên trong, hoàn toàn không xem
      // dòng event: của SSE. Thiếu nó client sẽ mãi không nhận được response.completed.
      type: name,
      ...data,
      sequence_number: this.#seq++,
      response_id: this.#response.id,
    };
    // created / in_progress / completed / failed / incomplete mang snapshot response hoàn chỉnh
    if (
      name === SSE_EVENTS.CREATED ||
      name === SSE_EVENTS.IN_PROGRESS ||
      name === SSE_EVENTS.QUEUED ||
      name === SSE_EVENTS.COMPLETED ||
      name === SSE_EVENTS.FAILED ||
      name === SSE_EVENTS.INCOMPLETE
    ) {
      payload.response = { ...this.#response, output: this.#buildOutput() };
    }
    return { event: name, data: payload };
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
