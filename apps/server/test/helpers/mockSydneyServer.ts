import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { MESSAGE_TYPE, RECORD_SEPARATOR } from '../../src/adapter/protocol.js';

/**
 * Mock WebSocket upstream Sydney / BizChat (tương ứng kế hoạch triển khai §8 "Mock Sydney WS upstream").
 *
 * Cách giao tiếp giống như upstream thật: SignalR JSON frame + phân tách 0x1e, ack bắt tay, stream vài frame,
 * kết thúc bằng completion. Định dạng trường bám sát kết quả hiệu chuẩn M0 đã thông qua với tài khoản thật ngày 27-07-2026 —
 * Phía request `arguments[0].message` là đối tượng số ít, payload nghiệp vụ phía response nằm trong trường `item`
 * (`item.messages[]` / `item.result`), không phải `arguments[0].messages[]` của mô hình cũ
 * (chi tiết xem chú thích đầu `src/adapter/codecV1.ts`). Có thể qua behavior để inject các ngoại lệ,
 * dùng để test cách xử lý của tầng kết nối và bộ điều phối.
 *
 * Tuyệt đối không dính dáng mạng thật hoặc thông tin xác thực thật.
 */

export type MockBehavior =
  | { kind: 'normal'; chunks: string[]; citations?: { url: string; title: string }[] }
  /** Chèn độ trễ giữa các chunk, tạo khoảng thời gian cho test "client ngắt kết nối trước khi stream kết thúc" */
  | { kind: 'slow'; chunks: string[]; delayMs: number }
  /** Giai đoạn nâng cấp WS trả về trực tiếp HTTP status chỉ định (401/403/429…) */
  | { kind: 'http-status'; status: number; retryAfter?: string }
  /** Đóng bất thường sau khi bắt tay */
  | { kind: 'abnormal-close'; code: number; reason?: string }
  /** Trả về lỗi Throttled có thể thử lại trong stream */
  | { kind: 'throttle' }
  /** Sau khi bắt tay không gửi gì, kích hoạt timeout rảnh rỗi */
  | { kind: 'idle' }
  /** completion có mang theo lỗi */
  | { kind: 'completion-error'; message: string }
  /** Trả về một lệnh gọi công cụ */
  | { kind: 'tool-call'; callId: string; name: string; arguments: string }
  /** Trả về nhiều lệnh gọi công cụ cùng lúc (test song song và giới hạn trên mỗi vòng) */
  | { kind: 'tool-calls'; calls: { callId: string; name: string; arguments: string }[] }
  /** Invocation lần 1 trả về badArgs, sau đó trả về goodArgs (test sửa tham số) */
  | { kind: 'tool-call-repair'; callId: string; name: string; badArgs: string; goodArgs: string };

export interface MockSydneyServer {
  url: string;
  /** Query param access_token nhận được (dùng cho test khử nhạy cảm) */
  lastAccessToken: string | null;
  /** Văn bản invocation nhận được, theo thứ tự đến */
  invocationTexts: string[];
  /** Số kết nối đã thiết lập */
  connectionCount: number;
  /** Số invocation nhận được (qua các kết nối) */
  invocationCount: number;
  /** Số lượng ping nhận được */
  pingCount: number;
  setBehavior: (behavior: MockBehavior) => void;
  close: () => Promise<void>;
}

function frame(payload: unknown): string {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
}

