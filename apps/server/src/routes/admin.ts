import { ApiError } from '@m365-codex/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { verifyPassword } from '../crypto/password.js';
import { clientIpFor, createAdminGuard, extractBearerToken, LoginThrottle } from '../gateway/auth.js';
import { maskIp } from '../observability/logger.js';

/** API quản trị: Đăng nhập, phiên làm việc, quản lý API Key, tra cứu nhật ký kiểm toán. */

const loginSchema = z.object({
  password: z.string().min(1, 'Mật khẩu không được để trống'),
});

const timestamp = z.number().int().nonnegative().nullable().optional();
const positiveInt = z.number().int().positive().nullable().optional();
const stringList = z.array(z.string().min(1)).nullable().optional();
// Ghi chú chỉ dùng để hiển thị, đặt giới hạn trên nới lỏng để tránh việc giao diện quản trị bị chèn văn bản quá dài
const note = z.string().max(500, 'Ghi chú quá dài').nullable().optional();

const createKeySchema = z.object({
  name: z.string().min(1, 'Tên không được để trống').max(100, 'Tên quá dài'),
  starts_at: timestamp,
  expires_at: timestamp,
  rpm_limit: positiveInt,
  daily_limit: positiveInt,
  max_concurrency: positiveInt,
  allowed_endpoints: stringList,
  allowed_models: stringList,
  note,
  // §10.1: Giới hạn trên số lượt gọi công cụ / kích thước tệp đơn lẻ siết chặt theo Key; không được vượt trần toàn cục.
  // Quy tắc nghiêm ngặt này không kiểm tra ở đây (khi ghi cho phép số dương bất kỳ), khi có hiệu lực sẽ do gateway/auth.ts
  // dùng clampToCeiling cắt gọt đồng bộ, duy trì cách làm nhất quán với rpm_limit/daily_limit hiện có.
  max_tool_calls: positiveInt,
  max_file_bytes: positiveInt,
});

const updateKeySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    starts_at: timestamp,
    expires_at: timestamp,
    rpm_limit: positiveInt,
    daily_limit: positiveInt,
    max_concurrency: positiveInt,
    allowed_endpoints: stringList,
    allowed_models: stringList,
    note,
    max_tool_calls: positiveInt,
    max_file_bytes: positiveInt,
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Cần cung cấp ít nhất một trường để cập nhật' });

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? 'Nội dung yêu cầu không hợp lệ', issue?.path.join('.') || undefined);
  }
  return result.data;
}

function assertValidWindow(startsAt: number | null | undefined, expiresAt: number | null | undefined): void {
  if (startsAt != null && expiresAt != null && expiresAt <= startsAt) {
    throw ApiError.badRequest('expires_at phải sau starts_at', 'expires_at');
  }
}

