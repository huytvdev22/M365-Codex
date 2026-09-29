import { randomUUID } from 'node:crypto';
import type { ApiKeyView } from '@m365-codex/shared';
import { generateApiKey, maskApiKey } from '../crypto/apiKey.js';
import { asRow, asRows, type Database } from '../db/index.js';

/** Tầng truy cập dữ liệu API Key. Trong DB vĩnh viễn không xuất hiện Key dạng văn bản rõ. */

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  salt: string;
  hash: string;
  enabled: number;
  revoked_at: number | null;
  starts_at: number | null;
  expires_at: number | null;
  rpm_limit: number | null;
  daily_limit: number | null;
  max_concurrency: number | null;
  allowed_endpoints: string | null;
  allowed_models: string | null;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  /** Ghi chú, thuần túy để hiển thị, không tham gia vào bất kỳ phán đoán xác thực/hạn mức nào */
  note: string | null;
  /** Số lượt yêu cầu tích lũy (hiển thị lượng sử dụng trên giao diện quản trị), tăng dần cùng với touch(), không tốn thêm 1 lần ghi riêng trên hot path */
  request_count: number;
  /** Giới hạn số lần gọi công cụ siết chặt theo Key (tích lũy chuỗi hội thoại), null biểu thị không siết chặt thêm, chỉ chịu ràng buộc trần toàn cục */
  max_tool_calls: number | null;
  /** Giới hạn dung lượng đơn file/từng chunk tải lên siết chặt theo Key (byte), null biểu thị không siết chặt thêm */
  max_file_bytes: number | null;
}

/**
 * `ApiKeyView`/`ApiKeyCreated` (`@m365-codex/shared`) chưa thu nhận 4 trường này —
 * Phạm vi sửa đổi lần này giới hạn trong `apps/server/**`, không sửa package chia sẻ (tránh xung đột
 * với sửa đổi đồng thời ở `apps/web`). Ở đây mở rộng một tầng nội bộ trong server, giá trị trường vẫn giữ nguyên qua JSON
 * trả về cho giao diện quản trị; sau này nếu muốn cung cấp static type cho WebUI, sẽ gộp các trường này vào
 * type contract công khai của `packages/shared`.
 */
export interface ApiKeyViewExt extends ApiKeyView {
  note: string | null;
  request_count: number;
  max_tool_calls: number | null;
  max_file_bytes: number | null;
}

export interface ApiKeyCreatedExt extends ApiKeyViewExt {
  /** API Key dạng văn bản rõ, chỉ trả về 1 lần duy nhất khi tạo, server không lưu trữ */
  key: string;
}

export interface CreateApiKeyInput {
  name: string;
  startsAt?: number | null;
  expiresAt?: number | null;
  rpmLimit?: number | null;
  dailyLimit?: number | null;
  maxConcurrency?: number | null;
  allowedEndpoints?: string[] | null;
  allowedModels?: string[] | null;
  note?: string | null;
  maxToolCalls?: number | null;
  maxFileBytes?: number | null;
}

export interface UpdateApiKeyInput {
  name?: string;
  enabled?: boolean;
  startsAt?: number | null;
  expiresAt?: number | null;
  rpmLimit?: number | null;
  dailyLimit?: number | null;
  maxConcurrency?: number | null;
  allowedEndpoints?: string[] | null;
  allowedModels?: string[] | null;
  note?: string | null;
  maxToolCalls?: number | null;
  maxFileBytes?: number | null;
}

