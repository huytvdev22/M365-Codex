import { afterEach, describe, expect, it } from 'vitest';
import type { AccountStatus } from '@m365-codex/shared';
import { loadConfig } from '../src/config/index.js';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { AccountRepository } from '../src/repo/accounts.js';
import { AccountPool } from '../src/scheduler/accountPool.js';
import { testEnv } from './helpers/testApp.js';

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function setup(): { accounts: AccountRepository; pool: AccountPool } {
  const config = loadConfig(testEnv());
  db = openDatabase(':memory:');
  runMigrations(db);
  const accounts = new AccountRepository(db, new Cryptor(config.masterKey, config.masterKeyVersion));
  return { accounts, pool: new AccountPool(accounts) };
}

function seed(accounts: AccountRepository, oid: string, status: AccountStatus = 'online'): string {
  const view = accounts.upsert({
    tid: 'tenant-1',
    oid,
    email: `${oid}@office.example.invalid`,
    displayName: oid,
    source: 'oauth',
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  });
  if (status !== 'probing') accounts.forceStatus(view.id, status);
  return view.id;
}

describe('pick 基本可用性', () => {
  it('空池返回 null', () => {
    const { pool } = setup();
    expect(pool.pick()).toBeNull();
    expect(pool.hasAnySchedulable()).toBe(false);
  });

  it('只选可调度状态的账号', () => {
    const { accounts, pool } = setup();
    seed(accounts, 'disabled-one', 'disabled');
    seed(accounts, 'reauth-one', 'reauth_required');
    const onlineId = seed(accounts, 'online-one', 'online');
    expect(pool.pick()?.id).toBe(onlineId);
  });

  it('probing 与 busy 也可被调度', () => {
    const { accounts, pool } = setup();
    seed(accounts, 'p', 'probing');
    expect(pool.pick()).not.toBeNull();
    const { accounts: a2, pool: p2 } = setup();
    seed(a2, 'b', 'busy');
    expect(p2.pick()).not.toBeNull();
  });

  it('冷却中的账号被跳过', () => {
    const { accounts, pool } = setup();
    const id = seed(accounts, 'cooling', 'online');
    accounts.recordFailure(id, 'rate_limited', { cooldownUntil: Date.now() + 60_000 });
    expect(pool.pick()).toBeNull();
    // Có thể chọn lại sau khi hết thời gian làm nguội
    expect(pool.pick({ now: Date.now() + 61_000 })?.id).toBe(id);
  });
});

describe('带权最少连接', () => {
  it('优先选活跃连接最少的账号', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    const b = seed(accounts, 'b');
    pool.acquire(a);
    pool.acquire(a);
    pool.acquire(b);
    expect(pool.pick()?.id).toBe(b);
  });

  it('连接数并列时选连续失败少的', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    const b = seed(accounts, 'b');
    accounts.recordFailure(a, 'upstream_error');
    expect(pool.pick()?.id).toBe(b);
  });

  it('acquire/release 正确增减计数', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    pool.acquire(a);
    pool.acquire(a);
    expect(pool.activeCount(a)).toBe(2);
    pool.release(a);
    expect(pool.activeCount(a)).toBe(1);
    pool.release(a);
    expect(pool.activeCount(a)).toBe(0);
  });
});

describe('排除与粘性', () => {
  it('排除集里的账号不会被选', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    const b = seed(accounts, 'b');
    expect(pool.pick({ exclude: new Set([a]) })?.id).toBe(b);
  });

  it('prefer 命中且可用时直接返回它，即使连接更多', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    seed(accounts, 'b');
    pool.acquire(a);
    pool.acquire(a);
    // Dù a có nhiều kết nối hơn, ưu tiên tính dính (stickiness)
    expect(pool.pick({ prefer: a })?.id).toBe(a);
  });

  it('prefer 不可用时回退到常规选择', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    const b = seed(accounts, 'b');
    accounts.recordFailure(a, 'rate_limited', { cooldownUntil: Date.now() + 60_000 });
    expect(pool.pick({ prefer: a })?.id).toBe(b);
  });

  it('全部被排除时返回 null，但 hasAnySchedulable 仍为真', () => {
    const { accounts, pool } = setup();
    const a = seed(accounts, 'a');
    const b = seed(accounts, 'b');
    expect(pool.pick({ exclude: new Set([a, b]) })).toBeNull();
    expect(pool.hasAnySchedulable()).toBe(true);
  });
});
