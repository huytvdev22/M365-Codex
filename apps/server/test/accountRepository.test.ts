import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_STATUSES, type AccountStatus } from '@m365-codex/shared';
import { loadConfig } from '../src/config/index.js';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import {
  AccountRepository,
  canTransition,
  InvalidStateTransitionError,
} from '../src/repo/accounts.js';
import { testEnv } from './helpers/testApp.js';

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function createRepo(): AccountRepository {
  const config = loadConfig(testEnv());
  db = openDatabase(':memory:');
  runMigrations(db);
  return new AccountRepository(db, new Cryptor(config.masterKey, config.masterKeyVersion));
}

function seed(repo: AccountRepository, overrides: Partial<{ tid: string; oid: string }> = {}) {
  return repo.upsert({
    tid: overrides.tid ?? 'tenant-1',
    oid: overrides.oid ?? 'user-1',
    email: 'user@office.example.invalid',
    displayName: '测试用户',
    source: 'oauth',
    tokens: {
      accessToken: 'access-token-plaintext',
      refreshToken: 'refresh-token-plaintext',
      expiresAt: Date.now() + 3600_000,
    },
  });
}

describe('upsert', () => {
  it('按 (tid, oid) 去重：同一账号重复写入只更新', () => {
    const repo = createRepo();
    const first = seed(repo);
    const second = seed(repo);
    expect(second.id).toBe(first.id);
    expect(repo.listViews()).toHaveLength(1);
  });

  it('不同 oid 视为不同账号', () => {
    const repo = createRepo();
    seed(repo, { oid: 'user-1' });
    seed(repo, { oid: 'user-2' });
    expect(repo.listViews()).toHaveLength(2);
  });

  it('同一 oid 在不同租户下视为不同账号', () => {
    const repo = createRepo();
    seed(repo, { tid: 'tenant-1', oid: 'same-oid' });
    seed(repo, { tid: 'tenant-2', oid: 'same-oid' });
    expect(repo.listViews()).toHaveLength(2);
  });

  it('Token 加密存储，库中查不到明文', () => {
    const repo = createRepo();
    const view = seed(repo);
    const raw = JSON.stringify(db!.prepare('SELECT * FROM account_tokens').all());
    expect(raw).not.toContain('access-token-plaintext');
    expect(raw).not.toContain('refresh-token-plaintext');
    expect(repo.readAccessToken(view.id)?.token).toBe('access-token-plaintext');
    expect(repo.readRefreshToken(view.id)).toBe('refresh-token-plaintext');
  });

  it('access 与 refresh 使用不同 nonce', () => {
    const repo = createRepo();
    seed(repo);
    const row = db!.prepare('SELECT access_nonce, refresh_nonce FROM account_tokens').get() as {
      access_nonce: Uint8Array;
      refresh_nonce: Uint8Array;
    };
    expect(Buffer.from(row.access_nonce).toString('hex')).not.toBe(
      Buffer.from(row.refresh_nonce).toString('hex'),
    );
  });

  it('密文绑定到账号：换个账号 ID 解不开', () => {
    const repo = createRepo();
    const a = seed(repo, { oid: 'user-a' });
    const b = seed(repo, { oid: 'user-b' });
    // Chuyển bản mã của a sang dòng của b, AAD không khớp phải dẫn đến giải mã thất bại
    const rowA = db!
      .prepare('SELECT access_token_enc, access_nonce FROM account_tokens WHERE account_id = ?')
      .get(a.id) as { access_token_enc: Uint8Array; access_nonce: Uint8Array };
    db!
      .prepare('UPDATE account_tokens SET access_token_enc = ?, access_nonce = ? WHERE account_id = ?')
      .run(rowA.access_token_enc, rowA.access_nonce, b.id);
    expect(() => repo.readAccessToken(b.id)).toThrow(/解密失败/);
  });

  it('重新授权把账号拉回 probing，但不会自动启用已停用账号', () => {
    const repo = createRepo();
    const view = seed(repo);
    repo.forceStatus(view.id, 'disabled');
    expect(seed(repo).status).toBe('disabled');

    repo.forceStatus(view.id, 'online');
    expect(seed(repo).status).toBe('probing');
  });

  it('新账号自动建立健康度记录', () => {
    const repo = createRepo();
    const view = seed(repo);
    expect(view.consecutive_failures).toBe(0);
    expect(view.cooldown_until).toBeNull();
  });
});

describe('replaceTokens', () => {
  it('只换 Token，不动身份字段', () => {
    const repo = createRepo();
    const view = seed(repo);
    repo.replaceTokens(view.id, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 7200_000,
    });
    const after = repo.getView(view.id);
    expect(after?.email).toBe(view.email);
    expect(repo.readAccessToken(view.id)?.token).toBe('new-access');
    expect(repo.readRefreshToken(view.id)).toBe('new-refresh');
  });

  it('refreshToken 传 null 时保留原值', () => {
    const repo = createRepo();
    const view = seed(repo);
    repo.replaceTokens(view.id, { accessToken: 'new-access', refreshToken: null, expiresAt: null });
    expect(repo.readRefreshToken(view.id)).toBe('refresh-token-plaintext');
  });
});

