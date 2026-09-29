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
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
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
    if (row === undefined) throw ApiError.notFound('请求记录不存在');
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
      throw ApiError.badRequest(`未知的设置分组：${body.group}`, 'group');
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
    .refine((v) => Object.keys(v).length > 0, { message: '至少需要提供一个待更新字段' });
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
      const name = commaIndex > 0 ? line.slice(0, commaIndex).trim() : `导入节点 ${index + 1}`;
      const url = commaIndex > 0 ? line.slice(commaIndex + 1).trim() : line;
      // Kiểm tra tính hợp lệ của URL, tránh việc mã hóa và lưu vào DB chuỗi rõ ràng không mở được
      if (!isValidUrl(url)) {
        results.push({ line, ok: false, error: 'url 不是合法的 URL' });
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
      throw ApiError.badRequest('url 不是合法的 URL', 'url');
    }
    const row = context.proxyNodes.update(request.params.id, body);
    if (row === undefined) throw ApiError.notFound('代理节点不存在');
    context.auditLogs.record({ actor: 'admin', action: 'proxy.update', target: row.id });
    return toView(row);
  });

  app.delete<{ Params: { id: string } }>('/admin/proxies/:id', { preHandler: adminGuard }, async (request) => {
    const row = context.proxyNodes.findById(request.params.id);
    if (row === undefined) throw ApiError.notFound('代理节点不存在');
    context.proxyNodes.remove(request.params.id);
    context.auditLogs.record({ actor: 'admin', action: 'proxy.delete', target: request.params.id });
    return { deleted: true, id: request.params.id };
  });

  app.post<{ Params: { id: string } }>(
    '/admin/proxies/:id/check',
    { preHandler: adminGuard },
    async (request) => {
      const row = context.proxyNodes.findById(request.params.id);
      if (row === undefined) throw ApiError.notFound('代理节点不存在');
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
        notes.push('未设置 PUBLIC_API_BASE_URL，此处用本机地址兜底，请按你的实际对外地址修改');
      }
      notes.push(`请把环境变量 ${envKey} 设为你的 sk- API Key`);
      notes.push('model 与 model_reasoning_effort 由 Codex 端自行选择，本文件不代填');

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
    if (row === undefined) throw ApiError.notFound('文件不存在');
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
    const models = loadModels(undefined, (reason) => context.logger.warn({ reason }, '模型目录降级')).data.map(
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
    upstream('文本对话/代码生成', '走 /v1/responses，转发到 Copilot 上游，尚未经真实上游验收'),
    upstream('流式输出（SSE）', '事件序列已实现，真实上游的分片行为待 M0 校准'),
    upstream('多轮上下文（previous_response_id）', '续接机制已实现，真实上游会话保持能力待验证'),
    upstream('模型 ID 透传', '原样透传不新造别名；上游是否按该模型作答不可控（§5.4）'),
    upstream('思考等级（reasoning.effort）透传', '原样透传；上游是否真正分级待 M0 确认'),
    upstream('工具调用与代理循环', `当前 TOOLS_MODE=${context.config.tools.mode}；真实上游工具协议待 M0 校准`),
    local('自定义 Base URL + sk- 密钥登录 Codex', '网关自身能力，与上游无关'),
    local('本机文件读写 / apply_patch / Shell / Git', 'Codex 客户端本地执行，网关不参与'),
    local('本地/自建 MCP、只调本地工具的插件', 'Codex 客户端本地执行'),
    local('AGENTS.md 项目指令', '作为 instructions 注入，纯提示词'),
    local('多 API Key、独立限额与有效期', '网关自身实现（§10）'),
    local('自定义公开地址 / 反向代理', '网关自身实现（§12）'),
    {
      feature: '提示词模拟工具调用（TOOLS_MODE=prompt）',
      status: 'experimental',
      detail: '未确认上游原生支持时的兜底方案，命中率门槛需 M0 真实账号测得（§3.5）',
    },
    // §24.2 Phụ thuộc vào việc thăm dò upstream
    context.config.upstreamImageInput
      ? upstream('图片输入（input_image）', '当前已放行转发给上游，真实支持程度未经 M0 确认')
      : unsupported('图片输入（input_image）', 'UPSTREAM_IMAGE_INPUT=false，明确返回 unsupported_feature，不假装支持'),
    upstream('PDF / Office 附件', '服务端已提取文本，上游对提取内容的理解效果未经确认'),
    upstream('长上下文上限', '由上游实际承载能力决定，当前只做本地字符数截断兜底'),
    upstream('严格结构化 JSON 输出', '可能需要约束输出适配，真实可靠性未经确认'),
    upstream('并行工具调用', '取决于上游能否一次产出多个工具调用'),
    upstream('思考等级是否真正分级', '上游可能"接受但不区分"'),
    upstream('精确 Token 用量', '当前 usage 为 null，上游可能只给估算值'),
    upstream('引用/来源信息', '已映射 Copilot citation 结构，来源数据真实性取决于上游'),
    upstream('请求取消及时性', '取决于上游 WebSocket 取消行为'),
    // §24.3 Không thể thực hiện
    unsupported('Codex Cloud / 云端任务委派', '云端执行环境由 OpenAI 后端提供'),
    unsupported('云端代码审查 / 云端 GitHub 集成', '依赖 OpenAI 云服务；本地命令行 review 可用'),
    unsupported('OpenAI 托管内置工具（web_search/file_search/code_interpreter/computer_use/image_generation）', '需 OpenAI 托管后端执行'),
    unsupported('ChatGPT 工作区 RBAC / 企业保留', '属 ChatGPT 账号管理特权'),
    unsupported('依赖 OpenAI OAuth 的插件/MCP', '其后端指向 OpenAI，无法用 Copilot 替代'),
    unsupported('Embeddings / Realtime / Batch / Fine-tuning', 'Copilot 上游无对应能力'),
    unsupported('官方用量/计费面板', '属 OpenAI 平台账户体系'),
  ];
}
