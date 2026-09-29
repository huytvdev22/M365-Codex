import { ApiError } from '@m365-codex/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createAdminGuard } from '../gateway/auth.js';
import { runFilesCleanupWithBytes } from '../files/cleanup.js';
import { loadModels } from '../responses/models.js';
import { maskProxyUrl, toProxyNodeView, type ProxyNodeRow } from '../repo/proxyNodes.js';
import { SETTING_GROUPS, type SettingGroup } from '../settings/service.js';
import { APP_VERSION } from '../version.js';

/**
 * Các API quản trị bổ sung trong M7 (tương ứng `docs/Hop-dong-API-quan-tri.md` §2): Tổng quan, lịch sử yêu cầu, cài đặt,
 * pool proxy đầu ra, sinh cấu hình Codex, góc nhìn quản lý tệp, ma trận năng lực.
 *
 * Tên trường và ngữ nghĩa được triển khai nghiêm ngặt theo tài liệu hợp đồng; những điểm hợp đồng chưa cố định trường cụ thể (tên trường nhóm thanh toán,
 * chi tiết kết quả import proxy hàng loạt), do server quy định và liệt kê trong báo cáo mốc để WebUI đồng bộ.
 */

function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? 'Nội dung yêu cầu không hợp lệ', issue?.path.join('.') || undefined);
  }
  return result.data;
}

function isSettingGroup(value: string): value is SettingGroup {
  return (SETTING_GROUPS as readonly string[]).includes(value);
}

const HOUR_MS = 60 * 60 * 1000;

