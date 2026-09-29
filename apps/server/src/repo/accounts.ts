import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { AccountStatus } from '@m365-codex/shared';
import type { Cryptor, SealedValue } from '../crypto/index.js';
import { asRow, asRows, type Database } from '../db/index.js';
import type { Metrics } from '../observability/metrics.js';

/**
 * Tầng truy cập dữ liệu cho tài khoản và Token.
 *
 * Quy tắc thép: Token dạng văn bản rõ chỉ tồn tại tạm thời trong bộ nhớ, trước khi lưu DB bắt buộc phải mã hóa qua Cryptor;
 * File này không in bất kỳ log nào, triệt tiêu nguy cơ rò rỉ Token qua log.
 */

export interface AccountRow {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  display_name: string | null;
  status: AccountStatus;
  proxy_node_id: string | null;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface AccountTokenRow {
  account_id: string;
  access_token_enc: Uint8Array | null;
  access_nonce: Uint8Array | null;
  refresh_token_enc: Uint8Array | null;
  refresh_nonce: Uint8Array | null;
  key_version: number;
  expires_at: number | null;
  rotated_at: number | null;
}

export interface AccountHealthRow {
  account_id: string;
  last_ok_at: number | null;
  last_error_at: number | null;
  last_error_type: string | null;
  consecutive_failures: number;
  cooldown_until: number | null;
  updated_at: number;
}

/** View tài khoản hiển thị ra ngoài, tuyệt đối không chứa Token. */
export interface AccountView {
  id: string;
  tid: string;
  oid: string;
  email: string | null;
  display_name: string | null;
  status: AccountStatus;
  source: string;
  /** ID node proxy đầu ra được liên kết (hợp đồng §2.4), chưa liên kết là null */
  proxy_node_id: string | null;
  created_at: number;
  updated_at: number;
  token_expires_at: number | null;
  token_rotated_at: number | null;
  has_refresh_token: boolean;
  consecutive_failures: number;
  cooldown_until: number | null;
  last_ok_at: number | null;
  last_error_type: string | null;
}

/** Token dạng văn bản rõ mang theo khi ghi tài khoản. Bên gọi có trách nhiệm hủy bỏ các chuỗi này càng sớm càng tốt. */
export interface TokenMaterial {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch mili-giây */
  expiresAt: number | null;
}

export interface UpsertAccountInput {
  tid: string;
  oid: string;
  email: string | null;
  displayName: string | null;
  /** Đánh dấu nguồn: `oauth` (cấp quyền cục bộ) hoặc `import:<tên>` (nhập từ bên ngoài) */
  source: string;
  tokens: TokenMaterial;
}

/**
 * Các bước chuyển đổi trạng thái được phép.
 * Tập trung tại một nơi thay vì rải rác trong code nghiệp vụ, tránh việc "ai cũng có thể đổi tài khoản sang online".
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  probing: ['online', 'unsupported', 'reauth_required', 'error', 'disabled'],
  online: ['busy', 'cooldown', 'reauth_required', 'error', 'disabled', 'probing'],
  busy: ['online', 'cooldown', 'reauth_required', 'error', 'disabled'],
  cooldown: ['online', 'probing', 'reauth_required', 'error', 'disabled'],
  reauth_required: ['probing', 'online', 'disabled', 'error'],
  // Vô hiệu hóa là hành động thủ công, chỉ có thể khôi phục thủ công về probing để thăm dò lại
  disabled: ['probing'],
  unsupported: ['probing', 'disabled'],
  error: ['probing', 'online', 'cooldown', 'reauth_required', 'disabled'],
};

export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidStateTransitionError extends Error {
  constructor(from: AccountStatus, to: AccountStatus) {
    super(`账号状态不允许从 ${from} 迁移到 ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

function toBuffer(value: Uint8Array | null): Buffer | null {
  if (value === null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class AccountRepository {
  readonly #db: Database;
  readonly #cryptor: Cryptor;
  /** M8: Đo đạc chuyển trạng thái tài khoản (§17), tùy chọn — khi không truyền (phần lớn unit test khởi tạo trực tiếp) sẽ bỏ qua trong im lặng. */
  readonly #metrics: Metrics | undefined;

  constructor(db: Database, cryptor: Cryptor, metrics?: Metrics) {
    this.#db = db;
    this.#cryptor = cryptor;
    this.#metrics = metrics;
  }

