import { describe, expect, it } from 'vitest';
import { assertReportClean, buildStructureSample, maskEmail, maskId, redactWsUrl } from '../src/evidence.js';

describe('buildStructureSample', () => {
  it('把普通字符串替换成 <string:长度>，保留字段名与类型', () => {
    const sample = buildStructureSample({ text: '你好世界', count: 3, ok: true, note: null });
    expect(sample).toEqual({ text: '<string:4>', count: 3, ok: true, note: null });
  });

  it('allowlist 命中的字面量原样保留', () => {
    const literal = '这是我们自己发出去的固定测试文本';
    const sample = buildStructureSample({ text: literal }, new Set([literal]));
    expect(sample).toEqual({ text: literal });
  });

  it('禁止键名（access_token 等）整体替换为占位符，即便值本身不是字符串', () => {
    const sample = buildStructureSample({
      access_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature',
      refresh_token: { nested: 'whatever' },
      Authorization: 'Bearer abcdefghijklmnop',
      Cookie: 'session=xyz',
    });
    expect(sample).toEqual({
      access_token: '<redacted:forbidden-key>',
      refresh_token: '<redacted:forbidden-key>',
      Authorization: '<redacted:forbidden-key>',
      Cookie: '<redacted:forbidden-key>',
    });
  });

  it('JWT 形态的字符串即便键名不敏感也会被识别为疑似密钥并脱敏', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const sample = buildStructureSample({ weirdFieldName: jwt });
    expect(sample).toEqual({ weirdFieldName: '<redacted:looks-like-secret>' });
  });

  it('URL 里的 access_token 查询参数会被识别为疑似密钥', () => {
    const url = 'wss://substrate.office.com/m365Copilot/Chathub/oid@tid?access_token=abc.def.ghi';
    const sample = buildStructureSample({ url });
    expect(sample).toEqual({ url: '<redacted:looks-like-secret>' });
  });

  it('数组超过上限会截断并记录剩余数量', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const sample = buildStructureSample(arr) as unknown[];
    expect(sample).toHaveLength(21); // 20 mục + 1 gợi ý cắt ngắn
    expect(sample[20]).toBe('<truncated:5-more-items>');
  });

  it('嵌套对象递归处理', () => {
    const sample = buildStructureSample({ arguments: [{ messages: [{ text: 'hi', author: 'user' }] }] });
    expect(sample).toEqual({ arguments: [{ messages: [{ text: '<string:2>', author: '<string:4>' }] }] });
  });
});

describe('maskId', () => {
  it('只保留前 8 位', () => {
    expect(maskId('0123456789abcdef')).toBe('01234567…');
  });
  it('不超过 8 位时原样返回', () => {
    expect(maskId('abc123')).toBe('abc123');
  });
  it('空值返回 null', () => {
    expect(maskId(null)).toBeNull();
    expect(maskId(undefined)).toBeNull();
    expect(maskId('')).toBeNull();
  });
});

describe('maskEmail / redactWsUrl（复用自 apps/server）', () => {
  it('邮箱掩码形态符合 fo***@domain 规则', () => {
    expect(maskEmail('foo@example.com')).toBe('fo***@example.com');
  });
  it('WebSocket URL 的 access_token 会被脱敏', () => {
    const masked = redactWsUrl('wss://substrate.office.com/chat?access_token=super-secret-value');
    expect(masked).not.toContain('super-secret-value');
    // searchParams.set của URL sẽ mã hóa percent cho giá trị, sau khi decode sẽ thấy placeholder khử nhạy cảm
    expect(decodeURIComponent(masked)).toContain('已脱敏');
  });
});

describe('assertReportClean（写盘前最终防线）', () => {
  it('干净文本不抛异常', () => {
    expect(() => assertReportClean('这是一份正常的、已脱敏的报告。fo***@example.com')).not.toThrow();
  });

  it('检测到 JWT 形态时抛异常', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(() => assertReportClean(`不小心混进去一个 token：${jwt}`)).toThrow();
  });

  it('检测到 URL 中的 access_token 时抛异常', () => {
    expect(() =>
      assertReportClean('地址：wss://substrate.office.com/chat?access_token=leaked-value-1234'),
    ).toThrow();
  });

  it('检测到 Bearer 认证头时抛异常', () => {
    expect(() => assertReportClean('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toThrow();
  });

  it('检测到未脱敏的完整邮箱时抛异常（掩码形态除外）', () => {
    expect(() => assertReportClean('用户邮箱是 realuser@example.com，请核实。')).toThrow();
    expect(() => assertReportClean('测试账号：fo***@example.com')).not.toThrow();
  });
});
