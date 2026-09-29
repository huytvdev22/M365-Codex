#!/usr/bin/env node
/**
 * Mock upstream Sydney / BizChat độc lập (dùng cho phát triển và nghiệm thu, không tham gia image production).
 *
 * Mục đích: Khi không có tài khoản Microsoft 365 Copilot thật, cho phép chạy thông toàn bộ luồng của gateway —
 * Codex ──Responses──> M365-Codex ──WebSocket──> script này.
 * Nhờ đó có thể xác minh tầng giao thức, SSE, vòng lặp agent công cụ, chèn file đính kèm v.v. mà không phụ thuộc Microsoft.
 *
 * Cách giao tiếp giống như apps/server/test/helpers/mockSydneyServer.ts:
 * SignalR JSON frame + phân tách 0x1e, ack bắt tay, một số STREAM_ITEM, cuối cùng là COMPLETION.
 *
 * Đây là một "mô hình giả", hành vi được quyết định bởi các quy tắc đơn giản:
 *   - invocation có toolResults  → trả về câu trả lời cuối trích dẫn kết quả công cụ;
 *   - invocation có tools và text của người dùng chứa từ khóa kích hoạt → trả về gọi công cụ;
 *   - các trường hợp còn lại → stream một đoạn text và phản hồi lại độ dài ngữ cảnh nhận được để kiểm tra file đính kèm.
 *
 * Cách dùng: node dev/mock-sydney.mjs [--port 4300]
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const RECORD_SEPARATOR = ' ';
const TYPE = { INVOCATION: 1, STREAM_ITEM: 2, COMPLETION: 3, STREAM_INVOCATION: 4, CANCEL: 5, PING: 6 };

const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 4300;

/** Khớp bất kỳ từ nào trong số này được coi là "người dùng muốn mô hình thực hiện thao tác", từ đó kích hoạt gọi công cụ. */
const TOOL_TRIGGERS = ['运行', '执行', '跑一下', '看看目录', 'run ', 'execute', 'list files', 'shell'];

function frame(payload) {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
}

function sendText(ws, invocationId, text) {
  ws.send(
    frame({
      type: TYPE.STREAM_ITEM,
      invocationId,
      arguments: [{ messages: [{ author: 'bot', text, messageType: 'Chat' }] }],
    }),
  );
}

function sendToolCall(ws, invocationId, callId, name, args) {
  ws.send(
    frame({
      type: TYPE.STREAM_ITEM,
      invocationId,
      arguments: [{ messages: [{ author: 'bot', toolCalls: [{ callId, name, arguments: args }] }] }],
    }),
  );
}

/** Tự bịa một bộ tham số hợp lý cho công cụ đã khai báo: công cụ quen thuộc điền theo ngữ nghĩa, lạ thì để object rỗng. */
function inventArguments(tool) {
  const name = tool?.name ?? '';
  const props = tool?.parameters?.properties ?? {};
  if ('command' in props) {
    // Công cụ shell của Codex: command có thể là mảng string hoặc string
    const isArray = props.command?.type === 'array';
    return JSON.stringify({ command: isArray ? ['echo', 'hello-from-mock-upstream'] : 'echo hello' });
  }
  if ('path' in props) return JSON.stringify({ path: '.' });
  if ('query' in props) return JSON.stringify({ query: 'mock query' });
  if (name.includes('weather') && 'city' in props) return JSON.stringify({ city: '北京' });
  return '{}';
}

const httpServer = createServer((req, res) => {
  if (req.url?.startsWith('/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', role: 'mock-sydney-upstream' }));
    return;
  }
  res.writeHead(426);
  res.end('Upgrade Required');
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let connections = 0;
let invocations = 0;

wss.on('connection', (ws) => {
  connections += 1;
  console.log(`[mock] 新连接，当前 ${connections} 条`);
  let handshakeDone = false;

  ws.on('message', (data) => {
    const raw = data.toString('utf8');
    for (const part of raw.split(RECORD_SEPARATOR).filter((s) => s.length > 0)) {
      let msg;
      try {
        msg = JSON.parse(part);
      } catch {
        continue;
      }

      if (!handshakeDone && 'protocol' in msg) {
        handshakeDone = true;
        ws.send(frame({}));
        continue;
      }
      if (msg.type === TYPE.PING) {
        ws.send(frame({ type: TYPE.PING }));
        continue;
      }
      if (msg.type === TYPE.CANCEL) {
        console.log('[mock] 收到取消:', msg.invocationId);
        continue;
      }
      if (msg.type !== TYPE.STREAM_INVOCATION && msg.type !== TYPE.INVOCATION) continue;

      invocations += 1;
      const invocationId = msg.invocationId ?? String(invocations);
      const arg = msg.arguments?.[0] ?? {};
      const userText = (arg.messages ?? []).find((m) => m.author === 'user')?.text ?? '';
      const tools = arg.tools ?? [];
      const toolResults = arg.toolResults ?? [];

      console.log(
        `[mock] #${invocations} 文本 ${userText.length} 字符，工具 ${tools.length} 个，工具结果 ${toolResults.length} 条`,
      );

      // 1) Mang kết quả công cụ quay lại: đưa ra câu trả lời cuối cùng và chèn nội dung kết quả vào, chứng minh cả chu trình đã thông suốt
      if (toolResults.length > 0) {
        const joined = toolResults.map((r) => String(r.output ?? '').trim()).join(' | ');
        sendText(ws, invocationId, '工具已执行完毕。');
        sendText(ws, invocationId, `返回内容是：${joined.slice(0, 400)}`);
        ws.send(frame({ type: TYPE.COMPLETION, invocationId }));
        continue;
      }

      // 2) Đã khai báo công cụ và người dùng muốn thực hiện thao tác: khởi tạo một lệnh gọi công cụ
      const wantsTool = TOOL_TRIGGERS.some((t) => userText.toLowerCase().includes(t.toLowerCase()));
      if (tools.length > 0 && wantsTool) {
        const tool = tools.find((t) => t.name === 'shell') ?? tools[0];
        const callId = `mockcall_${invocations}_${randomBytes(4).toString('hex')}`;
        console.log(`[mock] → 调用工具 ${tool.name}`);
        sendToolCall(ws, invocationId, callId, tool.name, inventArguments(tool));
        ws.send(frame({ type: TYPE.COMPLETION, invocationId }));
        continue;
      }

      // 3) Hỏi đáp thông thường: stream trả về qua vài frame và phản hồi lại quy mô ngữ cảnh để xác nhận file đính kèm đã được chèn
      const reply = [
        '这是模拟上游的回答。',
        `我收到了 ${userText.length} 个字符的上下文`,
        tools.length > 0 ? `，以及 ${tools.length} 个可用工具。` : '。',
      ].join('');
      for (const chunk of reply.match(/.{1,12}/gu) ?? [reply]) {
        sendText(ws, invocationId, chunk);
      }
      ws.send(frame({ type: TYPE.COMPLETION, invocationId }));
    }
  });

  ws.on('close', () => {
    connections -= 1;
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] 模拟 Sydney 上游已启动：ws://0.0.0.0:${PORT}`);
  console.log('[mock] 这是假上游，不连接任何 Microsoft 服务，也不涉及任何真实凭据。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('[mock] 退出');
    httpServer.close(() => process.exit(0));
  });
}
