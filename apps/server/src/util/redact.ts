/** Công cụ che giấu thông tin nhạy cảm (redact): Che mờ các trường nhạy cảm khi ghi log / kiểm toán. */

/** Che giấu email: Giữ lại 2 ký tự đầu và tên miền, phần còn lại che bằng dấu sao, ví dụ `fo***@example.com`. */
export function maskEmail(email: string | null | undefined): string {
  if (email == null || email === '') return '(无邮箱)';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}
