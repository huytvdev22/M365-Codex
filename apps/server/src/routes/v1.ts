import { ApiError, REQUEST_ID_HEADER } from '@m365-codex/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { createApiKeyGuard } from '../gateway/auth.js';
import { beginIdempotency } from '../gateway/idempotency.js';
import { loadModels } from '../responses/models.js';
import { parseResponsesRequest } from '../responses/schema.js';
import { serializeSse, type SseEvent } from '../responses/types.js';

/**
 * Giao diện tương thích bên ngoài `/v1/*` (tương ứng kế hoạch triển khai §4.1).
 * Toàn bộ đi qua xác thực API Key. Responses hỗ trợ cả non-stream và SSE stream.
 */

export function registerV1Routes(app: FastifyInstance, context: AppContext): void {
  const apiKeyGuard = createApiKeyGuard(context);
  // Khi không đọc được tệp danh mục thì fallback về danh mục đơn lẻ tích hợp sẵn — đây là vấn đề triển khai, bắt buộc phải lưu vết
  const models = loadModels(undefined, (reason) => context.logger.warn({ reason }, 'Hạ cấp danh mục mô hình'));

  app.get('/v1/models', { preHandler: apiKeyGuard }, async () => models);

  app.post('/v1/responses', { preHandler: apiKeyGuard }, async (request, reply) => {
    const body = parseResponsesRequest(request.body);
    const apiKeyId = request.apiKeyRow?.id ?? null;
    const idempotencyKey = headerValue(request, 'idempotency-key');

    const idem = beginIdempotency({
      store: context.idempotency,
      key: idempotencyKey,
      apiKeyId,
      endpoint: 'POST /v1/responses',
      rawBody: request.body,
      stream: body.stream === true,
    });
    if (idem.replay !== undefined) {
      reply.code(idem.replay.statusCode);
      return idem.replay.body;
    }

    try {
      // Client ngắt kết nối → Hủy upstream
      const controller = new AbortController();
      const execution = context.responses.create({
        request: body,
        apiKeyId,
        signal: controller.signal,
        idempotencyKey,
        toolCallsCeiling: request.apiKeyLimits?.maxToolCalls,
      });
      context.inFlight.register(execution.responseId, controller);

      // Công cụ đã khai báo nhưng không thể thực thi (như web_search do OpenAI quản lý) không bị âm thầm loại bỏ:
      // Trả về header phản hồi tại đây để caller thấy ngay những công cụ nào của họ sẽ không có hiệu lực
      if (execution.skippedTools.length > 0) {
        void reply.header('x-m365-codex-skipped-tools', execution.skippedTools.join(','));
      }

      // handlerDone đánh dấu "request này đã chạy tới phần kết thúc (finally)" — sau khi SSE hijack,
      // onResponse của Fastify không còn được kích hoạt nữa, chỉ có thể dựa vào cờ này để phân biệt "client ngắt kết nối
      // khi stream chưa kết thúc" (thực sự bị gián đoạn, tính vào sseInterrupted) và "kết nối chỉ đóng sau khi stream
      // đã kết thúc bình thường" (không tính là gián đoạn)
      let handlerDone = false;
      const onClose = (): void => {
        if (!handlerDone && body.stream === true) {
          context.metrics.sseInterrupted.inc({ endpoint: 'responses' });
        }
        controller.abort();
      };
      reply.raw.on('close', onClose);

      try {
        if (body.stream) {
          const startedAt = process.hrtime.bigint();
          const streamed = await streamResponse(reply, execution.stream);
          // Sau khi hijack thì onResponse không kích hoạt, tại đây ghi nhận thủ công số lượng request và thời gian xử lý (§17)
          context.metrics.requests.inc({ endpoint: 'POST /v1/responses', status: '200' });
          context.metrics.requestDuration.observe(elapsedSeconds(startedAt), {
            endpoint: 'POST /v1/responses',
          });
          idem.handle?.complete(0, null, null);
          return streamed;
        }
        // Không stream: Chạy cạn luồng sự kiện (thúc đẩy upstream), sau đó trả về đối tượng cuối cùng
        for await (const _event of execution.stream) {
          void _event;
        }
        const error = execution.getError();
        if (error !== null) throw error;
        reply.code(200);
        const final = execution.getFinal();
        idem.handle?.complete(200, final, execution.responseId);
        return final;
      } finally {
        handlerDone = true;
        reply.raw.removeListener('close', onClose);
        context.inFlight.unregister(execution.responseId);
      }
    } catch (error) {
      // Lần đầu thất bại cần giải phóng idempotency key, nếu không việc thử lại với cùng key sẽ liên tục gặp in_progress
      idem.handle?.release();
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/v1/responses/:id',
    { preHandler: apiKeyGuard },
    async (request) => {
      const row = context.responseRepo.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('response không tồn tại');
      assertOwnership(row.api_key_id, request.apiKeyRow?.id ?? null);
      const body = context.responseRepo.readBody(request.params.id);
      if (body === null) {
        // Chưa hoàn thành hoặc không có snapshot: Trả về trạng thái tinh gọn
        return { id: row.id, object: 'response', status: row.status };
      }
      return body;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/responses/:id/cancel',
    { preHandler: apiKeyGuard },
    async (request) => {
      const row = context.responseRepo.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('response không tồn tại');
      assertOwnership(row.api_key_id, request.apiKeyRow?.id ?? null);
      const cancelled = context.inFlight.cancel(request.params.id);
      if (!cancelled && (row.status === 'completed' || row.status === 'failed')) {
        throw ApiError.badRequest(`response đã ở trạng thái ${row.status}, không thể hủy`);
      }
      return { id: row.id, object: 'response', status: 'cancelling' };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/responses/:id',
    { preHandler: apiKeyGuard },
    async (request) => {
      const row = context.responseRepo.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('response không tồn tại');
      assertOwnership(row.api_key_id, request.apiKeyRow?.id ?? null);
      context.inFlight.cancel(request.params.id);
      return { id: row.id, object: 'response', deleted: true };
    },
  );
}

/** Truyền phát trực tuyến bằng SSE. Thiết lập header SSE và hijack trước sự kiện đầu tiên. */
async function streamResponse(reply: FastifyReply, stream: AsyncGenerator<SseEvent>): Promise<void> {
  reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  reply.raw.setHeader('cache-control', 'no-cache, no-transform');
  reply.raw.setHeader('connection', 'keep-alive');
  reply.raw.setHeader('x-accel-buffering', 'no');
  reply.raw.setHeader(REQUEST_ID_HEADER, String(reply.request.id));
  reply.hijack();
  reply.raw.flushHeaders();

  try {
    for await (const event of stream) {
      // Kết nối đã ngắt thì không cần ghi tiếp nữa — tiếp tục write() chỉ ném byte vào một bộ đệm không có người nhận,
      // làm chậm vô ích tốc độ chạy cạn của luồng sự kiện
      if (reply.raw.destroyed) continue;
      const ok = reply.raw.write(serializeSse(event));
      if (!ok) await waitForDrainOrClose(reply);
    }
  } catch (error) {
    // Bên trong luồng sự kiện về lý thuyết đã chuyển lỗi thành response.failed; chạy tới đây là ngoài ý muốn
    reply.request.log.error({ err: error }, 'Luồng SSE bị gián đoạn bất ngờ');
  } finally {
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }
}

/**
 * Đợi cho đến khi bộ đệm có thể ghi xả hết ('drain') rồi mới tiếp tục ghi; nhưng nếu kết nối đã bị đóng/hủy trong lúc đợi
 * (client ngắt kết nối), 'drain' sẽ không bao giờ tới — bắt buộc phải đồng thời lắng nghe 'close', nếu không vòng lặp stream
 * sẽ bị treo vĩnh viễn trên một kết nối không có người nhận, `inFlight` sẽ không bao giờ được giải phóng.
 */
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

function assertOwnership(rowApiKeyId: string | null, requesterApiKeyId: string | null): void {
  // Mỗi API Key chỉ được xem response của chính mình
  if (rowApiKeyId !== null && requesterApiKeyId !== null && rowApiKeyId !== requesterApiKeyId) {
    throw ApiError.notFound('response không tồn tại');
  }
}
