import { randomUUID } from 'node:crypto';
import { asRow, asRows, type Database } from '../db/index.js';
import type { FileKind, FileStatus, UploadStatus } from '../files/types.js';

/**
 * Tầng truy cập dữ liệu cho File / Upload phân đoạn (tương ứng kế hoạch triển khai §11, §M6).
 *
 * Quy tắc sở hữu: Mọi truy vấn đều yêu cầu bên gọi kèm theo `apiKeyId` để lọc — một API Key chỉ có thể nhìn thấy,
 * đọc được, xóa được file do chính nó tạo ra, danh sách cũng không ngoại lệ (không chỉ không đọc được nội dung mà ngay cả sự tồn tại cũng không thấy).
 */

export interface FileRow {
  id: string;
  api_key_id: string;
  filename: string;
  purpose: string;
  mime_type: string;
  kind: FileKind;
  bytes: number;
  sha256: string;
  status: FileStatus;
  extracted_text: string | null;
  extraction_note: string | null;
  created_at: number;
  expires_at: number | null;
  deleted_at: number | null;
}

export interface CreateFileInput {
  id: string;
  apiKeyId: string;
  filename: string;
  purpose: string;
  mimeType: string;
  kind: FileKind;
  bytes: number;
  sha256: string;
  status: FileStatus;
  extractedText: string | null;
  extractionNote: string | null;
  expiresAt: number | null;
}

export class FileRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateFileInput, now = Date.now()): FileRow {
    this.#db
      .prepare(
        `INSERT INTO files (
           id, api_key_id, filename, purpose, mime_type, kind, bytes, sha256,
           status, extracted_text, extraction_note, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.apiKeyId,
        input.filename,
        input.purpose,
        input.mimeType,
        input.kind,
        input.bytes,
        input.sha256,
        input.status,
        input.extractedText,
        input.extractionNote,
        now,
        input.expiresAt,
      );
    const row = this.findById(input.id);
    if (row === undefined) throw new Error('文件创建后立即读取失败');
    return row;
  }

  findById(id: string): FileRow | undefined {
    return asRow<FileRow>(this.#db.prepare('SELECT * FROM files WHERE id = ?').get(id));
  }

  /** Tìm một file "chưa bị xóa", và bắt buộc thuộc về Key chỉ định; nếu không xem như không tồn tại (không để lộ tính tồn tại). */
  findOwnedActive(id: string, apiKeyId: string): FileRow | undefined {
    return asRow<FileRow>(
      this.#db
        .prepare('SELECT * FROM files WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL')
        .get(id, apiKeyId),
    );
  }

  listByApiKey(apiKeyId: string, purpose?: string | null): FileRow[] {
    if (purpose !== undefined && purpose !== null) {
      return asRows<FileRow>(
        this.#db
          .prepare(
            'SELECT * FROM files WHERE api_key_id = ? AND purpose = ? AND deleted_at IS NULL ORDER BY created_at DESC',
          )
          .all(apiKeyId, purpose),
      );
    }
    return asRows<FileRow>(
      this.#db
        .prepare('SELECT * FROM files WHERE api_key_id = ? AND deleted_at IS NULL ORDER BY created_at DESC')
        .all(apiKeyId),
    );
  }

  /** Số byte lưu trữ hiện tại mà Key này chiếm dụng (chưa xóa, chưa hết hạn). */
  sumActiveBytes(apiKeyId: string, now = Date.now()): number {
    const row = asRow<{ total: number | null }>(
      this.#db
        .prepare(
          `SELECT SUM(bytes) AS total FROM files
           WHERE api_key_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(apiKeyId, now),
    );
    return row?.total ?? 0;
  }

  /** Xóa mềm: giữ lại hàng phục vụ kiểm toán, nhưng cả nội dung và metadata đều không còn hiển thị ra ngoài nữa. */
  softDelete(id: string, apiKeyId: string, now = Date.now()): boolean {
    const result = this.#db
      .prepare('UPDATE files SET deleted_at = ? WHERE id = ? AND api_key_id = ? AND deleted_at IS NULL')
      .run(now, id, apiKeyId);
    return Number(result.changes) > 0;
  }

  /** Tìm các file đã hết hạn nhưng chưa được dọn dẹp (dành cho tác vụ dọn dẹp sử dụng, không phân biệt API Key). */
  findExpired(now = Date.now()): FileRow[] {
    return asRows<FileRow>(
      this.#db
        .prepare('SELECT * FROM files WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?')
        .all(now),
    );
  }

  /** Danh sách file theo góc nhìn quản trị (hợp đồng §2.6), tùy chọn lọc theo API Key, có thể nhìn thấy xuyên suốt các Key. */
  listForAdmin(filters: { limit: number; apiKeyId?: string }): { items: FileRow[]; totalBytes: number } {
    if (filters.apiKeyId !== undefined) {
      const items = asRows<FileRow>(
        this.#db
          .prepare(
            'SELECT * FROM files WHERE api_key_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
          )
          .all(filters.apiKeyId, filters.limit),
      );
      const totalBytes = this.sumActiveBytes(filters.apiKeyId);
      return { items, totalBytes };
    }
    const items = asRows<FileRow>(
      this.#db.prepare('SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(
        filters.limit,
      ),
    );
    const totalRow = asRow<{ total: number | null }>(
      this.#db.prepare('SELECT SUM(bytes) AS total FROM files WHERE deleted_at IS NULL').get(),
    );
    return { items, totalBytes: totalRow?.total ?? 0 };
  }

  /** Xóa từ phía quản trị: bỏ qua kiểm tra quyền sở hữu (hợp đồng §2.6 `DELETE /admin/files/:id`). */
  adminSoftDelete(id: string, now = Date.now()): FileRow | undefined {
    const existing = this.findById(id);
    if (existing === undefined || existing.deleted_at !== null) return undefined;
    this.#db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(now, id);
    return this.findById(id);
  }
}

