import type { FileRepository, UploadRepository } from '../repo/files.js';
import type { FileStorage } from './storage.js';

/**
 * Dọn dẹp tệp hết hạn và các Upload chưa hoàn thành (tương ứng với Kế hoạch thực hiện §11:
 * "Tự động dọn dẹp Upload chưa hoàn tất, tệp hết hạn").
 *
 * M6 triển khai logic dọn dẹp thành hàm thuần có thể gọi độc lập và unit test; việc đăng ký timer để lại cho M7 —
 * tránh việc khi chưa có WebUI/bảng quản trị xem lịch sử thực thi đã ngầm chạy một background task không ai biết đến.
 */

export interface CleanupDeps {
  files: FileRepository;
  uploads: UploadRepository;
  storage: FileStorage;
}

export interface CleanupResult {
  expiredFiles: number;
  expiredUploads: number;
}

/** Dọn dẹp tệp đã quá hạn lưu trữ nhưng chưa xóa: Xóa mềm dòng trong CSDL + xóa nội dung trên đĩa. */
export function cleanupExpiredFiles(deps: CleanupDeps, now = Date.now()): number {
  const expired = deps.files.findExpired(now);
  for (const file of expired) {
    const deleted = deps.files.softDelete(file.id, file.api_key_id, now);
    // softDelete có tính idempotency: chỉ khi thực sự có hiệu lực (chưa bị dọn dẹp đồng thời) mới xóa đĩa,
    // tránh các tác vụ cleanup đồng thời xóa lặp cùng một file.
    if (deleted) deps.storage.deleteFile(file.id);
  }
  return expired.length;
}

/** Dọn dẹp Upload đã hết hạn nhưng vẫn ở trạng thái pending: Đánh dấu expired + xóa các mảnh đã nhận. */
export function cleanupExpiredUploads(deps: CleanupDeps, now = Date.now()): number {
  const expired = deps.uploads.findExpiredPending(now);
  for (const upload of expired) {
    deps.uploads.markExpired(upload.id);
    deps.storage.deleteUpload(upload.id);
  }
  return expired.length;
}

/** Chạy một lần cả 2 loại dọn dẹp, dùng cho timer ở M7 hoặc quản trị viên kích hoạt thủ công. */
export function runFilesCleanup(deps: CleanupDeps, now = Date.now()): CleanupResult {
  return {
    expiredFiles: cleanupExpiredFiles(deps, now),
    expiredUploads: cleanupExpiredUploads(deps, now),
  };
}

export interface CleanupWithBytesResult extends CleanupResult {
  /** Số byte tệp được giải phóng trong lần dọn dẹp này (dùng cho `POST /admin/files/cleanup`, Hợp đồng §2.6) */
  freedBytes: number;
}

/**
 * Dành cho nút "Dọn dẹp ngay" ở phía quản trị: Cùng logic với `runFilesCleanup`,
 * thống kê thêm số byte được giải phóng (đọc kích thước các file sắp xóa trước khi dọn).
 */
export function runFilesCleanupWithBytes(deps: CleanupDeps, now = Date.now()): CleanupWithBytesResult {
  const expiredFiles = deps.files.findExpired(now);
  const freedBytes = expiredFiles.reduce((sum, file) => sum + file.bytes, 0);
  let deletedCount = 0;
  for (const file of expiredFiles) {
    const deleted = deps.files.softDelete(file.id, file.api_key_id, now);
    if (deleted) {
      deps.storage.deleteFile(file.id);
      deletedCount += 1;
    }
  }
  return {
    expiredFiles: deletedCount,
    expiredUploads: cleanupExpiredUploads(deps, now),
    freedBytes,
  };
}
