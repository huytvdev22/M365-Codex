import { randomUUID } from 'node:crypto';
import { ApiError } from '@m365-codex/shared';
import type { FilesConfig } from '../config/index.js';
import type { FileRepository, FileRow } from '../repo/files.js';
import { classifyFile } from './classify.js';
import { extractText } from './extract.js';
import type { FileStorage } from './storage.js';
import { sha256Hex } from './storage.js';

/**
 * Dịch vụ tệp: Kết nối chuỗi "Kiểm tra → Phân loại → Trích xuất → Ghi đĩa → Lưu CSDL" (tương ứng Kế hoạch §11, §M6).
 *
 * Quyền sở hữu và hạn ngạch được kiểm soát tập trung tại tầng này, các route và quy trình hoàn thành Uploads
 * đều tái sử dụng cùng một cổng vào, tránh việc viết 2 bộ quy tắc ở 2 nơi rồi dần dần trôi dạt khác nhau.
 */

export interface FilesServiceDeps {
  files: FileRepository;
  storage: FileStorage;
  config: FilesConfig;
}

export interface IngestFileParams {
  apiKeyId: string;
  filename: string;
  purpose: string;
  declaredMimeType: string | null;
  content: Buffer;
  /**
   * Giới hạn kích thước tệp đơn lẻ siết chặt theo API Key (§10.1), do bên gọi truyền vào bằng
   * `min(cài đặt của Key, trần toàn cục)` tính từ `gateway/auth.ts`;
   * nếu không truyền thì chỉ kiểm tra theo cấu hình toàn cục `files.maxFileBytes`, hành vi đồng nhất với trước.
   */
  maxFileBytesOverride?: number;
}

export class FilesService {
  readonly #deps: FilesServiceDeps;

  constructor(deps: FilesServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Kiểm tra kích thước tệp đơn lẻ, dùng cho route gọi ngay sau khi đọc nội dung multipart để từ chối sớm yêu cầu quá lớn.
   * `ceilingOverride` là giới hạn siết chặt theo API Key (§10.1, tính bằng `clampToCeiling` từ `gateway/auth.ts`,
   * không thể lỏng hơn cấu hình toàn cục), nếu không truyền chỉ kiểm tra theo `files.maxFileBytes`.
   */
  assertFileSize(bytes: number, ceilingOverride?: number): void {
    const limit =
      ceilingOverride === undefined
        ? this.#deps.config.maxFileBytes
        : Math.min(this.#deps.config.maxFileBytes, ceilingOverride);
    if (bytes > limit) {
      throw new ApiError({
        type: 'invalid_request_error',
        status: 413,
        message: `文件大小 ${bytes} 字节，超过单文件上限 ${limit} 字节`,
      });
    }
  }

  /** Kiểm tra hạn ngạch lưu trữ tích lũy: dung lượng đang chiếm + phần thêm mới lần này có vượt trần của Key không. */
  assertQuota(apiKeyId: string, additionalBytes: number): void {
    const used = this.#deps.files.sumActiveBytes(apiKeyId);
    const limit = this.#deps.config.maxTotalBytesPerKey;
    if (used + additionalBytes > limit) {
      throw new ApiError({
        type: 'invalid_request_error',
        status: 413,
        message: `该 API Key 累计存储已占用 ${used} 字节，本次 ${additionalBytes} 字节将超过上限 ${limit} 字节`,
      });
    }
  }

  /** Quy trình hoàn chỉnh: Kiểm tra, phân loại, trích xuất, ghi đĩa, lưu CSDL. */
  async ingest(params: IngestFileParams): Promise<FileRow> {
    this.assertFileSize(params.content.length, params.maxFileBytesOverride);
    this.assertQuota(params.apiKeyId, params.content.length);

    const { kind, trusted } = classifyFile(params.filename, params.declaredMimeType, params.content);
    const extraction = await extractText(params.content, kind, trusted);

    const fileId = `file_${randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    const expiresAt = this.#deps.config.retentionMs > 0 ? now + this.#deps.config.retentionMs : null;

    this.#deps.storage.writeFileContent(fileId, params.content);

    return this.#deps.files.create(
      {
        id: fileId,
        apiKeyId: params.apiKeyId,
        filename: params.filename,
        purpose: params.purpose,
        mimeType: params.declaredMimeType ?? 'application/octet-stream',
        kind,
        bytes: params.content.length,
        sha256: sha256Hex(params.content),
        status: extraction.ok || extraction.skipped ? 'processed' : 'error',
        extractedText: extraction.ok ? extraction.text : null,
        extractionNote: extraction.ok ? null : extraction.note,
        expiresAt,
      },
      now,
    );
  }

  list(apiKeyId: string, purpose?: string | null): FileRow[] {
    return this.#deps.files.listByApiKey(apiKeyId, purpose);
  }

  /** Tìm tệp thuộc về Key này; không tồn tại hoặc không thuộc Key đều trả về 404, không làm lộ sự tồn tại. */
  getOwned(fileId: string, apiKeyId: string): FileRow {
    const row = this.#deps.files.findOwnedActive(fileId, apiKeyId);
    if (row === undefined) throw ApiError.notFound('文件不存在');
    return row;
  }

  getContent(fileId: string, apiKeyId: string): { row: FileRow; content: Buffer } {
    const row = this.getOwned(fileId, apiKeyId);
    return { row, content: this.#deps.storage.readFileContent(fileId) };
  }

  delete(fileId: string, apiKeyId: string): void {
    const deleted = this.#deps.files.softDelete(fileId, apiKeyId);
    if (!deleted) throw ApiError.notFound('文件不存在');
    this.#deps.storage.deleteFile(fileId);
  }

  /**
   * Dành cho `input_file` của Responses: Lấy văn bản đã trích xuất theo file-id, bắt buộc phải thuộc
   * API Key khởi tạo request lần này — không cho phép tham chiếu tệp của người khác giữa các Key.
   * Trả về null biểu thị không tồn tại, không thuộc Key, hoặc không tạo ra văn bản khả dụng.
   */
  resolveOwnedText(fileId: string, apiKeyId: string): { filename: string; text: string } | null {
    const row = this.#deps.files.findOwnedActive(fileId, apiKeyId);
    if (row === undefined || row.extracted_text === null) return null;
    return { filename: row.filename, text: row.extracted_text };
  }

  /**
   * Dành cho `input_image` của Responses (khi `UPSTREAM_IMAGE_INPUT=true`):
   * Lấy nội dung gốc theo file-id và chuyển thành data URL. Chỉ chấp nhận tệp đã phân loại là image.
   */
  resolveOwnedImageDataUrl(fileId: string, apiKeyId: string): { dataUrl: string; filename: string } | null {
    const row = this.#deps.files.findOwnedActive(fileId, apiKeyId);
    if (row === undefined || row.kind !== 'image') return null;
    const content = this.#deps.storage.readFileContent(fileId);
    return { dataUrl: `data:${row.mime_type};base64,${content.toString('base64')}`, filename: row.filename };
  }
}
