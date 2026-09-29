import { ProxyAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { resolveDispatcherForTokenUrl } from '../src/oauth/client.js';

/**
 * Việc chọn proxy gửi đi cho endpoint OAuth token phải tuân thủ NO_PROXY (giống quy ước tầng kết nối WebSocket
 * upstream, xem nhóm NO_PROXY trong test/connection.test.ts): Khi khớp danh sách loại trừ,
 * dù truyền proxy mặc định toàn cục hay proxy riêng của tài khoản, đều bắt buộc kết nối trực tiếp.
 */

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

describe('resolveDispatcherForTokenUrl', () => {
  it('未设置 NO_PROXY 时，配了 proxyUrl 就走代理', () => {
    const dispatcher = resolveDispatcherForTokenUrl(TOKEN_URL, 'http://proxy.invalid:8080', null);
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('未配置 proxyUrl 时始终直连', () => {
    expect(resolveDispatcherForTokenUrl(TOKEN_URL, null, null)).toBeUndefined();
    expect(resolveDispatcherForTokenUrl(TOKEN_URL, undefined, null)).toBeUndefined();
  });

  it('token 端点主机命中 NO_PROXY 时直连，即使配了 proxyUrl', () => {
    const dispatcher = resolveDispatcherForTokenUrl(
      TOKEN_URL,
      'http://proxy.invalid:8080',
      'login.microsoftonline.com',
    );
    expect(dispatcher).toBeUndefined();
  });

  it('NO_PROXY 命中的是账号专属代理覆盖时同样直连', () => {
    // Mô phỏng tài khoản đã liên kết proxy riêng (kịch bản ghi đè proxyUrl của TokenManager.refresh)
    const dispatcher = resolveDispatcherForTokenUrl(
      TOKEN_URL,
      'http://account-specific-proxy.invalid:8080',
      '*.microsoftonline.com',
    );
    expect(dispatcher).toBeUndefined();
  });

  it('NO_PROXY 里没有命中的条目不影响代理生效', () => {
    const dispatcher = resolveDispatcherForTokenUrl(TOKEN_URL, 'http://proxy.invalid:8080', 'other.invalid');
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });
});
