import {
  MESSAGE_TYPE,
  RECORD_SEPARATOR,
  type ImageInputDescriptor,
  type InvocationInput,
  type ProtocolCodec,
  type RawMessage,
  type UpstreamEvent,
} from './protocol.js';

/**
 * Mã hóa / giải mã giao thức Sydney JSON v1.
 *
 * Phân cách frame và các loại message SignalR là quy chuẩn đã định, đáng tin cậy. **Ngữ nghĩa các trường bên trong message đã được
 * kiểm chuẩn thành công vào ngày 27-07-2026 bằng tài khoản M365 Copilot thật (bắt tay WebSocket thật + access token thật)**,
 * kết luận như sau (chi tiết xem phần M0 trong `docs/trien-khai-va-nghiem-thu.md`):
 *
 * 1. **Phía request**: `arguments[0]` là một đối tượng số ít `message` (`{author,inputMethod,text,
 *    messageType}`), không phải mảng `messages` như mô hình cũ; `participant.id` (oid tài khoản),
 *    `conversationId` (chỉ mang theo khi tiếp tục phiên, lượt đầu không gửi), `requestId`, `isStartOfSession`,
 *    `source` đều là các trường ngang hàng cấp cao nhất của `arguments[0]`. Phiên bản này đổi thẳng `messages: []`
 *    cũ thành `message: {}`, vì cấu trúc cũ chưa bao giờ chạy lọt qua upstream thật (luôn trả về
 *    `InvalidRequest`), việc giữ lại một nhánh tương thích "luôn sai" là vô nghĩa, thay thế trực tiếp sẽ gọn ghẽ hơn.
 * 2. **Phía response**: Payload nghiệp vụ nằm trong trường `item` của frame `type:2`, không phải `arguments[0]`
 *    như mô hình cũ; `item.messages[]` đồng thời chứa cả tin nhắn người dùng phản hồi lại và tin nhắn của bot,
 *    `item.result.value` (`Success`/`InvalidRequest`/`ForbiddenRequest`/`InternalError`/`Throttled`...) là kênh lỗi,
 *    `item.result.errorCode` (như `InvalidCopilotLicense`) là phân loại lỗi chi tiết hơn; `item.conversationId`
 *    là định danh phiên làm việc của lượt này; frame completion `type:3` chỉ có `{type:3,invocationId}`,
 *    không mang payload.
 * 3. **`spokenText` không phải là tóm tắt suy luận**: Đo đạc thực tế trong cùng một tin nhắn của bot cho thấy `spokenText` và `text`
 *    có nội dung hoàn toàn giống nhau, chỉ là phiên bản thân thiện với tổng hợp giọng nói (ví dụ lược bỏ một số dấu câu/định dạng), implementation
 *    cũ ánh xạ nó thành `reasoning_delta` là đoán sai — tiếp tục làm vậy sẽ lặp lại nội dung câu trả lời cuối cùng và
 *    giả dạng thành "quá trình suy nghĩ" gửi cho client. Hiện đã loại bỏ; trường suy luận/chuỗi tư duy thật sự chưa thể kiểm chứng
 *    trong đợt này (vấn đề giấy phép/hạn ngạch Copilot của tài khoản test khiến chưa có một lần sinh thành công, xem bên dưới).
 * 4. **Bản thân tài khoản test chưa kiểm chứng được phản hồi sinh thành công**: Yêu cầu được tiếp nhận đầy đủ, phân tích bình thường, tính phí
 *    bình thường (`throttling.metering` trả về hạn ngạch bình thường), nhưng kết quả cuối cùng dừng lại ổn định ở
 *    `ForbiddenRequest`/`InvalidCopilotLicense` (nhánh khi `conversationId` dùng giá trị mặc định/bỏ qua)
 *    hoặc `InternalError` (nhánh khi `conversationId` truyền chuỗi rỗng `''`, vượt qua bước kiểm tra trước nhưng dừng lại ở đây).
 *    Đây là vấn đề hạn ngạch/giấy phép của chính tài khoản (trước đó đã quan sát thấy việc đăng nhập tài khoản này cũng bị chặn bởi chính sách bảo mật,
 *    thuộc cùng một nhóm giới hạn từ phía tài khoản), không phải lỗi định dạng yêu cầu — phản hồi của cả hai luồng đều là đối tượng nghiệp vụ có cấu trúc
 *    hoàn chỉnh chứ không phải `InvalidRequest`, chứng minh định dạng giao thức đã được upstream phân tích chính xác. Vì vậy ở đây
 *    triển khai theo hình thái tự nhiên hơn và nhiều khả năng là chính thức được mong đợi: "lượt đầu không gửi conversationId, tiếp tục phiên mới mang theo"
 *    (tức nhánh đầu tiên), thay vì sao chép cách viết "truyền chuỗi rỗng" nghi là một mẹo lách bất ngờ có hiệu lực. Gọi công cụ, hình ảnh đầu vào
 *    và các trường suy luận thực tế vẫn cần một tài khoản có giấy phép đầy đủ để kiểm chứng.
 */

