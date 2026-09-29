import { Buffer } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backup/service.js';
import { packArchive, unpackArchive } from '../src/backup/archive.js';
import { DB_FILE_NAME, LATEST_SCHEMA_VERSION, openDatabase, runMigrations, type Database } from '../src/db/index.js';

/**
 * Sao lưu và phục hồi (§15.4). Điểm mấu chốt:
 * - Snapshot có tính nhất quán (VACUUM INTO), không phải copy trực tiếp DB đang ghi;
 * - **Khóa chính tuyệt đối không vào gói sao lưu**, chỉ ghi nhận số phiên bản để kiểm tra;
 * - Trước khi phục hồi kiểm tra phiên bản định dạng, phiên bản cấu trúc và phiên bản khóa chính, không khớp sẽ từ chối rõ ràng.
 */

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm365-backup-'));
  db = openDatabase(join(dir, DB_FILE_NAME));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function service(overrides: Partial<ConstructorParameters<typeof BackupService>[0]> = {}): BackupService {
  return new BackupService({
    db,
    dataDir: dir,
    appVersion: '9.9.9',
    masterKeyVersion: 1,
    ...overrides,
  });
}

function seedFile(id: string, content: string): void {
  mkdirSync(join(dir, 'files', id), { recursive: true });
  writeFileSync(join(dir, 'files', id, 'content'), content, 'utf8');
}

describe('生成备份', () => {
  it('包含 manifest、数据库快照与文件内容', () => {
    seedFile('file-a', '附件甲');
    const { archive, manifest } = service().create();
    const entries = unpackArchive(archive);
    const paths = entries.map((e) => e.path);

    expect(paths).toContain('manifest.json');
    expect(paths).toContain('db.sqlite');
    expect(paths).toContain('files/file-a/content');
    expect(manifest.schema_version).toBe(LATEST_SCHEMA_VERSION);
    expect(manifest.file_count).toBe(1);

    // Snapshot phải là SQLite có thể mở được (16 byte đầu là magic number SQLite)
    const snapshot = entries.find((e) => e.path === 'db.sqlite')?.content as Buffer;
    expect(snapshot.subarray(0, 15).toString('ascii')).toBe('SQLite format 3');
  });

  it('可以只备份数据库、不带文件', () => {
    seedFile('file-a', 'x');
    const { archive, manifest } = service().create({ includeFiles: false });
    expect(manifest.includes_files).toBe(false);
    expect(unpackArchive(archive).map((e) => e.path)).not.toContain('files/file-a/content');
  });

  it('备份包里没有主密钥，只有密钥版本号', () => {
    const secret = 'ZmFrZS1tYXN0ZXIta2V5LWZvci10ZXN0aW5nLW9ubHk=';
    const { archive, manifest } = service().create();
    const dump = unpackArchive(archive)
      .map((e) => e.content.toString('binary'))
      .join('');
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('M365_CODEX_MASTER_KEY');
    expect(manifest.master_key_version).toBe(1);
  });

  it('临时快照文件用完即删，不留在数据目录里', () => {
    service().create();
    const leftovers = existsSync(join(dir, 'backup-tmp')) ? readdirSync(join(dir, 'backup-tmp')) : [];
    expect(leftovers).toHaveLength(0);
  });
});

describe('恢复', () => {
  it('替换数据库与文件，旧库留底', () => {
    seedFile('file-a', '原始内容');
    const { archive } = service().create();

    // Phá hoại hiện trạng: Sửa file, thêm file mồ côi không có trong bản sao lưu
    writeFileSync(join(dir, 'files', 'file-a', 'content'), '被改坏了', 'utf8');
    seedFile('file-orphan', '孤儿');

    const manifest = service().restore(archive, 1_700_000_000_000);
    expect(manifest.file_count).toBe(1);
    expect(readFileSync(join(dir, 'files', 'file-a', 'content'), 'utf8')).toBe('原始内容');
    // File không có trong bản sao lưu không được giữ lại, tránh file mồ côi "DB không có nhưng đĩa vẫn còn"
    expect(existsSync(join(dir, 'files', 'file-orphan', 'content'))).toBe(false);
    // Giữ lại DB cũ làm bản lưu, khi phục hồi gặp sự cố vẫn có thể tìm lại thủ công
    expect(existsSync(join(dir, `${DB_FILE_NAME}.replaced-1700000000000`))).toBe(true);
  });

  it('不是本项目的包直接拒绝', () => {
    const bogus = gzipSync(Buffer.alloc(1024));
    expect(() => service().restore(bogus)).toThrow(/manifest|备份/);
  });

  it('主密钥版本不一致时拒绝，并说明原因', () => {
    const { archive } = service({ masterKeyVersion: 1 }).create();
    expect(() => service({ masterKeyVersion: 2 }).restore(archive)).toThrow(/主密钥版本/);
  });

  it('来自更高结构版本的备份拒绝恢复', () => {
    const { archive } = service().create();
    const entries = unpackArchive(archive);
    const manifest = JSON.parse(
      entries.find((e) => e.path === 'manifest.json')?.content.toString('utf8') as string,
    ) as Record<string, unknown>;
    manifest.schema_version = LATEST_SCHEMA_VERSION + 5;

    const tampered = packArchive(
      entries.map((e) =>
        e.path === 'manifest.json'
          ? { path: e.path, content: Buffer.from(JSON.stringify(manifest), 'utf8') }
          : e,
      ),
      Date.now(),
    );
    expect(() => service().restore(tampered)).toThrow(/高于当前程序支持/);
  });
});

describe('占用统计', () => {
  it('给出库大小与文件占用', () => {
    seedFile('f1', 'x'.repeat(100));
    seedFile('f2', 'y'.repeat(50));
    const usage = service().usage();
    expect(usage.fileCount).toBe(2);
    expect(usage.filesBytes).toBe(150);
    expect(usage.dbBytes).toBeGreaterThan(0);
  });
});
