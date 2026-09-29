import { ApiError, ACCOUNT_STATUSES } from '@m365-codex/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createAdminGuard } from '../gateway/auth.js';
import { TokenUnavailableError } from '../oauth/tokenManager.js';
import { InvalidStateTransitionError } from '../repo/accounts.js';
import { maskEmail } from '../util/redact.js';

/**
 * API quản lý tài khoản và ủy quyền. Mọi phản hồi đều không chứa Token.
 *
 * Chỉ có một cách duy nhất để thêm tài khoản: quy trình ủy quyền PKCE riêng của gateway
 * (authorize-url → đăng nhập trình duyệt → callback).
 */

// Tài liệu hợp đồng (§1) ghi nhận tham số đầu vào là `{redirect_url}` hoặc `{code, state}`; triển khai ban đầu dùng
// `{callback}`. Chấp nhận cả 3 dạng — `callback`/`redirect_url` đồng nghĩa (đều là URL callback đầy đủ hoặc query string thô),
// `{code, state}` là dạng mà WebUI tự bóc tách từ URL callback rồi gửi lại, tại đây ghép lại thành chuỗi truy vấn tương đương,
// tái sử dụng cùng một logic phân tích của `parseCallback`, không tạo thêm mã phân tích thứ hai.
const callbackSchema = z
  .object({
    callback: z.string().min(1).optional(),
    redirect_url: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
  })
  .transform((value, ctx) => {
    if (value.callback !== undefined) return value.callback;
    if (value.redirect_url !== undefined) return value.redirect_url;
    if (value.code !== undefined && value.state !== undefined) {
      return `code=${encodeURIComponent(value.code)}&state=${encodeURIComponent(value.state)}`;
    }
    ctx.addIssue({
      code: 'custom',
      message: 'Vui lòng cung cấp callback, redirect_url, hoặc code + state',
    });
    return z.NEVER;
  });

const statusSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
});

