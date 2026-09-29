import { Buffer } from 'node:buffer';
import { ProxyAgent, request, type Dispatcher } from 'undici';
import type { OAuthConfig } from '../config/index.js';
import { hostnameFromUrl, shouldBypassProxy } from '../util/noProxy.js';

/**
 * Tương tác HTTP với Microsoft identity platform.
 *
 * Tách thành interface để tầng trên (luồng cấp quyền, làm mới Token) có thể thay thế mạng thực trong test,
 * các bài test tích hợp không phụ thuộc vào thông tin xác thực thật.
 */

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** Body lỗi OAuth tiêu chuẩn trả về từ Microsoft. */
export class OAuthRequestError extends Error {
  readonly status: number;
  /** Ví dụ `invalid_grant`, `invalid_client`, `interaction_required` */
  readonly errorCode: string;
  readonly description: string;

  constructor(status: number, errorCode: string, description: string) {
    super(`OAuth 请求失败（HTTP ${status} / ${errorCode}）：${description}`);
    this.name = 'OAuthRequestError';
    this.status = status;
    this.errorCode = errorCode;
    this.description = description;
  }

  /** refresh_token đã mất hiệu lực, bắt buộc phải thực hiện lại toàn bộ luồng cấp quyền. */
  get requiresReauth(): boolean {
    return (
      this.errorCode === 'invalid_grant' ||
      this.errorCode === 'interaction_required' ||
      this.errorCode === 'consent_required'
    );
  }
}

export interface OAuthClient {
  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenResponse>;
  /**
   * `proxyUrl` tùy chọn: proxy đầu ra phân giải theo tài khoản (tương ứng kế hoạch triển khai §13.1 "cấu hình proxy riêng cho OAuth và
   * Copilot"). Nếu không truyền sẽ dùng proxy mặc định toàn cục khi khởi tạo client.
   */
  refresh(params: { refreshToken: string; proxyUrl?: string | null }): Promise<TokenResponse>;
}

export interface HttpOAuthClientOptions {
  config: OAuthConfig;
  /** Proxy đầu ra, tương ứng HTTPS_PROXY / HTTP_PROXY */
  proxyUrl?: string | null;
  /** Danh sách loại trừ NO_PROXY; host của endpoint token khi khớp sẽ kết nối trực tiếp dù đã cấu hình proxy */
  noProxy?: string | null;
  timeoutMs?: number;
}

export class HttpOAuthClient implements OAuthClient {
  readonly #config: OAuthConfig;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #timeoutMs: number;
  readonly #noProxy: string | null;

  constructor(options: HttpOAuthClientOptions) {
    this.#config = options.config;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#noProxy = options.noProxy ?? null;
    this.#dispatcher = resolveDispatcherForTokenUrl(this.#config.tokenUrl, options.proxyUrl, this.#noProxy);
  }

  buildAuthorizeUrl(params: { state: string; codeChallenge: string }): string {
    const url = new URL(this.#config.authorizeUrl);
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', this.#config.scopes.join(' '));
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Bắt buộc chọn tài khoản: trong kịch bản pool tài khoản cần cấp quyền liên tục nhiều tài khoản, không bị bám vào session có sẵn của trình duyệt
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenResponse> {
    return this.#postToken({
      client_id: this.#config.clientId,
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: this.#config.redirectUri,
      code_verifier: params.codeVerifier,
      scope: this.#config.scopes.join(' '),
    });
  }

