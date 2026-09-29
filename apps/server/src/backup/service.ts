import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ApiError } from '@m365-codex/shared';
import type { Database } from '../db/index.js';
import { DB_FILE_NAME, LATEST_SCHEMA_VERSION } from '../db/index.js';
import { packArchive, unpackArchive, type ArchiveEntry } from './archive.js';

/**
 * Sao lưu và khôi phục (tương ứng với Kế hoạch thực hiện §15.4).
 *
 * Gói sao lưu là một file tar.gz tiêu chuẩn, bao gồm:
 *   manifest.json   —— Phiên bản, schema version, phiên bản khóa chính, thời gian tạo, danh mục nội dung
 *   db.sqlite       —— Bản snapshot nhất quán được tạo bằng `VACUUM INTO` (không phải sao chép trực tiếp file DB đang ghi)
 *   files/<id>/…    —— Nội dung gốc của các tệp đã upload (tùy chọn)
 *
 * **Khóa chính không nằm trong gói sao lưu**: Token trong cơ sở dữ liệu vẫn là bản mã AES-256-GCM, khi chuyển sang máy khác khôi phục
 * bắt buộc phải cung cấp cùng một `M365_CODEX_MASTER_KEY` mới giải mã được. manifest chỉ ghi lại **số phiên bản** của khóa
 * để kiểm tra tính tương thích, tuyệt đối không ghi bản thân khóa. Nhờ vậy việc lộ gói sao lưu không đồng nghĩa với lộ Token.
 */

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  format_version: number;
  app_version: string;
  schema_version: number;
  master_key_version: number;
  created_at: number;
  includes_files: boolean;
  file_count: number;
}

export interface BackupResult {
  archive: Buffer;
  manifest: BackupManifest;
}

export interface BackupDeps {
  db: Database;
  dataDir: string;
  appVersion: string;
  masterKeyVersion: number;
}

/** Liệt kê tất cả các tệp thông thường trong thư mục files, trả về đường dẫn tương đối trong file lưu trữ. */
function listFiles(root: string): { archivePath: string; absolute: string }[] {
  if (!existsSync(root)) return [];
  const out: { archivePath: string; absolute: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, absolute).split(sep).join('/');
      out.push({ archivePath: `files/${rel}`, absolute });
    }
  };
  walk(root);
  return out;
}

