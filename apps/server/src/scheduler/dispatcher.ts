import { ApiError } from '@m365-codex/shared';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { UpstreamConfig } from '../config/index.js';
import { buildUpstreamUrl } from '../adapter/endpoint.js';
import { UpstreamError } from '../adapter/errors.js';
import type {
  ProtocolCodec,
  ToolDeclaration,
  ToolResultInput,
  UpstreamEvent,
} from '../adapter/protocol.js';
import { SydneyConnection, type ConnectionDeps } from '../adapter/connection.js';
import type { AccountRepository } from '../repo/accounts.js';
import { TokenUnavailableError, type TokenManager } from '../oauth/tokenManager.js';
import type { Metrics } from '../observability/metrics.js';
import type { AccountPool } from './accountPool.js';

/**
 * Upstream Dispatcher: Điều phối "một yêu cầu hội thoại" tới kết nối upstream của một tài khoản cụ thể, và khi thất bại
 * sẽ thực hiện làm mới (refresh) / làm nguội (cooldown) / chuyển đổi (failover) theo phân loại lỗi (tương ứng kế hoạch triển khai §M3 DoD).
 *
 * Xử lý thất bại:
 * - 401 → Làm mới Token một lần, thử lại một lần trên cùng tài khoản;
 * - 403 / chính sách bị đóng → Cooldown tài khoản này và chuyển sang tài khoản khác, không chuyển đổi vô hạn (tài khoản vào tập loại trừ);
 * - 429 → Cooldown tài khoản theo Retry-After, chuyển sang tài khoản khác;
 * - 5xx / WS ngắt kết nối → Thử lại số lần hữu hạn, có thể chuyển đổi;
 * - 4xx (không phải 401/403/429) → Coi là lỗi nghiêm trọng (fatal), thất bại trực tiếp.
 *
 * "Chuyển tài khoản dùng nội dung cục bộ tái dựng ngữ cảnh": Tầng này mỗi lần thử đều dùng **văn bản request ban đầu** để phát lại
 * invocation. Do đó **chỉ khi chưa xuất bất kỳ nội dung nào xuống downstream** mới thực hiện chuyển đổi / thử lại; một khi đã
 * có text_delta chảy ra, nếu giữa chừng thất bại sẽ ném lỗi chân thực — việc tiếp tục từ điểm ngắt sạch sẽ và tính idempotent của công cụ thuộc về M4/M5.
 */

export interface DispatchRequest {
  /** Văn bản thuần do người dùng nhập ở vòng này (M3 chỉ có văn bản) */
  text: string;
  /** Liên kết bám dính: Tài khoản và tham chiếu phiên upstream đã dùng ở vòng trước */
  sticky?: { accountId: string; conversationRef: string | null } | null;
  /** Các tham số chuyển tiếp cho upstream (model / reasoning.effort v.v., không viết lại) */
  passthrough?: Record<string, unknown> | undefined;
  /** Khai báo các công cụ khả dụng ở vòng này (M5) */
  tools?: readonly ToolDeclaration[] | undefined;
  /** Kết quả thực thi công cụ gửi lại (M5, mang theo khi tiếp nối) */
  toolResults?: readonly ToolResultInput[] | undefined;
  /**
   * Request này có khả năng kích hoạt tác dụng phụ hay không (true khi mang kết quả công cụ gửi lại).
   * Giai đoạn tác dụng phụ cấm tự động phát lại qua tài khoản khác — một khi thất bại không chuyển tài khoản, ném lỗi trực tiếp.
   */
  sideEffect?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface DispatchResult {
  /** Tài khoản thực tế sử dụng lần này */
  accountId: string;
  /** Tham chiếu phiên upstream (để tầng trên lưu trữ, phục vụ tiếp nối) */
  conversationRef: string | null;
  /** Luồng sự kiện đã chuẩn hóa */
  events: AsyncGenerator<UpstreamEvent>;
}

export interface DispatcherDeps {
  config: UpstreamConfig;
  codec: ProtocolCodec;
  accounts: AccountRepository;
  pool: AccountPool;
  tokens: TokenManager;
  logger: Logger;
  proxyUrl?: string | null;
  /** Danh sách loại trừ NO_PROXY, chuyển tiếp cho tầng kết nối; host mục tiêu khớp danh sách sẽ kết nối trực tiếp dù có cấu hình proxy */
  noProxy?: string | null;
  /**
   * Phân giải proxy đầu ra theo tài khoản (tương ứng kế hoạch triển khai §13.1 "Tài khoản liên kết proxy duy trì tính bám dính đầu ra").
   * Trả về null biểu thị tài khoản này chưa liên kết proxy hoặc node liên kết đã dừng hoạt động, fallback về giá trị mặc định toàn cục `proxyUrl`.
   */
  resolveProxyForAccount?: (accountId: string) => string | null;
  /** Inject triển khai kết nối, dùng cho kiểm thử */
  connectionFactory?: (deps: ConnectionDeps) => SydneyConnection;
  /** Số lượng tài khoản tối đa thử cho một request đơn (bao gồm cả thử lại), mặc định 4 */
  maxAttempts?: number;
  /** Thời gian cooldown mặc định (mili giây) ngoài 403 / 429 */
  defaultCooldownMs?: number;
  /** M8: Thu thập số liệu lần gọi upstream và phân loại lỗi (§17) */
  metrics?: Metrics;
}

export class UpstreamDispatcher {
  readonly #deps: DispatcherDeps;
  readonly #maxAttempts: number;
  readonly #defaultCooldownMs: number;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#maxAttempts = deps.maxAttempts ?? 4;
    this.#defaultCooldownMs = deps.defaultCooldownMs ?? 30_000;
  }

