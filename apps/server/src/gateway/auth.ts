import { ApiError, API_KEY_PREFIX } from '@m365-codex/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiKeyLookupPrefix, isWellFormedApiKey, verifyApiKey } from '../crypto/apiKey.js';
import type { AppContext } from '../context.js';
import { evaluateApiKeyUsability, parseList, type ApiKeyRow } from '../repo/apiKeys.js';
import type { AdminSessionRow } from '../repo/adminSessions.js';
import { maskIp } from '../observability/logger.js';
import { clampToCeiling } from './rateLimit.js';

/** Xác thực: Hai kênh độc lập gồm API Key đối ngoại và phiên quản trị. */

/**
 * Hạn ngạch hiệu dụng cấp API Key đã được cắt tỉa theo trần toàn cục (§10.1): `max_tool_calls`/
 * `max_file_bytes` được gán tại đây để các route tiếp theo đọc trực tiếp, không cần truy vấn DB lại hay tính lại
 * `clampToCeiling` — áp dụng cùng quy tắc "chỉ có thể siết chặt hơn, không vượt quá giới hạn toàn cục" với rpm/daily/concurrency (`gateway/rateLimit.ts`).
 */
export interface ApiKeyEffectiveLimits {
  maxToolCalls: number;
  maxFileBytes: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyRow?: ApiKeyRow;
    apiKeyLimits?: ApiKeyEffectiveLimits;
    adminSession?: AdminSessionRow;
  }
}

/** Đồng thời hỗ trợ `Authorization: Bearer sk-…` và `X-API-Key: sk-…`. */
export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim() !== '') {
    return header.trim();
  }
  const auth = request.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

export function extractBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match?.[1]?.trim() ?? null;
}

/** Lấy tag endpoint (`METHOD /route/pattern`) từ request, dùng cho whitelist hạn ngạch và phạm vi idempotency. */
export function endpointTagFor(request: FastifyRequest): string {
  const pattern = request.routeOptions.url ?? request.url;
  return `${request.method} ${pattern}`;
}

/** Lấy trường `model` từ request body đã parse (chỉ có ý nghĩa với request Responses / Chat Completions). */
function modelFromBody(request: FastifyRequest): string | null {
  const body = request.body;
  if (body !== null && typeof body === 'object' && 'model' in body) {
    const model = (body as { model?: unknown }).model;
    return typeof model === 'string' && model !== '' ? model : null;
  }
  return null;
}

/**
 * Xác thực API Key đối ngoại và áp dụng hạn ngạch của §10 (whitelist endpoint/model, RPM, hạn mức ngày, concurrency tối đa).
 * Sau khi khớp prefix vẫn so sánh hash thời gian hằng số (constant-time) từng ứng viên, tránh phân biệt sự tồn tại của Key qua thời gian phản hồi.
 */
export function createApiKeyGuard(context: AppContext) {
  return async function apiKeyGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const presented = extractApiKey(request);
    if (presented === null) {
      throw ApiError.unauthorized(
        `Thiếu API Key, vui lòng cung cấp qua Authorization: Bearer ${API_KEY_PREFIX}… hoặc X-API-Key`,
      );
    }
    if (!isWellFormedApiKey(presented)) {
      throw ApiError.unauthorized('Định dạng API Key không hợp lệ');
    }

    const candidates = context.apiKeys.findByPrefix(apiKeyLookupPrefix(presented));
    let matched: ApiKeyRow | undefined;
    for (const candidate of candidates) {
      if (verifyApiKey(presented, candidate.salt, candidate.hash)) {
        matched = candidate;
        break;
      }
    }
    if (matched === undefined) {
      throw ApiError.unauthorized('API Key không hợp lệ');
    }

    const usability = evaluateApiKeyUsability(matched);
    if (!usability.usable) {
      throw ApiError.forbidden(usability.reason);
    }

    const endpoint = endpointTagFor(request);
    const model = modelFromBody(request);

    try {
      context.rateLimiter.checkEndpointAndModel(
        { endpoints: parseList(matched.allowed_endpoints), models: parseList(matched.allowed_models) },
        endpoint,
        model,
      );
    } catch (error) {
      recordRestrictionHit(context, matched.id, endpoint, 'api_key.access_denied', 'endpoint_or_model', clientIpFor(context, request));
      throw error;
    }

    const limits = context.rateLimiter.effectiveLimits(matched);
    const consumed = context.rateLimiter.consume(matched.id, limits);
    if (!consumed.ok) {
      recordRestrictionHit(context, matched.id, endpoint, 'api_key.rate_limited', consumed.reason, clientIpFor(context, request));
      reply.header('Retry-After', String(consumed.retryAfterSeconds));
      throw ApiError.rateLimited(
        `Đã đạt giới hạn ${rateLimitReasonLabel(consumed.reason)} của API Key này, vui lòng thử lại sau ${consumed.retryAfterSeconds} giây`,
      );
    }
    // Hạn mức đồng thời được giải phóng qua sự kiện close của kết nối HTTP: response stream (SSE) sẽ hijack,
    // hook onResponse của Fastify không chạy đối với kết nối bị hijack, sự kiện close của raw socket kích hoạt tin cậy dù có hijack hay không
    // (trong router việc client ngắt kết nối hủy upstream cũng dùng sự kiện này, đã kiểm chứng độ tin cậy).
    reply.raw.once('close', consumed.release);

    request.apiKeyRow = matched;
    // §10.1: Số lần gọi công cụ, kích thước file/mảnh upload siết chặt theo Key cũng tuân theo "không vượt quá trần toàn cục" —
    // tại đây cắt tỉa thống nhất để responses/service.ts và route files đọc trực tiếp, không cần mỗi bên truy vấn lại CSDL
    request.apiKeyLimits = {
      maxToolCalls: clampToCeiling(matched.max_tool_calls, context.config.tools.maxTotalCalls),
      maxFileBytes: clampToCeiling(matched.max_file_bytes, context.config.files.maxFileBytes),
    };
    context.apiKeys.touch(matched.id, clientIpFor(context, request));
  };
}

