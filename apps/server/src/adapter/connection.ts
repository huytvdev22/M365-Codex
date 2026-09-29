import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger } from 'pino';
import { WebSocket, type ClientOptions } from 'ws';
import type { UpstreamConfig } from '../config/index.js';
import { hostnameFromUrl, shouldBypassProxy } from '../util/noProxy.js';
import { AsyncQueue } from './asyncQueue.js';
import { redactWsUrl } from './endpoint.js';
import { classifyCloseCode, classifyHttpStatus, UpstreamError } from './errors.js';
import {
  FrameReassembler,
  MESSAGE_TYPE,
  type ProtocolCodec,
  type ToolDeclaration,
  type ToolResultInput,
  type UpstreamEvent,
} from './protocol.js';

/**
 * Kết nối đối thoại upstream đơn lẻ.
 *
 * Một instance SydneyConnection = một lần invocation trên một kết nối WebSocket.
 * Chịu trách nhiệm: bắt tay, nhịp tim (heartbeat), hết thời gian chờ rỗi (idle timeout),
 * tái tổ hợp frame, ánh xạ raw message thành các sự kiện đã chuẩn hóa, hủy bỏ.
 *
 * Việc kết nối lại khi mất mạng và đổi tài khoản không nằm ở đây — chúng biểu thị việc
 * "tái tạo đối thoại bằng ngữ cảnh đã tích lũy ở local", do scheduler điều phối (xem scheduler).
 * Tầng này chỉ phản ánh trung thực vòng đời của một kết nối đơn lẻ,
 * khi lỗi xảy ra sẽ throw UpstreamError **đã được phân loại**.
 */

export interface ConnectionDeps {
  config: UpstreamConfig;
  codec: ProtocolCodec;
  logger: Logger;
  /** URL proxy outbound (HTTPS_PROXY / HTTP_PROXY), dùng để liên kết lưu lượng upstream tới outbound chỉ định */
  proxyUrl?: string | null;
  /** Danh sách loại trừ NO_PROXY; máy chủ đích nếu khớp sẽ kết nối trực tiếp dù proxyUrl đã được cấu hình */
  noProxy?: string | null;
  /** Inject implementation WebSocket, dùng cho kiểm thử; mặc định dùng thư viện ws */
  wsFactory?: (url: string, options: ClientOptions) => WebSocket;
}

export interface RunInput {
  url: string;
  invocationId: string;
  text: string;
  conversationRef?: string | undefined;
  /** Object ID của tài khoản, truyền nguyên trạng cho codec điền `participant.id` (M0 xác nhận upstream thật cần trường này) */
  oid?: string | undefined;
  passthrough?: Record<string, unknown> | undefined;
  tools?: readonly ToolDeclaration[] | undefined;
  toolResults?: readonly ToolResultInput[] | undefined;
  /** Tín hiệu hủy từ bên ngoài: sau khi abort kết nối sẽ gửi frame hủy lên upstream và đóng lại */
  signal?: AbortSignal | undefined;
}

