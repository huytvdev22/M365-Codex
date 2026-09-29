import { ApiError } from '@m365-codex/shared';
import { parse as parseQuery } from 'node:querystring';
import type { OAuthConfig } from '../config/index.js';
import type { AccountRepository, AccountView } from '../repo/accounts.js';
import type { OAuthSessionRepository } from '../repo/oauthSessions.js';
import { extractIdentity, type OAuthClient } from './client.js';
import { createPkcePair } from './pkce.js';

/**
 * Điều phối luồng cấp quyền OAuth.
 *
 * Áp dụng hình thức tương tác tương tự như công cụ hỗ trợ ủy quyền PKCE Native M365 cục bộ hiện tại của người dùng:
 * Dịch vụ sinh liên kết ủy quyền → người dùng đăng nhập trên trình duyệt → dán URL callback nativeclient quay lại.
 * Bằng cách này dịch vụ không cần mở cổng callback ra ngoài, do đó không cần khả năng truy cập qua mạng công cộng.
 */

export interface AuthorizationStart {
  authorize_url: string;
  state: string;
  expires_at: number;
}

export interface AuthorizationResult {
  account: AccountView;
  /** Tài khoản này trước đó đã có trong pool hay chưa */
  existing: boolean;
}

export interface OAuthServiceDeps {
  config: OAuthConfig;
  client: OAuthClient;
  sessions: OAuthSessionRepository;
  accounts: AccountRepository;
}

export class OAuthService {
  readonly #deps: OAuthServiceDeps;

  constructor(deps: OAuthServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Bắt đầu một lượt cấp quyền. Mỗi lần gọi sẽ tạo một phiên verifier/state độc lập,
   * do đó có thể cấp quyền song song cho nhiều tài khoản cùng lúc mà không ảnh hưởng lẫn nhau.
   */
  start(now = Date.now()): AuthorizationStart {
    const pkce = createPkcePair();
    const session = this.#deps.sessions.create(
      {
        state: pkce.state,
        codeVerifier: pkce.verifier,
        redirectUri: this.#deps.config.redirectUri,
        scopes: this.#deps.config.scopes,
      },
      now,
    );
    return {
      authorize_url: this.#deps.client.buildAuthorizeUrl({
        state: pkce.state,
        codeChallenge: pkce.challenge,
      }),
      state: pkce.state,
      expires_at: session.expires_at,
    };
  }

  /**
   * Dùng URL callback (hoặc chuỗi truy vấn trần `code=…&state=…`) để hoàn tất cấp quyền.
   * state phải khớp chính xác với phiên cụ thể, mã cấp quyền chỉ được tiêu thụ 1 lần.
   */
  async complete(callback: string, now = Date.now()): Promise<AuthorizationResult> {
    const { code, state } = parseCallback(callback);

    const consumed = this.#deps.sessions.consume(state, now);
    if (!consumed.ok) {
      throw mapConsumeFailure(consumed.reason);
    }

    let tokens;
    try {
      tokens = await this.#deps.client.exchangeCode({ code, codeVerifier: consumed.codeVerifier });
    } catch (error) {
      throw new ApiError({
        type: 'upstream_error',
        status: 502,
        message: `换取 Token 失败：${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    const identity = extractIdentity(tokens);
    if (identity === null) {
      throw new ApiError({
        type: 'upstream_error',
        status: 502,
        message: 'Token 中缺少租户（tid）或对象（oid）声明，无法识别账号',
      });
    }

    const existing = this.#deps.accounts.findByTenantObject(identity.tid, identity.oid) !== undefined;
    const account = this.#deps.accounts.upsert(
      {
        tid: identity.tid,
        oid: identity.oid,
        email: identity.email,
        displayName: identity.displayName,
        source: 'oauth',
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: computeExpiry(tokens.expires_in, now),
        },
      },
      now,
    );

    return { account, existing };
  }
}

/** Chuyển `expires_in` (giây) sang epoch mili-giây; mặc định tính 1 giờ, khớp với mặc định của Microsoft. */
export function computeExpiry(expiresIn: number | undefined, now: number): number {
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 3600;
  return now + seconds * 1000;
}

/** Lấy code và state từ URL callback hoàn chỉnh hoặc query string trần. */
export function parseCallback(input: string): { code: string; state: string } {
  const text = input.trim();
  if (text === '') {
    throw ApiError.badRequest('请粘贴包含 code 与 state 的回调地址', 'callback');
  }

  let query: string;
  if (text.startsWith('http://') || text.startsWith('https://')) {
    try {
      query = new URL(text).search.replace(/^\?/, '');
    } catch {
      throw ApiError.badRequest('回调地址不是合法 URL', 'callback');
    }
  } else {
    query = text.replace(/^\?/, '');
  }

  const parsed = parseQuery(query);
  const first = (value: string | string[] | undefined): string =>
    Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

  // Microsoft cũng callback khi người dùng hủy hoặc phát sinh lỗi, lúc này mang error thay vì code
  const oauthError = first(parsed.error);
  if (oauthError !== '') {
    const description = first(parsed.error_description).split('\n')[0] ?? '';
    throw ApiError.badRequest(`授权未完成（${oauthError}）：${description}`, 'callback');
  }

  const code = first(parsed.code);
  const state = first(parsed.state);
  if (code === '') throw ApiError.badRequest('回调地址中没有 code 参数', 'callback');
  if (state === '') throw ApiError.badRequest('回调地址中没有 state 参数', 'callback');
  return { code, state };
}

function mapConsumeFailure(reason: 'not_found' | 'expired' | 'already_consumed'): ApiError {
  switch (reason) {
    case 'not_found':
      return ApiError.badRequest('state 不匹配任何进行中的授权会话，请重新生成授权链接', 'state');
    case 'expired':
      return ApiError.badRequest('授权会话已超过 10 分钟有效期，请重新生成授权链接', 'state');
    case 'already_consumed':
      return ApiError.badRequest('该授权码已被使用过，请重新生成授权链接', 'state');
  }
}
