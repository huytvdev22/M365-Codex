import { Buffer } from 'node:buffer';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Băm mật khẩu phía quản trị (scrypt).
 *
 * Mật khẩu quản trị được lấy từ biến môi trường, server không lưu trữ plain text; hash tại đây dùng để xác thực đăng nhập,
 * mỗi lần tiến trình khởi động sẽ được phái sinh lại dựa trên biến môi trường, tránh việc plain text lưu lại lâu dài trong logic so sánh.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (saltB64 === undefined || hashB64 === undefined) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.byteLength === 0 || expected.byteLength === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.byteLength, { N: n, r, p });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
