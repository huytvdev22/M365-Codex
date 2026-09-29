import type { Buffer } from 'node:buffer';
import { ApiError, type AccountStatus } from '@m365-codex/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { summarizeConfig } from '../config/index.js';
import { createAdminGuard } from '../gateway/auth.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { buildDiagnostics } from '../observability/diagnostics.js';
import { evaluateReadiness } from './health.js';
import { APP_VERSION } from '../version.js';

/**
 * Sao lưu / Phục hồi / Chẩn đoán (tương ứng kế hoạch triển khai §15.4, §17, hợp đồng §3).
 */

interface MultipartFileField {
  type: 'file';
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}
type MultipartBody = Record<string, MultipartFileField | { type: 'field'; value: unknown } | undefined>;

function requireUploadedFile(request: FastifyRequest): MultipartFileField {
  if (!request.isMultipart()) {
    throw ApiError.badRequest('Yêu cầu phải là multipart/form-data với tên trường là file');
  }
  const body = (request.body ?? {}) as MultipartBody;
  const field = body.file;
  if (field === undefined || field.type !== 'file') {
    throw ApiError.badRequest('Thiếu trường tệp file', 'file');
  }
  return field;
}

const createBackupSchema = z
  .object({
    // Mặc định giữ hành vi ban đầu (bao gồm tệp), không vì bổ sung tham số này mà âm thầm thay đổi ngữ nghĩa mặc định
    includeFiles: z.boolean({ invalid_type_error: 'includeFiles phải là kiểu boolean' }).optional(),
  })
  .strict();

/** Giống adminOps.ts: Nếu phân tích thất bại thì ném lỗi đồng bộ, không âm thầm fallback. */
function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? 'Nội dung yêu cầu không hợp lệ', issue?.path.join('.') || undefined);
  }
  return result.data;
}

export function registerBackupRoutes(app: FastifyInstance, context: AppContext): void {
  const adminGuard = createAdminGuard(context);

  // -----------------------------------------------------------------------
  // Sao lưu
  // -----------------------------------------------------------------------
  app.post('/admin/backup', { preHandler: adminGuard }, async (request, reply) => {
    // Body của request là tùy chọn: Phần lớn client không gửi kèm body, khi đó chạy theo mặc định (bao gồm tệp).
    // Nhưng **nếu đã gửi kèm body thì phải hợp lệ** — nếu lỗi như viết includeFiles thành string bị âm thầm
    // bỏ qua, bên gọi sẽ tưởng rằng mình nhận được gói "chỉ chứa DB", trong khi thực tế nhận được gói đầy đủ.
    // Tham số ảnh hưởng đến ngữ nghĩa không được âm thầm giả vờ có hiệu lực (rào chắn §1.7).
    const rawBody = request.body;
    const bodyOmitted =
      rawBody === undefined ||
      rawBody === null ||
      (typeof rawBody === 'object' && Object.keys(rawBody).length === 0);
    const includeFiles = bodyOmitted ? undefined : parseOrThrow(createBackupSchema, rawBody).includeFiles;

    const { archive, manifest } = context.backup.create({ includeFiles });
    const saved = context.backupStore.save(archive);
    context.auditLogs.record({
      actor: 'admin',
      action: 'backup.create',
      target: saved.id,
      detail: { bytes: saved.bytes, includes_files: manifest.includes_files },
    });
    reply.code(201);
    return saved;
  });

  app.get('/admin/backup', { preHandler: adminGuard }, async () => {
    return { items: context.backupStore.list() };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/backup/:id/download',
    { preHandler: adminGuard },
    async (request, reply) => {
      const content = context.backupStore.read(request.params.id);
      if (content === undefined) throw ApiError.notFound('Gói sao lưu không tồn tại');
      reply.header('content-type', 'application/gzip');
      reply.header('content-disposition', `attachment; filename="${request.params.id}.tar.gz"`);
      return reply.send(content);
    },
  );

  // -----------------------------------------------------------------------
  // Phục hồi: Ghi đĩa và kiểm tra hợp lệ là xong, nhưng **phải khởi động lại tiến trình mới có hiệu lực** — các kết nối đang chạy
  // vẫn giữ DB cũ, ở đây tuyệt đối không giả vờ rằng phục hồi đã có hiệu lực đối với tiến trình hiện tại
  // -----------------------------------------------------------------------
  app.post(
    '/admin/restore',
    { preHandler: adminGuard, bodyLimit: 512 * 1024 * 1024 },
    async (request) => {
      const field = requireUploadedFile(request);
      const content = await field.toBuffer();
      const manifest = context.backup.restore(content);
      context.auditLogs.record({
        actor: 'admin',
        action: 'restore.apply',
        detail: { schema_version: manifest.schema_version, file_count: manifest.file_count },
      });
      return {
        restored: true,
        requires_restart: true,
        message: 'Bản sao lưu đã được xác minh và ghi vào thư mục dữ liệu, cần khởi động lại dịch vụ để có hiệu lực',
        manifest,
      };
    },
  );

  // -----------------------------------------------------------------------
  // Gói chẩn đoán
  // -----------------------------------------------------------------------
  app.get('/admin/diagnostics', { preHandler: adminGuard }, async () => {
    const accounts = context.accounts.listViews();
    const accountsByStatus: Record<AccountStatus, number> = {
      probing: 0,
      online: 0,
      busy: 0,
      cooldown: 0,
      reauth_required: 0,
      disabled: 0,
      unsupported: 0,
      error: 0,
    };
    for (const account of accounts) {
      accountsByStatus[account.status] += 1;
    }

    const readiness = evaluateReadiness(context);
    const usage = context.backup.usage();
    const maintenanceJobs = context.scheduler.statuses().map((job) => ({
      name: job.name,
      lastRunAt: job.lastRunAt,
      lastError: job.lastError,
    }));

    const report = buildDiagnostics({
      appVersion: APP_VERSION,
      schemaVersion: currentSchemaVersion(context.db),
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
      startedAt: context.startedAt,
      now: Date.now(),
      accountsByStatus,
      // Đếm tích lũy trong vòng đời tiến trình (về 0 khi khởi động lại), cùng chung đánh đổi
      // "đủ dùng nhưng không phải giá trị chính xác lịch sử" với arg_pass_rate của /admin/overview
      recentErrorsByType: context.metrics.upstreamErrors.sumByLabel('disposition'),
      inFlightRequests: context.inFlight.size,
      configSummary: summarizeConfig(context.config),
      storage: { dbBytes: usage.dbBytes, filesBytes: usage.filesBytes, fileCount: usage.fileCount },
      maintenanceJobs,
      readiness: readiness.checks.map((check) => ({ name: check.name, ok: check.ok })),
    });
    return report;
  });
}
