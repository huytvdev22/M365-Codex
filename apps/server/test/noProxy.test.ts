import { describe, expect, it } from 'vitest';
import { hostnameFromUrl, shouldBypassProxy } from '../src/util/noProxy.js';

/**
 * Phán đoán loại trừ NO_PROXY: Khớp với quy ước chung của hệ sinh thái curl/Node (phân tách dấu phẩy/khoảng trắng, `*`,
 * dấu chấm đầu, wildcard `*.`, không phân biệt hoa thường, bỏ qua cổng, khớp hậu tố ranh giới dấu chấm).
 */

describe('shouldBypassProxy', () => {
  it('未设置 NO_PROXY 时永不命中', () => {
    expect(shouldBypassProxy('example.com', null)).toBe(false);
    expect(shouldBypassProxy('example.com', undefined)).toBe(false);
    expect(shouldBypassProxy('example.com', '')).toBe(false);
  });

  it('* 表示全部主机都不走代理', () => {
    expect(shouldBypassProxy('anything.example', '*')).toBe(true);
  });

  it('裸域名同时匹配自身与子域名', () => {
    expect(shouldBypassProxy('example.com', 'example.com')).toBe(true);
    expect(shouldBypassProxy('sub.example.com', 'example.com')).toBe(true);
    expect(shouldBypassProxy('a.b.example.com', 'example.com')).toBe(true);
  });

  it('点边界匹配：notexample.com 不会被 example.com 命中', () => {
    expect(shouldBypassProxy('notexample.com', 'example.com')).toBe(false);
    expect(shouldBypassProxy('badexample.com', 'example.com')).toBe(false);
  });

  it('前导点条目等价于通配子域名，且不匹配裸域名以外的前缀拼接', () => {
    expect(shouldBypassProxy('sub.example.com', '.example.com')).toBe(true);
    expect(shouldBypassProxy('example.com', '.example.com')).toBe(true);
    expect(shouldBypassProxy('notexample.com', '.example.com')).toBe(false);
  });

  it('*.example.com 与 .example.com 等价', () => {
    expect(shouldBypassProxy('sub.example.com', '*.example.com')).toBe(true);
    expect(shouldBypassProxy('example.com', '*.example.com')).toBe(true);
    expect(shouldBypassProxy('notexample.com', '*.example.com')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(shouldBypassProxy('Example.COM', 'example.com')).toBe(true);
    expect(shouldBypassProxy('example.com', 'EXAMPLE.COM')).toBe(true);
  });

  it('逗号或空白分隔多个条目', () => {
    const list = 'a.example, b.example  c.example';
    expect(shouldBypassProxy('a.example', list)).toBe(true);
    expect(shouldBypassProxy('b.example', list)).toBe(true);
    expect(shouldBypassProxy('c.example', list)).toBe(true);
    expect(shouldBypassProxy('d.example', list)).toBe(false);
  });

  it('IP 字面量精确匹配', () => {
    expect(shouldBypassProxy('192.168.0.1', '192.168.0.1')).toBe(true);
    expect(shouldBypassProxy('192.168.0.2', '192.168.0.1')).toBe(false);
  });

  it('localhost 作为普通条目处理', () => {
    expect(shouldBypassProxy('localhost', 'localhost')).toBe(true);
  });

  it('条目可以带端口，比较时忽略端口', () => {
    expect(shouldBypassProxy('example.com', 'example.com:8080')).toBe(true);
    expect(shouldBypassProxy('192.168.0.1', '192.168.0.1:443')).toBe(true);
  });

  it('不合法/空条目被忽略，不影响其它条目', () => {
    expect(shouldBypassProxy('example.com', ' , ,example.com,')).toBe(true);
  });
});

describe('hostnameFromUrl', () => {
  it('从 ws/wss/https URL 中取出主机名', () => {
    expect(hostnameFromUrl('wss://substrate.office.com/path')).toBe('substrate.office.com');
    expect(hostnameFromUrl('https://login.microsoftonline.com/common/token')).toBe(
      'login.microsoftonline.com',
    );
  });

  it('非法 URL 返回 null', () => {
    expect(hostnameFromUrl('not a url')).toBeNull();
  });
});
