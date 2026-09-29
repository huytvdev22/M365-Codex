import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { MASTER_KEY_BYTES } from '@m365-codex/shared';

/**
 * Mã hóa cấp độ trường AES-256-GCM (tương ứng với Kế hoạch thực hiện §1.2).
 *
 * Điểm thiết kế chính:
 * - Mỗi trường nhạy cảm dùng một nonce ngẫu nhiên độc lập, tuyệt đối không tái sử dụng;
 * - Bản mã kèm theo thẻ xác thực (auth tag), mọi hành vi giả mạo đều thất bại khi giải mã;
 * - Ghi lại số phiên bản khóa, chừa không gian cho việc xoay vòng khóa chính sau này;
 * - Hỗ trợ liên kết AAD (ví dụ account ID), ngăn chặn việc chuyển bản mã của tài khoản A sang dòng của tài khoản B.
 */

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = MASTER_KEY_BYTES;

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
  }
}

/** Trường sau khi mã hóa: Cả 3 thành phần cần được lưu trữ cùng nhau. */
export interface SealedValue {
  /** Bản mã + 16 byte thẻ xác thực */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export class Cryptor {
  readonly #keys: Map<number, Buffer>;
  readonly #currentVersion: number;

  /**
   * @param currentKey Khóa chính hiện tại (32 byte)
   * @param currentVersion Số phiên bản khóa hiện tại
   * @param previousKeys Các khóa lịch sử, chỉ dùng để giải mã dữ liệu cũ
   */
  constructor(
    currentKey: Buffer,
    currentVersion = 1,
    previousKeys: ReadonlyMap<number, Buffer> = new Map(),
  ) {
    if (currentKey.byteLength !== KEY_BYTES) {
      throw new CryptoError(`主密钥必须为 ${KEY_BYTES} 字节，实际 ${currentKey.byteLength} 字节`);
    }
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new CryptoError('密钥版本号必须是 ≥1 的整数');
    }
    this.#keys = new Map(previousKeys);
    for (const [version, key] of this.#keys) {
      if (key.byteLength !== KEY_BYTES) {
        throw new CryptoError(`历史密钥 v${version} 长度非法`);
      }
    }
    this.#keys.set(currentVersion, currentKey);
    this.#currentVersion = currentVersion;
  }

  get keyVersion(): number {
    return this.#currentVersion;
  }

  /** Mã hóa bằng khóa hiện tại. `aad` dùng để liên kết bản mã với một bản ghi cụ thể. */
  seal(plaintext: string, aad?: string): SealedValue {
    const key = this.#requireKey(this.#currentVersion);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    if (aad !== undefined) {
      cipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: Buffer.concat([body, tag]), nonce, keyVersion: this.#currentVersion };
  }

  /** Giải mã. Bản mã bị giả mạo, nonce không khớp hoặc AAD không đồng nhất sẽ ném CryptoError. */
  open(sealed: SealedValue, aad?: string): string {
    if (sealed.nonce.byteLength !== NONCE_BYTES) {
      throw new CryptoError('nonce 长度非法');
    }
    if (sealed.ciphertext.byteLength < TAG_BYTES) {
      throw new CryptoError('密文长度不足，缺少认证标签');
    }
    const key = this.#requireKey(sealed.keyVersion);
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.byteLength - TAG_BYTES);
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.byteLength - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
    decipher.setAuthTag(tag);
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new CryptoError('解密失败：密文已被篡改，或密钥/AAD 不匹配', { cause: error });
    }
  }

  /** Bản mã này có đang dùng phiên bản khóa hiện tại không (dùng để xác định xem có cần mã hóa lại khi xoay vòng). */
  needsRotation(sealed: SealedValue): boolean {
    return sealed.keyVersion !== this.#currentVersion;
  }

  #requireKey(version: number): Buffer {
    const key = this.#keys.get(version);
    if (key === undefined) {
      throw new CryptoError(`缺少密钥版本 v${version}，无法解密该字段`);
    }
    return key;
  }
}

/** Tạo một khóa chính ngẫu nhiên mới (Base64), dùng cho khởi tạo vận hành. */
export function generateMasterKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** So sánh an toàn độ dài cố định, tránh kênh phụ về mặt thời gian do so sánh chuỗi. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) {
    // Chiều dài khác nhau cũng chạy so sánh một lần để giảm sự khác biệt về thời gian rò rỉ độ dài
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
