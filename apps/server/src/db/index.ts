import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations.js';

export { LATEST_SCHEMA_VERSION, MIGRATIONS };
export type { Migration };

/** Bí danh kiểu con trỏ SQLite, thuận tiện thay thế triển khai sau này. */
export type Database = DatabaseSync;

export const DB_FILE_NAME = 'm365-codex.sqlite';

export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

/** Suy ra đường dẫn file cơ sở dữ liệu từ thư mục dữ liệu. `:memory:` được truyền thẳng, dùng cho test. */
export function resolveDatabasePath(dataDir: string): string {
  return dataDir === ':memory:' ? ':memory:' : join(dataDir, DB_FILE_NAME);
}

/**
 * Mở cơ sở dữ liệu và thiết lập các pragma như WAL.
 * Tự động tạo thư mục nếu chưa tồn tại, tránh lỗi khởi động khi container mount volume rỗng lần đầu.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

/** Phiên bản migration cao nhất đã áp dụng hiện tại; trả về 0 khi chưa khởi tạo. */
export function currentSchemaVersion(db: Database): number {
  ensureMigrationTable(db);
  const result = asRow<{ version: number | null }>(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
  );
  return result?.version ?? 0;
}

export interface MigrationResult {
  applied: number[];
  schemaVersion: number;
}

/**
 * Thực thi các migration chưa được áp dụng theo thứ tự phiên bản, được bao bọc trong một transaction.
 * Bất kỳ câu lệnh nào thất bại sẽ rollback toàn bộ, không để lại schema dở dang.
 */
export function runMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  ensureMigrationTable(db);
  const startVersion = currentSchemaVersion(db);
  const pending = [...migrations]
    .filter((migration) => migration.version > startVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { applied: [], schemaVersion: startVersion };
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new DatabaseError(`数据库迁移失败，已回滚到 v${startVersion}`, { cause: error });
  }

  return {
    applied: pending.map((migration) => migration.version),
    schemaVersion: currentSchemaVersion(db),
  };
}

/**
 * node:sqlite trả về `Record<string, SQLOutputValue>`, không chồng chéo cấu trúc với row type của nghiệp vụ,
 * ép kiểu trực tiếp sẽ bị TS từ chối. Hai helper này tập trung chuyển đổi "kết quả truy vấn → row type" về một nơi,
 * tránh rải rác `as unknown as` trong các repo.
 */
export function asRows<T>(result: unknown): T[] {
  return result as T[];
}

export function asRow<T>(result: unknown): T | undefined {
  return result as T | undefined;
}

/** Kiểm tra cơ sở dữ liệu có thể ghi hay không: readyz dùng nó để phát hiện lỗi triển khai như mount read-only. */
export function checkWritable(db: Database): { ok: boolean; detail: string } {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _write_probe (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM _write_probe');
    return { ok: true, detail: 'Cơ sở dữ liệu có thể ghi' };
  } catch (error) {
    return { ok: false, detail: `Cơ sở dữ liệu không thể ghi: ${(error as Error).message}` };
  }
}
