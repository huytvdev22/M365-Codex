import type { Logger } from 'pino';
import type { AccountRepository } from '../repo/accounts.js';
import type { Metrics } from '../observability/metrics.js';
import { OAuthRequestError, type OAuthClient } from './client.js';
import { computeExpiry } from './service.js';

/**
 * Làm mới Access Token theo nhu cầu.
 *
 * Ràng buộc then chốt:
 * - **Mỗi tài khoản chỉ cho phép 1 tác vụ làm mới duy nhất**. Các request đồng thời chia sẻ cùng một Promise, nếu không nhiều tác vụ làm mới
 *   sẽ ghi đè refresh_token lẫn nhau, làm hỏng tài khoản;
 * - Ghi lại bằng transaction nguyên tử;
 * - `invalid_grant` chứng tỏ refresh_token đã bị vô hiệu, tài khoản chuyển sang `reauth_required`,
 *   không thử lại liên tục nữa;
 * - Toàn bộ quá trình không in Token ra log, log chỉ có ID tài khoản và mã lỗi.
 */

/** Làm mới trước bao lâu: khi tuổi thọ còn lại của Token nhỏ hơn giá trị này sẽ chủ động đổi mới. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class TokenUnavailableError extends Error {
  readonly accountId: string;
  readonly reason: 'no_token' | 'no_refresh_token' | 'reauth_required' | 'refresh_failed';

  constructor(accountId: string, reason: TokenUnavailableError['reason'], message: string) {
    super(message);
    this.name = 'TokenUnavailableError';
    this.accountId = accountId;
    this.reason = reason;
  }
}

export interface TokenManagerDeps {
  accounts: AccountRepository;
  client: OAuthClient;
  logger: Logger;
  skewMs?: number;
  /** Phân giải proxy đầu ra theo tài khoản, sau khi gắn thì làm mới Token đi qua cùng một cổng ra (tương ứng kế hoạch triển khai §13.1). */
  resolveProxyForAccount?: (accountId: string) => string | null;
  /** M8: Đo đạc số liệu kết quả làm mới Token (§17) */
  metrics?: Metrics;
}

export class TokenManager {
  readonly #accounts: AccountRepository;
  readonly #client: OAuthClient;
  readonly #logger: Logger;
  readonly #skewMs: number;
  readonly #resolveProxyForAccount: ((accountId: string) => string | null) | undefined;
  readonly #metrics: Metrics | undefined;
  /** accountId → Tác vụ làm mới đang diễn ra, đảm bảo cùng một tài khoản chỉ chạy đơn lẻ */
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(deps: TokenManagerDeps) {
    this.#accounts = deps.accounts;
    this.#client = deps.client;
    this.#logger = deps.logger;
    this.#skewMs = deps.skewMs ?? REFRESH_SKEW_MS;
    this.#resolveProxyForAccount = deps.resolveProxyForAccount;
    this.#metrics = deps.metrics;
  }

  /** Lấy một access token khả dụng hiện tại, khi cần thiết sẽ làm mới trước. */
  async getAccessToken(accountId: string, now = Date.now()): Promise<string> {
    const current = this.#accounts.readAccessToken(accountId);
    if (current === null) {
      throw new TokenUnavailableError(accountId, 'no_token', '该账号没有已保存的 Token');
    }
    const expiresAt = current.expiresAt;
    if (expiresAt !== null && expiresAt - now > this.#skewMs) {
      return current.token;
    }
    return this.refresh(accountId, now);
  }

  /** Bắt buộc làm mới. Các cuộc gọi đồng thời trên cùng tài khoản sẽ tái sử dụng cùng một tác vụ đang chạy. */
  async refresh(accountId: string, now = Date.now()): Promise<string> {
    const existing = this.#inFlight.get(accountId);
    if (existing !== undefined) return existing;

    const task = this.#doRefresh(accountId, now).finally(() => {
      this.#inFlight.delete(accountId);
    });
    this.#inFlight.set(accountId, task);
    return task;
  }

  /** Hiện tại có tác vụ làm mới nào đang chạy không, dành cho test và observability. */
  isRefreshing(accountId: string): boolean {
    return this.#inFlight.has(accountId);
  }

  async #doRefresh(accountId: string, now: number): Promise<string> {
    const account = this.#accounts.findById(accountId);
    if (account === undefined) {
      throw new TokenUnavailableError(accountId, 'no_token', '账号不存在');
    }
    if (account.status === 'reauth_required') {
      throw new TokenUnavailableError(
        accountId,
        'reauth_required',
        '该账号需要重新授权，刷新凭据已失效',
      );
    }

    const refreshToken = this.#accounts.readRefreshToken(accountId);
    if (refreshToken === null) {
      // Không có refresh_token thì không thể tự động gia hạn, trực tiếp yêu cầu cấp quyền lại
      this.#accounts.forceStatus(accountId, 'reauth_required', now);
      this.#metrics?.tokenRefresh.inc({ result: 'no_refresh_token' });
      throw new TokenUnavailableError(
        accountId,
        'no_refresh_token',
        '该账号没有 refresh_token，无法自动刷新',
      );
    }

    try {
      const proxyUrl = this.#resolveProxyForAccount?.(accountId) ?? undefined;
      const tokens = await this.#client.refresh({ refreshToken, proxyUrl });
      this.#accounts.replaceTokens(
        accountId,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresAt: computeExpiry(tokens.expires_in, now),
        },
        now,
      );
      this.#accounts.recordSuccess(accountId, now);
      if (account.status === 'error' || account.status === 'cooldown') {
        this.#accounts.forceStatus(accountId, 'probing', now);
      }
      this.#metrics?.tokenRefresh.inc({ result: 'success' });
      this.#logger.info({ account_id: accountId }, 'Token 刷新成功');
      return tokens.access_token;
    } catch (error) {
      if (error instanceof OAuthRequestError && error.requiresReauth) {
        this.#accounts.forceStatus(accountId, 'reauth_required', now);
        this.#accounts.recordFailure(accountId, error.errorCode, {}, now);
        this.#metrics?.tokenRefresh.inc({ result: 'reauth_required' });
        this.#logger.warn(
          { account_id: accountId, oauth_error: error.errorCode },
          '刷新凭据已失效，账号转入 reauth_required',
        );
        throw new TokenUnavailableError(
          accountId,
          'reauth_required',
          `刷新凭据已失效（${error.errorCode}），需要重新授权`,
        );
      }

      const errorCode = error instanceof OAuthRequestError ? error.errorCode : 'network_error';
      this.#accounts.recordFailure(accountId, errorCode, {}, now);
      this.#metrics?.tokenRefresh.inc({ result: 'failure' });
      this.#logger.warn({ account_id: accountId, oauth_error: errorCode }, 'Token 刷新失败');
      throw new TokenUnavailableError(accountId, 'refresh_failed', `Token 刷新失败（${errorCode}）`);
    }
  }
}
