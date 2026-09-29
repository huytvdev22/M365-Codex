import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64Url,
  createPkcePair,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  isValidCodeVerifier,
} from '../src/oauth/pkce.js';

describe('generateCodeVerifier', () => {
  it('长度与字符集符合 RFC 7636', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isValidCodeVerifier(generateCodeVerifier())).toBe(true);
    }
  });

  it('不重复', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateCodeVerifier());
    expect(seen.size).toBe(500);
  });
});

describe('deriveCodeChallenge', () => {
  it('等于 BASE64URL(SHA256(verifier))', () => {
    const verifier = generateCodeVerifier();
    const expected = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });

  it('与 RFC 7636 附录 B 的示例一致', () => {
    // Test vector chuẩn do RFC 7636 Appendix B cung cấp
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('不同 verifier 得到不同 challenge', () => {
    expect(deriveCodeChallenge(generateCodeVerifier())).not.toBe(
      deriveCodeChallenge(generateCodeVerifier()),
    );
  });

  it('challenge 无法反推 verifier（不含其明文）', () => {
    const verifier = generateCodeVerifier();
    expect(deriveCodeChallenge(verifier)).not.toContain(verifier);
  });
});

describe('generateState', () => {
  it('不重复且足够长', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const state = generateState();
      expect(state.length).toBeGreaterThanOrEqual(32);
      seen.add(state);
    }
    expect(seen.size).toBe(500);
  });
});

describe('createPkcePair', () => {
  it('三要素齐备且互相匹配', () => {
    const pair = createPkcePair();
    expect(isValidCodeVerifier(pair.verifier)).toBe(true);
    expect(pair.challenge).toBe(deriveCodeChallenge(pair.verifier));
    expect(pair.state).not.toBe(pair.verifier);
  });

  it('每次生成的三要素都不同', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
    expect(a.state).not.toBe(b.state);
  });
});

describe('isValidCodeVerifier', () => {
  it('拒绝过短、过长与含非法字符的值', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(50)}+`)).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(50)}/`)).toBe(false);
  });

  it('接受 RFC 允许的全部非保留字符', () => {
    expect(isValidCodeVerifier(`${'aA0-._~'.repeat(7)}xx`)).toBe(true);
  });
});
