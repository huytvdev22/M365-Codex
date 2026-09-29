import { randomUUID } from 'node:crypto';
import { asRows, type Database } from '../db/index.js';

/**
 * Nhật ký kiểm toán: ghi lại "ai đã làm gì vào lúc nào".
 * detail chỉ cho phép ghi tóm tắt có cấu trúc không nhạy cảm, nghiêm cấm ghi Token, mật khẩu, API Key dạng văn bản rõ.
 */

export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  client_ip: string | null;
  created_at: number;
}

export interface AuditEvent {
  actor: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  clientIp?: string | null;
}

export class AuditLogRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  record(event: AuditEvent, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO audit_logs (id, actor, action, target, detail, client_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        event.actor,
        event.action,
        event.target ?? null,
        event.detail == null ? null : JSON.stringify(event.detail),
        event.clientIp ?? null,
        now,
      );
  }

  recent(limit = 100): AuditLogRow[] {
    return asRows<AuditLogRow>(
      this.#db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit),
    );
  }

  /** Dọn dẹp nhật ký kiểm toán cũ hơn mốc cutoff (tương ứng dọn dẹp định kỳ trong kế hoạch triển khai §18). */
  purgeOlderThan(cutoff: number): number {
    const result = this.#db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
    return Number(result.changes);
  }
}