export async function startMockSydneyServer(initial: MockBehavior): Promise<MockSydneyServer> {
  let behavior = initial;
  const state = {
    lastAccessToken: null as string | null,
    invocationTexts: [] as string[],
    connectionCount: 0,
    pingCount: 0,
    invocationCount: 0,
  };

  const httpServer: Server = createServer((_req, res) => {
    res.writeHead(426);
    res.end('Upgrade Required');
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.lastAccessToken = url.searchParams.get('access_token');

    // Hành vi http-status: Từ chối trong giai đoạn nâng cấp và trả về status code chỉ định
    if (behavior.kind === 'http-status') {
      const extra = behavior.retryAfter !== undefined ? `Retry-After: ${behavior.retryAfter}\r\n` : '';
      socket.write(
        `HTTP/1.1 ${behavior.status} Rejected\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    state.connectionCount += 1;
    let handshakeDone = false;

    ws.on('message', (data: Buffer) => {
      const raw = data.toString('utf8');
      for (const part of raw.split(RECORD_SEPARATOR).filter((frag) => frag.length > 0)) {
        let msg: { type?: number; target?: string; invocationId?: string; arguments?: unknown[] };
        try {
          msg = JSON.parse(part);
        } catch {
          continue;
        }

        // Frame bắt tay: {"protocol":"json","version":1}
        if (!handshakeDone && 'protocol' in msg) {
          handshakeDone = true;
          ws.send(frame({})); // ack
          return;
        }

        if (msg.type === MESSAGE_TYPE.PING) {
          state.pingCount += 1;
          continue;
        }

        if (msg.type === MESSAGE_TYPE.STREAM_INVOCATION || msg.type === MESSAGE_TYPE.INVOCATION) {
          // Hình thái request thật: arguments[0].message là đối tượng số ít, không phải mảng messages
          const arg = (msg.arguments?.[0] ?? {}) as { message?: { text?: string; author?: string } };
          state.invocationTexts.push(arg.message?.text ?? '');
          state.invocationCount += 1;
          void runBehavior(ws, msg.invocationId ?? 'inv', state.invocationCount);
        }
      }
    });
  });

  function sendItem(ws: WebSocket, invocationId: string, item: Record<string, unknown>): void {
    ws.send(frame({ type: MESSAGE_TYPE.STREAM_ITEM, invocationId, item }));
  }

  function sendToolCall(ws: WebSocket, invocationId: string, callId: string, name: string, args: string): void {
    sendItem(ws, invocationId, {
      messages: [{ author: 'bot', toolCalls: [{ callId, name, arguments: args }] }],
    });
    ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
  }

  async function runBehavior(ws: WebSocket, invocationId: string, invocationCount: number): Promise<void> {
    switch (behavior.kind) {
      case 'tool-call': {
        sendToolCall(ws, invocationId, behavior.callId, behavior.name, behavior.arguments);
        break;
      }
      case 'tool-calls': {
        sendItem(ws, invocationId, { messages: [{ author: 'bot', toolCalls: behavior.calls }] });
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
        break;
      }
      case 'tool-call-repair': {
        const args = invocationCount === 1 ? behavior.badArgs : behavior.goodArgs;
        sendToolCall(ws, invocationId, behavior.callId, behavior.name, args);
        break;
      }
      case 'slow': {
        // Lưu trước một bản vào biến cục bộ: await phía dưới sẽ khiến TS cho rằng `behavior` lớp ngoài khả biến
        // có thể đã bị gán lại bởi setBehavior khi khôi phục thực thi, dẫn đến mất type narrowing
        const slow = behavior;
        for (const chunk of slow.chunks) {
          await new Promise((resolve) => setTimeout(resolve, slow.delayMs));
          if (ws.readyState !== WebSocket.OPEN) return; // Client đã ngắt kết nối, không ghi lên kết nối đã đóng nữa
          sendItem(ws, invocationId, { messages: [{ author: 'bot', text: chunk, messageType: 'Chat' }] });
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
        break;
      }
      case 'normal': {
        for (const chunk of behavior.chunks) {
          const message: Record<string, unknown> = {
            author: 'bot',
            text: chunk,
            messageType: 'Chat',
          };
          if (behavior.citations !== undefined) {
            message.sourceAttributions = behavior.citations.map((c) => ({
              seeMoreUrl: c.url,
              providerDisplayName: c.title,
            }));
          }
          sendItem(ws, invocationId, { messages: [message] });
        }
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
        break;
      }
      case 'throttle': {
        sendItem(ws, invocationId, { result: { value: 'Throttled', message: '触发限流' } });
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId }));
        break;
      }
      case 'completion-error': {
        ws.send(frame({ type: MESSAGE_TYPE.COMPLETION, invocationId, error: behavior.message }));
        break;
      }
      case 'abnormal-close': {
        ws.close(behavior.code, behavior.reason ?? '');
        break;
      }
      case 'idle': {
        // Cố ý không gửi gì cả
        break;
      }
      default:
        break;
    }
  }

  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${port}`,
    get lastAccessToken() {
      return state.lastAccessToken;
    },
    get invocationTexts() {
      return state.invocationTexts;
    },
    get connectionCount() {
      return state.connectionCount;
    },
    get invocationCount() {
      return state.invocationCount;
    },
    get pingCount() {
      return state.pingCount;
    },
    setBehavior(next: MockBehavior) {
      behavior = next;
    },
    close: async () => {
      wss.close();
      httpServer.close();
      await once(httpServer, 'close').catch(() => undefined);
    },
  };
}
