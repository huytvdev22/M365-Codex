import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Cryptor, SealedValue } from '../crypto/index.js';
import { asRow, asRows, type Database } from '../db/index.js';

/**
 * Tầng truy cập dữ liệu cho pool proxy đầu ra (tương ứng kế hoạch triển khai §13.1, §M7).
 *
 * Trong `url` có thể kèm username và password, thuộc về thông tin xác thực, được lưu trữ mã hóa AES-256-GCM cùng chuẩn với Token,
 * nonce độc lập. Hiển thị ra ngoài luôn đi qua `maskProxyUrl`, chuỗi văn bản rõ vĩnh viễn không rời khỏi file này.
 */

export type ProxyStatus = 'unknown' | 'healthy' | 'unhealthy';
export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyNodeRow {
  id: string;
  name: string;
  url_enc: Uint8Array;
  url_nonce: Uint8Array;
  key_version: number;
  protocol: ProxyProtocol;
  weight: number;
  priority: number;
  enabled: number;
  status: ProxyStatus;
  latency_ms: number | null;
  last_check_at: number | null;
  failure_count: number;
  cooldown_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateProxyNodeInput {
  name: string;
  url: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateProxyNodeInput {
  name?: string;
  url?: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export interface ProxyCheckResult {
  status: ProxyStatus;
  latencyMs: number | null;
  failureCount: number;
  cooldownUntil: number | null;
}

/** Suy đoán giao thức từ URL; không nhận diện được thì quy về http (dạng phổ biến nhất). */
export function protocolOf(url: string): ProxyProtocol {
  const scheme = url.split('://')[0]?.toLowerCase() ?? '';
  if (scheme === 'socks5' || scheme === 'socks5h') return 'socks5';
  if (scheme === 'https') return 'https';
  return 'http';
}

/**
 * Làm mờ: chỉ giữ lại giao thức và host:port, username:password thay thế toàn bộ thành `***:***`.
 * Khi phân tích thất bại (sai định dạng) sẽ che mờ toàn bộ, tuyệt đối không để lọt chuỗi gốc.
 */
export function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const auth = parsed.username !== '' ? '***:***@' : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '***';
  }
}

export interface ProxyNodeView {
  id: string;
  name: string;
  url_masked: string;
  protocol: ProxyProtocol;
  weight: number;
  priority: number;
  enabled: boolean;
  status: ProxyStatus;
  latency_ms: number | null;
  last_check_at: number | null;
  failure_count: number;
  cooldown_until: number | null;
  bound_accounts: string[];
  created_at: number;
  updated_at: number;
}

export class ProxyNodeRepository {
  readonly #db: Database;
  readonly #cryptor: Cryptor;

  constructor(db: Database, cryptor: Cryptor) {
    this.#db = db;
    this.#cryptor = cryptor;
  }

  create(input: CreateProxyNodeInput, now = Date.now()): ProxyNodeRow {
    const id = randomUUID();
    const sealed = this.#cryptor.seal(input.url, `proxy:${id}`);
    this.#db
      .prepare(
        `INSERT INTO proxy_nodes (
           id, name, url_enc, url_nonce, key_version, protocol, weight, priority,
           enabled, status, failure_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyVersion,
        protocolOf(input.url),
        input.weight ?? 1,
        input.priority ?? 0,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    const row = this.findById(id);
    if (row === undefined) throw new Error('代理节点创建后立即读取失败');
    return row;
  }

  findById(id: string): ProxyNodeRow | undefined {
    return asRow<ProxyNodeRow>(this.#db.prepare('SELECT * FROM proxy_nodes WHERE id = ?').get(id));
  }

  list(): ProxyNodeRow[] {
    return asRows<ProxyNodeRow>(
      this.#db.prepare('SELECT * FROM proxy_nodes ORDER BY priority DESC, created_at ASC').all(),
    );
  }

  /** Giải mã ra URL văn bản rõ. Chỉ dùng cho chuyển tiếp nội bộ (quay số, kiểm tra sức khỏe), tuyệt đối không trả ra ngoài. */
  decryptUrl(row: ProxyNodeRow): string {
    const sealed: SealedValue = {
      ciphertext: Buffer.isBuffer(row.url_enc) ? row.url_enc : Buffer.from(row.url_enc),
      nonce: Buffer.isBuffer(row.url_nonce) ? row.url_nonce : Buffer.from(row.url_nonce),
      keyVersion: row.key_version,
    };
    return this.#cryptor.open(sealed, `proxy:${row.id}`);
  }

  /** Dành cho bộ điều phối/OAuth client phân giải cổng ra mà tài khoản liên kết: node không tồn tại hoặc đã vô hiệu hóa đều xem như không khả dụng. */
  resolveActiveUrl(id: string): string | null {
    const row = this.findById(id);
    if (row === undefined || row.enabled !== 1) return null;
    return this.decryptUrl(row);
  }

  update(id: string, input: UpdateProxyNodeInput, now = Date.now()): ProxyNodeRow | undefined {
    const existing = this.findById(id);
    if (existing === undefined) return undefined;

    let urlEnc = existing.url_enc;
    let urlNonce = existing.url_nonce;
    let keyVersion = existing.key_version;
    let protocol = existing.protocol;
    if (input.url !== undefined) {
      const sealed = this.#cryptor.seal(input.url, `proxy:${id}`);
      urlEnc = sealed.ciphertext;
      urlNonce = sealed.nonce;
      keyVersion = sealed.keyVersion;
      protocol = protocolOf(input.url);
    }

    this.#db
      .prepare(
        `UPDATE proxy_nodes SET
           name = ?, url_enc = ?, url_nonce = ?, key_version = ?, protocol = ?,
           weight = ?, priority = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        urlEnc,
        urlNonce,
        keyVersion,
        protocol,
        input.weight ?? existing.weight,
        input.priority ?? existing.priority,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        now,
        id,
      );
    return this.findById(id);
  }

  remove(id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM proxy_nodes WHERE id = ?').run(id).changes) > 0;
  }

  /** Ghi lại kết quả kiểm tra sức khỏe: độ trễ, số lần thất bại, cửa sổ làm nguội (tương ứng kế hoạch triển khai §13.1). */
  recordCheck(id: string, result: ProxyCheckResult, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE proxy_nodes SET
           status = ?, latency_ms = ?, last_check_at = ?, failure_count = ?, cooldown_until = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(result.status, result.latencyMs, now, result.failureCount, result.cooldownUntil, now, id);
  }

  /** Danh sách ID tài khoản hiện đang liên kết với node này. */
  boundAccountIds(id: string): string[] {
    const rows = asRows<{ id: string }>(
      this.#db.prepare('SELECT id FROM accounts WHERE proxy_node_id = ?').all(id),
    );
    return rows.map((r) => r.id);
  }
}

/** Lắp ráp view đối ngoại. `urlMasked` bắt buộc do bên gọi tính trước qua `maskProxyUrl(repo.decryptUrl(row))` rồi truyền vào. */
export function toProxyNodeView(row: ProxyNodeRow, urlMasked: string, boundAccounts: string[]): ProxyNodeView {
  return {
    id: row.id,
    name: row.name,
    url_masked: urlMasked,
    protocol: row.protocol,
    weight: row.weight,
    priority: row.priority,
    enabled: row.enabled === 1,
    status: row.status,
    latency_ms: row.latency_ms,
    last_check_at: row.last_check_at,
    failure_count: row.failure_count,
    cooldown_until: row.cooldown_until,
    bound_accounts: boundAccounts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
