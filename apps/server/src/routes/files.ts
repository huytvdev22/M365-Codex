import { randomUUID } from 'node:crypto';
import { ApiError } from '@m365-codex/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createApiKeyGuard } from '../gateway/auth.js';
import type { FileRow, UploadRow } from '../repo/files.js';
import type { FileObject, UploadObject } from '../files/types.js';

/**
 * API tệp tin / tải lên theo phần (tương ứng kế hoạch triển khai §11, §M6).
 *
 * Tên trường được căn chỉnh theo Files / Uploads API của OpenAI; toàn bộ đi qua xác thực API Key hiện có,
 * quyền sở hữu và hạn mức do `files/service.ts` kiểm soát tập trung, ở đây chỉ chịu trách nhiệm chuyển đổi giao thức.
 */

const toSeconds = (ms: number): number => Math.floor(ms / 1000);

function toFileObject(row: FileRow): FileObject {
  return {
    id: row.id,
    object: 'file',
    bytes: row.bytes,
    created_at: toSeconds(row.created_at),
    filename: row.filename,
    purpose: row.purpose,
    status: row.status,
    status_details: row.status === 'error' ? row.extraction_note : null,
    expires_at: row.expires_at === null ? null : toSeconds(row.expires_at),
  };
}

function toUploadObject(row: UploadRow, file: FileRow | null): UploadObject {
  return {
    id: row.id,
    object: 'upload',
    bytes: row.bytes,
    created_at: toSeconds(row.created_at),
    filename: row.filename,
    purpose: row.purpose,
    status: row.status,
    expires_at: toSeconds(row.expires_at),
    file: file === null ? null : toFileObject(file),
  };
}

/** Lấy trường chỉ định từ multipart request body đã bật `attachFieldsToBody`. */
interface MultipartFileField {
  type: 'file';
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}
interface MultipartValueField {
  type: 'field';
  value: unknown;
}
type MultipartBody = Record<string, MultipartFileField | MultipartValueField | undefined>;

function asMultipartBody(request: FastifyRequest): MultipartBody {
  if (!request.isMultipart()) {
    throw ApiError.badRequest('Yêu cầu phải là multipart/form-data');
  }
  return (request.body ?? {}) as MultipartBody;
}

function requireFileField(body: MultipartBody, field: string): MultipartFileField {
  const value = body[field];
  if (value === undefined || value.type !== 'file') {
    throw ApiError.badRequest(`Thiếu trường tệp ${field}`, field);
  }
  return value;
}

function optionalStringField(body: MultipartBody, field: string, fallback: string): string {
  const value = body[field];
  if (value === undefined) return fallback;
  if (value.type === 'field' && typeof value.value === 'string' && value.value.trim() !== '') {
    return value.value.trim();
  }
  return fallback;
}

const createUploadSchema = z.object({
  filename: z.string().min(1, 'filename không được để trống'),
  purpose: z.string().min(1).optional(),
  bytes: z.number().int().positive(),
  mime_type: z.string().min(1).optional(),
});

const completeUploadSchema = z.object({
  part_ids: z.array(z.string()).min(1, 'part_ids không được để trống'),
});

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? 'Nội dung yêu cầu không hợp lệ', issue?.path.join('.') || undefined);
  }
  return result.data;
}

function requireApiKeyId(request: FastifyRequest): string {
  const id = request.apiKeyRow?.id;
  if (id === undefined) throw ApiError.unauthorized();
  return id;
}

