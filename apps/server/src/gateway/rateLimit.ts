import { ApiError } from '@m365-codex/shared';
import type { RateLimitConfig } from '../config/index.js';
import type { ApiKeyRow } from '../repo/apiKeys.js';

/**
 * Giới hạn hạn ngạch cấp API Key (tương ứng kế hoạch triển khai §10, hợp đồng §2.3).
 *
 * Quy tắc thép (§10 câu cuối): **Giới hạn cấp API Key không được vượt trần toàn cục**. Cách thức áp dụng rất trực tiếp —
 * Hạn ngạch hiệu lực luôn là `min(thiết lập riêng của Key, trần toàn cục)`; khi Key không thiết lập (null = không giới hạn)
 * thì dùng thẳng trần toàn cục làm chặn dưới, chứ không thực sự thả nổi không giới hạn.
 *
 * Bộ đếm đồng thời chỉ được duy trì trong tiến trình (bộ đếm `#concurrent`), comment nói rõ tiền đề này trước:
 * Trong triển khai một container thì đây chính là concurrency thực tế toàn cục; một khi chạy đa bản sao (multi-replica),
 * mỗi bản sao tự tính riêng, sẽ xuất hiện tình huống "tổng concurrency có vẻ vượt giới hạn" — mở rộng ngang đa bản sao không nằm trong phạm vi kiến trúc hiện tại.
 */

export interface EffectiveLimits {
  rpmLimit: number;
  dailyLimit: number;
  maxConcurrency: number;
}

export type ConsumeResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'rpm' | 'daily' | 'concurrency'; retryAfterSeconds: number };

interface KeyState {
  minuteWindowStart: number;
  minuteCount: number;
  dayWindowStart: number;
  dayCount: number;
  concurrent: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class RateLimiter {
  readonly #global: RateLimitConfig;
  readonly #states = new Map<string, KeyState>();

  constructor(global: RateLimitConfig) {
    this.#global = global;
  }

  /** Kết hợp thiết lập của bản thân Key với trần toàn cục, vĩnh viễn không vượt quá giới hạn trần toàn cục. */
  effectiveLimits(key: ApiKeyRow): EffectiveLimits {
    return {
      rpmLimit: clampToCeiling(key.rpm_limit, this.#global.globalRpmLimit),
      dailyLimit: clampToCeiling(key.daily_limit, this.#global.globalDailyLimit),
      maxConcurrency: clampToCeiling(key.max_concurrency, this.#global.globalMaxConcurrency),
    };
  }

  /**
   * Xác thực phạm vi endpoint và model (§10). Khi không khớp trả về nguyên nhân rõ ràng, bên gọi chuyển thành 403.
   * `allowed_endpoints` / `allowed_models` là `null` biểu thị không giới hạn; một khi đã thiết lập (dù là mảng rỗng)
   * sẽ trở thành whitelist, không nằm trong danh sách đều bị từ chối.
   */
  checkEndpointAndModel(
    parsed: { endpoints: string[] | null; models: string[] | null },
    endpoint: string,
    model: string | null,
  ): void {
    if (parsed.endpoints !== null && !parsed.endpoints.includes(endpoint)) {
      throw ApiError.forbidden(`API Key này chưa được cấp quyền truy cập endpoint ${endpoint}`);
    }
    if (model !== null && parsed.models !== null && !parsed.models.includes(model)) {
      throw ApiError.forbidden(`API Key này chưa được cấp quyền sử dụng mô hình ${model}`);
    }
  }

  /** Thử tiêu thụ 1 lượt quota; vượt hạn mức trả về kết quả thất bại kèm `retryAfterSeconds`, bên gọi chuyển thành 429. */
  consume(keyId: string, limits: EffectiveLimits, now = Date.now()): ConsumeResult {
    const state = this.#stateFor(keyId, now);

    if (state.concurrent >= limits.maxConcurrency) {
      return { ok: false, reason: 'concurrency', retryAfterSeconds: 1 };
    }
    if (state.minuteCount >= limits.rpmLimit) {
      return {
        ok: false,
        reason: 'rpm',
        retryAfterSeconds: Math.max(1, Math.ceil((state.minuteWindowStart + MINUTE_MS - now) / 1000)),
      };
    }
    if (state.dayCount >= limits.dailyLimit) {
      return {
        ok: false,
        reason: 'daily',
        retryAfterSeconds: Math.max(1, Math.ceil((state.dayWindowStart + DAY_MS - now) / 1000)),
      };
    }

    state.minuteCount += 1;
    state.dayCount += 1;
    state.concurrent += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return; // Ngăn ngừa bên gọi release lặp lại làm giảm âm bộ đếm
        released = true;
        state.concurrent = Math.max(0, state.concurrent - 1);
      },
    };
  }

  /** Dành cho test và khả năng quan sát (observability) xem trạng thái trong tiến trình hiện tại. */
  snapshot(keyId: string): Readonly<KeyState> | undefined {
    return this.#states.get(keyId);
  }

  #stateFor(keyId: string, now: number): KeyState {
    let state = this.#states.get(keyId);
    if (state === undefined) {
      state = { minuteWindowStart: now, minuteCount: 0, dayWindowStart: now, dayCount: 0, concurrent: 0 };
      this.#states.set(keyId, state);
      return state;
    }
    if (now - state.minuteWindowStart >= MINUTE_MS) {
      state.minuteWindowStart = now;
      state.minuteCount = 0;
    }
    if (now - state.dayWindowStart >= DAY_MS) {
      state.dayWindowStart = now;
      state.dayCount = 0;
    }
    return state;
  }
}

/**
 * Hạn ngạch hiệu lực luôn là `min(thiết lập riêng của Key, trần toàn cục)`; khi Key không đặt (null) thì dùng thẳng
 * trần toàn cục làm chặn dưới. Ngoài rpm/daily/concurrency, `max_tool_calls`/`max_file_bytes`
 * (§10.1) cũng tái sử dụng cùng quy tắc cắt tỉa này, export cho `gateway/auth.ts` sử dụng.
 */
export function clampToCeiling(keyLimit: number | null, globalCeiling: number): number {
  if (keyLimit === null) return globalCeiling;
  return Math.min(keyLimit, globalCeiling);
}
