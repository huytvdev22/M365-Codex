import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unpackArchive } from '../src/backup/archive.js';
import { createTestHarness, loginAdmin, type TestHarness } from './helpers/testApp.js';

/**
 * Endpoint Sao lưu / Phục hồi / Chẩn đoán (tương ứng kế hoạch triển khai §15.4, §17, hợp đồng §3).
 * Gói sao lưu phải thực sự ghi ra đĩa, dùng thư mục tạm thật (DATA_DIR không thể là :memory:).
 */

let harness: TestHarness | undefined;
let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'm365-codex-backuproutes-'));
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function setup(): Promise<{ h: TestHarness; token: string }> {
  harness = await createTestHarness({ DATA_DIR: dataDir });
  const token = await loginAdmin(harness.app);
  return { h: harness, token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('POST /admin/backup', () => {
  it('生成备份包并落到磁盘，返回 id/bytes/created_at', async () => {
    const { h, token } = await setup();
    const res = await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; bytes: number; created_at: number };
    expect(body.id).toMatch(/^bkp_/);
    expect(body.bytes).toBeGreaterThan(0);
    expect(typeof body.created_at).toBe('number');
  });

  it('无管理会话返回 401', async () => {
    harness = await createTestHarness();
    const res = await harness.app.inject({ method: 'POST', url: '/admin/backup' });
    expect(res.statusCode).toBe(401);
  });

  it('includeFiles: false 时不打包已上传文件，manifest.includes_files 为 false', async () => {
    const { h, token } = await setup();
    // Giả mạo nội dung file đã upload trong thư mục dữ liệu, xác minh nó không bị đóng gói vào bản sao lưu
    mkdirSync(join(dataDir as string, 'files', 'file-a'), { recursive: true });
    writeFileSync(join(dataDir as string, 'files', 'file-a', 'content'), '附件内容', 'utf8');

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/backup',
      headers: auth(token),
      payload: { includeFiles: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };

    const download = await h.app.inject({
      method: 'GET',
      url: `/admin/backup/${body.id}/download`,
      headers: auth(token),
    });
    const entries = unpackArchive(download.rawPayload);
    expect(entries.some((e) => e.path.startsWith('files/'))).toBe(false);

    const manifestEntry = entries.find((e) => e.path === 'manifest.json');
    const manifest = JSON.parse(manifestEntry?.content.toString('utf8') ?? '{}') as { includes_files: boolean };
    expect(manifest.includes_files).toBe(false);

    const actions = h.context.auditLogs.recent(10).map((row) => ({ action: row.action, detail: row.detail }));
    const createEntry = actions.find((a) => a.action === 'backup.create');
    expect(createEntry?.detail).toContain('"includes_files":false');
  });

  // Có mang body thì bắt buộc phải hợp lệ: Nếu viết includeFiles thành string mà bị âm thầm bỏ qua,
  // phía gọi sẽ tưởng rằng nhận được gói "chỉ chứa database", trong khi thực tế nhận gói đầy đủ (hàng rào bảo vệ §1.7)
  it('includeFiles 类型不对时明确报错，而不是静默按缺省处理', async () => {
    const { h, token } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/backup',
      headers: auth(token),
      payload: { includeFiles: 'false' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('includeFiles');
  });

  it('body 里出现未知字段时同样报错，避免拼错字段名却以为生效', async () => {
    const { h, token } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/backup',
      headers: auth(token),
      payload: { include_files: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('显式传 includeFiles: true 与缺省行为一致', async () => {
    const { h, token } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/backup',
      headers: auth(token),
      payload: { includeFiles: true },
    });
    expect(res.statusCode).toBe(201);
  });

  it('缺省（不传 includeFiles）时保持原有行为：包含已上传文件', async () => {
    const { h, token } = await setup();
    mkdirSync(join(dataDir as string, 'files', 'file-b'), { recursive: true });
    writeFileSync(join(dataDir as string, 'files', 'file-b', 'content'), '附件内容', 'utf8');

    const res = await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) });
    const body = res.json() as { id: string };
    const download = await h.app.inject({
      method: 'GET',
      url: `/admin/backup/${body.id}/download`,
      headers: auth(token),
    });
    const entries = unpackArchive(download.rawPayload);
    expect(entries.some((e) => e.path.startsWith('files/'))).toBe(true);
  });
});

