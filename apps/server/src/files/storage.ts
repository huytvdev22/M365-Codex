import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lưu trữ tệp trên đĩa (tương ứng với Kế hoạch thực hiện §11: "Tên tệp không được trực tiếp làm đường dẫn đĩa").
 *
 * Bố cục:
 *   <DATA_DIR>/files/<file-id>/content              —— Nội dung tệp đã hoàn thành
 *   <DATA_DIR>/files/uploads/<upload-id>/<part-id>  —— Từng mảnh của upload phân đoạn
 *
 * Tên thư mục luôn dùng id (UUID) do hệ thống sinh ra, tên tệp gốc chỉ lưu vào CSDL, tuyệt đối không ghép vào đường dẫn,
 * tránh lỗ hổng Path Traversal (`../`) và vấn đề ký tự tên tệp không hợp lệ.
 */
export class FileStorage {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'files');
  }

  #fileDir(fileId: string): string {
    return join(this.#root, fileId);
  }

  #uploadDir(uploadId: string): string {
    return join(this.#root, 'uploads', uploadId);
  }

  writeFileContent(fileId: string, content: Buffer): void {
    const dir = this.#fileDir(fileId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'content'), content);
  }

  readFileContent(fileId: string): Buffer {
    return readFileSync(join(this.#fileDir(fileId), 'content'));
  }

  deleteFile(fileId: string): void {
    rmSync(this.#fileDir(fileId), { recursive: true, force: true });
  }

  writeUploadPart(uploadId: string, partId: string, content: Buffer): void {
    const dir = this.#uploadDir(uploadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, partId), content);
  }

  readUploadPart(uploadId: string, partId: string): Buffer {
    return readFileSync(join(this.#uploadDir(uploadId), partId));
  }

  deleteUpload(uploadId: string): void {
    rmSync(this.#uploadDir(uploadId), { recursive: true, force: true });
  }
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
