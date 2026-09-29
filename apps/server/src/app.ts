import { randomBytes } from 'node:crypto';
import { ApiError, buildErrorBody, REQUEST_ID_HEADER } from '@m365-codex/shared';
import multipart from '@fastify/multipart';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { endpointTagFor } from './gateway/auth.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminOpsRoutes } from './routes/adminOps.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerUiRoutes } from './routes/ui.js';
import { registerV1Routes } from './routes/v1.js';

/** Khởi dựng ứng dụng Fastify. Trong test gọi trực tiếp qua `app.inject()`, không cần lắng nghe cổng thực tế. */

export interface BuildAppOptions {
  /** Giới hạn dung lượng request body, mặc định 8 MiB */
  bodyLimit?: number;
}

function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

export function buildApp(context: AppContext, options: BuildAppOptions = {}): FastifyInstance {
  const logger: FastifyBaseLogger = context.logger;
  const app = Fastify({
    // Khai báo là FastifyBaseLogger để giữ kiểu mặc định generic, tránh xung đột kiểu giữa các route
    loggerInstance: logger,
    trustProxy: context.config.trustProxy,
    genReqId: generateRequestId,
    bodyLimit: options.bodyLimit ?? 8 * 1024 * 1024,
    // Ở chế độ strict tắt ghi log truy cập từng request để tránh ghi URL và query string xuống đĩa.
    logController: new LogController({
      disableRequestLogging: context.config.logPrivacyMode === 'strict',
    }),
  });

  // Request ID xuyên suốt response header và error body, hỗ trợ định vị khi người dùng báo sự cố
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Đo lường số lượng request và thời gian thực thi. Phản hồi SSE dùng reply.hijack(), các route đó tự ghi nhận riêng
  app.addHook('onResponse', async (request, reply) => {
    const endpoint = endpointTagFor(request);
    context.metrics.requests.inc({ endpoint, status: String(reply.statusCode) });
    context.metrics.requestDuration.observe(reply.elapsedTime / 1000, { endpoint });
  });

  /*
   * Một số endpoint quản trị không cần body, nhưng nhiều HTTP client gửi POST tự động thêm Content-Type.
   * Xử lý dự phòng: với Content-Type không xác định, body rỗng được coi là không có body,
   * chỉ từ chối khi body không rỗng và trả về cấu trúc lỗi thống nhất.
   */
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body: Buffer, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    // Fastify sẽ bù statusCode mặc định cho lỗi, thêm 415 rõ ràng để vào nhánh 4xx xuất cấu trúc lỗi thống nhất
    const error = Object.assign(
      new Error('Content-Type không được hỗ trợ, vui lòng dùng application/json cho request body'),
      { statusCode: 415 },
    );
    done(error, undefined);
  });

  app.setErrorHandler<Error & { statusCode?: number }>((error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof ApiError) {
      request.log.warn(
        { err_type: error.type, status: error.status, details: error.details },
        'Yêu cầu bị từ chối',
      );
      reply.code(error.status).send(error.toBody(requestId));
      return;
    }

    // Lỗi nội bộ của Fastify: lỗi parse JSON, body quá lớn, xác thực route thất bại, v.v.
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      reply
        .code(statusCode)
        .send(
          buildErrorBody('invalid_request_error', statusCode, error.message, { requestId }),
        );
      return;
    }

    // Lỗi ngoài dự kiến: giữ lại stack trace trong log, chỉ trả thông tin chung để tránh lộ chi tiết nội bộ
    request.log.error({ err: error }, 'Lỗi máy chủ chưa được xử lý');
    reply
      .code(500)
      .send(buildErrorBody('internal_error', 500, 'Internal server error', { requestId }));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(
        buildErrorBody('not_found_error', 404, `Không tìm thấy route ${request.method} ${request.url}`, {
          requestId: String(request.id),
        }),
      );
  });

  // Files/Uploads dùng multipart/form-data; attachFieldsToBody đưa tệp vào Buffer trong request.body.
  void app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: context.config.files.maxFileBytes + 1, files: 1 },
  });

  registerHealthRoutes(app, context);
  registerAdminRoutes(app, context);
  registerAdminOpsRoutes(app, context);
  registerBackupRoutes(app, context);
  registerMetricsRoutes(app, context);
  registerAccountRoutes(app, context);
  registerV1Routes(app, context);
  registerFileRoutes(app, context);
  registerChatRoutes(app, context);
  // Đăng ký ở cuối cùng: /ui/* là wildcard route, các route cụ thể phía trước phải khớp trước
  registerUiRoutes(app);

  return app;
}
