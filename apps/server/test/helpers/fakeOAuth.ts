import { Buffer } from 'node:buffer';
import type { OAuthClient, TokenResponse } from '../../src/oauth/client.js';
import { OAuthRequestError } from '../../src/oauth/client.js';

/**
 * Mock identity endpoint của Microsoft.
 *
 * Test tích hợp đều dùng nó, tuyệt đối không chạm mạng thật và thông tin xác thực thật.
 * "Token" sinh ra là JWT có cấu trúc hợp lệ nhưng hoàn toàn hư cấu, giá trị mang dấu hiệu fake rõ ràng.
 */

export interface FakeIdentity {
  tid: string;
  oid: string;
  email: string;
  name?: string;
}

/** Tạo một JWT có phần chữ ký là placeholder — chỉ payload có ý nghĩa, dự án này cũng chỉ đọc payload. */
export function makeFakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fake-signature-not-verified`;
}

export function makeFakeTokenResponse(
  identity: FakeIdentity,
  options: { expiresIn?: number; withRefresh?: boolean; marker?: string } = {},
): TokenResponse {
  const marker = options.marker ?? 'v1';
  const claims = {
    tid: identity.tid,
    oid: identity.oid,
    preferred_username: identity.email,
    name: identity.name ?? identity.email.split('@')[0],
    aud: 'https://substrate.office.com/sydney',
  };
  const response: TokenResponse = {
    access_token: makeFakeJwt({ ...claims, marker }),
    id_token: makeFakeJwt(claims),
    token_type: 'Bearer',
    expires_in: options.expiresIn ?? 3600,
  };
  if (options.withRefresh !== false) {
    response.refresh_token = `fake-refresh-${identity.oid}-${marker}`;
  }
  return response;
}

export interface FakeOAuthClientOptions {
  /** Mã ủy quyền → danh tính. Code chưa đăng ký sẽ bị từ chối */
  codes?: Map<string, FakeIdentity>;
  authorizeBase?: string;
}

/** OAuth client giả có thể lập trình: Có thể inject lỗi, thống kê số lần gọi, mô phỏng phản hồi chậm. */
export class FakeOAuthClient implements OAuthClient {
  readonly codes: Map<string, FakeIdentity>;
  readonly exchangeCalls: { code: string; codeVerifier: string }[] = [];
  readonly refreshCalls: { refreshToken: string }[] = [];

  /** Lỗi sẽ ném ra trong lần exchangeCode tiếp theo */
  nextExchangeError: Error | null = null;
  /** Lỗi sẽ ném ra trong lần refresh tiếp theo */
  nextRefreshError: Error | null = null;
  /** Danh tính trả về khi refresh; không đặt thì tra cứu ngược từ refreshToken */
  refreshIdentity: FakeIdentity | null = null;
  /** refresh có cấp refresh_token mới hay không */
  refreshIssuesNewRefreshToken = true;
  /** Độ trễ nhân tạo, dùng để test xử lý đơn lẻ khi đồng thời */
  refreshDelayMs = 0;
  /** Dấu hiệu access_token trả về mỗi lần refresh tăng dần, thuận tiện phân biệt có phải kết quả cùng lần refresh không */
  #refreshCounter = 0;

  readonly #authorizeBase: string;

  constructor(options: FakeOAuthClientOptions = {}) {
    this.codes = options.codes ?? new Map();
    this.#authorizeBase = options.authorizeBase ?? 'https://login.example.invalid/authorize';
  }

  /** Đăng ký một mã ủy quyền khả dụng. */
  registerCode(code: string, identity: FakeIdentity): void {
    this.codes.set(code, identity);
  }

  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
    const url = new URL(this.#authorizeBase);
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenResponse> {
    this.exchangeCalls.push(params);
    if (this.nextExchangeError !== null) {
      const error = this.nextExchangeError;
      this.nextExchangeError = null;
      throw error;
    }
    const identity = this.codes.get(params.code);
    if (identity === undefined) {
      throw new OAuthRequestError(400, 'invalid_grant', '授权码无效或已使用');
    }
    return makeFakeTokenResponse(identity);
  }

  async refresh(params: { refreshToken: string }): Promise<TokenResponse> {
    this.refreshCalls.push(params);
    if (this.refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
    }
    if (this.nextRefreshError !== null) {
      const error = this.nextRefreshError;
      this.nextRefreshError = null;
      throw error;
    }

    const identity =
      this.refreshIdentity ??
      [...this.codes.values()].find((candidate) =>
        params.refreshToken.includes(candidate.oid),
      ) ?? { tid: 'fake-tid', oid: 'fake-oid', email: 'fake@example.invalid' };

    this.#refreshCounter += 1;
    return makeFakeTokenResponse(identity, {
      marker: `refreshed-${this.#refreshCounter}`,
      withRefresh: this.refreshIssuesNewRefreshToken,
    });
  }

  get refreshCount(): number {
    return this.refreshCalls.length;
  }
}

/** Tạo một callback URL dạng nativeclient, cùng định dạng dán trong wizard người dùng. */
export function makeCallbackUrl(code: string, state: string): string {
  const url = new URL('https://login.microsoftonline.com/common/oauth2/nativeclient');
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}