export class SydneyConnection {
  readonly #deps: ConnectionDeps;
  #ws: WebSocket | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
  }

  /**
   * Kết nối và chạy trọn vẹn một invocation, yield các sự kiện đã chuẩn hóa theo thứ tự đến.
   * Kết thúc bình thường tại completion; bất thường sẽ ném UpstreamError.
   */
  async *run(input: RunInput): AsyncGenerator<UpstreamEvent> {
    const { config, codec, logger } = this.#deps;
    const queue = new AsyncQueue<UpstreamEvent>();
    const reassembler = new FrameReassembler();
    let handshakeAcked = false;

    // X-Scenario là điều kiện cứng để upstream thông qua: thiếu nó luôn bị 403 (body rỗng, không có WWW-Authenticate,
    // trông hoàn toàn như "tài khoản này không có quyền", gây hiểu nhầm rất lớn khi điều tra thực tế). Giá trị phải khớp chính xác.
    const options: ClientOptions = {
      handshakeTimeout: config.handshakeTimeoutMs,
      headers: { 'X-Scenario': config.scenario },
    };
    if (this.#deps.proxyUrl != null && this.#deps.proxyUrl !== '') {
      const targetHost = hostnameFromUrl(input.url);
      const bypass = targetHost !== null && shouldBypassProxy(targetHost, this.#deps.noProxy);
      if (bypass) {
        logger.debug({ url: redactWsUrl(input.url) }, 'Máy chủ đích khớp NO_PROXY, kết nối trực tiếp không qua proxy');
      } else {
        options.agent = new HttpsProxyAgent(this.#deps.proxyUrl);
      }
    }

    const ws = (this.#deps.wsFactory ?? defaultWsFactory)(input.url, options);
    this.#ws = ws;

    const resetIdle = (): void => {
      if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => {
        queue.fail(
          new UpstreamError('Upstream hết thời gian chờ rỗi, không nhận được frame trong thời gian dự kiến', 'retry_or_switch', { statusCode: null }),
        );
        this.#teardown(1000);
      }, config.idleTimeoutMs);
      this.#idleTimer.unref?.();
    };

    // Lỗi HTTP giai đoạn bắt tay WS (401/403/429) chỉ ở đây mới lấy được mã trạng thái
    ws.on('unexpected-response', (_req, res) => {
      queue.fail(classifyHttpStatus(readStatusCode(res), readRetryAfterHeader(res)));
      this.#teardown();
    });

    ws.on('open', () => {
      logger.debug({ url: redactWsUrl(input.url) }, 'WebSocket upstream đã kết nối, gửi bắt tay (handshake)');
      ws.send(codec.encodeHandshake());
      resetIdle();
    });

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      resetIdle();
      const text = bufferToString(data);
      // Trước khi nhận ack bắt tay, đoạn văn bản đầu tiên dùng để xác nhận bắt tay thành công và kích hoạt invocation
      if (!handshakeAcked) {
        if (codec.isHandshakeAck(text)) {
          handshakeAcked = true;
          this.#startHeartbeat(ws, codec, config.heartbeatIntervalMs);
          ws.send(
            codec.encodeInvocation({
              invocationId: input.invocationId,
              text: input.text,
              conversationRef: input.conversationRef,
              participantId: input.oid,
              passthrough: input.passthrough,
              tools: input.tools,
              toolResults: input.toolResults,
            }),
          );
          return;
        }
        // Frame đầu tiên không phải ack: có thể việc bắt tay đã trả về nội dung cùng lúc, tiếp tục xử lý như message thông thường
        handshakeAcked = true;
        this.#startHeartbeat(ws, codec, config.heartbeatIntervalMs);
      }

      for (const message of reassembler.push(text)) {
        if (message.type === MESSAGE_TYPE.PING) {
          // Phản hồi nhịp tim ping
          ws.send(codec.encodePing());
          continue;
        }
        for (const event of codec.mapMessageToEvents(message)) {
          queue.push(event);
        }
        if (codec.isCompletion(message)) {
          queue.end();
          this.#teardown(1000);
          return;
        }
      }
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString('utf8');
      const classified = classifyCloseCode(code, reason);
      if (classified === null) {
        queue.end();
      } else {
        queue.fail(classified);
      }
      this.#teardown();
    });

    ws.on('error', (error: Error) => {
      // 'error' thường đi kèm 'close' / 'unexpected-response'; nếu hàng đợi đã kết thúc thì bỏ qua
      queue.fail(
        new UpstreamError(`Lỗi kết nối upstream: ${error.message}`, 'retry_or_switch', {
          statusCode: null,
          cause: error,
        }),
      );
      this.#teardown();
    });

    const onAbort = (): void => {
      logger.debug('Nhận được tín hiệu hủy, gửi frame hủy lên upstream');
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(codec.encodeCancel(input.invocationId));
        }
      } catch {
        // Hủy theo cơ chế nỗ lực tối đa (best-effort), dù gửi thất bại cũng tiếp tục đóng
      }
      queue.end();
      this.#teardown(1000);
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      yield* queue;
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      this.#teardown();
    }
  }

  #startHeartbeat(ws: WebSocket, codec: ProtocolCodec, intervalMs: number): void {
    if (this.#heartbeat !== null) return;
    this.#heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(codec.encodePing());
        } catch {
          // Gửi thất bại sẽ do sự kiện error/close tiếp quản
        }
      }
    }, intervalMs);
    this.#heartbeat.unref?.();
  }

  #teardown(closeCode?: number): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#ws !== null) {
      try {
        if (closeCode !== undefined) this.#ws.close(closeCode);
        else this.#ws.terminate();
      } catch {
        // Bỏ qua ngoại lệ khi đóng
      }
      this.#ws = null;
    }
  }
}

function defaultWsFactory(url: string, options: ClientOptions): WebSocket {
  return new WebSocket(url, options);
}

function bufferToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * Trích xuất an toàn mã trạng thái và Retry-After từ callback 'unexpected-response' của ws.
 * Type annotation của ws cho tham số callback này có thể suy biến thành any qua các phiên bản,
 * ở đây xử lý theo unknown để không để any rò rỉ vào logic nghiệp vụ.
 */
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
