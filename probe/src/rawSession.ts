import { WebSocket } from 'ws';
import {
  FrameReassembler,
  MESSAGE_TYPE,
  type ProtocolCodec,
  type RawMessage,
  type ToolDeclaration,
  type ToolResultInput,
  type UpstreamEvent,
} from '../../apps/server/dist/adapter/protocol.js';
import { classifyCloseCode, classifyHttpStatus, UpstreamError } from '../../apps/server/dist/adapter/errors.js';
import type { InvocationOutcome } from './types.js';

/**
 * Engine "phiên thô" (raw session) của chính probe.
 *
 * Tái sử dụng hằng số giao thức, codec và phân loại lỗi của `apps/server/src/adapter`
 * （`FrameReassembler` / `MESSAGE_TYPE` / codec / `classifyHttpStatus` /
 * (`classifyCloseCode`), nhưng **không** tái sử dụng `SydneyConnection`: Trách nhiệm tầng đó là
 * chuẩn hóa frame upstream thành `UpstreamEvent` cho tầng nghiệp vụ sử dụng, sẽ loại bỏ cấu trúc frame gốc; trong khi đó
 * nhiệm vụ cốt lõi của probe M0 lại chính là thu thập cấu trúc frame gốc để hiệu chuẩn `codecV1.ts` (xem
 * "Danh sách sai khác giao thức" trong `report.ts`), vì vậy ở đây cần một vòng kết nối vừa lấy sự kiện chuẩn hóa,
 * vừa lấy frame gốc. Ngoài việc thu thập cấu trúc frame, các ngữ nghĩa vòng đời còn lại (bắt tay, heartbeat,
 * timeout rảnh rỗi, hủy) đều nhất quán với `SydneyConnection`.
 */

export interface RawSessionOptions {
  url: string;
  codec: ProtocolCodec;
  invocationId: string;
  text: string;
  conversationRef?: string | undefined;
  passthrough?: Record<string, unknown> | undefined;
  tools?: readonly ToolDeclaration[] | undefined;
  toolResults?: readonly ToolResultInput[] | undefined;
  handshakeTimeoutMs: number;
  /** Header X-Scenario bắt buộc phải có khi bắt tay; không có đều bị 403 */
  scenario: string;
  /**
   * Object ID của tài khoản, được mã hóa thành `participant.id` trong invocation.
   *
   * Thực nghiệm M0: Các yêu cầu mà upstream thật phân tích đúng đều có trường này ở cấp cao nhất `arguments[0]`.
   * Mục đích của probe là bám sát hình thái client thật, thiếu nó thì kết luận thăm dò sẽ không đáng tin cậy.
   */
  oid?: string | undefined;
  idleTimeoutMs: number;
  /** Timeout cứng của toàn bộ invocation (bao gồm bắt tay), vượt quá sẽ coi là thất bại và đóng kết nối */
  totalTimeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Mỗi khi nhận được một sự kiện chuẩn hóa thì gọi callback đồng bộ một lần, dùng cho các case kiểu "hủy" kích hoạt hủy sau chunk đầu */
  onEvent?: ((event: UpstreamEvent, raw: RawMessage) => void) | undefined;
  /**
   * Khi hủy có gửi stop frame `encodeCancel` trước hay không (mặc định true, tương ứng §3.1 mục 17 "gửi stop frame").
   * Truyền false biểu thị ngắt kết nối trực tiếp, không gửi bất kỳ frame hủy nào (tương ứng mục 29 "Upstream có thể hủy sau khi client ngắt kết nối không",
   * mô phỏng việc client bị rớt mạng bất thường thay vì chủ động hủy một cách nhẹ nhàng).
   */
  sendCancelOnAbort?: boolean | undefined;
  /** Dùng để inject trong test; mặc định dùng thư viện `ws` để nối upstream thật/mô phỏng */
  wsFactory?: ((url: string) => WebSocket) | undefined;
}