describe('状态机', () => {
  it('允许的迁移能通过', () => {
    const repo = createRepo();
    const view = seed(repo);
    expect(repo.setStatus(view.id, 'online').status).toBe('online');
    expect(repo.setStatus(view.id, 'busy').status).toBe('busy');
    expect(repo.setStatus(view.id, 'cooldown').status).toBe('cooldown');
    expect(repo.setStatus(view.id, 'online').status).toBe('online');
  });

  it('停用的账号不能被直接改成 online', () => {
    const repo = createRepo();
    const view = seed(repo);
    repo.forceStatus(view.id, 'disabled');
    expect(() => repo.setStatus(view.id, 'online')).toThrow(InvalidStateTransitionError);
    // Chỉ có thể quay về probing để thăm dò lại
    expect(repo.setStatus(view.id, 'probing').status).toBe('probing');
  });

  it('busy 不能直接跳到 probing', () => {
    const repo = createRepo();
    const view = seed(repo);
    repo.setStatus(view.id, 'online');
    repo.setStatus(view.id, 'busy');
    expect(() => repo.setStatus(view.id, 'probing')).toThrow(InvalidStateTransitionError);
  });

  it('迁移到自身总是允许的', () => {
    for (const status of ACCOUNT_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it('每个状态都定义了迁移规则', () => {
    for (const from of ACCOUNT_STATUSES) {
      const reachable = ACCOUNT_STATUSES.filter(
        (to: AccountStatus) => to !== from && canTransition(from, to),
      );
      expect(reachable.length).toBeGreaterThan(0);
    }
  });
});

describe('健康度', () => {
  it('记录失败会累加计数并写入冷却时间', () => {
    const repo = createRepo();
    const view = seed(repo);
    const cooldownUntil = Date.now() + 60_000;
    repo.recordFailure(view.id, 'rate_limited', { cooldownUntil });
    repo.recordFailure(view.id, 'rate_limited', { cooldownUntil });

    const after = repo.getView(view.id);
    expect(after?.consecutive_failures).toBe(2);
    expect(after?.cooldown_until).toBe(cooldownUntil);
    expect(after?.last_error_type).toBe('rate_limited');
  });

  it('记录成功会清空失败计数与冷却', () => {
    const repo = createRepo();
    const view = seed(repo);
    repo.recordFailure(view.id, 'upstream_error', { cooldownUntil: Date.now() + 60_000 });
    repo.recordSuccess(view.id);

    const after = repo.getView(view.id);
    expect(after?.consecutive_failures).toBe(0);
    expect(after?.cooldown_until).toBeNull();
    expect(after?.last_error_type).toBeNull();
    expect(after?.last_ok_at).toBeTypeOf('number');
  });
});

describe('删除', () => {
  it('删除账号会级联清掉 Token 与健康度', () => {
    const repo = createRepo();
    const view = seed(repo);
    expect(repo.remove(view.id)).toBe(true);
    expect(db!.prepare('SELECT COUNT(*) AS c FROM account_tokens').get()).toEqual({ c: 0 });
    expect(db!.prepare('SELECT COUNT(*) AS c FROM account_health').get()).toEqual({ c: 0 });
  });

  // Đã gặp khi thực nghiệm thực tế: Khi tài khoản đã từng phục vụ yêu cầu, responses.account_id và
  // conversation_bindings.account_id là hai khóa ngoại thông thường sẽ ghim chặt nó, xóa sẽ bị 500 ngay
  it('账号服务过请求后仍能删除：历史记录留下、粘性绑定清掉', () => {
    const repo = createRepo();
    const view = seed(repo);

    db!
      .prepare(
        `INSERT INTO responses (id, api_key_id, account_id, status, created_at, updated_at)
         VALUES ('resp_1', NULL, ?, 'completed', 1, 1)`,
      )
      .run(view.id);
    db!
      .prepare(
        `INSERT INTO conversation_bindings (response_id, account_id, upstream_conversation_ref, created_at)
         VALUES ('resp_1', ?, 'conv-1', 1)`,
      )
      .run(view.id);

    expect(repo.remove(view.id)).toBe(true);

    // Yêu cầu thực sự đã diễn ra, bản ghi cần được giữ; chỉ là không còn biết tài khoản nào đảm nhận
    const response = db!.prepare('SELECT account_id, status FROM responses WHERE id = ?').get('resp_1') as {
      account_id: string | null;
      status: string;
    };
    expect(response.status).toBe('completed');
    expect(response.account_id).toBeNull();
    // Binding mất tài khoản thì không còn ý nghĩa, không giữ lại dòng rác (zombie)
    expect(db!.prepare('SELECT COUNT(*) AS c FROM conversation_bindings').get()).toEqual({ c: 0 });
  });

  it('删除失败时整体回滚，不会留下半删状态', () => {
    const repo = createRepo();
    const view = seed(repo);
    // Xóa một ID không tồn tại: không ảnh hưởng tài khoản hiện có và không được ném lỗi
    expect(repo.remove('not-a-real-account')).toBe(false);
    expect(repo.getView(view.id)).toBeDefined();
    expect(db!.prepare('SELECT COUNT(*) AS c FROM account_tokens').get()).toEqual({ c: 1 });
  });
});

describe('视图', () => {
  it('账号视图中不含任何 Token 字段', () => {
    const repo = createRepo();
    const view = seed(repo);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('access-token-plaintext');
    expect(serialized).not.toContain('refresh-token-plaintext');
    expect(Object.keys(view)).not.toContain('accessToken');
    expect(view.has_refresh_token).toBe(true);
  });
});