  async refresh(params: { refreshToken: string; proxyUrl?: string | null }): Promise<TokenResponse> {
    return this.#postToken(
      {
        client_id: this.#config.clientId,
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
        scope: this.#config.scopes.join(' '),
      },
      params.proxyUrl,
    );
  }

  async #postToken(form: Record<string, string>, proxyUrlOverride?: string | null): Promise<TokenResponse> {
    const body = new URLSearchParams(form).toString();
    // Khi tài khoản gắn proxy riêng, mỗi lần gọi sẽ tạm thời chuyển dispatcher; nếu không sẽ dùng mặc định toàn cục lúc khởi tạo.
    // Khi host endpoint token khớp NO_PROXY, resolveDispatcherForTokenUrl sẽ trả về undefined bất kể proxyUrl truyền vào là gì
    // — điều kiện này được ưu tiên hơn proxy ghi đè của tài khoản, theo ngữ nghĩa "host này không đi qua proxy" là ràng buộc cứng.
    const dispatcher =
      proxyUrlOverride === undefined
        ? this.#dispatcher
        : resolveDispatcherForTokenUrl(this.#config.tokenUrl, proxyUrlOverride, this.#noProxy);
    const response = await request(this.#config.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      headersTimeout: this.#timeoutMs,
      bodyTimeout: this.#timeoutMs,
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });

    const text = await response.body.text();
    if (response.statusCode >= 400) {
      throw parseOAuthError(response.statusCode, text);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OAuthRequestError(response.statusCode, 'invalid_response', 'Token 端点返回的不是合法 JSON');
    }
    const tokens = parsed as TokenResponse;
    if (typeof tokens.access_token !== 'string' || tokens.access_token === '') {
      throw new OAuthRequestError(response.statusCode, 'invalid_response', 'Token 端点响应缺少 access_token');
    }
    return tokens;
  }
}

/** Proxy URL rỗng/chưa cấu hình thì không tạo dispatcher, dùng mặc định của undici (kết nối trực tiếp). */
function toDispatcher(proxyUrl?: string | null): Dispatcher | undefined {
  return proxyUrl == null || proxyUrl === '' ? undefined : new ProxyAgent(proxyUrl);
}

/**
 * Quyết định có tạo proxy dispatcher hay không dựa trên host đích của endpoint token: khi khớp NO_PROXY luôn kết nối trực tiếp,
 * bất kể `proxyUrl` truyền vào là proxy mặc định toàn cục hay proxy riêng của tài khoản. Export dạng hàm thuần túy để có thể kiểm thử riêng
 * logic phán đoán này mà không cần gửi request mạng thật.
 */
export function resolveDispatcherForTokenUrl(
  tokenUrl: string,
  proxyUrl: string | null | undefined,
  noProxy: string | null | undefined,
): Dispatcher | undefined {
  const host = hostnameFromUrl(tokenUrl);
  if (host !== null && shouldBypassProxy(host, noProxy)) return undefined;
  return toDispatcher(proxyUrl);
}

/**
 * Phân tích cú pháp phản hồi lỗi từ Microsoft.
 * Mô tả lỗi có thể chứa định danh nội bộ, chỉ giữ lại dòng đầu và cắt ngắn, tránh rác log.
 */
export function parseOAuthError(status: number, rawBody: string): OAuthRequestError {
  let errorCode = 'unknown_error';
  let description = rawBody.slice(0, 300);
  try {
    const parsed = JSON.parse(rawBody) as { error?: string; error_description?: string };
    if (typeof parsed.error === 'string') errorCode = parsed.error;
    if (typeof parsed.error_description === 'string') {
      description = parsed.error_description.split('\n')[0]?.slice(0, 300) ?? '';
    }
  } catch {
    // Phản hồi không phải JSON (trang lỗi gateway...) giữ nguyên và cắt ngắn
  }
  return new OAuthRequestError(status, errorCode, description);
}

/** Giải mã payload của JWT. Chỉ dùng để đọc claim tid/oid/email..., **không xác thực chữ ký**. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2 || parts[1] === undefined) return {};
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface IdentityClaims {
  tid: string;
  oid: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Trích xuất danh tính tài khoản từ id_token / access_token.
 * Ưu tiên dùng id_token vì claim đầy đủ hơn; nếu cả hai đều thiếu tid hoặc oid thì coi như không khả dụng.
 */
export function extractIdentity(tokens: TokenResponse): IdentityClaims | null {
  const claims = {
    ...decodeJwtClaims(tokens.access_token),
    ...(tokens.id_token === undefined ? {} : decodeJwtClaims(tokens.id_token)),
  };

  const str = (key: string): string | null => {
    const value = claims[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };

  const tid = str('tid');
  const oid = str('oid') ?? str('sub');
  if (tid === null || oid === null) return null;

  const email = str('preferred_username') ?? str('email') ?? str('upn') ?? str('unique_name');
  const displayName = str('name') ?? (email === null ? null : (email.split('@')[0] ?? null));

  return { tid, oid, email, displayName };
}
