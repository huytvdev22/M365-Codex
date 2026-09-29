/**
 * Các kiểu dữ liệu domain của hệ thống con tệp (tương ứng với Kế hoạch thực hiện §11, §M6).
 */

/** Loại nội dung: quyết định đi qua đường dẫn trích xuất văn bản nào, và có thể làm hình ảnh đầu vào hay không. */
export const FILE_KINDS = ['text', 'pdf', 'docx', 'xlsx', 'pptx', 'image', 'unknown'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Trạng thái xử lý của dòng file. unsupported_feature (như trích xuất PDF bị tắt do audit) quy về error và nêu rõ lý do. */
export const FILE_STATUSES = ['processed', 'error'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const UPLOAD_STATUSES = ['pending', 'completed', 'cancelled', 'expired'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** Kết quả trích xuất: thành công trả về text; chủ động bỏ qua (như ảnh/binary không rõ) trả về lý do; thất bại trả về nguyên nhân lỗi. */
export interface ExtractionResult {
  /** Có tạo ra văn bản khả dụng hay không */
  ok: boolean;
  text: string | null;
  /** Giải thích khi không tạo ra văn bản (lý do bỏ qua hoặc thất bại), dùng cho extraction_note của bảng files */
  note: string | null;
  /**
   * Khi ok=false phân biệt 2 tình huống: true=chủ động không trích xuất (bỏ qua theo chính sách, như ảnh/binary không rõ/
   * không đáng tin), không tính là lỗi; false=đáng lẽ trích xuất được nhưng thất bại (như PDF/Office hỏng,
   * khai là text nhưng nội dung không phải UTF-8 hợp lệ). Bảng files dựa vào đây để quyết định status là processed hay error.
   */
  skipped: boolean;
}

/** Đối tượng File đối ngoại (đồng bộ cách đặt tên trường với OpenAI Files API). */
export interface FileObject {
  id: string;
  object: 'file';
  bytes: number;
  /** Epoch tính bằng giây, đồng bộ với OpenAI */
  created_at: number;
  filename: string;
  purpose: string;
  status: FileStatus;
  status_details: string | null;
  /** Epoch tính bằng giây; null biểu thị không tự động hết hạn */
  expires_at: number | null;
}

/** Đối tượng Upload.Part đối ngoại. */
export interface UploadPartObject {
  id: string;
  object: 'upload.part';
  created_at: number;
  upload_id: string;
}

/** Đối tượng Upload đối ngoại. */
export interface UploadObject {
  id: string;
  object: 'upload';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: UploadStatus;
  expires_at: number;
  file: FileObject | null;
}
