import type { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Quản lý gói sao lưu trên đĩa (tương ứng với Kế hoạch thực hiện §15.4, Hợp đồng §3).
 *
 * `BackupService` (`backup/service.ts`) chỉ quan tâm đến việc "tạo / xác thực / khôi phục một gói như thế nào",
 * không quan tâm "các gói này đặt ở đâu, tên là gì, khi nào nên xóa" — đó là trách nhiệm ở đây:
 * `<DATA_DIR>/backups/<id>.tar.gz`, `id` do class này sinh ra, không nhận input bên ngoài ghép vào đường dẫn,
 * loại trừ tận gốc lỗ hổng Path Traversal của `GET /admin/backup/:id/download`.
 */

export interface BackupFileInfo {
  id: string;
  bytes: number;
  created_at: number;
}

/** id chỉ có thể có dạng do class này sinh ra: `bkp_<timestamp_ms>_<8_ký_tự_hex>`. */
const ID_PATTERN = /^bkp_[0-9]+_[a-f0-9]{8}$/;

export function isValidBackupId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export class BackupStore {
  readonly #dir: string;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'backups');
  }

  get dir(): string {
    return this.#dir;
  }

  /** Sinh id mới và ghi xuống đĩa, trả về metadata của gói sao lưu đó. */
  save(content: Buffer, now = Date.now()): BackupFileInfo {
    mkdirSync(this.#dir, { recursive: true });
    const id = `bkp_${now}_${randomBytes(4).toString('hex')}`;
    writeFileSync(this.#path(id), content);
    return { id, bytes: content.byteLength, created_at: now };
  }

  /** Liệt kê toàn bộ các gói sao lưu theo thứ tự giảm dần thời gian tạo. */
  list(): BackupFileInfo[] {
    if (!existsSync(this.#dir)) return [];
    const items: BackupFileInfo[] = [];
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue;
      const id = entry.name.slice(0, -'.tar.gz'.length);
      if (!isValidBackupId(id)) continue; // Thư mục bị lẫn file khác, bỏ qua thay vì báo lỗi
      const stat = statSync(join(this.#dir, entry.name));
      items.push({ id, bytes: stat.size, created_at: stat.mtimeMs });
    }
    return items.sort((a, b) => b.created_at - a.created_at);
  }

  /** Đọc nội dung id chỉ định; id không hợp lệ hoặc file không tồn tại đều trả về undefined. */
  read(id: string): Buffer | undefined {
    if (!isValidBackupId(id)) return undefined;
    const path = this.#path(id);
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
  }

  delete(id: string): boolean {
    if (!isValidBackupId(id)) return false;
    const path = this.#path(id);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** Chỉ giữ lại retentionCount bản gần nhất, xóa các bản cũ hơn; trả về số lượng đã xóa (cho tác vụ cleanup). */
  prune(retentionCount: number): number {
    const items = this.list(); // Đã sắp xếp giảm dần theo thời gian
    const toDelete = items.slice(retentionCount);
    for (const item of toDelete) this.delete(item.id);
    return toDelete.length;
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.tar.gz`);
  }
}
