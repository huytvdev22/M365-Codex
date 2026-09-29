import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@m365-codex/shared';
import { fingerprintRequest, IdempotencyStore } from '../src/gateway/idempotency.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';

/**
 * Tính idempotent của yêu cầu (§18). Yêu cầu cốt lõi là **không gửi lặp lại các yêu cầu upstream có thể sinh ra lệnh gọi công cụ**:
 * Gửi lại một lần POST /v1/responses đồng nghĩa với việc mô hình có thể lại quyết định thực thi một công cụ có tác dụng phụ.
 */

let db: Database;
let store: IdempotencyStore;

const KEY = 'client-key-1';
const API_KEY = 'ak_1';
const ENDPOINT = 'POST /v1/responses';

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO api_keys (id, name, prefix, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(API_KEY, '测试 Key', 'sk-test', 'salt', 'hash', Date.now());
  store = new IdempotencyStore(db);
});

afterEach(() => {
  db.close();
});

describe('请求指纹', () => {
  it('字段顺序不同不算不同请求', () => {
    expect(fingerprintRequest({ a: 1, b: [1, 2], c: { d: 'x' } })).toBe(
      fingerprintRequest({ c: { d: 'x' }, b: [1, 2], a: 1 }),
    );
  });

  it('内容不同则指纹不同', () => {
    expect(fingerprintRequest({ input: '你好' })).not.toBe(fingerprintRequest({ input: '你好吗' }));
  });

  it('数组顺序仍然算不同（顺序在语义上有意义）', () => {
    expect(fingerprintRequest([1, 2])).not.toBe(fingerprintRequest([2, 1]));
  });
});

describe('首次与回放', () => {
  it('首次请求返回 fresh，完成后同键回放同一结果', () => {
    const fp = fingerprintRequest({ input: 'hi' });
    expect(store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp })).toEqual({
      fresh: true,
    });

    store.complete({
      key: KEY,
      apiKeyId: API_KEY,
      endpoint: ENDPOINT,
      statusCode: 200,
      body: { id: 'resp_1', status: 'completed' },
      responseId: 'resp_1',
    });

    const again = store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp });
    expect(again.replay?.statusCode).toBe(200);
    expect(again.replay?.responseId).toBe('resp_1');
    expect(again.replay?.body).toEqual({ id: 'resp_1', status: 'completed' });
  });

  it('尚未完成时同键请求被标为处理中，不会再打一次上游', () => {
    const fp = fingerprintRequest({ input: 'hi' });
    store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp });
    expect(store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp })).toEqual({
      inProgress: true,
    });
  });
});

describe('用错幂等键', () => {
  it('同一把键配不同请求体返回 409，而不是回放上一次结果', () => {
    store.begin({
      key: KEY,
      apiKeyId: API_KEY,
      endpoint: ENDPOINT,
      fingerprint: fingerprintRequest({ input: '第一次' }),
    });
    try {
      store.begin({
        key: KEY,
        apiKeyId: API_KEY,
        endpoint: ENDPOINT,
        fingerprint: fingerprintRequest({ input: '第二次' }),
      });
      throw new Error('本应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).type).toBe('idempotency_error');
      expect((error as ApiError).status).toBe(409);
    }
  });
});

describe('作用域', () => {
  it('不同 API Key 用同一个字符串互不干扰', () => {
    db.prepare(
      `INSERT INTO api_keys (id, name, prefix, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ak_2', '另一个 Key', 'sk-other', 'salt', 'hash', Date.now());

    const fp = fingerprintRequest({ input: 'hi' });
    store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp });
    expect(store.begin({ key: KEY, apiKeyId: 'ak_2', endpoint: ENDPOINT, fingerprint: fp })).toEqual({
      fresh: true,
    });
  });

  it('不同端点互不干扰', () => {
    const fp = fingerprintRequest({ input: 'hi' });
    store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp });
    expect(
      store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: 'POST /v1/chat/completions', fingerprint: fp }),
    ).toEqual({ fresh: true });
  });
});

describe('失败释放与清理', () => {
  it('失败释放后同键可以重新执行', () => {
    const fp = fingerprintRequest({ input: 'hi' });
    store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp });
    store.release(KEY, API_KEY, ENDPOINT);
    expect(store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp })).toEqual({
      fresh: true,
    });
  });

  it('已完成的记录不会被 release 误删', () => {
    const fp = fingerprintRequest({ input: 'hi' });
    store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp });
    store.complete({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, statusCode: 200, body: { ok: true } });
    store.release(KEY, API_KEY, ENDPOINT);
    expect(store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp }).replay).toBeDefined();
  });

  it('按时间清理过期记录', () => {
    const fp = fingerprintRequest({ input: 'hi' });
    store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp, now: 1000 });
    expect(store.purgeOlderThan(2000)).toBe(1);
    expect(store.begin({ key: KEY, apiKeyId: API_KEY, endpoint: ENDPOINT, fingerprint: fp })).toEqual({
      fresh: true,
    });
  });
});