export class BackupService {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  /**
   * Tạo gói sao lưu.
   * Cơ sở dữ liệu dùng VACUUM INTO để xuất ra snapshot nhất quán — đọc trực tiếp file CSDL đang ghi có thể gặp trạng thái rách dữ liệu (torn read).
   */
  create(options: { includeFiles?: boolean } = {}, now = Date.now()): BackupResult {
    const includeFiles = options.includeFiles ?? true;
    const { dataDir } = this.#deps;

    const tmpDir = join(dataDir, 'backup-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const snapshotPath = join(tmpDir, `snapshot-${now}.sqlite`);
    rmSync(snapshotPath, { force: true });

    try {
      // Đường dẫn của VACUUM INTO cần escape dấu nháy đơn, dù ở đây là đường dẫn tự sinh vẫn không bỏ bước này
      this.#deps.db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      const dbSnapshot = readFileSync(snapshotPath);

      const files = includeFiles ? listFiles(join(dataDir, 'files')) : [];
      const manifest: BackupManifest = {
        format_version: BACKUP_FORMAT_VERSION,
        app_version: this.#deps.appVersion,
        schema_version: LATEST_SCHEMA_VERSION,
        master_key_version: this.#deps.masterKeyVersion,
        created_at: now,
        includes_files: includeFiles,
        file_count: files.length,
      };

      const entries: ArchiveEntry[] = [
        { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
        { path: 'db.sqlite', content: dbSnapshot },
        ...files.map((f) => ({ path: f.archivePath, content: readFileSync(f.absolute) })),
      ];

      return { archive: packArchive(entries, now), manifest };
    } finally {
      rmSync(snapshotPath, { force: true });
    }
  }

  /**
   * Xác thực gói sao lưu và ghi nội dung vào thư mục đích.
   *
   * Khôi phục theo cơ chế **ghi đè thay thế**, và chỉ có hiệu lực sau khi server khởi động lại — tiến trình đang chạy giữ kết nối tới DB cũ.
   * Vì vậy ở đây chỉ chịu trách nhiệm ghi đĩa và kiểm tra hợp lệ, việc restart do bên gọi (API admin) thông báo cho quản trị viên thực hiện.
   */
  restore(archive: Buffer, now = Date.now()): BackupManifest {
    let entries: ArchiveEntry[];
    try {
      entries = unpackArchive(archive);
    } catch (error) {
      // gzip/tar parse thất bại (ví dụ upload file linh tinh) là lỗi input người dùng, không phải lỗi server,
      // không được để thành 500 — nếu không bên gọi không phân biệt được là do mình gửi sai hay server hỏng
      throw ApiError.badRequest(
        `备份包无法解析（不是合法的 tar.gz）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const manifestEntry = entries.find((e) => e.path === 'manifest.json');
    if (manifestEntry === undefined) {
      throw ApiError.badRequest('备份包缺少 manifest.json，不是本项目生成的备份');
    }

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(manifestEntry.content.toString('utf8')) as BackupManifest;
    } catch {
      throw ApiError.badRequest('备份包的 manifest.json 无法解析');
    }

    if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
      throw ApiError.badRequest(
        `备份包格式版本为 ${manifest.format_version}，当前只支持 ${BACKUP_FORMAT_VERSION}`,
      );
    }
    if (manifest.schema_version > LATEST_SCHEMA_VERSION) {
      // Sao lưu từ phiên bản mới hơn có thể chứa cấu trúc bảng phiên bản này không nhận biết, khôi phục cũng không chạy được
      throw ApiError.badRequest(
        `备份包的数据库结构版本（v${manifest.schema_version}）高于当前程序支持的 v${LATEST_SCHEMA_VERSION}，请先升级程序再恢复`,
      );
    }
    if (manifest.master_key_version !== this.#deps.masterKeyVersion) {
      throw ApiError.badRequest(
        `备份包用的是主密钥版本 v${manifest.master_key_version}，当前是 v${this.#deps.masterKeyVersion}；` +
          '恢复后 Token 将无法解密，请先切回对应版本的主密钥',
      );
    }

    const dbEntry = entries.find((e) => e.path === 'db.sqlite');
    if (dbEntry === undefined) {
      throw ApiError.badRequest('备份包缺少数据库快照');
    }

    const { dataDir } = this.#deps;
    mkdirSync(dataDir, { recursive: true });

    // Đổi tên DB cũ để lưu dự phòng, khi khôi phục có sự cố vẫn có thể tìm lại thủ công
    const dbPath = join(dataDir, DB_FILE_NAME);
    if (existsSync(dbPath)) {
      writeFileSync(`${dbPath}.replaced-${now}`, readFileSync(dbPath));
    }
    writeFileSync(dbPath, dbEntry.content);

    // Thay thế toàn bộ nội dung files: không giữ lại các tệp không có trong bản backup, tránh tình trạng file mồ côi
    const filesRoot = join(dataDir, 'files');
    if (manifest.includes_files) {
      rmSync(filesRoot, { recursive: true, force: true });
      for (const entry of entries) {
        if (!entry.path.startsWith('files/')) continue;
        const target = join(filesRoot, ...entry.path.slice('files/'.length).split('/'));
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, entry.content);
      }
    }

    return manifest;
  }

  /** Tổng quan mức chiếm dụng dữ liệu, dùng để hiển thị trên trang quản trị. */
  usage(): { dbBytes: number; filesBytes: number; fileCount: number } {
    const dbPath = join(this.#deps.dataDir, DB_FILE_NAME);
    const dbBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
    const files = listFiles(join(this.#deps.dataDir, 'files'));
    const filesBytes = files.reduce((sum, f) => sum + statSync(f.absolute).size, 0);
    return { dbBytes, filesBytes, fileCount: files.length };
  }
}