interface SydneyToolCall {
  callId?: string;
  id?: string;
  name?: string;
  /** Đối số đã hoàn chỉnh (chuỗi JSON hoặc object) */
  arguments?: string | Record<string, unknown>;
  /** Phần gia tăng đối số (dạng stream) */
  argumentsDelta?: string;
  /** Giai đoạn: begin / delta / end */
  phase?: 'begin' | 'delta' | 'end';
}

/** Tin nhắn đơn lẻ phía request (trường thực tế: object số ít, không phải mảng). */
interface SydneyOutboundMessage {
  author: string;
  inputMethod: string;
  text: string;
  messageType: string;
  [key: string]: unknown;
}

/** Tham số invocation gửi tới upstream (`arguments[0]`). */
interface SydneyInvocationArgument {
  source?: string;
  isStartOfSession?: boolean;
  message?: SydneyOutboundMessage;
  participant?: { id: string };
  conversationId?: string;
  requestId?: string;
  /** Khai báo/kết quả công cụ, hình ảnh: vị trí đặt thực tế chưa được kiểm chứng do giới hạn bản quyền tài khoản, tạm áp dụng quy ước trường ngang hàng */
  images?: ImageInputDescriptor[];
  [key: string]: unknown;
}

/** Một tin nhắn trong `item.messages[]` phía response (echo từ người dùng hoặc phản hồi từ bot). */
interface SydneyResponseMessage {
  text?: string;
  author?: string;
  messageType?: string;
  contentOrigin?: string;
  /** Phiên bản thân thiện với bộ đọc giọng nói, nội dung trùng với text, không phải bản tóm tắt suy luận (xem chú thích đầu file mục 3) */
  spokenText?: string;
  /** Cờ đánh dấu thất bại quan sát được; thông tin lỗi chính xác nằm trong item.result, không phán đoán đơn độc dựa vào đây */
  turnState?: string;
  adaptiveCards?: unknown[];
  sourceAttributions?: { seeMoreUrl?: string; providerDisplayName?: string }[];
  /** Gọi công cụ (M5, hình thái thực tế chưa kiểm chứng, dùng mô hình sẵn có) */
  toolCalls?: SydneyToolCall[];
  [key: string]: unknown;
}

/** Kênh lỗi/kết quả phía response. */
interface SydneyResultBlock {
  value?: string;
  message?: string;
  errorCode?: string;
  serviceVersion?: string;
}

/** Trường `item` trong frame `type:2` phía response (vị trí thực tế, không phải `arguments[0]`). */
interface SydneyResponseItem {
  messages?: SydneyResponseMessage[];
  conversationId?: string;
  requestId?: string;
  result?: SydneyResultBlock;
  [key: string]: unknown;
}