export function registerFileRoutes(app: FastifyInstance, context: AppContext): void {
  const apiKeyGuard = createApiKeyGuard(context);
  const routeBodyLimit = { bodyLimit: context.config.files.maxRequestBytes };

  // ---- Files ----

  app.post(
    '/v1/files',
    { preHandler: apiKeyGuard, ...routeBodyLimit },
    async (request, reply) => {
      const apiKeyId = requireApiKeyId(request);
      const body = asMultipartBody(request);
      const file = requireFileField(body, 'file');
      const purpose = optionalStringField(body, 'purpose', 'user_data');
      const content = await file.toBuffer();

      const row = await context.files.ingest({
        apiKeyId,
        filename: file.filename,
        purpose,
        declaredMimeType: file.mimetype,
        content,
        maxFileBytesOverride: request.apiKeyLimits?.maxFileBytes,
      });
      reply.code(201);
      return toFileObject(row);
    },
  );

  app.get('/v1/files', { preHandler: apiKeyGuard }, async (request) => {
    const apiKeyId = requireApiKeyId(request);
    const query = request.query as { purpose?: string };
    const rows = context.files.list(apiKeyId, query.purpose ?? null);
    return { object: 'list', data: rows.map(toFileObject) };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/files/:id',
    { preHandler: apiKeyGuard },
    async (request) => {
      const apiKeyId = requireApiKeyId(request);
      const row = context.files.getOwned(request.params.id, apiKeyId);
      return toFileObject(row);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/files/:id/content',
    { preHandler: apiKeyGuard },
    async (request, reply) => {
      const apiKeyId = requireApiKeyId(request);
      const { row, content } = context.files.getContent(request.params.id, apiKeyId);
      reply.header('content-type', row.mime_type);
      reply.header('content-disposition', `attachment; filename="${encodeURIComponent(row.filename)}"`);
      return reply.send(content);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/files/:id',
    { preHandler: apiKeyGuard },
    async (request) => {
      const apiKeyId = requireApiKeyId(request);
      context.files.delete(request.params.id, apiKeyId);
      return { id: request.params.id, object: 'file', deleted: true };
    },
  );

  // ---- Uploads ----

  app.post('/v1/uploads', { preHandler: apiKeyGuard }, async (request, reply) => {
    const apiKeyId = requireApiKeyId(request);
    const body = parseOrThrow(createUploadSchema, request.body);
    context.files.assertFileSize(body.bytes, request.apiKeyLimits?.maxFileBytes);

    const now = Date.now();
    const row = context.uploadRepo.create(
      {
        id: `upload_${randomUUID().replaceAll('-', '')}`,
        apiKeyId,
        filename: body.filename,
        purpose: body.purpose ?? 'user_data',
        mimeType: body.mime_type ?? 'application/octet-stream',
        bytes: body.bytes,
        expiresAt: now + context.config.files.uploadTtlMs,
      },
      now,
    );
    reply.code(201);
    return toUploadObject(row, null);
  });

  app.post<{ Params: { id: string } }>(
    '/v1/uploads/:id/parts',
    { preHandler: apiKeyGuard, ...routeBodyLimit },
    async (request, reply) => {
      const apiKeyId = requireApiKeyId(request);
      const upload = getOwnedPendingUpload(context, request.params.id, apiKeyId);
      const body = asMultipartBody(request);
      const dataField = requireFileField(body, 'data');
      const content = await dataField.toBuffer();
      context.files.assertFileSize(content.length, request.apiKeyLimits?.maxFileBytes);

      const part = context.uploadRepo.addPart(upload.id, content.length);
      context.fileStorage.writeUploadPart(upload.id, part.id, content);

      reply.code(201);
      return { id: part.id, object: 'upload.part', created_at: toSeconds(part.created_at), upload_id: upload.id };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/uploads/:id/complete',
    { preHandler: apiKeyGuard },
    async (request) => {
      const apiKeyId = requireApiKeyId(request);
      const upload = getOwnedPendingUpload(context, request.params.id, apiKeyId);
      const body = parseOrThrow(completeUploadSchema, request.body);

      const parts = context.uploadRepo.listParts(upload.id);
      const byId = new Map(parts.map((p) => [p.id, p]));
      const ordered = body.part_ids.map((id) => {
        const part = byId.get(id);
        if (part === undefined) {
          throw ApiError.badRequest(`part_id ${id} không thuộc về Upload này hoặc không tồn tại`, 'part_ids');
        }
        return part;
      });

      const buffers = ordered.map((part) => context.fileStorage.readUploadPart(upload.id, part.id));
      const content = Buffer.concat(buffers);

      const fileRow = await context.files.ingest({
        apiKeyId,
        filename: upload.filename,
        purpose: upload.purpose,
        declaredMimeType: upload.mime_type,
        content,
        maxFileBytesOverride: request.apiKeyLimits?.maxFileBytes,
      });
      context.uploadRepo.markCompleted(upload.id, fileRow.id);
      context.fileStorage.deleteUpload(upload.id);

      return toUploadObject({ ...upload, status: 'completed', file_id: fileRow.id }, fileRow);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/uploads/:id/cancel',
    { preHandler: apiKeyGuard },
    async (request) => {
      const apiKeyId = requireApiKeyId(request);
      const upload = context.uploadRepo.findOwned(request.params.id, apiKeyId);
      if (upload === undefined) throw ApiError.notFound('Upload không tồn tại');
      context.uploadRepo.markCancelled(upload.id);
      context.fileStorage.deleteUpload(upload.id);
      return toUploadObject({ ...upload, status: 'cancelled' }, null);
    },
  );
}

function getOwnedPendingUpload(context: AppContext, id: string, apiKeyId: string) {
  const upload = context.uploadRepo.findOwned(id, apiKeyId);
  if (upload === undefined) throw ApiError.notFound('Upload không tồn tại');
  if (upload.status !== 'pending') {
    throw ApiError.badRequest(`Upload đã ở trạng thái ${upload.status}, không thể tiếp tục thao tác`);
  }
  return upload;
}