  /**
   * Thêm mới hoặc cập nhật tài khoản theo khóa duy nhất (tid, oid), và thay thế Token một cách nguyên tử.
   * Cấp quyền lặp lại cùng một tài khoản sẽ chỉ cập nhật, không tạo mục trùng lặp trong pool.
   */
  upsert(input: UpsertAccountInput, now = Date.now()): AccountView {
    const existing = this.findByTenantObject(input.tid, input.oid);
    const id = existing?.id ?? randomUUID();
    // Cấp quyền lại nghĩa là thông tin xác thực vừa cập nhật, quay về probing để lần thăm dò tiếp theo quyết định có online không;
    // Nhưng tài khoản bị vô hiệu hóa thủ công sẽ không bị kích hoạt âm thầm chỉ vì một lần cấp quyền
    const nextStatus: AccountStatus =
      existing === undefined ? 'probing' : existing.status === 'disabled' ? 'disabled' : 'probing';

    const sealedAccess = this.#cryptor.seal(input.tokens.accessToken, `account:${id}:access`);
    const sealedRefresh =
      input.tokens.refreshToken === null
        ? null
        : this.#cryptor.seal(input.tokens.refreshToken, `account:${id}:refresh`);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (existing === undefined) {
        this.#db
          .prepare(
            `INSERT INTO accounts (id, tid, oid, email, display_name, status, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.tid, input.oid, input.email, input.displayName, nextStatus, input.source, now, now);
        this.#db
          .prepare('INSERT INTO account_health (account_id, updated_at) VALUES (?, ?)')
          .run(id, now);
      } else {
        this.#db
          .prepare(
            `UPDATE accounts SET email = ?, display_name = ?, status = ?, source = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.email, input.displayName, nextStatus, input.source, now, id);
      }

      this.#db
        .prepare(
          `INSERT INTO account_tokens (
             account_id, access_token_enc, access_nonce, refresh_token_enc, refresh_nonce,
             key_version, expires_at, rotated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET
             access_token_enc = excluded.access_token_enc,
             access_nonce = excluded.access_nonce,
             refresh_token_enc = excluded.refresh_token_enc,
             refresh_nonce = excluded.refresh_nonce,
             key_version = excluded.key_version,
             expires_at = excluded.expires_at,
             rotated_at = excluded.rotated_at`,
        )
        .run(
          id,
          sealedAccess.ciphertext,
          sealedAccess.nonce,
          sealedRefresh?.ciphertext ?? null,
          sealedRefresh?.nonce ?? null,
          sealedAccess.keyVersion,
          input.tokens.expiresAt,
          now,
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }

