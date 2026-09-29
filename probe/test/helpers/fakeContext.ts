import { createLogger } from '../../../apps/server/dist/observability/logger.js';
import { SydneyCodecV1 } from '../../../apps/server/dist/adapter/codecV1.js';
import type { AccountRepository } from '../../../apps/server/dist/repo/accounts.js';
import type { OAuthClient } from '../../../apps/server/dist/oauth/client.js';
import type { TokenManager } from '../../../apps/server/dist/oauth/tokenManager.js';
import type { ProbeContext } from '../../src/types.js';

/**
 * `ProbeContext` tối thiểu dùng cho test: Chỉ điền thật các trường cần thiết để "chạy một invocation",
 * các dependency liên quan đến refresh Token (`accounts`/`oauthClient`/`tokenManager`) được điền bằng
 * placeholder object không bao giờ bị gọi tới — case nào cần dùng sẽ tự thay thế bằng fake thật trong test tương ứng.
 */
export function makeFakeContext(mockServerUrl: string, overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    account: { id: 'test-account', oid: 'test-oid', tid: 'test-tid', email: 'probe@example.invalid' },
    getAccessToken: () => Promise.resolve('mock-access-token-not-real'),
    upstream: {
      wsBase: mockServerUrl,
      pathTemplate: '/{oid}@{tid}',
      protocolVersion: 'sydney-json-v1',
      heartbeatIntervalMs: 15_000,
      handshakeTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      scenario: 'officeweb',
    },
    codec: new SydneyCodecV1(),
    logger: createLogger({ level: 'silent', privacyMode: 'strict' }),
    delayMs: 0,
    repeat: 3,
    invocationTimeoutMs: 5000,
    accounts: {} as unknown as AccountRepository,
    oauthClient: {} as unknown as OAuthClient,
    tokenManager: {} as unknown as TokenManager,
    ...overrides,
  };
}