function rateLimitReasonLabel(reason: 'rpm' | 'daily' | 'concurrency'): string {
  switch (reason) {
    case 'rpm':
      return 'số yêu cầu mỗi phút (RPM)';
    case 'daily':
      return 'số yêu cầu mỗi ngày';
    case 'concurrency':
      return 'số yêu cầu đồng thời';
  }
}

/** Giới hạn/whitelist khớp phải lưu vết, nhưng tuyệt đối không ghi nội dung request (bất kỳ trường nào ngoài model) vào audit log hoặc metrics. */
function recordRestrictionHit(
  context: AppContext,
  apiKeyId: string,
  endpoint: string,
  action: string,
  reason: string,
  clientIp: string | null,
): void {
  context.metrics.rateLimitRejections.inc({ reason });
  context.auditLogs.record({
    actor: 'api_key',
    action,
    target: apiKeyId,
    detail: { endpoint, reason },
    clientIp: maskIp(clientIp ?? undefined, context.privacyMode.current),
  });
}

/** Xác thực token phiên quản trị. */
export function createAdminGuard(context: AppContext) {
  return async function adminGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearerToken(request);
    if (token === null) {
      throw ApiError.unauthorized('Thiếu token phiên quản trị');
    }
    const session = context.adminSessions.verify(token);
    if (session === undefined) {
      throw ApiError.unauthorized('Phiên quản trị không hợp lệ hoặc đã hết hạn');
    }
    request.adminSession = session;
  };
}

/** Lấy IP của client: bỏ qua X-Forwarded-* khi chưa bật TRUST_PROXY. */
export function clientIpFor(context: AppContext, request: FastifyRequest): string | null {
  if (context.config.trustProxy) {
    return request.ip;
  }
  return request.socket.remoteAddress ?? null;
}

/** Điều tiết thất bại đăng nhập (login throttle): Đếm theo IP để chống brute force mật khẩu quản trị trực tuyến. */
export class LoginThrottle {
  readonly #attempts = new Map<string, { count: number; resetAt: number }>();
  readonly #maxAttempts: number;
  readonly #windowMs: number;

  constructor(maxAttempts = 8, windowMs = 15 * 60 * 1000) {
    this.#maxAttempts = maxAttempts;
    this.#windowMs = windowMs;
  }

  check(key: string, now = Date.now()): void {
    const entry = this.#attempts.get(key);
    if (entry === undefined) return;
    if (entry.resetAt <= now) {
      this.#attempts.delete(key);
      return;
    }
    if (entry.count >= this.#maxAttempts) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      throw ApiError.rateLimited(`Đăng nhập thất bại quá nhiều lần, vui lòng thử lại sau ${seconds} giây`);
    }
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.#attempts.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.#attempts.set(key, { count: 1, resetAt: now + this.#windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.#attempts.delete(key);
  }
}
