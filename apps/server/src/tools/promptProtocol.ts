import { randomBytes } from 'node:crypto';
import type { UpstreamEvent } from '../adapter/protocol.js';
import type { ParsedTool } from './registry.js';

/**
 * Giao thức công cụ mô phỏng qua prompt (tương ứng kế hoạch triển khai §3.5, bước 3 của §7.2).
 *
 * Probe M0 chưa xác nhận liệu upstream có hỗ trợ lệnh gọi công cụ có cấu trúc nguyên bản hay không, do đó cung cấp con đường thứ hai:
 * Đưa danh mục công cụ và định dạng đầu ra vào văn bản gửi cho upstream, sau đó bóc tách
 * `<tool_call>{...}</tool_call>` từ nội dung phản hồi để chuyển thành các sự kiện đã chuẩn hóa.
 *
 * Ràng buộc then chốt (§7.3): **JSON công cụ không được xuất lặp lại vào nội dung chính** — bộ quét sẽ bóc tách thẻ
 * và nội dung bên trong khỏi luồng văn bản, client sẽ chỉ thấy mục function_call, không thấy thêm một bản sao JSON.
 */

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/** Tạo danh mục công cụ nghiêm ngặt và ràng buộc đầu ra gửi cho upstream. */
export function buildToolInstruction(tools: readonly ParsedTool[]): string {
  if (tools.length === 0) return '';
  const catalog = tools
    .map((tool) => {
      const description = tool.description === null ? '' : `：${tool.description}`;
      const schema = tool.parameters === null ? '{}' : JSON.stringify(tool.parameters);
      return `- ${tool.name}${description}\n  参数 JSON Schema：${schema}`;
    })
    .join('\n');

  return [
    '你可以使用下列工具，且只能使用下列工具：',
    catalog,
    '',
    `需要调用工具时，严格输出：${TOOL_CALL_OPEN}{"name":"工具名","arguments":{…}}${TOOL_CALL_CLOSE}`,
    '要求：name 必须与上面列出的名字完全一致；arguments 必须是符合该工具 Schema 的 JSON 对象；',
    '同一次回答里每个工具调用只输出一次，不要在正文中复述工具调用的 JSON；',
    '不需要调用工具时正常回答，不要输出上述标记。',
  ].join('\n');
}

/** Tạo một call_id. Mô phỏng prompt của upstream không tự mang id, do gateway này cấp phát (§7.3 tính duy nhất). */
function makeCallId(): string {
  return `call_${randomBytes(12).toString('hex')}`;
}

export interface ScanResult {
  /** Nội dung chính còn lại sau khi bóc tách lệnh gọi công cụ, có thể gửi cho client */
  text: string;
  /** Sự kiện gọi công cụ được phân tích từ nội dung chính */
  events: UpstreamEvent[];
}

/**
 * Bộ quét luồng văn bản: Nhận từng đoạn text_delta, xuất ra "nội dung chính sau khi loại bỏ gọi công cụ" cùng các sự kiện công cụ.
 *
 * Khi stream, thẻ đánh dấu có thể bị cắt làm đôi (`<tool_` / `call>`), do đó phần đuôi cần giữ lại vài ký tự có thể là tiền tố của thẻ mở,
 * chờ đoạn tiếp theo rồi mới phán đoán, tránh việc xuất nửa cái thẻ ra làm nội dung chính.
 */
export class PromptToolScanner {
  /** Văn bản chưa thể phán đoán (có thể là tiền tố của thẻ mở) */
  #pendingText = '';
  /** Nội dung tích lũy khi đã đi vào bên trong <tool_call> */
  #inside: string | null = null;

  push(chunk: string): ScanResult {
    this.#pendingText += chunk;
    return this.#drain(false);
  }

  /** Kết thúc luồng: Xả phần đuôi đã giữ lại; lệnh gọi công cụ chưa đóng được xử lý như văn bản bình thường (xuất trả nguyên vẹn). */
  flush(): ScanResult {
    const result = this.#drain(true);
    if (this.#inside !== null) {
      // Upstream mở thẻ nhưng không đóng: Không suy đoán, trả nguyên vẹn về nội dung chính
      result.text += TOOL_CALL_OPEN + this.#inside;
      this.#inside = null;
    }
    const tail = this.#pendingText;
    this.#pendingText = '';
    return { text: result.text + tail, events: result.events };
  }

  #drain(final: boolean): ScanResult {
    let text = '';
    const events: UpstreamEvent[] = [];

    for (;;) {
      if (this.#inside !== null) {
        const closeAt = this.#pendingText.indexOf(TOOL_CALL_CLOSE);
        if (closeAt < 0) {
          // Thẻ kết thúc cũng có thể bị cắt đôi, giữ lại tiền tố có thể ở đuôi rồi phán đoán tiếp
          const keep = final ? 0 : partialSuffixLength(this.#pendingText, TOOL_CALL_CLOSE);
          this.#inside += this.#pendingText.slice(0, this.#pendingText.length - keep);
          this.#pendingText = this.#pendingText.slice(this.#pendingText.length - keep);
          break;
        }
        const payload = this.#inside + this.#pendingText.slice(0, closeAt);
        this.#pendingText = this.#pendingText.slice(closeAt + TOOL_CALL_CLOSE.length);
        this.#inside = null;
        const parsed = parseToolCallPayload(payload);
        if (parsed === null) {
          // Không parse được thì không giả vờ là có lệnh gọi công cụ, trả về nguyên dạng làm nội dung chính (không âm thầm mất nội dung)
          text += TOOL_CALL_OPEN + payload + TOOL_CALL_CLOSE;
        } else {
          events.push(...parsed);
        }
        continue;
      }

      const openAt = this.#pendingText.indexOf(TOOL_CALL_OPEN);
      if (openAt >= 0) {
        text += this.#pendingText.slice(0, openAt);
        this.#pendingText = this.#pendingText.slice(openAt + TOOL_CALL_OPEN.length);
        this.#inside = '';
        continue;
      }

      if (final) {
        break;
      }
      // Giữ lại phần đuôi có thể là tiền tố của thẻ mở
      const keep = partialSuffixLength(this.#pendingText, TOOL_CALL_OPEN);
      text += this.#pendingText.slice(0, this.#pendingText.length - keep);
      this.#pendingText = this.#pendingText.slice(this.#pendingText.length - keep);
      break;
    }

    return { text, events };
  }
}

/** Số ký tự ở đuôi văn bản có thể là tiền tố của marker (dùng để giữ nửa cái thẻ qua các phân mảnh stream). */
function partialSuffixLength(text: string, marker: string): number {
  const max = Math.min(marker.length - 1, text.length);
  for (let len = max; len > 0; len -= 1) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

/** Chuyển `{"name":…,"arguments":…}` thành 3 sự kiện begin + args_delta + end. */
function parseToolCallPayload(payload: string): UpstreamEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== 'string' || name === '') return null;

  const rawArgs = record.arguments ?? record.parameters ?? {};
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  // Nếu upstream có sẵn id thì giữ nguyên để thuận tiện đối chiếu nhiều frame; nếu không do gateway cấp phát
  const callId = typeof record.call_id === 'string' && record.call_id !== '' ? record.call_id : makeCallId();

  return [
    { kind: 'tool_call_begin', callId, name },
    { kind: 'tool_call_args_delta', callId, delta: args },
    { kind: 'tool_call_end', callId },
  ];
}
