import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { ApiKeyRepository } from '../src/repo/apiKeys.js';

/**
 * Các trường bổ sung của repository API Key (kế hoạch §10.1): Ghi chú, số lần yêu cầu tích lũy, mức siết chặt
 * trần gọi công cụ / dung lượng upload theo Key. Bốn mục này trước đó chưa làm — ở đây chỉ test tầng truy cập dữ liệu;
 * logic cắt giảm "không được vượt qua trần toàn cục" thuộc về gateway/auth.ts, xem gatewayAuth.test.ts.
 */

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function setup(): ApiKeyRepository {
  db = openDatabase(':memory:');
  runMigrations(db);
  return new ApiKeyRepository(db);
}

describe('创建', () => {
  it('不传补充字段时默认为 null / 0', () => {
    const repo = setup();
    const created = repo.create({ name: 'k' });
    expect(created.note).toBeNull();
    expect(created.request_count).toBe(0);
    expect(created.max_tool_calls).toBeNull();
    expect(created.max_file_bytes).toBeNull();
  });

  it('可以在创建时写入备注与限制', () => {
    const repo = setup();
    const created = repo.create({ name: 'k', note: '备注文本', maxToolCalls: 5, maxFileBytes: 2048 });
    expect(created.note).toBe('备注文本');
    expect(created.max_tool_calls).toBe(5);
    expect(created.max_file_bytes).toBe(2048);
  });
});

describe('list / getRowById', () => {
  it('列表与单条读取都带上这四个字段', () => {
    const repo = setup();
    repo.create({ name: 'k', note: 'n', maxToolCalls: 1, maxFileBytes: 2 });
    const [view] = repo.list();
    expect(view?.note).toBe('n');
    expect(view?.max_tool_calls).toBe(1);
    expect(view?.max_file_bytes).toBe(2);

    const row = repo.getRowById(view!.id);
    expect(row?.request_count).toBe(0);
  });
});

describe('update', () => {
  it('可以单独更新备注/限制，不传的字段保持原值', () => {
    const repo = setup();
    const created = repo.create({ name: 'k', note: '旧备注', maxToolCalls: 1, maxFileBytes: 2 });

    const updated = repo.update(created.id, { note: '新备注' });
    expect(updated?.note).toBe('新备注');
    expect(updated?.max_tool_calls).toBe(1); // Không truyền, giữ nguyên giá trị ban đầu
    expect(updated?.max_file_bytes).toBe(2);

    const cleared = repo.update(created.id, { maxToolCalls: null, maxFileBytes: null });
    expect(cleared?.max_tool_calls).toBeNull();
    expect(cleared?.max_file_bytes).toBeNull();
  });
});

describe('touch', () => {
  it('每次调用把 request_count 累加 1，并与 last_used_at 一起写（不额外多一次落库）', () => {
    const repo = setup();
    const created = repo.create({ name: 'k' });

    repo.touch(created.id, '1.2.3.4');
    repo.touch(created.id, '1.2.3.4');
    repo.touch(created.id, '5.6.7.8');

    const row = repo.getRowById(created.id);
    expect(row?.request_count).toBe(3);
    expect(row?.last_used_ip).toBe('5.6.7.8');
    expect(row?.last_used_at).toBeTypeOf('number');
  });

  it('不同 Key 的计数互不影响', () => {
    const repo = setup();
    const a = repo.create({ name: 'a' });
    const b = repo.create({ name: 'b' });

    repo.touch(a.id, null);
    repo.touch(a.id, null);
    repo.touch(b.id, null);

    expect(repo.getRowById(a.id)?.request_count).toBe(2);
    expect(repo.getRowById(b.id)?.request_count).toBe(1);
  });
});
