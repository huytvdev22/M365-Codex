import { Buffer } from 'node:buffer';
import type { Cryptor } from '../crypto/index.js';
import { asRow, type Database } from '../db/index.js';

/**
 * Phiên ủy quyền PKCE.
 *
 * Ba đảm bảo cứng:
 * 1. code_verifier được lưu trữ mã hóa (nó có thể đổi ra Token, thuộc về thông tin xác thực);
 * 2. Phiên hết hạn sau 10 phút;
 * 3. Mã ủy quyền chỉ có thể tiêu thụ một lần — thực hiện bằng UPDATE với điều kiện `consumed_at IS NULL`,
 *    khi gửi đồng thời cùng một state chỉ có một yêu cầu lấy được phiên.
 */

export const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

export interface OAuthSessionRow {
  state: string;
  code_verifier_enc: Uint8Array;
  code_verifier_nonce: Uint8Array;
  key_version: number;
  redirect_uri: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface CreateOAuthSessionInput {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: readonly string[];
}

export type ConsumeResult =
  | { ok: true; codeVerifier: string; redirectUri: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_consumed' };

export class OAuthSessionRepository {
  readonly #db: Database;
  readonly #cryptor: Cryptor;

  constructor(db: Database, cryptor: Cryptor) {
    this.#db = db;
    this.#cryptor = cryptor;
  }

  create(input: CreateOAuthSessionInput, now = Date.now(), ttlMs = OAUTH_SESSION_TTL_MS): OAuthSessionRow {
    const sealed = this.#cryptor.seal(input.codeVerifier, `oauth:${input.state}`);
    this.#db
      .prepare(
        `INSERT INTO oauth_sessions (
           state, code_verifier_enc, code_verifier_nonce, key_version,
           redirect_uri, scopes, created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.state,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyVersion,
        input.redirectUri,
        JSON.stringify(input.scopes),
        now,
        now + ttlMs,
      );
    const row = this.find(input.state);
    if (row === undefined) throw new Error('授权会话写入后立即读取失败');
    return row;
  }

  find(state: string): OAuthSessionRow | undefined {
    return asRow<OAuthSessionRow>(
      this.#db.prepare('SELECT * FROM oauth_sessions WHERE state = ?').get(state),
    );
  }

  /**
   * Tiêu thụ nguyên tử: chỉ lần gọi nào đổi thành công consumed_at từ NULL sang timestamp mới thành công.
   * Khi phát lại đồng thời cùng một mã ủy quyền, người đến sau sẽ nhận được `already_consumed`.
   */
  consume(state: string, now = Date.now()): ConsumeResult {
    const row = this.find(state);
    if (row === undefined) return { ok: false, reason: 'not_found' };
    if (row.consumed_at !== null) return { ok: false, reason: 'already_consumed' };
    if (row.expires_at <= now) return { ok: false, reason: 'expired' };

    const result = this.#db
      .prepare('UPDATE oauth_sessions SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL')
      .run(now, state);
    if (Number(result.changes) === 0) {
      return { ok: false, reason: 'already_consumed' };
    }

    const codeVerifier = this.#cryptor.open(
      {
        ciphertext: Buffer.from(row.code_verifier_enc),
        nonce: Buffer.from(row.code_verifier_nonce),
        keyVersion: row.key_version,
      },
      `oauth:${state}`,
    );
    return { ok: true, codeVerifier, redirectUri: row.redirect_uri };
  }

  /** Dọn dẹp các phiên hết hạn và đã tiêu thụ, tránh việc bản mã code_verifier lưu lại lâu dài. */
  purge(now = Date.now(), consumedRetentionMs = 60 * 60 * 1000): number {
    const expired = this.#db.prepare('DELETE FROM oauth_sessions WHERE expires_at <= ?').run(now);
    const consumed = this.#db
      .prepare('DELETE FROM oauth_sessions WHERE consumed_at IS NOT NULL AND consumed_at <= ?')
      .run(now - consumedRetentionMs);
    return Number(expired.changes) + Number(consumed.changes);
  }

  countPending(now = Date.now()): number {
    const row = asRow<{ count: number }>(
      this.#db
        .prepare('SELECT COUNT(*) AS count FROM oauth_sessions WHERE consumed_at IS NULL AND expires_at > ?')
        .get(now),
    );
    return row?.count ?? 0;
  }
}