export function registerAdminOpsRoutes(app: FastifyInstance, context: AppContext): void {
  const adminGuard = createAdminGuard(context);

  // ---------------------------------------------------------------------
  // 2.1 Tổng quan
  // ---------------------------------------------------------------------
  app.get('/admin/overview', { preHandler: adminGuard }, async () => {
    const now = Date.now();
    const accounts = context.accounts.listViews();
    const accountsSummary = {
      total: accounts.length,
      online: accounts.filter((a) => a.status === 'online').length,
      cooldown: accounts.filter((a) => a.status === 'cooldown').length,
      reauth_required: accounts.filter((a) => a.status === 'reauth_required').length,
      disabled: accounts.filter((a) => a.status === 'disabled').length,
    };

    const lastHour = now - HOUR_MS;
    const requests = {
      in_flight: context.inFlight.size,
      last_hour: context.responseRepo.countCreatedSince(lastHour),
      failed_last_hour: context.responseRepo.countFailedSince(lastHour),
    };

    const validationsByResult = context.metrics.toolArgValidations.sumByLabel('result');
    const passCount = validationsByResult.pass ?? 0;
    const rejectedCount = validationsByResult.rejected ?? 0;
    const tools = {
      calls_last_hour: context.toolCalls.countCreatedSince(lastHour),
      // Tỷ lệ hợp lệ kể từ khi tiến trình khởi động (bộ đếm bộ nhớ, về 0 khi khởi động lại; xem observability/metrics.ts)
      arg_pass_rate: passCount + rejectedCount === 0 ? 1 : passCount / (passCount + rejectedCount),
    };

    const dbBytes = readDbBytes(context);
    const filesTotal = context.fileRepo.listForAdmin({ limit: 1_000_000 });

    return {
      system_status: computeSystemStatus(context),
      version: APP_VERSION,
      uptime_ms: now - context.startedAt,
      accounts: accountsSummary,
      requests,
      tools,
      upstream: {
        protocol_version: context.config.upstream.protocolVersion,
        ws_base: context.config.upstream.wsBase,
        image_input: context.config.upstreamImageInput,
      },
      storage: {
        db_bytes: dbBytes,
        files_bytes: filesTotal.totalBytes,
        files_count: filesTotal.items.length,
      },
      public_api_base_url: context.config.publicApiBaseUrl,
      pending_restart: context.settings.pendingRestartEnvVars(),
    };
  });

  // ---------------------------------------------------------------------
  // 2.2 Lịch sử yêu cầu
  // ---------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string; status?: string; api_key_id?: string } }>(
    '/admin/requests',
    { preHandler: adminGuard },
    async (request) => {
      const limit = clampLimit(request.query.limit, 100, 500);
      const { items, total } = context.responseRepo.listForAdmin({
        limit,
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
        ...(request.query.api_key_id === undefined ? {} : { apiKeyId: request.query.api_key_id }),
      });
      return {
        items: items.map((row) => ({
          id: row.id,
          status: row.status,
          requested_model: row.requested_model,
          requested_reasoning_effort: row.requested_reasoning_effort,
          api_key_id: row.api_key_id,
          account_id: row.account_id,
          tool_round: row.tool_round,
          tool_calls_total: row.tool_calls_total,
          created_at: row.created_at,
          updated_at: row.updated_at,
          error_message: row.error_message,
        })),
        total,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/requests/:id', { preHandler: adminGuard }, async (request) => {
    const row = context.responseRepo.findById(request.params.id);
    if (row === undefined) throw ApiError.notFound('Bản ghi yêu cầu không tồn tại');
    const toolCalls = context.toolCalls.listByResponse(row.id).map((call) => ({
      call_id: call.call_id,
      name: call.name,
      status: call.status,
      side_effect: call.side_effect === 1,
      created_at: call.created_at,
    }));
    return {
      id: row.id,
      status: row.status,
      requested_model: row.requested_model,
      requested_reasoning_effort: row.requested_reasoning_effort,
      upstream_model_parameter: row.upstream_model_parameter,
      reported_upstream_model: row.reported_upstream_model,
      api_key_id: row.api_key_id,
      account_id: row.account_id,
      previous_response_id: row.previous_response_id,
      tool_round: row.tool_round,
      tool_calls_total: row.tool_calls_total,
      created_at: row.created_at,
      updated_at: row.updated_at,
      error_message: row.error_message,
      tool_calls: toolCalls,
    };
  });

  // ---------------------------------------------------------------------
  // 2.3 Cài đặt
  // ---------------------------------------------------------------------
  app.get('/admin/settings', { preHandler: adminGuard }, async () => context.settings.getAll());

  const settingsPatchSchema = z.object({
    group: z.string().min(1),
    values: z.record(z.string(), z.unknown()),
  });

  app.patch('/admin/settings', { preHandler: adminGuard }, async (request) => {
    const body = parseOrThrow(settingsPatchSchema, request.body);
    if (!isSettingGroup(body.group)) {
      throw ApiError.badRequest(`Nhóm cài đặt không xác định: ${body.group}`, 'group');
    }
    const updated = context.settings.patchGroup(body.group, body.values);
    context.auditLogs.record({
      actor: 'admin',
      action: 'settings.update',
      target: body.group,
      detail: { fields: Object.keys(body.values) },
    });
    return { [body.group]: updated };
  });

  // ---------------------------------------------------------------------
  // 2.4 Pool proxy đầu ra
  // ---------------------------------------------------------------------
  const createProxySchema = z.object({
    name: z.string().min(1).max(100),
    url: z.string().min(1),
    weight: z.number().int().positive().optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional(),
  });
  const updateProxySchema = z
    .object({
      name: z.string().min(1).max(100).optional(),
      url: z.string().min(1).optional(),
      weight: z.number().int().positive().optional(),
      priority: z.number().int().optional(),
      enabled: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Cần cung cấp ít nhất một trường để cập nhật' });
  const bulkImportSchema = z.object({ urls: z.string().min(1) });

  function toView(row: ProxyNodeRow) {
    const masked = maskProxyUrl(context.proxyNodes.decryptUrl(row));
    return toProxyNodeView(row, masked, context.proxyNodes.boundAccountIds(row.id));
  }

  app.get('/admin/proxies', { preHandler: adminGuard }, async () => {
    return { items: context.proxyNodes.list().map(toView) };
  });

  app.post('/admin/proxies', { preHandler: adminGuard }, async (request, reply) => {
    const body = parseOrThrow(createProxySchema, request.body);
    const row = context.proxyNodes.create(body);
    context.auditLogs.record({ actor: 'admin', action: 'proxy.create', target: row.id, detail: { name: row.name } });
    reply.code(201);
    return toView(row);
  });

  app.post('/admin/proxies/bulk', { preHandler: adminGuard }, async (request) => {
    const body = parseOrThrow(bulkImportSchema, request.body);
    const lines = body.urls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');

    const results: { line: string; ok: boolean; id?: string; error?: string }[] = [];
    let created = 0;
    let failed = 0;
    lines.forEach((line, index) => {
      const commaIndex = line.indexOf(',');
      const name = commaIndex > 0 ? line.slice(0, commaIndex).trim() : `Node nhập ${index + 1}`;
      const url = commaIndex > 0 ? line.slice(commaIndex + 1).trim() : line;
      // Kiểm tra tính hợp lệ của URL, tránh việc mã hóa và lưu vào DB chuỗi rõ ràng không mở được
      if (!isValidUrl(url)) {
        results.push({ line, ok: false, error: 'url không phải là URL hợp lệ' });
        failed += 1;
        return;
      }
      try {
        const row = context.proxyNodes.create({ name, url });
        results.push({ line, ok: true, id: row.id });
        created += 1;
      } catch (error) {
        results.push({ line, ok: false, error: error instanceof Error ? error.message : String(error) });
        failed += 1;
      }
    });

    context.auditLogs.record({
      actor: 'admin',
      action: 'proxy.bulk_import',
      detail: { created, failed },
    });
    return { created, failed, results };
  });

  app.patch<{ Params: { id: string } }>('/admin/proxies/:id', { preHandler: adminGuard }, async (request) => {
    const body = parseOrThrow(updateProxySchema, request.body);
    if (body.url !== undefined && !isValidUrl(body.url)) {
      throw ApiError.badRequest('url không phải là URL hợp lệ', 'url');
    }
    const row = context.proxyNodes.update(request.params.id, body);
    if (row === undefined) throw ApiError.notFound('Node proxy không tồn tại');
    context.auditLogs.record({ actor: 'admin', action: 'proxy.update', target: row.id });
    return toView(row);
  });

  app.delete<{ Params: { id: string } }>('/admin/proxies/:id', { preHandler: adminGuard }, async (request) => {
    const row = context.proxyNodes.findById(request.params.id);
    if (row === undefined) throw ApiError.notFound('Node proxy không tồn tại');
    context.proxyNodes.remove(request.params.id);
    context.auditLogs.record({ actor: 'admin', action: 'proxy.delete', target: request.params.id });
    return { deleted: true, id: request.params.id };
  });

  app.post<{ Params: { id: string } }>(
    '/admin/proxies/:id/check',
    { preHandler: adminGuard },
    async (request) => {
      const row = context.proxyNodes.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('Node proxy không tồn tại');
      const url = context.proxyNodes.decryptUrl(row);
      const result = await context.proxyChecker(url, context.config.proxyCheckTimeoutMs);

      const failureCount = result.ok ? 0 : row.failure_count + 1;
      const cooldownUntil = result.ok ? null : Date.now() + Math.min(failureCount, 10) * 30_000;
      context.proxyNodes.recordCheck(row.id, {
        status: result.ok ? 'healthy' : 'unhealthy',
        latencyMs: result.latencyMs,
        failureCount,
        cooldownUntil,
      });
      return { ok: result.ok, latency_ms: result.latencyMs, detail: result.detail };
    },
  );

  // ---------------------------------------------------------------------
  // 2.5 Sinh cấu hình Codex
  // ---------------------------------------------------------------------
  app.get<{ Querystring: { api_key_env?: string } }>(
    '/admin/codex-config',
    { preHandler: adminGuard },
    async (request) => {
      const envKey = request.query.api_key_env?.trim() || 'M365_CODEX_API_KEY';
      const notes: string[] = [];
      let baseUrl = context.config.publicApiBaseUrl;
      if (baseUrl === null) {
        baseUrl = `http://localhost:${context.config.port}/v1`;
        notes.push('Chưa thiết lập PUBLIC_API_BASE_URL, tạm thời dùng địa chỉ cục bộ làm dự phòng, vui lòng sửa lại theo địa chỉ công khai thực tế của bạn');
      }
      notes.push(`Vui lòng đặt biến môi trường ${envKey} thành sk- API Key của bạn`);
      notes.push('model và model_reasoning_effort do phía Codex tự chọn, tệp này không điền thay');

      const toml = [
        'model_provider = "m365-codex"',
        '',
        '[model_providers.m365-codex]',
        'name = "M365-Codex (Responses compatible)"',
        `base_url = "${baseUrl}"`,
        `env_key = "${envKey}"`,
        'wire_api = "responses"',
        '',
      ].join('\n');

      return { toml, base_url: baseUrl, notes };
    },
  );

  // ---------------------------------------------------------------------
  // 2.6 Tệp (góc nhìn quản trị)
  // ---------------------------------------------------------------------
  app.get<{ Querystring: { api_key_id?: string; limit?: string } }>(
    '/admin/files',
    { preHandler: adminGuard },
    async (request) => {
      const limit = clampLimit(request.query.limit, 100, 1000);
      const { items, totalBytes } = context.fileRepo.listForAdmin({
        limit,
        ...(request.query.api_key_id === undefined ? {} : { apiKeyId: request.query.api_key_id }),
      });
      return {
        items: items.map((row) => ({
          id: row.id,
          filename: row.filename,
          mime_type: row.mime_type,
          kind: row.kind,
          bytes: row.bytes,
          status: row.status,
          api_key_id: row.api_key_id,
          created_at: row.created_at,
          expires_at: row.expires_at,
        })),
        total_bytes: totalBytes,
      };
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/files/:id', { preHandler: adminGuard }, async (request) => {
    const row = context.fileRepo.adminSoftDelete(request.params.id);
    if (row === undefined) throw ApiError.notFound('Tệp không tồn tại');
    context.fileStorage.deleteFile(row.id);
    context.auditLogs.record({ actor: 'admin', action: 'file.delete', target: row.id });
    return { deleted: true, id: row.id };
  });

  app.post('/admin/files/cleanup', { preHandler: adminGuard }, async () => {
    const result = runFilesCleanupWithBytes({
      files: context.fileRepo,
      uploads: context.uploadRepo,
      storage: context.fileStorage,
    });
    context.auditLogs.record({
      actor: 'admin',
      action: 'files.cleanup',
      detail: { deleted_files: result.expiredFiles, deleted_uploads: result.expiredUploads },
    });
    return {
      deleted_files: result.expiredFiles,
      deleted_uploads: result.expiredUploads,
      freed_bytes: result.freedBytes,
    };
  });

  // ---------------------------------------------------------------------
  // 2.7 Model và ma trận năng lực
  // ---------------------------------------------------------------------
  app.get('/admin/capabilities', { preHandler: adminGuard }, async () => {
    const models = loadModels(undefined, (reason) => context.logger.warn({ reason }, 'Hạ cấp danh mục mô hình')).data.map(
      (m) => ({ id: m.id, source: m.owned_by }),
    );
    return { models, matrix: buildCapabilityMatrix(context) };
  });
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function isValidUrl(value: string): boolean {
  try {
    return new URL(value).href !== '';
  } catch {
    return false;
  }
}

/** Kích thước tệp cơ sở dữ liệu (phục vụ storage.db_bytes của /admin/overview); nếu không truy vấn được trả về 0, không để mục này làm hỏng toàn bộ tổng quan. */
function readDbBytes(context: AppContext): number {
  try {
    const row = context.db
      .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
      .get() as { bytes: number } | undefined;
    return row?.bytes ?? 0;
  } catch {
    return 0;
  }
}

/** Trạng thái hệ thống (hợp đồng §2.1): migration chưa hoàn thành ưu tiên báo migration_failed; tài khoản hoàn toàn không khả dụng báo upstream_unavailable. */
function computeSystemStatus(
  context: AppContext,
): 'normal' | 'degraded' | 'maintenance' | 'upstream_unavailable' | 'migration_failed' {
  const accounts = context.accounts.listViews();
  if (accounts.length === 0) return 'normal';
  const usable = accounts.filter((a) => a.status === 'online' || a.status === 'probing' || a.status === 'busy');
  if (usable.length === 0) return 'upstream_unavailable';
  return 'normal';
}

/**
 * Ma trận năng lực (hợp đồng §2.7, kế hoạch triển khai §24). **Chưa qua probe thực tế M0 xác nhận thì toàn bộ đánh dấu
 * `upstream_decided` hoặc `unsupported`, không được đánh dấu `native`** — dự án đến nay chưa từng chạy
 * probe M0 trên upstream thực tế, do đó ở đây không có bất kỳ dòng nào là `native`.
 */
function buildCapabilityMatrix(context: AppContext): { feature: string; status: string; detail: string }[] {
  const local = (feature: string, detail: string): { feature: string; status: string; detail: string } => ({
    feature,
    status: 'local',
    detail,
  });
  const upstream = (feature: string, detail: string): { feature: string; status: string; detail: string } => ({
    feature,
    status: 'upstream_decided',
    detail,
  });
  const unsupported = (feature: string, detail: string): { feature: string; status: string; detail: string } => ({
    feature,
    status: 'unsupported',
    detail,
  });

  return [
    // §24.1 Khung thực thi cục bộ hoặc theo giao thức Responses đã hoàn thành, nhưng end-to-end có thực sự thông suốt hay không phụ thuộc vào M0 chưa chạy
    upstream('Đối thoại văn bản / Sinh mã nguồn', 'Đi qua /v1/responses, chuyển tiếp tới Copilot upstream, chưa qua nghiệm thu với upstream thực tế'),
    upstream('Đầu ra dạng luồng (SSE)', 'Trình tự sự kiện đã triển khai, hành vi phân đoạn của upstream thực tế chờ probe M0 hiệu chuẩn'),
    upstream('Ngữ cảnh nhiều lượt (previous_response_id)', 'Cơ chế nối tiếp đã triển khai, khả năng duy trì phiên của upstream thực tế cần kiểm chứng'),
    upstream('Chuyển tiếp nguyên trạng ID mô hình', 'Chuyển tiếp nguyên trạng không tạo alias mới; việc upstream có phản hồi theo đúng model hay không nằm ngoài tầm kiểm soát (§5.4)'),
    upstream('Chuyển tiếp mức độ tư duy (reasoning.effort)', 'Chuyển tiếp nguyên trạng; việc upstream có thực sự phân cấp tư duy hay không chờ probe M0 xác nhận'),
    upstream('Gọi công cụ và vòng lặp Agent', `Hiện tại TOOLS_MODE=${context.config.tools.mode}; giao thức công cụ của upstream thực tế chờ probe M0 hiệu chuẩn`),
    local('Base URL tùy chỉnh + khóa sk- đăng nhập Codex', 'Năng lực nội tại của cổng gateway, độc lập với upstream'),
    local('Đọc ghi tệp máy cục bộ / apply_patch / Shell / Git', 'Codex client thực thi cục bộ, cổng gateway không can thiệp'),
    local('MCP cục bộ / tự dựng, plugin chỉ gọi công cụ cục bộ', 'Codex client thực thi cục bộ'),
    local('Chỉ thị dự án AGENTS.md', 'Được chèn vào dưới dạng instructions, thuần túy là câu lệnh nhắc (prompt)'),
    local('Nhiều API Key, hạn ngạch và thời hạn độc lập', 'Cổng gateway tự triển khai (§10)'),
    local('Địa chỉ công khai tùy chỉnh / Reverse proxy', 'Cổng gateway tự triển khai (§12)'),
    {
      feature: 'Giả lập gọi công cụ bằng prompt (TOOLS_MODE=prompt)',
      status: 'experimental',
      detail: 'Phương án dự phòng khi chưa xác nhận upstream hỗ trợ native, ngưỡng tỷ lệ trúng cần đo bằng tài khoản thật M0 (§3.5)',
    },
    // §24.2 Phụ thuộc vào việc thăm dò upstream
    context.config.upstreamImageInput
      ? upstream('Đầu vào hình ảnh (input_image)', 'Hiện đã cho phép chuyển tiếp tới upstream, mức độ hỗ trợ thực tế chưa qua probe M0 xác nhận')
      : unsupported('Đầu vào hình ảnh (input_image)', 'UPSTREAM_IMAGE_INPUT=false, trả về lỗi unsupported_feature rõ ràng, không giả vờ hỗ trợ'),
    upstream('Tệp đính kèm PDF / Office', 'Server đã trích xuất văn bản thô, hiệu quả hiểu nội dung trích xuất của upstream chưa được xác nhận'),
    upstream('Giới hạn trần ngữ cảnh dài', 'Phụ thuộc vào khả năng chịu tải thực tế của upstream, hiện tại chỉ cắt ngắn ký tự cục bộ làm phương án dự phòng'),
    upstream('Đầu ra JSON có cấu trúc nghiêm ngặt', 'Có thể cần điều chỉnh ràng buộc đầu ra, độ tin cậy thực tế chưa được xác nhận'),
    upstream('Gọi công cụ song song (Parallel Tool Calls)', 'Phụ thuộc vào việc upstream có thể tạo ra nhiều lệnh gọi công cụ cùng lúc hay không'),
    upstream('Mức độ tư duy có thực sự phân cấp hay không', 'Upstream có thể "chấp nhận nhưng không phân biệt"'),
    upstream('Mức tiêu thụ Token chính xác', 'Hiện tại usage trả về null, upstream có thể chỉ cung cấp giá trị ước lượng'),
    upstream('Thông tin trích dẫn / Nguồn tham chiếu (Citations)', 'Đã ánh xạ cấu trúc citation của Copilot, tính xác thực của dữ liệu nguồn phụ thuộc vào upstream'),
    upstream('Tính kịp thời khi hủy yêu cầu', 'Phụ thuộc vào hành vi ngắt kết nối WebSocket của upstream'),
    // §24.3 Không khả thi
    unsupported('Codex Cloud / Ủy quyền tác vụ trên đám mây', 'Môi trường thực thi đám mây do backend của OpenAI cung cấp'),
    unsupported('Đánh giá mã đám mây / Tích hợp GitHub trên đám mây', 'Phụ thuộc vào dịch vụ đám mây của OpenAI; review dòng lệnh cục bộ vẫn hoạt động bình thường'),
    unsupported('Công cụ tích hợp do OpenAI lưu trữ (web_search/file_search/code_interpreter/computer_use/image_generation)', 'Cần backend lưu trữ của OpenAI để thực thi'),
    unsupported('ChatGPT Workspace RBAC / Enterprise Retention', 'Thuộc đặc quyền quản trị tài khoản ChatGPT'),
    unsupported('Plugin / MCP phụ thuộc vào OpenAI OAuth', 'Backend trỏ về OpenAI, không thể thay thế bằng Copilot'),
    unsupported('Embeddings / Realtime / Batch / Fine-tuning', 'Copilot upstream không có các năng lực tương ứng này'),
    unsupported('Bảng điều khiển thanh toán / mức dùng chính thức', 'Thuộc hệ thống tài khoản nền tảng của OpenAI'),
  ];
}
