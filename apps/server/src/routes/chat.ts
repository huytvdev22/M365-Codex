import { REQUEST_ID_HEADER } from '@m365-codex/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { createApiKeyGuard } from '../gateway/auth.js';
import { beginIdempotency } from '../gateway/idempotency.js';
import {
  ChatStreamTranslator,
  chatRequestToResponsesPayload,
  parseChatCompletionRequest,
  responseToChatCompletion,
} from '../responses/chatBridge.js';
import { parseResponsesRequest } from '../responses/schema.js';
import type { SseEvent } from '../responses/types.js';

/**
 * `POST /v1/chat/completions` (tương ứng kế hoạch triển khai §M6).
 *
 * **Tái sử dụng nhân Responses, tuyệt đối không xây dựng thêm một logic suy luận riêng**: Chuyển request Chat thành
 * `ResponsesRequest` giao cho `ResponsesService` hiện có, rồi chuyển kết quả/luồng sự kiện ngược lại
 * hình thái Chat. Điều phối tài khoản, vòng lặp proxy công cụ, vòng đời SSE đều dùng lại toàn bộ
 * triển khai sẵn có của `/v1/responses`, ở đây chỉ làm chuyển đổi giao thức (xem `responses/chatBridge.ts`).
 */
export function registerChatRoutes(app: FastifyInstance, context: AppContext): void {
  const apiKeyGuard = createApiKeyGuard(context);

  app.post('/v1/chat/completions', { preHandler: apiKeyGuard }, async (request, reply) => {
    const chat = parseChatCompletionRequest(request.body);
    const responsesRequest = parseResponsesRequest(chatRequestToResponsesPayload(chat));
    const apiKeyId = request.apiKeyRow?.id ?? null;
    const idempotencyKey = headerValue(request, 'idempotency-key');

    const idem = beginIdempotency({
      store: context.idempotency,
      key: idempotencyKey,
      apiKeyId,
      endpoint: 'POST /v1/chat/completions',
      rawBody: request.body,
      stream: chat.stream === true,
    });
    if (idem.replay !== undefined) {
      reply.code(idem.replay.statusCode);
      return idem.replay.body;
    }

    try {
      // Client ngắt kết nối → Hủy upstream (dùng chung cơ chế hủy với /v1/responses)
      const controller = new AbortController();
      const execution = context.responses.create({
        request: responsesRequest,
        apiKeyId,
        signal: controller.signal,
        idempotencyKey,
        toolCallsCeiling: request.apiKeyLimits?.maxToolCalls,
      });
      context.inFlight.register(execution.responseId, controller);

      // Xem chú thích biến cùng tên trong routes/v1.ts: sau khi hijack thì onResponse không còn kích hoạt nữa,
      // dựa vào cờ này để phân biệt "client ngắt kết nối khi luồng chưa kết thúc" (tính là gián đoạn) và "kết nối đóng sau khi luồng đã hoàn tất"
      let handlerDone = false;
      const onClose = (): void => {
        if (!handlerDone && chat.stream === true) {
          context.metrics.sseInterrupted.inc({ endpoint: 'chat_completions' });
        }
        controller.abort();
      };
      reply.raw.on('close', onClose);

      try {
        if (chat.stream) {
          const startedAt = process.hrtime.bigint();
          const streamed = await streamChatCompletion(reply, execution.stream, execution.responseId, chat.model);
          context.metrics.requests.inc({ endpoint: 'POST /v1/chat/completions', status: '200' });
          context.metrics.requestDuration.observe(elapsedSeconds(startedAt), {
            endpoint: 'POST /v1/chat/completions',
          });
          idem.handle?.complete(0, null, null);
          return streamed;
        }
        // Không stream: Chạy cạn luồng sự kiện (thúc đẩy upstream), rồi chuyển đối tượng Response cuối cùng thành chat.completion
        for await (const _event of execution.stream) {
          void _event;
        }
        const error = execution.getError();
        if (error !== null) throw error;
        reply.code(200);
        const final = responseToChatCompletion(execution.getFinal());
        idem.handle?.complete(200, final, execution.responseId);
        return final;
      } finally {
        handlerDone = true;
        reply.raw.removeListener('close', onClose);
        context.inFlight.unregister(execution.responseId);
      }
    } catch (error) {
      idem.handle?.release();
      throw error;
    }
  });
}

/** Truyền phát trực tuyến dưới dạng SSE `chat.completion.chunk`, cuối cùng gửi `data: [DONE]`. */
async function streamChatCompletion(
  reply: FastifyReply,
  stream: AsyncGenerator<SseEvent>,
  responseId: string,
  model: string,
): Promise<void> {
  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('cache-control', 'no-cache, no-transform');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.raw.setHeader('x-accel-buffering', 'no');
  reply.raw.setHeader(REQUEST_ID_HEADER, String(reply.request.id));
  reply.hijack();
  reply.raw.flushHeaders();

  const createdAt = Math.floor(Date.now() / 1000);
  const translator = new ChatStreamTranslator(responseId, model, createdAt);

  const write = async (payload: Record<string, unknown>): Promise<void> => {
    if (reply.raw.destroyed) return;
    const ok = reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    // Sau khi client ngắt kết nối thì sự kiện 'drain' sẽ không bao giờ tới (xem chú thích tương tự waitForDrainOrClose trong routes/v1.ts),
    // bắt buộc phải đồng thời lắng nghe 'close', nếu không tại đây sẽ bị treo vĩnh viễn và inFlight cũng không bao giờ được giải phóng
    if (!ok) await waitForDrainOrClose(reply);
  };

  try {
    await write(translator.start());
    for await (const event of stream) {
      const chunk = translator.translate(event);
      if (chunk !== null) await write(chunk);
    }
    if (!reply.raw.destroyed) reply.raw.write('data: [DONE]\n\n');
  } catch (error) {
    // Bên trong luồng sự kiện về lý thuyết đã chuyển lỗi thành response.failed (sẽ dịch thành chunk có finish_reason);
    // chạy tới đây là trường hợp ngoài ý muốn, giữ cách xử lý nhất quán với /v1/responses
    reply.request.log.error({ err: error }, 'Luồng SSE Chat Completions bị gián đoạn bất ngờ');
  } finally {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }
}

function waitForDrainOrClose(reply: FastifyReply): Promise<void> {
  if (reply.raw.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      reply.raw.removeListener('drain', onSettled);
      reply.raw.removeListener('close', onSettled);
    };
    const onSettled = (): void => {
      cleanup();
      resolve();
    };
    reply.raw.once('drain', onSettled);
    reply.raw.once('close', onSettled);
  });
}

/** Chuyển đổi điểm bắt đầu `process.hrtime.bigint()` thành số giây đã trôi qua, phục vụ ghi nhận histogram. */
function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}