/** Export cho `gateway/rateLimit.ts` tái sử dụng, tránh có thêm bản sao logic parse JSON thứ hai. */
export function parseList(value: string | null): string[] | null {
  if (value === null || value === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function serializeList(value: string[] | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return JSON.stringify(value);
}

export function toApiKeyView(row: ApiKeyRow): ApiKeyViewExt {
  return {
    id: row.id,
    name: row.name,
    masked_key: maskApiKey(row.prefix),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    rpm_limit: row.rpm_limit,
    daily_limit: row.daily_limit,
    max_concurrency: row.max_concurrency,
    allowed_endpoints: parseList(row.allowed_endpoints),
    allowed_models: parseList(row.allowed_models),
    note: row.note,
    request_count: row.request_count,
    max_tool_calls: row.max_tool_calls,
    max_file_bytes: row.max_file_bytes,
  };
}

export class ApiKeyRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateApiKeyInput, now = Date.now()): ApiKeyCreatedExt {
    const generated = generateApiKey();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO api_keys (
           id, name, prefix, salt, hash, enabled, starts_at, expires_at,
           rpm_limit, daily_limit, max_concurrency, allowed_endpoints, allowed_models, created_at,
           note, max_tool_calls, max_file_bytes
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        generated.prefix,
        generated.salt,
        generated.hash,
        input.startsAt ?? null,
        input.expiresAt ?? null,
        input.rpmLimit ?? null,
        input.dailyLimit ?? null,
        input.maxConcurrency ?? null,
        serializeList(input.allowedEndpoints),
        serializeList(input.allowedModels),
        now,
        input.note ?? null,
        input.maxToolCalls ?? null,
        input.maxFileBytes ?? null,
      );

    const row = this.getRowById(id);
    if (row === undefined) {
      throw new Error('API Key 创建后立即读取失败');
    }
    return { ...toApiKeyView(row), key: generated.key };
  }

  getRowById(id: string): ApiKeyRow | undefined {
    return asRow<ApiKeyRow>(this.#db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
  }

  /** Tiền tố có thể trùng (xác suất cực thấp), trả về toàn bộ ứng viên để bên gọi kiểm tra từng cái bằng constant-time. */
  findByPrefix(prefix: string): ApiKeyRow[] {
    return asRows<ApiKeyRow>(this.#db.prepare('SELECT * FROM api_keys WHERE prefix = ?').all(prefix));
  }

  list(): ApiKeyViewExt[] {
    const rows = asRows<ApiKeyRow>(
      this.#db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all(),
    );
    return rows.map(toApiKeyView);
  }

  update(id: string, input: UpdateApiKeyInput): ApiKeyViewExt | undefined {
    const existing = this.getRowById(id);
    if (existing === undefined) return undefined;

    const next = {
      name: input.name ?? existing.name,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      starts_at: input.startsAt === undefined ? existing.starts_at : input.startsAt,
      expires_at: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
      rpm_limit: input.rpmLimit === undefined ? existing.rpm_limit : input.rpmLimit,
      daily_limit: input.dailyLimit === undefined ? existing.daily_limit : input.dailyLimit,
      max_concurrency:
        input.maxConcurrency === undefined ? existing.max_concurrency : input.maxConcurrency,
      allowed_endpoints:
        input.allowedEndpoints === undefined
          ? existing.allowed_endpoints
          : serializeList(input.allowedEndpoints),
      allowed_models:
        input.allowedModels === undefined ? existing.allowed_models : serializeList(input.allowedModels),
      note: input.note === undefined ? existing.note : input.note,
      max_tool_calls: input.maxToolCalls === undefined ? existing.max_tool_calls : input.maxToolCalls,
      max_file_bytes: input.maxFileBytes === undefined ? existing.max_file_bytes : input.maxFileBytes,
    };

    this.#db
      .prepare(
        `UPDATE api_keys SET
           name = ?, enabled = ?, starts_at = ?, expires_at = ?,
           rpm_limit = ?, daily_limit = ?, max_concurrency = ?,
           allowed_endpoints = ?, allowed_models = ?,
           note = ?, max_tool_calls = ?, max_file_bytes = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.enabled,
        next.starts_at,
        next.expires_at,
        next.rpm_limit,
        next.daily_limit,
        next.max_concurrency,
        next.allowed_endpoints,
        next.allowed_models,
        next.note,
        next.max_tool_calls,
        next.max_file_bytes,
        id,
      );

    const row = this.getRowById(id);
    return row === undefined ? undefined : toApiKeyView(row);
  }

  /** Thu hồi: giữ lại bản ghi để kiểm toán nhưng lập tức vô hiệu hóa. */
  revoke(id: string, now = Date.now()): ApiKeyViewExt | undefined {
    const existing = this.getRowById(id);
    if (existing === undefined) return undefined;
    this.#db
      .prepare('UPDATE api_keys SET enabled = 0, revoked_at = ? WHERE id = ?')
      .run(existing.revoked_at ?? now, id);
    const row = this.getRowById(id);
    return row === undefined ? undefined : toApiKeyView(row);
  }

  /**
   * Cập nhật thời gian/IP sử dụng gần nhất, đồng thời cộng dồn số lượt yêu cầu +1 (§10.1).
   * Ghi chung trong 1 câu UPDATE với last_used_at, không tốn thêm 1 lần ghi DB riêng trên hot path xác thực.
   */
  touch(id: string, ip: string | null, now = Date.now()): void {
    this.#db
      .prepare(
        'UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, request_count = request_count + 1 WHERE id = ?',
      )
      .run(now, ip, id);
  }
}

/** Key có đang ở trạng thái khả dụng hay không; trả về lý do không khả dụng giúp đưa ra lỗi rõ ràng. */
export function evaluateApiKeyUsability(
  row: ApiKeyRow,
  now = Date.now(),
): { usable: true } | { usable: false; reason: string } {
  if (row.revoked_at !== null) return { usable: false, reason: 'API Key 已被撤销' };
  if (row.enabled !== 1) return { usable: false, reason: 'API Key 已被停用' };
  if (row.starts_at !== null && now < row.starts_at) return { usable: false, reason: 'API Key 尚未生效' };
  if (row.expires_at !== null && now >= row.expires_at) return { usable: false, reason: 'API Key 已过期' };
  return { usable: true };
}