function frame(payload: unknown): string {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class SydneyCodecV1 implements ProtocolCodec {
  readonly version = 'sydney-json-v1';

  encodeHandshake(): string {
    return frame({ protocol: 'json', version: 1 });
  }

  isHandshakeAck(raw: string): boolean {
    const trimmed = raw.replaceAll(RECORD_SEPARATOR, '').trim();
    if (trimmed === '' || trimmed === '{}') return true;
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; type?: unknown };
      // Ack bắt tay là đối tượng rỗng hoặc đối tượng không chứa error; có error nghĩa là bắt tay thất bại
      return parsed.error === undefined && parsed.type === undefined;
    } catch {
      return false;
    }
  }

  encodeInvocation(input: InvocationInput): string {
    const argument: SydneyInvocationArgument = {
      // Cùng nguồn với header X-Scenario khi bắt tay; đo thực tế M0 xác nhận giá trị này giúp request được phân tích đầy đủ.
      source: 'officeweb',
      requestId: input.invocationId,
      // Lượt đầu (không có conversationRef) không truyền conversationId, để upstream tạo phiên mới;
      // Khi tiếp tục thì mang theo ID phiên nhận được từ lượt trước.
      isStartOfSession: input.conversationRef === undefined,
      message: {
        author: 'user',
        inputMethod: 'Keyboard',
        text: input.text,
        messageType: 'Chat',
      },
      ...(input.conversationRef === undefined ? {} : { conversationId: input.conversationRef }),
      ...(input.participantId === undefined ? {} : { participant: { id: input.participantId } }),
      ...(input.tools === undefined || input.tools.length === 0 ? {} : { tools: input.tools }),
      ...(input.toolResults === undefined || input.toolResults.length === 0
        ? {}
        : { toolResults: input.toolResults }),
      ...(input.passthrough ?? {}),
    };
    return frame({
      type: MESSAGE_TYPE.STREAM_INVOCATION,
      invocationId: input.invocationId,
      target: 'chat',
      arguments: [argument],
    });
  }

  encodePing(): string {
    return frame({ type: MESSAGE_TYPE.PING });
  }

  encodeCancel(invocationId: string): string {
    return frame({ type: MESSAGE_TYPE.CANCEL_INVOCATION, invocationId });
  }

  isCompletion(message: RawMessage): boolean {
    return message.type === MESSAGE_TYPE.COMPLETION;
  }

  mapMessageToEvents(message: RawMessage): UpstreamEvent[] {
    // Frame nhịp tim và đóng kết nối không sinh ra sự kiện nghiệp vụ
    if (message.type === MESSAGE_TYPE.PING || message.type === MESSAGE_TYPE.CLOSE) {
      return [];
    }

    // completion: Frame completion thực tế của upstream chỉ có {type:3,invocationId}, không mang
    // payload (lỗi đã được phát trước đó trong frame STREAM_ITEM qua item.result);
    // Ở đây giữ lại kiểm tra tương thích cho trường error, đề phòng một số nhánh ngoại lệ đặt lỗi tại frame này.
    if (message.type === MESSAGE_TYPE.COMPLETION) {
      if (typeof message.error === 'string' && message.error !== '') {
        return [{ kind: 'upstream_error', message: message.error, retryable: false }];
      }
      return [{ kind: 'completed', stopReason: null }];
    }

    // stream item: Payload nghiệp vụ nằm trong item (M0 xác nhận thực tế, không phải arguments[0])
    const item = isRecord(message.item) ? (message.item as SydneyResponseItem) : undefined;
    if (item === undefined) return [];

    // Ưu tiên xác định kênh lỗi: khi result.value khác 'Success', tin nhắn bot trong
    // messages chính là văn bản giải thích lỗi (ví dụ trong kịch bản InvalidCopilotLicense / InternalError
    // bot sẽ phản hồi một câu xin lỗi), không được chuyển tiếp nó như nội dung trả lời thật sự.
    const result = item.result;
    if (
      result !== undefined &&
      typeof result.value === 'string' &&
      result.value !== '' &&
      result.value !== 'Success'
    ) {
      return [
        {
          kind: 'upstream_error',
          message: result.message ?? result.errorCode ?? result.value,
          // Throttled / lỗi tạm thời phía server có thể thử lại
          retryable: result.value === 'Throttled' || result.value === 'InternalServerError',
        },
      ];
    }

    const events: UpstreamEvent[] = [];
    const sydneyMessages = Array.isArray(item.messages) ? item.messages : [];
    for (const msg of sydneyMessages) {
      if (msg.author === 'user') continue; // Bỏ qua tin nhắn echo của người dùng

      if (typeof msg.text === 'string' && msg.text !== '') {
        events.push({ kind: 'text_delta', text: msg.text });
      }
      for (const attribution of msg.sourceAttributions ?? []) {
        if (typeof attribution.seeMoreUrl === 'string') {
          events.push({
            kind: 'citation',
            url: attribution.seeMoreUrl,
            title: attribution.providerDisplayName ?? null,
          });
        }
      }
      for (const call of msg.toolCalls ?? []) {
        events.push(...mapToolCall(call));
      }
    }
    return events;
  }
}

/**
 * Ánh xạ message gọi công cụ từ upstream thành các sự kiện đã chuẩn hóa.
 * Hỗ trợ hai hình thái upstream: cung cấp toàn bộ đối số cùng lúc, hoặc phân đoạn stream begin/delta/end.
 *
 * ⚠️ Chờ kiểm chuẩn: Giới hạn giấy phép/hạn ngạch tài khoản đợt này khiến chưa kích hoạt được một lệnh gọi công cụ thật,
 * ở đây dùng tiếp mô hình dựa trên kinh nghiệm dịch ngược SignalR trước đó, tên trường và cách phân mảnh chưa được xác minh thực tế.
 */
function mapToolCall(call: SydneyToolCall): UpstreamEvent[] {
  const callId = call.callId ?? call.id;
  if (callId === undefined || callId === '') return [];

  // Dạng stream: phân phối theo phase
  if (call.phase === 'begin') {
    return [{ kind: 'tool_call_begin', callId, name: call.name ?? '' }];
  }
  if (call.phase === 'delta') {
    return call.argumentsDelta === undefined
      ? []
      : [{ kind: 'tool_call_args_delta', callId, delta: call.argumentsDelta }];
  }
  if (call.phase === 'end') {
    return [{ kind: 'tool_call_end', callId }];
  }

  // Dạng hoàn chỉnh một lần: tách thành begin + một đoạn args_delta + end
  const argsString =
    typeof call.arguments === 'string'
      ? call.arguments
      : call.arguments === undefined
        ? '{}'
        : JSON.stringify(call.arguments);
  return [
    { kind: 'tool_call_begin', callId, name: call.name ?? '' },
    { kind: 'tool_call_args_delta', callId, delta: argsString },
    { kind: 'tool_call_end', callId },
  ];
}

/** Lựa chọn codec theo phiên bản giao thức. Khi giao thức upstream trôi dạt tiếp thì thêm phiên bản mới tại đây. */
export function selectCodec(version: string): ProtocolCodec {
  switch (version) {
    case 'sydney-json-v1':
      return new SydneyCodecV1();
    default:
      // Phiên bản không xác định lùi về v1 và ghi log cảnh báo ở tầng kết nối
      return new SydneyCodecV1();
  }
}