export interface UploadRow {
  id: string;
  api_key_id: string;
  filename: string;
  purpose: string;
  mime_type: string;
  bytes: number;
  status: UploadStatus;
  file_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface CreateUploadInput {
  id: string;
  apiKeyId: string;
  filename: string;
  purpose: string;
  mimeType: string;
  bytes: number;
  expiresAt: number;
}

export interface UploadPartRow {
  id: string;
  upload_id: string;
  part_number: number;
  bytes: number;
  created_at: number;
}

export class UploadRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(input: CreateUploadInput, now = Date.now()): UploadRow {
    this.#db
      .prepare(
        `INSERT INTO uploads (id, api_key_id, filename, purpose, mime_type, bytes, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(input.id, input.apiKeyId, input.filename, input.purpose, input.mimeType, input.bytes, now, input.expiresAt);
    const row = this.findById(input.id);
    if (row === undefined) throw new Error('Upload 创建后立即读取失败');
    return row;
  }

  findById(id: string): UploadRow | undefined {
    return asRow<UploadRow>(this.#db.prepare('SELECT * FROM uploads WHERE id = ?').get(id));
  }

  findOwned(id: string, apiKeyId: string): UploadRow | undefined {
    return asRow<UploadRow>(
      this.#db.prepare('SELECT * FROM uploads WHERE id = ? AND api_key_id = ?').get(id, apiKeyId),
    );
  }

  /** Thêm một bản ghi phân đoạn; số thứ tự phân đoạn trùng lặp sẽ bị throw lỗi do ràng buộc UNIQUE, để bên gọi quyết định xử lý. */
  addPart(uploadId: string, bytes: number, now = Date.now()): UploadPartRow {
    const id = `part_${randomUUID().replaceAll('-', '')}`;
    const partNumber = this.#nextPartNumber(uploadId);
    this.#db
      .prepare(
        'INSERT INTO upload_parts (id, upload_id, part_number, bytes, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, uploadId, partNumber, bytes, now);
    const row = asRow<UploadPartRow>(
      this.#db.prepare('SELECT * FROM upload_parts WHERE id = ?').get(id),
    );
    if (row === undefined) throw new Error('分片创建后立即读取失败');
    return row;
  }

  #nextPartNumber(uploadId: string): number {
    const row = asRow<{ next: number }>(
      this.#db
        .prepare('SELECT COALESCE(MAX(part_number), 0) + 1 AS next FROM upload_parts WHERE upload_id = ?')
        .get(uploadId),
    );
    return row?.next ?? 1;
  }

  findPartById(id: string): UploadPartRow | undefined {
    return asRow<UploadPartRow>(this.#db.prepare('SELECT * FROM upload_parts WHERE id = ?').get(id));
  }

  listParts(uploadId: string): UploadPartRow[] {
    return asRows<UploadPartRow>(
      this.#db
        .prepare('SELECT * FROM upload_parts WHERE upload_id = ? ORDER BY part_number ASC')
        .all(uploadId),
    );
  }

  markCompleted(id: string, fileId: string): void {
    this.#db
      .prepare(
        "UPDATE uploads SET status = 'completed', file_id = ? WHERE id = ? AND status = 'pending'",
      )
      .run(fileId, id);
  }

  markCancelled(id: string): boolean {
    const result = this.#db
      .prepare("UPDATE uploads SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id);
    return Number(result.changes) > 0;
  }

  markExpired(id: string): void {
    this.#db.prepare("UPDATE uploads SET status = 'expired' WHERE id = ? AND status = 'pending'").run(id);
  }

  /** Tìm các Upload đã hết hạn nhưng vẫn ở trạng thái pending (dành cho tác vụ dọn dẹp sử dụng). */
  findExpiredPending(now = Date.now()): UploadRow[] {
    return asRows<UploadRow>(
      this.#db.prepare("SELECT * FROM uploads WHERE status = 'pending' AND expires_at < ?").all(now),
    );
  }
}
