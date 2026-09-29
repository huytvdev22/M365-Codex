import { asRow, asRows, type Database } from '../db/index.js';

/**
 * Truy xuất key-value nguyên bản cho các mục cài đặt (tương ứng kế hoạch triển khai §M7, hợp đồng §2.3).
 *
 * Chỉ làm đọc ghi KV cơ bản nhất; việc phân nhóm, ngữ nghĩa `source`/`editable`/`requires_restart`
 * do tầng trên `settings/service.ts` đảm nhận, ở đây giữ sự thuần túy để dễ dàng unit test.
 */

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export class SettingsRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(key: string): SettingRow | undefined {
    return asRow<SettingRow>(this.#db.prepare('SELECT * FROM settings WHERE key = ?').get(key));
  }

  getAll(): SettingRow[] {
    return asRows<SettingRow>(this.#db.prepare('SELECT * FROM settings ORDER BY key ASC').all());
  }

  /** Lưu giá trị đã mã hóa JSON, bên gọi chịu trách nhiệm serialize/deserialize. */
  set(key: string, jsonValue: string, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, jsonValue, now);
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
