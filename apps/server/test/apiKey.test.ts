import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX } from '@m365-codex/shared';
import {
  apiKeyLookupPrefix,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  maskApiKey,
  verifyApiKey,
} from '../src/crypto/apiKey.js';

describe('generateApiKey', () => {
  it('生成 sk- 前缀且随机主体不少于 48 位', () => {
    const generated = generateApiKey();
    expect(generated.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(generated.key.length - API_KEY_PREFIX.length).toBeGreaterThanOrEqual(48);
    expect(/^sk-[0-9A-Za-z]+$/.test(generated.key)).toBe(true);
  });

  it('不重复', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      keys.add(generateApiKey().key);
    }
    expect(keys.size).toBe(500);
  });

  it('每个 Key 使用独立的盐，相同明文哈希不同', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.salt).not.toBe(b.salt);
    expect(hashApiKey(a.key, a.salt)).not.toBe(hashApiKey(a.key, b.salt));
  });

  it('存储字段中不含明文 Key', () => {
    const generated = generateApiKey();
    expect(generated.hash).not.toContain(generated.key);
    expect(generated.salt).not.toContain(generated.key);
    // Tiền tố dùng để index, chỉ để lộ 8 ký tự ngẫu nhiên đầu tiên
    expect(generated.key.startsWith(generated.prefix)).toBe(true);
    expect(generated.prefix.length).toBeLessThan(generated.key.length);
  });
});

describe('verifyApiKey', () => {
  it('正确的 Key 校验通过', () => {
    const generated = generateApiKey();
    expect(verifyApiKey(generated.key, generated.salt, generated.hash)).toBe(true);
  });

  it('错误的 Key 校验失败', () => {
    const generated = generateApiKey();
    const other = generateApiKey();
    expect(verifyApiKey(other.key, generated.salt, generated.hash)).toBe(false);
  });

  it('盐不匹配时校验失败', () => {
    const generated = generateApiKey();
    const other = generateApiKey();
    expect(verifyApiKey(generated.key, other.salt, generated.hash)).toBe(false);
  });

  it('哈希长度异常时返回 false 而不抛异常', () => {
    const generated = generateApiKey();
    expect(verifyApiKey(generated.key, generated.salt, 'abcd')).toBe(false);
  });
});

describe('isWellFormedApiKey', () => {
  it('接受合法 Key', () => {
    expect(isWellFormedApiKey(generateApiKey().key)).toBe(true);
  });

  it('拒绝缺少前缀、过短或含非法字符的 Key', () => {
    expect(isWellFormedApiKey('pk-' + 'a'.repeat(52))).toBe(false);
    expect(isWellFormedApiKey('sk-短')).toBe(false);
    expect(isWellFormedApiKey('sk-' + 'a'.repeat(47))).toBe(false);
    expect(isWellFormedApiKey('sk-' + 'a'.repeat(51) + '!')).toBe(false);
  });
});

describe('apiKeyLookupPrefix / maskApiKey', () => {
  it('前缀可由明文 Key 稳定推导', () => {
    const generated = generateApiKey();
    expect(apiKeyLookupPrefix(generated.key)).toBe(generated.prefix);
  });

  it('掩码不泄露完整 Key', () => {
    const generated = generateApiKey();
    const masked = maskApiKey(generated.prefix);
    expect(masked.startsWith(generated.prefix)).toBe(true);
    expect(masked).not.toBe(generated.key);
    expect(generated.key).not.toContain(masked);
  });
});