    const view = this.getView(id);
    if (view === undefined) throw new Error('账号写入后立即读取失败');
    return view;
  }

  /** Chỉ thay thế Token, không động tới các trường danh tính tài khoản. Dùng cho việc ghi đè nguyên tử trong luồng làm mới. */
  replaceTokens(accountId: string, tokens: TokenMaterial, now = Date.now()): void {
    const sealedAccess = this.#cryptor.seal(tokens.accessToken, `account:${accountId}:access`);
    const sealedRefresh =
      tokens.refreshToken === null
        ? null
        : this.#cryptor.seal(tokens.refreshToken, `account:${accountId}:refresh`);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // Khi refresh_token là null thì giữ nguyên giá trị cũ: Microsoft không phải lần làm mới nào cũng cấp refresh_token mới
      this.#db
        .prepare(
          `UPDATE account_tokens SET
             access_token_enc = ?, access_nonce = ?,
             refresh_token_enc = COALESCE(?, refresh_token_enc),
             refresh_nonce = COALESCE(?, refresh_nonce),
             key_version = ?, expires_at = ?, rotated_at = ?
           WHERE account_id = ?`,
        )
        .run(
          sealedAccess.ciphertext,
          sealedAccess.nonce,
          sealedRefresh?.ciphertext ?? null,
          sealedRefresh?.nonce ?? null,
          sealedAccess.keyVersion,
          tokens.expiresAt,
          now,
          accountId,
        );
      this.#db.prepare('UPDATE accounts SET updated_at = ? WHERE id = ?').run(now, accountId);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Giải mã lấy access token. Trả về null khi tài khoản không tồn tại hoặc không có Token. */
  readAccessToken(accountId: string): { token: string; expiresAt: number | null } | null {
    const row = this.#tokenRow(accountId);
    if (row?.access_token_enc == null || row.access_nonce == null) return null;
    const sealed: SealedValue = {
      ciphertext: toBuffer(row.access_token_enc) as Buffer,
      nonce: toBuffer(row.access_nonce) as Buffer,
      keyVersion: row.key_version,
    };
    return {
      token: this.#cryptor.open(sealed, `account:${accountId}:access`),
      expiresAt: row.expires_at,
    };
  }

  readRefreshToken(accountId: string): string | null {
    const row = this.#tokenRow(accountId);
    if (row?.refresh_token_enc == null || row.refresh_nonce == null) return null;
    const sealed: SealedValue = {
      ciphertext: toBuffer(row.refresh_token_enc) as Buffer,
      nonce: toBuffer(row.refresh_nonce) as Buffer,
      keyVersion: row.key_version,
    };
    return this.#cryptor.open(sealed, `account:${accountId}:refresh`);
  }

  findById(id: string): AccountRow | undefined {
    return asRow<AccountRow>(this.#db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  findByTenantObject(tid: string, oid: string): AccountRow | undefined {
    return asRow<AccountRow>(
      this.#db.prepare('SELECT * FROM accounts WHERE tid = ? AND oid = ?').get(tid, oid),
    );
  }

  getView(id: string): AccountView | undefined {
    const account = this.findById(id);
    if (account === undefined) return undefined;
    const tokens = this.#tokenRow(id);
    const health = asRow<AccountHealthRow>(
      this.#db.prepare('SELECT * FROM account_health WHERE account_id = ?').get(id),
    );
    return {
      id: account.id,
      tid: account.tid,
      oid: account.oid,
      email: account.email,
      display_name: account.display_name,
      status: account.status,
      source: account.source,
      proxy_node_id: account.proxy_node_id,
      created_at: account.created_at,
      updated_at: account.updated_at,
      token_expires_at: tokens?.expires_at ?? null,
      token_rotated_at: tokens?.rotated_at ?? null,
      has_refresh_token: tokens?.refresh_token_enc != null,
      consecutive_failures: health?.consecutive_failures ?? 0,
      cooldown_until: health?.cooldown_until ?? null,
      last_ok_at: health?.last_ok_at ?? null,
      last_error_type: health?.last_error_type ?? null,
    };
  }

  listViews(): AccountView[] {
    const rows = asRows<AccountRow>(
      this.#db.prepare('SELECT id FROM accounts ORDER BY created_at ASC').all(),
    );
    return rows
      .map((row) => this.getView(row.id))
      .filter((view): view is AccountView => view !== undefined);
  }

  /** Chuyển đổi trạng thái tài khoản theo state machine; chuyển đổi phi pháp sẽ throw lỗi thay vì ghi âm thầm. */
  setStatus(accountId: string, next: AccountStatus, now = Date.now()): AccountView {
    const account = this.findById(accountId);
    if (account === undefined) throw new Error(`账号不存在：${accountId}`);
    if (!canTransition(account.status, next)) {
      throw new InvalidStateTransitionError(account.status, next);
    }
    this.#db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(next, now, accountId);
    this.#metrics?.accountStates.inc({ from: account.status, to: next });
    const view = this.getView(accountId);
    if (view === undefined) throw new Error('状态更新后读取失败');
    return view;
  }

  /** Ép đổi trạng thái, bỏ qua state machine. Chỉ dùng cho thao tác tường minh của admin, sẽ ghi log kiểm toán. */
  forceStatus(accountId: string, next: AccountStatus, now = Date.now()): AccountView | undefined {
    const before = this.findById(accountId);
    this.#db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(next, now, accountId);
    if (before !== undefined) this.#metrics?.accountStates.inc({ from: before.status, to: next });
    return this.getView(accountId);
  }

  recordSuccess(accountId: string, now = Date.now()): void {
    this.#db
      .prepare(
        `UPDATE account_health SET
           last_ok_at = ?, consecutive_failures = 0, cooldown_until = NULL,
           last_error_type = NULL, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(now, now, accountId);
  }

  recordFailure(
    accountId: string,
    errorType: string,
    options: { cooldownUntil?: number | null } = {},
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `UPDATE account_health SET
           last_error_at = ?, last_error_type = ?,
           consecutive_failures = consecutive_failures + 1,
           cooldown_until = ?, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(now, errorType, options.cooldownUntil ?? null, now, accountId);
  }

  /** Gắn/hủy gắn proxy đầu ra (hợp đồng §2.4 `POST /admin/accounts/:id/proxy`); truyền null để hủy gắn. */
  setProxyNode(accountId: string, proxyNodeId: string | null, now = Date.now()): AccountView | undefined {
    this.#db
      .prepare('UPDATE accounts SET proxy_node_id = ?, updated_at = ? WHERE id = ?')
      .run(proxyNodeId, now, accountId);
    return this.getView(accountId);
  }

  /**
   * Xóa tài khoản.
   *
   * `account_tokens` và `account_health` có cấu hình ON DELETE CASCADE nên sẽ tự động bị xóa theo;
   * Tuy nhiên `responses.account_id` và `conversation_bindings.account_id` chỉ là foreign key thông thường,
   * một khi tài khoản đã từng phục vụ request thì sẽ gắn chặt trong DB — lệnh DELETE trực tiếp sẽ đụng FOREIGN KEY constraint.
   *
   * Cách xử lý ở 2 bảng khác nhau do ngữ nghĩa khác nhau:
   * - `responses` là lịch sử request, **được giữ lại**, chỉ gán account_id thành null (request này thực sự đã diễn ra,
   *   chỉ là không còn biết tài khoản nào đảm nhận; cột này vốn đã nullable);
   * - `conversation_bindings` là liên kết dính "Response ↔ Tài khoản ↔ Phiên upstream",
   *   khi tài khoản mất đi thì liên kết này không còn ý nghĩa, **xóa trực tiếp**, tránh để lại dòng ma trỏ tới tài khoản rỗng.
   */
  remove(accountId: string): boolean {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM conversation_bindings WHERE account_id = ?').run(accountId);
      this.#db.prepare('UPDATE responses SET account_id = NULL WHERE account_id = ?').run(accountId);
      const changes = Number(
        this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId).changes,
      );
      this.#db.exec('COMMIT');
      return changes > 0;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #tokenRow(accountId: string): AccountTokenRow | undefined {
    return asRow<AccountTokenRow>(
      this.#db.prepare('SELECT * FROM account_tokens WHERE account_id = ?').get(accountId),
    );
  }
}
