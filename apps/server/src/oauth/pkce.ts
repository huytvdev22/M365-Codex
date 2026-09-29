import { createHash, randomBytes } from 'node:crypto';

/**
 * Sinh tham số PKCE (RFC 7636).
 *
 * Chỉ dùng S256, không hỗ trợ hạ cấp về plain — plain đồng nghĩa với không có bảo vệ.
 */

/** Mã hóa Base64URL, loại bỏ ký tự padding. */
export function base64Url(data: Buffer): string {
  return data.toString('base64url');
}

/** code_verifier: 48 byte số ngẫu nhiên sau khi encode thành 64 ký tự, nằm trong khoảng 43-128 theo yêu cầu của RFC. */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(48));
}

/** code_challenge = BASE64URL(SHA256(code_verifier)). */
export function deriveCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** state: chống CSRF, đồng thời làm khóa chính của phiên ủy quyền. */
export function generateState(): string {
  return base64Url(randomBytes(24));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

export function createPkcePair(): PkcePair {
  const verifier = generateCodeVerifier();
  return {
    verifier,
    challenge: deriveCodeChallenge(verifier),
    state: generateState(),
  };
}

/** Yêu cầu về bộ ký tự và độ dài của code_verifier theo RFC 7636 §4.1. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}
