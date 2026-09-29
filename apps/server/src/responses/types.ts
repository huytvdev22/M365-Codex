import type { ResponseStatus } from '@m365-codex/shared';

/**
 * Hình thái đối tượng giao thức OpenAI Responses (tập con văn bản M4).
 * Các mục gọi công cụ (function_call) được bổ sung ở M5; hình ảnh/tệp ở M6.
 */

export interface UrlCitationAnnotation {
  type: 'url_citation';
  url: string;
  title: string | null;
  start_index: number;
  end_index: number;
}

export interface OutputTextContent {
  type: 'output_text';
  text: string;
  annotations: UrlCitationAnnotation[];
}

export interface MessageOutputItem {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'in_progress' | 'completed';
  content: OutputTextContent[];
}

export interface ReasoningSummaryText {
  type: 'summary_text';
  text: string;
}

export interface ReasoningOutputItem {
  id: string;
  type: 'reasoning';
  summary: ReasoningSummaryText[];
}

export interface FunctionCallOutputItem {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'in_progress' | 'completed';
}

export type OutputItem = ReasoningOutputItem | MessageOutputItem | FunctionCallOutputItem;

export interface ResponseError {
  code: string;
  message: string;
}

export interface ResponseObject {
  id: string;
  object: 'response';
  /** Epoch theo giây, khớp với OpenAI */
  created_at: number;
  status: ResponseStatus;
  /** Echo lại model client yêu cầu (container không viết lại) */
  model: string;
  output: OutputItem[];
  /** M4 tạm thời chưa cung cấp mức sử dụng chính xác (phụ thuộc vào probe M0), trước mắt để null */
  usage: null;
  metadata: Record<string, string> | null;
  previous_response_id: string | null;
  reasoning: { effort: string | null } | null;
  max_output_tokens: number | null;
  temperature: number | null;
  error: ResponseError | null;
  incomplete_details: { reason: string } | null;
}

/** Tên sự kiện SSE (tương ứng kế hoạch triển khai §4.3, tối thiểu thực hiện các sự kiện này). */
export const SSE_EVENTS = {
  CREATED: 'response.created',
  QUEUED: 'response.queued',
  IN_PROGRESS: 'response.in_progress',
  OUTPUT_ITEM_ADDED: 'response.output_item.added',
  OUTPUT_ITEM_DONE: 'response.output_item.done',
  CONTENT_PART_ADDED: 'response.content_part.added',
  CONTENT_PART_DONE: 'response.content_part.done',
  OUTPUT_TEXT_DELTA: 'response.output_text.delta',
  OUTPUT_TEXT_DONE: 'response.output_text.done',
  OUTPUT_TEXT_ANNOTATION_ADDED: 'response.output_text.annotation.added',
  REASONING_SUMMARY_DELTA: 'response.reasoning_summary_text.delta',
  REASONING_SUMMARY_DONE: 'response.reasoning_summary_text.done',
  FUNCTION_CALL_ARGS_DELTA: 'response.function_call_arguments.delta',
  FUNCTION_CALL_ARGS_DONE: 'response.function_call_arguments.done',
  REFUSAL_DELTA: 'response.refusal.delta',
  REFUSAL_DONE: 'response.refusal.done',
  COMPLETED: 'response.completed',
  INCOMPLETE: 'response.incomplete',
  FAILED: 'response.failed',
  ERROR: 'error',
} as const;

export type SseEventName = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];

/** Một sự kiện SSE: tên + đối tượng dữ liệu. Dữ liệu đều mang sequence_number đơn điệu tăng. */
export interface SseEvent {
  event: SseEventName;
  data: Record<string, unknown>;
}

/** Tuần tự hóa thành định dạng đường truyền SSE. */
export function serializeSse(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
