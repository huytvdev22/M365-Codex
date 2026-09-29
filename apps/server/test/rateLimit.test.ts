import { describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import { RateLimiter } from '../src/gateway/rateLimit.js';
import type { ApiKeyRow } from '../src/repo/apiKeys.js';

/**
 * Hạn ngạch cấp API Key (§10): Hạn ngạch hiệu lực luôn là min(thiết lập của Key, trần toàn cục),
 * vượt hạn ngạch trả về retryAfterSeconds khả dụng, không khớp whitelist endpoint/model sẽ đưa ra lý do từ chối rõ ràng.
 */

function makeKey(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'key_1',
    name: '测试 Key',
    prefix: 'sk-test',
    salt: 'salt',
    hash: 'hash',
    enabled: 1,
    revoked_at: null,
    starts_at: null,
    expires_at: null,
    rpm_limit: null,
    daily_limit: null,
    max_concurrency: null,
    allowed_endpoints: null,
    allowed_models: null,
    created_at: 0,
    last_used_at: null,
    last_used_ip: null,
    note: null,
    request_count: 0,
    max_tool_calls: null,
    max_file_bytes: null,
    ...overrides,
  };
}

describe('有效限额不得突破全局上限', () => {
  it('Key 未设置限额时直接用全局天花板兜底', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 10, globalDailyLimit: 100, globalMaxConcurrency: 3 });
    const limits = limiter.effectiveLimits(makeKey());
    expect(limits).toEqual({ rpmLimit: 10, dailyLimit: 100, maxConcurrency: 3 });
  });

  it('Key 设置的值比全局更严时保留 Key 的值', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 100, globalDailyLimit: 1000, globalMaxConcurrency: 10 });
    const limits = limiter.effectiveLimits(makeKey({ rpm_limit: 5, daily_limit: 50, max_concurrency: 2 }));
    expect(limits).toEqual({ rpmLimit: 5, dailyLimit: 50, maxConcurrency: 2 });
  });

  it('Key 设置的值比全局更松时被裁剪到全局上限，不允许突破', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 10, globalDailyLimit: 100, globalMaxConcurrency: 3 });
    const limits = limiter.effectiveLimits(makeKey({ rpm_limit: 999, daily_limit: 999, max_concurrency: 999 }));
    expect(limits).toEqual({ rpmLimit: 10, dailyLimit: 100, maxConcurrency: 3 });
  });
});

describe('consume：每分钟请求数', () => {
  it('超过 RPM 限额返回 429 语义与 retryAfterSeconds', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 999 });
    const limits = { rpmLimit: 2, dailyLimit: 999, maxConcurrency: 999 };
    const now = 1_000_000;
    const r1 = limiter.consume('k1', limits, now);
    const r2 = limiter.consume('k1', limits, now + 100);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const r3 = limiter.consume('k1', limits, now + 200);
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.reason).toBe('rpm');
      expect(r3.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('窗口过后重新计数', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 999 });
    const limits = { rpmLimit: 1, dailyLimit: 999, maxConcurrency: 999 };
    const now = 0;
    expect(limiter.consume('k1', limits, now).ok).toBe(true);
    expect(limiter.consume('k1', limits, now + 1000).ok).toBe(false);
    expect(limiter.consume('k1', limits, now + 61_000).ok).toBe(true);
  });
});

describe('consume：每日配额', () => {
  it('超过日配额返回 daily 原因', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 999 });
    const limits = { rpmLimit: 999, dailyLimit: 1, maxConcurrency: 999 };
    const now = 0;
    expect(limiter.consume('k1', limits, now).ok).toBe(true);
    const second = limiter.consume('k1', limits, now + 10);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('daily');
  });
});

describe('consume：最大并发', () => {
  it('未 release 前占用并发额度，超过后拒绝；release 后恢复', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 999 });
    const limits = { rpmLimit: 999, dailyLimit: 999, maxConcurrency: 1 };
    const first = limiter.consume('k1', limits, 0);
    expect(first.ok).toBe(true);
    const second = limiter.consume('k1', limits, 1);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('concurrency');

    if (first.ok) first.release();
    const third = limiter.consume('k1', limits, 2);
    expect(third.ok).toBe(true);
  });

  it('release 重复调用是安全的，不会把计数减穿', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 1 });
    const limits = { rpmLimit: 999, dailyLimit: 999, maxConcurrency: 1 };
    const result = limiter.consume('k1', limits, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.release();
      result.release();
    }
    expect(limiter.snapshot('k1')?.concurrent).toBe(0);
  });

  it('不同 Key 互不干扰', () => {
    const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 1 });
    const limits = { rpmLimit: 999, dailyLimit: 999, maxConcurrency: 1 };
    expect(limiter.consume('k1', limits, 0).ok).toBe(true);
    expect(limiter.consume('k2', limits, 0).ok).toBe(true);
  });
});

describe('接口与模型白名单', () => {
  const limiter = new RateLimiter({ globalRpmLimit: 999, globalDailyLimit: 999, globalMaxConcurrency: 999 });

  it('allowed_endpoints 为 null 时不限制', () => {
    expect(() =>
      limiter.checkEndpointAndModel({ endpoints: null, models: null }, 'POST /v1/responses', 'gpt-5-codex'),
    ).not.toThrow();
  });

  it('接口不在白名单内时拒绝，报清晰原因', () => {
    expect(() =>
      limiter.checkEndpointAndModel(
        { endpoints: ['POST /v1/chat/completions'], models: null },
        'POST /v1/responses',
        null,
      ),
    ).toThrow(ApiError);
  });

  it('模型不在白名单内时拒绝', () => {
    expect(() =>
      limiter.checkEndpointAndModel(
        { endpoints: null, models: ['gpt-4o'] },
        'POST /v1/responses',
        'gpt-5-codex',
      ),
    ).toThrow(ApiError);
  });

  it('model 为 null（如 GET 请求）时不检查模型白名单', () => {
    expect(() =>
      limiter.checkEndpointAndModel({ endpoints: null, models: ['gpt-4o'] }, 'GET /v1/models', null),
    ).not.toThrow();
  });
});
