/**
 * Mã hóa / giải mã giao thức đường truyền Sydney / BizChat (lớp cô lập phiên bản).
 *
 * Upstream sử dụng giao thức JSON theo kiểu SignalR: mỗi thông điệp là một đoạn JSON,
 * kết thúc bằng ký tự phân cách bản ghi `0x1e` (RS). Sau khi bắt tay, client khởi tạo một invocation,
 * server truyền luồng về một số frame, cuối cùng trả về completion.
 *
 * Phân cách frame (0x1e) là quy chuẩn đã định của SignalR, ổn định và đáng tin cậy. **Ngữ nghĩa các trường bên trong message**
 * đã được kiểm chuẩn thực tế M0 với tài khoản thật vào ngày 27-07-2026: phía request là đối tượng số ít `message` (không phải
 * mảng `messages`), payload nghiệp vụ phía response nằm trong trường `item` (không phải `arguments[0]`) —
 * chi tiết xem chú thích đầu file `codecV1.ts` và phần M0 trong `docs/trien-khai-va-nghiem-thu.md`. Bước này vẫn được tách
 * riêng thành `mapMessageToEvents`, đóng vai trò là khớp nối thay thế nếu sau này giao thức upstream tiếp tục trôi dạt;
 * toàn bộ codec được phơi bày qua giao diện `ProtocolCodec`, có thể chuyển đổi implementation khác nhau theo `protocolVersion`.
 */

/** Ký tự phân cách bản ghi (Record separator): Mỗi message của giao thức SignalR JSON kết thúc bằng ký tự này. */
export const RECORD_SEPARATOR = '\x1e';

/** Phân loại message SignalR. */
export const MESSAGE_TYPE = {
  INVOCATION: 1,
  STREAM_ITEM: 2,
  COMPLETION: 3,
  STREAM_INVOCATION: 4,
  CANCEL_INVOCATION: 5,
  PING: 6,
  CLOSE: 7,
} as const;

/** Message upstream thô đã được parse. Các trường có hình thái chung của SignalR, ngữ nghĩa bên trong dành cho tầng ánh xạ xử lý. */
export interface RawMessage {
  type: number;
  target?: string;
  invocationId?: string;
  arguments?: unknown[];
  item?: unknown;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** Sự kiện upstream đã chuẩn hóa. M4 sẽ ánh xạ nó sang sự kiện SSE của Responses. */
export type UpstreamEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'citation'; url: string; title: string | null }
  /** Bắt đầu gọi công cụ: Upstream yêu cầu gọi công cụ có tên là name */
  | { kind: 'tool_call_begin'; callId: string; name: string }
  /** Phần gia tăng đối số gọi công cụ (đoạn chuỗi JSON) */
  | { kind: 'tool_call_args_delta'; callId: string; delta: string }
  /** Kết thúc gọi công cụ: Đối số đã hoàn chỉnh */
  | { kind: 'tool_call_end'; callId: string }
  | { kind: 'completed'; stopReason: string | null }
  | { kind: 'upstream_error'; message: string; retryable: boolean }
  | { kind: 'raw'; message: RawMessage };

/** Khai báo công cụ (hàm) cung cấp cho upstream. Tên name + tham số JSON Schema. */
export interface ToolDeclaration {
  name: string;
  description?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
}

/** Kết quả thực thi công cụ truyền ngược lại cho upstream, dùng để tiếp tục suy luận. */
export interface ToolResultInput {
  callId: string;
  output: string;
}

/**
 * Trường mô hình hóa cho dữ liệu đầu vào dạng hình ảnh (M6, có hiệu lực khi `UPSTREAM_IMAGE_INPUT=true`).
 *
 * ⚠️ Vẫn cần kiểm chuẩn: Dò quét thực tế M0 đã xác nhận cấu trúc trường của invocation văn bản (xem `codecV1.ts`),
 * nhưng do giới hạn trạng thái giấy phép Copilot của tài khoản thử nghiệm (thực tế gặp `InternalError` /
 * `InvalidCopilotLicense`, chưa nhận được phản hồi sinh thành công), nên chưa thể kiểm chứng thêm tên trường
 * và vị trí thực sự của hình ảnh đầu vào. Tại đây tiếp tục áp dụng quy ước sẵn có "chuyển tiếp qua `InvocationInput.passthrough`"
 * (`model`/`reasoning`/`temperature`... đã đi qua kênh này) — vì `scheduler/dispatcher.ts` đã đóng băng, không chấp nhận
 * thêm trường cấp cao nhất mới, việc tái sử dụng passthrough là cách duy nhất hiện tại để đưa trường mới vào tầng giao thức
 * dây mà không cần sửa tầng điều phối (dispatcher). Khi có tài khoản với giấy phép hợp lệ chạy thành công hình ảnh thật,
 * sẽ quyết định giữ nguyên quy ước này hay đổi theo hình thái thực tế mà upstream yêu cầu.
 */
