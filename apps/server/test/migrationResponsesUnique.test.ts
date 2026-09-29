import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';

/**
 * Migration v8: Nới lỏng ràng buộc UNIQUE (api_key_id, idempotency_key) của bảng responses (§18).
 *
 * Bối cảnh: Khi M003 tạo bảng đã đặt ràng buộc duy nhất này trực tiếp lên bảng responses, là chỗ giữ trước khi có "ngữ nghĩa hoàn chỉnh ở M7";
 * M7 gom việc đảm bảo tính duy nhất của idempotency về bảng idempotency_keys độc lập, ràng buộc cấp bảng này
 * lại xung đột với "yêu cầu stream thực thi xong giải phóng key, cùng key có thể thực thi lại" (lần INSERT thứ hai đụng ràng buộc cũ).
 * Ở đây xác minh: Đường dẫn nâng cấp giữ lại dữ liệu cũ, tham chiếu khóa ngoại không bị ảnh hưởng, và ràng buộc thực sự được nới lỏng.
 */

function seedUpToV7(db: Database, apiKeyId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO api_keys (id, name, prefix, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(apiKeyId, '测试 Key', 'sk-test', 'salt', 'hash', now);
  db.prepare(
    `INSERT INTO responses (
       id, api_key_id, status, requested_model, previous_response_id, idempotency_key,
       tool_round, tool_calls_total, created_at, updated_at
     ) VALUES (?, ?, 'completed', 'gpt-5-codex', NULL, ?, 0, 0, ?, ?)`,
  ).run('resp_old_1', apiKeyId, 'idem-legacy', now, now);
  db.prepare(
    `INSERT INTO tool_calls (id, response_id, call_id, name, status, side_effect, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'completed', 0, ?, ?)`,
  ).run('tc_1', 'resp_old_1', 'call_1', 'shell', now, now);
  db.prepare(
    `INSERT INTO conversation_bindings (response_id, account_id, upstream_conversation_ref, created_at)
     VALUES (?, NULL, NULL, ?)`,
  ).run('resp_old_1', now);
}

describe('迁移 v8：放宽 responses 的幂等键唯一约束', () => {
  it('升级后旧数据（含关联的 tool_calls、conversation_bindings）原样保留', () => {
    const db = openDatabase(':memory:');
    // Chạy trước đến v7 (chưa gồm v8), sau đó chèn thủ công dữ liệu cũ mô phỏng
    const v7Only = MIGRATIONS.filter((m) => m.version <= 7);
    runMigrations(db, v7Only);
    seedUpToV7(db, 'ak_1');

    // Sau đó bổ sung v8
    runMigrations(db, MIGRATIONS);

    const response = db.prepare('SELECT * FROM responses WHERE id = ?').get('resp_old_1') as {
      idempotency_key: string;
      status: string;
    };
    expect(response.idempotency_key).toBe('idem-legacy');
    expect(response.status).toBe('completed');

    const toolCall = db.prepare('SELECT * FROM tool_calls WHERE id = ?').get('tc_1') as {
      response_id: string;
    };
    expect(toolCall.response_id).toBe('resp_old_1');

    const binding = db
      .prepare('SELECT * FROM conversation_bindings WHERE response_id = ?')
      .get('resp_old_1') as { response_id: string } | undefined;
    expect(binding).toBeDefined();

    db.close();
  });

  it('升级后同一个 (api_key_id, idempotency_key) 允许出现第二条记录', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO api_keys (id, name, prefix, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ak_2', '测试 Key 2', 'sk-test2', 'salt', 'hash', now);

    db.prepare(
      `INSERT INTO responses (
         id, api_key_id, status, requested_model, idempotency_key, tool_round, tool_calls_total, created_at, updated_at
       ) VALUES (?, ?, 'completed', 'gpt-5-codex', 'same-key', 0, 0, ?, ?)`,
    ).run('resp_a', 'ak_2', now, now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO responses (
             id, api_key_id, status, requested_model, idempotency_key, tool_round, tool_calls_total, created_at, updated_at
           ) VALUES (?, ?, 'completed', 'gpt-5-codex', 'same-key', 0, 0, ?, ?)`,
        )
        .run('resp_b', 'ak_2', now, now),
    ).not.toThrow();

    db.close();
  });

  it('迁移后 responses 表仍保留按 api_key_id、status 的索引（查询路径不退化）', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'responses'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_responses_api_key', 'idx_responses_status']));
    db.close();
  });
});
