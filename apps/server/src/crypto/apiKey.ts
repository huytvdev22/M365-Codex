import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  API_KEY_BODY_LENGTH,
  API_KEY_LOOKUP_PREFIX_LENGTH,
  API_KEY_PREFIX,
} from '@m365-codex/shared';

/**
 * Tạo và xác thực API Key đối ngoại (tương ứng với Kế hoạch thực hiện §1.3).
 *
 * - Dạng `sk-` + 52 ký tự Base62 (CSPRNG, rejection sampling đảm bảo phân phối đồng đều);
 * - Cơ sở dữ liệu chỉ lưu SHA-256(salt || key) và tiền tố dùng để lập chỉ mục, không lưu plain text;
 * - Plain text chỉ xuất hiện một lần duy nhất trong phản hồi của API tạo khóa.
 */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 256 % 62 = 8, các byte rơi vào khoảng [248, 255] sẽ gây lệch (bias), loại bỏ và rút lại. */
const REJECT_THRESHOLD = 248;
const SALT_BYTES = 16;

export interface GeneratedApiKey {
  /** Key dạng plain text, chỉ trả về cho người tạo một lần duy nhất */
  key: string;
  /** Tiền tố dùng để lập index trong cơ sở dữ liệu (`sk-` + 8 ký tự) */
  prefix: string;
  /** Muối ngẫu nhiên dạng thập lục phân (hex) */
  salt: string;
  /** Chuỗi SHA-256(salt || key) dạng hex */
  hash: string;
}

/** Tạo chuỗi Base62 ngẫu nhiên có phân phối đồng đều. */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const need = length - out.length;
    const buf = randomBytes(need * 2);
    for (const byte of buf) {
      if (byte >= REJECT_THRESHOLD) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function hashApiKey(key: string, salt: string): string {
  return createHash('sha256').update(salt, 'utf8').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBase62(API_KEY_BODY_LENGTH);
  const salt = randomBytes(SALT_BYTES).toString('hex');
  return {
    key,
    prefix: key.slice(0, API_KEY_LOOKUP_PREFIX_LENGTH),
    salt,
    hash: hashApiKey(key, salt),
  };
}

/** Kiểm tra hình thái: chỉ kiểm tra định dạng, không truy vấn cơ sở dữ liệu. */
export function isWellFormedApiKey(key: string): boolean {
  if (!key.startsWith(API_KEY_PREFIX)) return false;
  const body = key.slice(API_KEY_PREFIX.length);
  if (body.length < 48) return false;
  for (const ch of body) {
    if (!BASE62.includes(ch)) return false;
  }
  return true;
}

/** Suy ra tiền tố lập chỉ mục cơ sở dữ liệu từ Key dạng plain text. */
export function apiKeyLookupPrefix(key: string): string {
  return key.slice(0, API_KEY_LOOKUP_PREFIX_LENGTH);
}

/** So sánh thời gian hằng số (constant-time) giữa Key plain text và hash trong cơ sở dữ liệu. */
export function verifyApiKey(key: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(key, salt), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  if (expected.byteLength !== actual.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

/** Tạo chuỗi mặt nạ hiển thị trên giao diện người dùng, ví dụ `sk-Ab12Cd34……`. */
export function maskApiKey(prefix: string): string {
  return `${prefix}${'•'.repeat(8)}`;
}