export interface ImageInputDescriptor {
  /** URL ảnh, hoặc data URL được giải mã từ file-id */
  url: string;
  detail?: string | null;
}

export interface InvocationInput {
  invocationId: string;
  /** Văn bản thuần túy người dùng nhập vào lượt này (M3 chỉ hỗ trợ văn bản; hình ảnh/tệp tin là M6) */
  text: string;
  /** Định danh phiên làm việc upstream; mang theo khi tiếp tục cùng một phiên */
  conversationRef?: string | undefined;
  /**
   * Object ID của tài khoản (`participant.id`). Đoạn đo thực tế M0 xác nhận mọi invocation của upstream thật
   * đều mang trường này (khớp với `from.id` của tin nhắn phản hồi); bên gọi (dispatcher) vốn đã giữ
   * oid để dựng URL kết nối, tiện đường chuyển tiếp cho tầng codec, không cần mở thêm kênh truy xuất mới.
   */
  participantId?: string | undefined;
  /** model / reasoning.effort... được truyền trực tiếp, giữ nguyên gửi lên upstream không sửa đổi */
  passthrough?: Record<string, unknown>;
  /** Khai báo các công cụ có sẵn cho lượt này (M5) */
  tools?: readonly ToolDeclaration[] | undefined;
  /** Kết quả thực thi công cụ truyền lại (M5, mang theo khi nối tiếp) */
  toolResults?: readonly ToolResultInput[] | undefined;
}

/** Giao diện mã hóa/giải mã giao thức. Chọn implementation cụ thể theo protocolVersion, thuận tiện thay thế sau M0. */
export interface ProtocolCodec {
  readonly version: string;
  /** Khung (frame) bắt tay (kèm ký tự RS kết thúc) */
  encodeHandshake(): string;
  /** Kiểm tra một đoạn văn bản có phải là phản hồi bắt tay hay không (ack từ server thường là đối tượng rỗng `{}`) */
  isHandshakeAck(raw: string): boolean;
  /** Frame invocation để khởi tạo đối thoại (kèm RS kết thúc) */
  encodeInvocation(input: InvocationInput): string;
  /** Frame nhịp tim ping (kèm RS kết thúc) */
  encodePing(): string;
  /** Frame hủy invocation (kèm RS kết thúc) */
  encodeCancel(invocationId: string): string;
  /** Ánh xạ một raw message thành một số sự kiện đã chuẩn hóa */
  mapMessageToEvents(message: RawMessage): UpstreamEvent[];
  /** Message này có đại diện cho completion (kết thúc luồng) của lượt này hay không */
  isCompletion(message: RawMessage): boolean;
}

/**
 * Tách luồng byte bị dính/nửa gói (sticky/half packet) theo ký tự RS thành các frame hoàn chỉnh.
 * Trả về mảng frame hoàn chỉnh và đoạn chưa hoàn thiện còn sót lại (dùng để ghép nối lượt sau).
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(RECORD_SEPARATOR);
  const rest = parts.pop() ?? '';
  const frames = parts.filter((frame) => frame.length > 0);
  return { frames, rest };
}

/** Phân tích frame JSON đơn lẻ thành raw message; JSON không hợp lệ trả về null (bên gọi quyết định cách xử lý). */
export function parseFrame(frame: string): RawMessage | null {
  try {
    const parsed: unknown = JSON.parse(frame);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as RawMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bộ tái tổ hợp frame: Đưa vào các mẩu chuỗi phân mảnh bất kỳ, xuất ra message hoàn chỉnh.
 * Một frame WebSocket không nhất thiết tương ứng 1-1 với một message của giao thức, có thể bị dính hoặc tách gói.
 */
export class FrameReassembler {
  #buffer = '';

  push(chunk: string): RawMessage[] {
    this.#buffer += chunk;
    const { frames, rest } = splitFrames(this.#buffer);
    this.#buffer = rest;
    const messages: RawMessage[] = [];
    for (const frame of frames) {
      const message = parseFrame(frame);
      if (message !== null) messages.push(message);
    }
    return messages;
  }
}