describe('GET /admin/backup', () => {
  it('列出已生成的备份包，按时间倒序', async () => {
    const { h, token } = await setup();
    await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) });
    await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) });
    const res = await h.app.inject({ method: 'GET', url: '/admin/backup', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; created_at: number }[] };
    expect(body.items.length).toBe(2);
    expect(body.items[0]?.created_at).toBeGreaterThanOrEqual(body.items[1]?.created_at as number);
  });
});

describe('GET /admin/backup/:id/download', () => {
  it('下载出的内容是合法的 tar.gz 备份包', async () => {
    const { h, token } = await setup();
    const created = (
      await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) })
    ).json() as { id: string; bytes: number };

    const res = await h.app.inject({
      method: 'GET',
      url: `/admin/backup/${created.id}/download`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.rawPayload.byteLength).toBe(created.bytes);
  });

  it('不存在的 id 返回 404，且不会因为路径穿越读到别的文件', async () => {
    const { h, token } = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/backup/../../etc/passwd/download',
      headers: auth(token),
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});

describe('POST /admin/restore', () => {
  it('校验通过后写盘，响应明确说明需要重启才生效', async () => {
    const { h, token } = await setup();
    const created = (
      await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) })
    ).json() as { id: string };
    const archive = (
      await h.app.inject({
        method: 'GET',
        url: `/admin/backup/${created.id}/download`,
        headers: auth(token),
      })
    ).rawPayload;

    const boundary = '----m365test';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
      ),
      archive,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/restore',
      headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { restored: boolean; requires_restart: boolean; message: string };
    expect(body.restored).toBe(true);
    expect(body.requires_restart).toBe(true);
    expect(body.message).toContain('重启');
  });

  it('不合法的备份包返回明确错误，不假装恢复成功', async () => {
    const { h, token } = await setup();
    const boundary = '----m365bad';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bad.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
      ),
      Buffer.from('not a real backup'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/restore',
      headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /admin/diagnostics', () => {
  it('汇总版本、配置摘要、账号分布与健康检查，且不含敏感信息', async () => {
    const { h, token } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/admin/diagnostics', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.app_version).toBeDefined();
    expect(body.schema).toBeDefined();
    expect(body.config).toBeDefined();
    const dump = JSON.stringify(body);
    expect(dump).not.toContain('@'); // Không chứa email
    expect(dump).not.toContain('sk-');
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{6,}/); // Không chứa dạng JWT
  });

  it('无管理会话返回 401', async () => {
    harness = await createTestHarness();
    const res = await harness.app.inject({ method: 'GET', url: '/admin/diagnostics' });
    expect(res.statusCode).toBe(401);
  });
});

describe('备份清理任务', () => {
  it('调度器里注册了 backups_cleanup，且能按保留份数清理', async () => {
    const { h, token } = await setup();
    for (let i = 0; i < 3; i += 1) {
      await h.app.inject({ method: 'POST', url: '/admin/backup', headers: auth(token) });
    }
    const before = (await h.app.inject({ method: 'GET', url: '/admin/backup', headers: auth(token) })).json() as {
      items: unknown[];
    };
    expect(before.items.length).toBe(3);

    const deleted = h.context.backupStore.prune(2);
    expect(deleted).toBe(1);

    const after = (await h.app.inject({ method: 'GET', url: '/admin/backup', headers: auth(token) })).json() as {
      items: unknown[];
    };
    expect(after.items.length).toBe(2);

    const statuses = h.context.scheduler.statuses();
    expect(statuses.some((s) => s.name === 'backups_cleanup')).toBe(true);
  });
});