// Tài liệu hợp đồng chỉ dùng đến status, nhưng PATCH /admin/accounts/:id là endpoint chung,
// dự trù các trường có thể bổ sung trong tương lai (display_name, v.v.) mà không làm thay đổi định tuyến này.
const patchAccountSchema = z
  .object({
    status: z.enum(ACCOUNT_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Cần cung cấp ít nhất một trường để cập nhật' });

const proxyBindingSchema = z.object({
  proxy_id: z.string().min(1).nullable(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? 'Nội dung yêu cầu không hợp lệ', issue?.path.join('.') || undefined);
  }
  return result.data;
}

/** Sử dụng hàm này khi kết quả phân tích không phải là `z.ZodType<T>` (có `.transform`), logic nhất quán với `parseOrThrow`. */
function parseTransformedOrThrow<Output>(
  schema: { safeParse: (payload: unknown) => z.SafeParseReturnType<unknown, Output> },
  payload: unknown,
): Output {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? 'Nội dung yêu cầu không hợp lệ', issue?.path.join('.') || undefined);
  }
  return result.data;
}

export function registerAccountRoutes(app: FastifyInstance, context: AppContext): void {
  const adminGuard = createAdminGuard(context);

  // ---- Quy trình ủy quyền ----

  app.post('/admin/oauth/authorize-url', { preHandler: adminGuard }, async (_request, reply) => {
    const started = context.oauth.start();
    context.auditLogs.record({ actor: 'admin', action: 'oauth.authorize_url.create' });
    reply.code(201);
    return started;
  });

  app.post('/admin/oauth/callback', { preHandler: adminGuard }, async (request) => {
    const callback = parseTransformedOrThrow(callbackSchema, request.body);
    const result = await context.oauth.complete(callback);
    context.auditLogs.record({
      actor: 'admin',
      action: result.existing ? 'account.reauthorized' : 'account.created',
      target: result.account.id,
      detail: { email: maskEmail(result.account.email), tid: result.account.tid },
    });
    return { account: result.account, existing: result.existing };
  });

  app.get('/admin/oauth/sessions', { preHandler: adminGuard }, async () => {
    return { pending: context.oauthSessions.countPending() };
  });

  // ---- Quản lý tài khoản ----

  app.get('/admin/accounts', { preHandler: adminGuard }, async () => {
    return { data: context.accounts.listViews() };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/accounts/:id',
    { preHandler: adminGuard },
    async (request) => {
      const view = context.accounts.getView(request.params.id);
      if (view === undefined) throw ApiError.notFound('Tài khoản không tồn tại');
      return view;
    },
  );

  function changeStatus(accountId: string, status: (typeof ACCOUNT_STATUSES)[number]): ReturnType<typeof context.accounts.setStatus> {
    const account = context.accounts.findById(accountId);
    if (account === undefined) throw ApiError.notFound('Tài khoản không tồn tại');

    let view;
    try {
      view = context.accounts.setStatus(accountId, status);
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        throw ApiError.badRequest(error.message, 'status');
      }
      throw error;
    }

    context.auditLogs.record({
      actor: 'admin',
      action: 'account.status.change',
      target: view.id,
      detail: { from: account.status, to: view.status },
    });
    return view;
  }

  app.patch<{ Params: { id: string } }>(
    '/admin/accounts/:id/status',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(statusSchema, request.body);
      return changeStatus(request.params.id, body.status);
    },
  );

  // Tài liệu hợp đồng §1 mục "Đã tồn tại" liệt kê PATCH /admin/accounts/:id (không có hậu tố /status);
  // giữ nguyên route /status phía trên (tránh ảnh hưởng đến các bài test và caller hiện có), tại đây bổ sung một endpoint chung
  // được đặt tên theo hợp đồng, hiện chỉ hỗ trợ sửa status, tên trường và ngữ nghĩa hoàn toàn đồng bộ với route /status.
  app.patch<{ Params: { id: string } }>(
    '/admin/accounts/:id',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(patchAccountSchema, request.body);
      if (body.status === undefined) {
        // Hiện tại trường duy nhất được hỗ trợ là status; về mặt lý thuyết sẽ không rơi vào đây (schema đã yêu cầu tối thiểu một mục),
        // nhưng báo lỗi rõ ràng sẽ trung thực hơn việc im lặng trả về như cũ
        throw ApiError.badRequest('Hiện tại chỉ hỗ trợ cập nhật trường status', 'status');
      }
      return changeStatus(request.params.id, body.status);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/accounts/:id/proxy',
    { preHandler: adminGuard },
    async (request) => {
      const body = parseOrThrow(proxyBindingSchema, request.body);
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('Tài khoản không tồn tại');

      if (body.proxy_id !== null && context.proxyNodes.findById(body.proxy_id) === undefined) {
        throw ApiError.badRequest('Node proxy không tồn tại', 'proxy_id');
      }

      const view = context.accounts.setProxyNode(request.params.id, body.proxy_id);
      if (view === undefined) throw ApiError.notFound('Tài khoản không tồn tại');

      context.auditLogs.record({
        actor: 'admin',
        action: 'account.proxy.bind',
        target: request.params.id,
        detail: { proxy_id: body.proxy_id },
      });
      return view;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/accounts/:id/refresh',
    { preHandler: adminGuard },
    async (request) => {
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('Tài khoản không tồn tại');

      try {
        await context.tokens.refresh(request.params.id);
      } catch (error) {
        if (error instanceof TokenUnavailableError) {
          const status = error.reason === 'reauth_required' ? 409 : 502;
          throw new ApiError({
            type: error.reason === 'reauth_required' ? 'permission_error' : 'upstream_error',
            status,
            message: error.message,
          });
        }
        throw error;
      }

      context.auditLogs.record({
        actor: 'admin',
        action: 'account.token.refresh',
        target: request.params.id,
      });
      // Trả về view thay vì Token — Token tuyệt đối không rời khỏi gateway
      return context.accounts.getView(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/accounts/:id',
    { preHandler: adminGuard },
    async (request) => {
      const account = context.accounts.findById(request.params.id);
      if (account === undefined) throw ApiError.notFound('Tài khoản không tồn tại');
      context.accounts.remove(request.params.id);
      context.auditLogs.record({
        actor: 'admin',
        action: 'account.delete',
        target: request.params.id,
        detail: { email: maskEmail(account.email) },
      });
      return { deleted: true, id: request.params.id };
    },
  );
}
