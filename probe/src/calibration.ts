import type { CapabilityResult } from './types.js';
import { extractToolCallStats } from './verdict.js';

/**
 * Khuyến nghị hiệu chuẩn khả thi (tương ứng kế hoạch triển khai §3 "Đưa ra khuyến nghị hiệu chuẩn có thể áp dụng trực tiếp").
 *
 * Cách làm: Thu thập đệ quy các tên trường xuất hiện trong tất cả bằng chứng của lượt này (giá trị đã được `evidence.ts` khử nhạy cảm,
 * bản thân tên trường không nhạy cảm), lấy phần bù với tập hợp tên trường giả định khi mô hình hóa `codecV1.ts`,
 * liệt kê hai loại "quan sát được nhưng chưa mô hình hóa" và "đã mô hình hóa nhưng chưa từng quan sát thấy", dùng cho việc sửa thủ công
 * `apps/server/src/adapter/codecV1.ts`. Đây không phải tự động sửa code, chỉ là đưa
 * sự khác biệt ra — việc lựa chọn cuối cùng các trường giao thức vẫn cần con người phán đoán (mẫu frame thật, độ ổn định qua nhiều lần chạy).
 */

/** Tên các trường đã được code cứng sẽ đọc trong `codecV1.ts` (giữ đồng bộ với mã nguồn, khi sửa codec nhớ cập nhật ở đây). */
const MODELED_FIELDS = new Set([
  'type',
  'invocationId',
  'target',
  'arguments',
  'item',
  'result',
  'error',
  'messages',
  'requestId',
  'images',
  'conversationId',
  'text',
  'author',
  'messageType',
  'contentOrigin',
  'spokenText',
  'adaptiveCards',
  'sourceAttributions',
  'toolCalls',
  'seeMoreUrl',
  'providerDisplayName',
  'callId',
  'id',
  'name',
  'argumentsDelta',
  'phase',
  'value',
  'message',
]);

function collectKeys(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 10 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(val, into, depth + 1);
  }
}

/** Thu thập tên các key từng xuất hiện trong phần mẫu cấu trúc frame gốc ở tất cả bằng chứng case của lượt này. */
export function collectObservedFrameKeys(results: readonly CapabilityResult[]): Set<string> {
  const keys = new Set<string>();
  for (const result of results) {
    collectKeys(result.evidence, keys);
  }
  return keys;
}

export interface CalibrationNotes {
  observedButUnmodeled: string[];
  modeledButUnobserved: string[];
  suggestedToolsMode: 'native' | 'prompt' | 'auto';
  suggestedUpstreamImageInput: boolean;
  observedRetryAfterMs: number[];
}

const NON_PROTOCOL_KEYS = new Set([
  // Tên key dùng trong cấu trúc evidence của chính probe, không phải trường giao thức upstream, cần loại trừ khi diff
  'event_kinds',
  'frame_count',
  'raw_frame_structure_sample',
  'close_code',
  'close_reason',
  'error_category',
  'error_message',
  'retry_after_ms',
  'conversation_ref_present',
  'duration_ms',
  'reply_length',
  'input_length',
  'text_delta_count',
  'usage_like_fields',
  'model_field_hits',
  'requested_model',
  'request_accepted',
  'mentions_model_name_in_text',
  'has_citation',
  'channel',
  'detected_name',
  'undeclared',
  'call_count',
  'tool_call_stats',
  'image_field_convention',
  'color_matched',
  'attachments_field_convention',
  'note_attachment_field_ok',
  'parse_strategy',
  'account_id_prefix',
  'tid_prefix',
  'refresh_succeeded',
  'access_token_expiry_extended',
  'refresh_token_rotated',
  'remembered',
  'leaked_other_session_content',
  'no_repeat_call',
  'note',
  'via_passthrough',
  'via_text_prefix',
  'turn1',
  'turn2',
  'first_turn',
  'resumed_turn',
  'round1',
  'round2',
  'tool_call_round',
  'result_round',
  'established_turn',
  'fabricated_ref_turn',
  'inline_text',
  'via_attachments_field',
  'path',
]);

export function buildCalibrationNotes(results: readonly CapabilityResult[]): CalibrationNotes {
  const observed = collectObservedFrameKeys(results);
  const observedProtocolKeys = [...observed].filter((key) => !NON_PROTOCOL_KEYS.has(key));

  const observedButUnmodeled = observedProtocolKeys.filter((key) => !MODELED_FIELDS.has(key)).sort();
  const modeledButUnobserved = [...MODELED_FIELDS].filter((key) => !observed.has(key)).sort();

  const toolDefinition = results.find((r) => r.id === 'tool_definition_understanding');
  const stats = extractToolCallStats(results);
  let suggestedToolsMode: CalibrationNotes['suggestedToolsMode'] = 'auto';
  if (toolDefinition?.status === 'native' || (stats !== null && stats.nativeHits > stats.promptHits)) {
    suggestedToolsMode = 'native';
  } else if (toolDefinition?.status === 'adaptable' || (stats !== null && stats.promptHits > 0 && stats.nativeHits === 0)) {
    suggestedToolsMode = 'prompt';
  }

  const imageResult = results.find((r) => r.id === 'image_understanding');
  const suggestedUpstreamImageInput = imageResult?.status === 'native';

  const retryAfterValues: number[] = [];
  for (const result of results) {
    const value = result.evidence.retry_after_ms;
    if (typeof value === 'number') retryAfterValues.push(value);
  }

  return {
    observedButUnmodeled,
    modeledButUnobserved,
    suggestedToolsMode,
    suggestedUpstreamImageInput,
    observedRetryAfterMs: retryAfterValues,
  };
}