  /**
   * Điều phối một lượt hội thoại. Trả về tài khoản được chọn, tham chiếu phiên upstream, cùng luồng sự kiện.
   * Bên trong luồng sự kiện sẽ hoàn thành việc chọn tài khoản và chuyển đổi khi thất bại; khi pool không còn tài khoản khả dụng sẽ ném
   * `503 account_pool_exhausted`.
   */
  dispatch(request: DispatchRequest): DispatchResult {
    // Xác định trước xem tài khoản ưu tiên có khả dụng không để trả về accountId đồng bộ; kết nối thực sự được thiết lập trong luồng sự kiện
    const state: { accountId: string; conversationRef: string | null } = {
      accountId: '',
      conversationRef: request.sticky?.conversationRef ?? null,
    };
    const events = this.#runWithFailover(request, state);
    return {
      get accountId() {
        return state.accountId;
      },
      get conversationRef() {
        return state.conversationRef;
      },
      events,
    };
  }

  async *#runWithFailover(
    request: DispatchRequest,
    state: { accountId: string; conversationRef: string | null },
  ): AsyncGenerator<UpstreamEvent> {
    const { pool, logger } = this.#deps;
    const excluded = new Set<string>();
    let emittedContent = false;
    let attempts = 0;
    let lastError: UpstreamError | TokenUnavailableError | null = null;

    while (attempts < this.#maxAttempts) {
      const account = pool.pick({
        exclude: excluded,
        prefer: attempts === 0 ? (request.sticky?.accountId ?? null) : null,
      });

      if (account === null) {
        // Phân biệt "pool ban đầu không có tài khoản khả dụng" và "tất cả đều bị loại trừ trong request này"
        if (!pool.hasAnySchedulable()) {
          throw new ApiError({
            type: 'account_pool_exhausted',
            status: 503,
            message: '没有可用的 Microsoft 账号',
          });
        }
        break; // Có tài khoản khả dụng nhưng đều bị loại trừ, thoát vòng lặp để xử lý tập trung bên dưới
      }

      attempts += 1;
      state.accountId = account.id;
      pool.acquire(account.id);
      this.#deps.metrics?.upstreamAttempts.inc({ result: 'started' });

      try {
        // Lấy Token (làm mới nếu cần)
        let accessToken: string;
        try {
          accessToken = await this.#deps.tokens.getAccessToken(account.id);
        } catch (error) {
          if (error instanceof TokenUnavailableError) {
            lastError = error;
            // Bản thân tài khoản không lấy được Token (cần tái ủy quyền, v.v.): loại trừ và đổi tài khoản
            excluded.add(account.id);
            logger.warn({ account_id: account.id, reason: error.reason }, '账号 Token 不可用，切换');
            continue;
          }
          throw error;
        }

        const url = buildUpstreamUrl({
          config: this.#deps.config,
          oid: account.oid,
          tid: account.tid,
          accessToken,
        });

        // Ưu tiên đầu ra liên kết của tài khoản: Kết nối dài của cùng một tài khoản đi cố định qua cùng một proxy, tránh đổi đầu ra mạng liên tục
        const proxyUrl = this.#deps.resolveProxyForAccount?.(account.id) ?? this.#deps.proxyUrl ?? null;
        const connection = (this.#deps.connectionFactory ?? defaultConnectionFactory)({
          config: this.#deps.config,
          codec: this.#deps.codec,
          logger,
          proxyUrl,
          noProxy: this.#deps.noProxy ?? null,
        });

        const invocationId = randomUUID();
        let retriedAfterRefresh = false;

        try {
          for await (const event of connection.run({
            url,
            invocationId,
            text: request.text,
            conversationRef: state.conversationRef ?? undefined,
            oid: account.oid,
            passthrough: request.passthrough,
            tools: request.tools,
            toolResults: request.toolResults,
            signal: request.signal,
          })) {
            // Văn bản, suy luận, gọi công cụ đều tính là "đã xuất nội dung" — thất bại sau đó sẽ không đổi tài khoản nữa,
            // tránh việc lệnh gọi công cụ có tác dụng phụ bị phát lại thực thi qua tài khoản khác (§M5)
            if (
              event.kind === 'text_delta' ||
              event.kind === 'reasoning_delta' ||
              event.kind === 'tool_call_begin'
            ) {
              emittedContent = true;
            }
            if (event.kind === 'upstream_error' && !event.retryable) {
              // Upstream báo lỗi không thể thử lại trong luồng
              this.#deps.accounts.recordFailure(account.id, 'upstream_error');
            }
            yield event;
          }
          // Chạy xong bình thường
          this.#deps.accounts.recordSuccess(account.id);
          this.#deps.metrics?.upstreamAttempts.inc({ result: 'success' });
          return;
        } catch (error) {
          const upstreamError =
            error instanceof UpstreamError
              ? error
              : new UpstreamError(
                  `未分类上游错误：${error instanceof Error ? error.message : String(error)}`,
                  'unknown',
                  { cause: error },
                );
          lastError = upstreamError;
          this.#deps.metrics?.upstreamAttempts.inc({ result: 'error' });
          this.#deps.metrics?.upstreamErrors.inc({ disposition: upstreamError.disposition });

          // Đã xuất nội dung thì không thể chuyển đổi sạch sẽ, ném lỗi trực tiếp
          if (emittedContent) {
            this.#deps.accounts.recordFailure(account.id, upstreamError.disposition);
            throw this.#toApiError(upstreamError);
          }

          // Request có tác dụng phụ (gửi lại kết quả công cụ) cấm phát lại qua tài khoản khác: Cho dù chưa xuất nội dung,
          // việc đổi tài khoản gửi lại cũng có thể khiến công cụ tác dụng phụ đã thực thi bị chạy lại lần nữa, nên báo thất bại trực tiếp
          if (request.sideEffect === true) {
            this.#deps.accounts.recordFailure(account.id, upstreamError.disposition);
            throw this.#toApiError(upstreamError);
          }

          const decision = this.#applyDisposition(account.id, upstreamError, excluded);
          if (decision === 'fatal') {
            throw this.#toApiError(upstreamError);
          }
          if (decision === 'refresh_retry' && !retriedAfterRefresh) {
            // 401: Làm mới một lần, thử lại một lần trên cùng tài khoản (không loại trừ)
            retriedAfterRefresh = true;
            try {
              await this.#deps.tokens.refresh(account.id);
              attempts -= 1; // Lần thử lại sau khi refresh này không tính vào trần số lần thử
            } catch {
              excluded.add(account.id);
            }
          }
          continue;
        } finally {
          pool.release(account.id);
        }
      } catch (outerError) {
        pool.release(account.id);
        throw outerError;
      }
    }

    // Đã hết số lần thử hoặc tất cả tài khoản đều bị loại trừ
    if (lastError !== null) {
      if (lastError instanceof UpstreamError) throw this.#toApiError(lastError);
      throw new ApiError({
        type: 'account_pool_exhausted',
        status: 503,
        message: '所有候选账号均不可用',
      });
    }
    throw new ApiError({
      type: 'account_pool_exhausted',
      status: 503,
      message: '没有可用的 Microsoft 账号',
    });
  }

  /**
   * Cập nhật trạng thái tài khoản theo phân loại lỗi và quyết định hành động tiếp theo.
   * Trả về 'switch' đổi tài khoản / 'refresh_retry' làm mới thử lại cùng tài khoản / 'fatal' thất bại trực tiếp.
   */
  #applyDisposition(
    accountId: string,
    error: UpstreamError,
    excluded: Set<string>,
    now = Date.now(),
  ): 'switch' | 'refresh_retry' | 'fatal' {
    const { accounts } = this.#deps;
    switch (error.disposition) {
      case 'refresh_and_retry':
        accounts.recordFailure(accountId, 'unauthorized');
        return 'refresh_retry';
      case 'account_forbidden':
        accounts.recordFailure(accountId, 'forbidden', {
          cooldownUntil: now + this.#defaultCooldownMs,
        });
        excluded.add(accountId);
        return 'switch';
      case 'rate_limited':
        accounts.recordFailure(accountId, 'rate_limited', {
          cooldownUntil: now + (error.retryAfterMs ?? this.#defaultCooldownMs),
        });
        excluded.add(accountId);
        return 'switch';
      case 'retry_or_switch':
      case 'unknown':
        accounts.recordFailure(accountId, 'upstream_error');
        excluded.add(accountId);
        return 'switch';
      case 'fatal_client':
        return 'fatal';
    }
  }

  #toApiError(error: UpstreamError): ApiError {
    const isTimeout = error.disposition === 'retry_or_switch' && error.statusCode === null;
    return new ApiError({
      type: isTimeout ? 'upstream_timeout' : 'upstream_error',
      status: 502,
      message: error.message,
      details: { disposition: error.disposition, status_code: error.statusCode },
    });
  }
}

function defaultConnectionFactory(deps: ConnectionDeps): SydneyConnection {
  return new SydneyConnection(deps);
}