function readStatusCode(res: unknown): number {
  if (typeof res === 'object' && res !== null) {
    const status = (res as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function readRetryAfterHeader(res: unknown): string | null {
  if (typeof res !== 'object' || res === null) return null;
  const headers = (res as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return null;
  const value = (headers as Record<string, unknown>)['retry-after'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function bufferToString(data: unknown): string {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

/** Chạy một invocation, thu thập frame gốc và sự kiện chuẩn hóa, trả về kết quả tổng hợp (không ném ngoại lệ, ngoại lệ đều quy về errorCategory). */
export async function runRawSession(options: RawSessionOptions): Promise<InvocationOutcome> {
  const startedAt = Date.now();
  const events: UpstreamEvent[] = [];
  const rawMessages: RawMessage[] = [];
  let conversationRef: string | null = options.conversationRef ?? null;

  return new Promise<InvocationOutcome>((resolve) => {
    let settled = false;
    let handshakeAcked = false;
    const reassembler = new FrameReassembler();
    // X-Scenario là điều kiện cứng để upstream chấp thuận, thiếu nó thì dù thông tin xác thực đúng đến đâu cũng bị 403
    const ws = (options.wsFactory ??
      ((url: string): WebSocket =>
        new WebSocket(url, { headers: { 'X-Scenario': options.scenario } })))(options.url);

    let totalTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;

    const finish = (
      result: Omit<InvocationOutcome, 'events' | 'rawMessages' | 'durationMs' | 'conversationRef' | 'retryAfterMs'> & {
        retryAfterMs?: number | null;
      },
    ): void => {
      if (settled) return;
      settled = true;
      if (totalTimer !== null) clearTimeout(totalTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      try {
        ws.close();
      } catch {
        // Bỏ qua ngoại lệ đóng, đằng nào cũng sẽ terminate ngay
      }
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve({
        ...result,
        retryAfterMs: result.retryAfterMs ?? null,
        events,
        rawMessages,
        durationMs: Date.now() - startedAt,
        conversationRef,
      });
    };

    const resetIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish({
          closeCode: null,
          closeReason: null,
          errorCategory: 'retry_or_switch',
          errorMessage: '上游空闲超时，未在预期时间内收到帧',
        });
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    totalTimer = setTimeout(() => {
      finish({
        closeCode: null,
        closeReason: null,
        errorCategory: 'timeout',
        errorMessage: `超过总超时 ${options.totalTimeoutMs}ms`,
      });
    }, options.totalTimeoutMs);
    totalTimer.unref?.();

    const onAbort = (): void => {
      const shouldSendCancel = options.sendCancelOnAbort ?? true;
      if (shouldSendCancel) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(options.codec.encodeCancel(options.invocationId));
          }
        } catch {
          // Việc hủy là nỗ lực tối đa (best-effort)
        }
      }
      finish({
        closeCode: 1000,
        closeReason: shouldSendCancel ? 'client_cancelled' : 'client_disconnected',
        errorCategory: null,
        errorMessage: null,
      });
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        // Đã hủy: Chờ sau khi open mới xử lý để tránh race condition
        ws.once('open', onAbort);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    ws.on('unexpected-response', (_req: unknown, res: unknown) => {
      const upstreamError = classifyHttpStatus(readStatusCode(res), readRetryAfterHeader(res));
      finish({
        closeCode: null,
        closeReason: null,
        errorCategory: upstreamError.disposition,
        errorMessage: upstreamError.message,
        retryAfterMs: upstreamError.retryAfterMs,
      });
    });

    ws.on('open', () => {
      resetIdle();
      ws.send(options.codec.encodeHandshake());
    });

    ws.on('message', (data: unknown) => {
      resetIdle();
      const text = bufferToString(data);

      if (!handshakeAcked) {
        if (options.codec.isHandshakeAck(text)) {
          handshakeAcked = true;
          ws.send(
            options.codec.encodeInvocation({
              invocationId: options.invocationId,
              text: options.text,
              conversationRef: options.conversationRef,
              participantId: options.oid,
              passthrough: options.passthrough,
              tools: options.tools,
              toolResults: options.toolResults,
            }),
          );
          return;
        }
        handshakeAcked = true;
        // Bắt tay không có ack độc lập, frame đầu coi như tin nhắn thông thường và xử lý tiếp (không return)
      }

      for (const message of reassembler.push(text)) {
        rawMessages.push(message);

        if (message.type === MESSAGE_TYPE.PING) {
          ws.send(options.codec.encodePing());
          continue;
        }

        const conv = extractConversationRef(message);
        if (conv !== null) conversationRef = conv;

        for (const event of options.codec.mapMessageToEvents(message)) {
          events.push(event);
          options.onEvent?.(event, message);
        }

        if (options.codec.isCompletion(message)) {
          finish({ closeCode: 1000, closeReason: null, errorCategory: null, errorMessage: null });
          return;
        }
      }
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString('utf8');
      const classified = classifyCloseCode(code, reason);
      finish({
        closeCode: code,
        closeReason: reason === '' ? null : reason,
        errorCategory: classified === null ? null : classified.disposition,
        errorMessage: classified === null ? null : classified.message,
      });
    });

    ws.on('error', (error: Error) => {
      const upstreamError =
        error instanceof UpstreamError
          ? error
          : new UpstreamError(`上游连接错误：${error.message}`, 'retry_or_switch', { cause: error });
      finish({
        closeCode: null,
        closeReason: null,
        errorCategory: upstreamError.disposition,
        errorMessage: upstreamError.message,
      });
    });
  });
}

/**
 * Tìm kiếm thăm dò định danh phiên/hội thoại từ tin nhắn gốc.
 *
 * Tên trường thực tế chờ M0 hiệu chuẩn, ở đây thử nghiệm heuristic vài key ứng viên theo cách đặt tên phổ biến,
 * tìm thấy chuỗi không rỗng đầu tiên thì sử dụng — không tìm thấy thì là `unknown`, phản ánh trung thực trong báo cáo.
 */
function extractConversationRef(message: RawMessage): string | null {
  const args = Array.isArray(message.arguments) ? message.arguments : [];
  const candidateKeys = ['conversationId', 'conversationRef', 'chatId', 'sessionId'];
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const record = arg as Record<string, unknown>;
    for (const key of candidateKeys) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  for (const key of candidateKeys) {
    const value = (message as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}