export function registerAdminRoutes(app: FastifyInstance, context: AppContext): void {
  const adminGuard = createAdminGuard(context);
  const throttle = new LoginThrottle();

  app.post('/admin/login', async (request, reply) => {
    const ip = clientIpFor(context, request);
    const throttleKey = ip ?? 'unknown';
    throttle.check(throttleKey);

    const body = parseOrThrow(loginSchema, request.body);
    if (!verifyPassword(body.password, context.adminPasswordHash)) {
      throttle.recordFailure(throttleKey);
      context.auditLogs.record({
        actor: 'admin',
        action: 'admin.login.failed',
        clientIp: maskIp(ip ?? undefined, context.privacyMode.current),
      });
      throw ApiError.unauthorized('Mật khẩu quản trị không chính xác');
    }

    throttle.reset(throttleKey);
    const session = context.adminSessions.issue(maskIp(ip ?? undefined, context.privacyMode.current));
    context.auditLogs.record({
      actor: 'admin',
      action: 'admin.login.success',
      clientIp: maskIp(ip ?? undefined, context.privacyMode.current),
    });
    reply.code(200);
    return { token: session.token, expires_at: session.expiresAt };
  });

  app.post('/admin/logout', { preHandler: adminGuard }, async (request) => {
    const token = extractBearerToken(request);
    if (token !== null) {
      context.adminSessions.revoke(token);
    }
    context.auditLogs.record({ actor: 'admin', action: 'admin.logout' });
    return { ok: true };
  });

  app.get('/admin/session', { preHandler: adminGuard }, async (request) => {
    const session = request.adminSession;
    return {
      created_at: session?.created_at ?? null,
      expires_at: session?.expires_at ?? null,
      public_api_base_url: context.config.publicApiBaseUrl,
      public_admin_url: context.config.publicAdminUrl,
    };
  });

  app.get('/admin/api-keys', { preHandler: adminGuard }, async () => {
    return { data: context.apiKeys.list() };
  });

  app.post('/admin/api-keys', { preHandler: adminGuard }, async (request, reply) => {
    const body = parseOrThrow(createKeySchema, request.body);
    assertValidWindow(body.starts_at, body.expires_at);

    const created = context.apiKeys.create({
      name: body.name,
      startsAt: body.starts_at ?? null,
      expiresAt: body.expires_at ?? null,
      rpmLimit: body.rpm_limit ?? null,
      dailyLimit: body.daily_limit ?? null,
      maxConcurrency: body.max_concurrency ?? null,
      allowedEndpoints: body.allowed_endpoints ?? null,
      allowedModels: body.allowed_models ?? null,
      note: body.note ?? null,
      maxToolCalls: body.max_tool_calls ?? null,
      maxFileBytes: body.max_file_bytes ?? null,
    });

    context.auditLogs.record({
      actor: 'admin',
      action: 'api_key.create',
      target: created.id,
      detail: { name: created.name, masked_key: created.masked_key },
    });

    reply.code(201);
    // Key dạng plain text chỉ xuất hiện một lần duy nhất tại đây, máy chủ không lưu trữ
    return created;
  });

  app.patch<{ Params: { id: string } }>(
    '/admin/api-keys/:id',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(updateKeySchema, request.body);
      assertValidWindow(body.starts_at, body.expires_at);

      const updated = context.apiKeys.update(request.params.id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.starts_at === undefined ? {} : { startsAt: body.starts_at }),
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }),
        ...(body.rpm_limit === undefined ? {} : { rpmLimit: body.rpm_limit }),
        ...(body.daily_limit === undefined ? {} : { dailyLimit: body.daily_limit }),
        ...(body.max_concurrency === undefined ? {} : { maxConcurrency: body.max_concurrency }),
        ...(body.allowed_endpoints === undefined ? {} : { allowedEndpoints: body.allowed_endpoints }),
        ...(body.allowed_models === undefined ? {} : { allowedModels: body.allowed_models }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.max_tool_calls === undefined ? {} : { maxToolCalls: body.max_tool_calls }),
        ...(body.max_file_bytes === undefined ? {} : { maxFileBytes: body.max_file_bytes }),
      });
      if (updated === undefined) {
        throw ApiError.notFound('API Key không tồn tại');
      }

      context.auditLogs.record({
        actor: 'admin',
        action: 'api_key.update',
        target: updated.id,
        detail: { enabled: updated.enabled },
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/api-keys/:id',
    { preHandler: adminGuard },
    async (request) => {
      const revoked = context.apiKeys.revoke(request.params.id);
      if (revoked === undefined) {
        throw ApiError.notFound('API Key không tồn tại');
      }
      context.auditLogs.record({ actor: 'admin', action: 'api_key.revoke', target: revoked.id });
      return revoked;
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    '/admin/audit-logs',
    { preHandler: adminGuard },
    async (request) => {
      const raw = Number(request.query.limit ?? '100');
      const limit = Number.isInteger(raw) && raw > 0 && raw <= 500 ? raw : 100;
      return { data: context.auditLogs.recent(limit) };
    },
  );
}
