import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cryptor } from '../src/crypto/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { maskProxyUrl, protocolOf, ProxyNodeRepository } from '../src/repo/proxyNodes.js';

/**
 * Pool proxy gửi đi (§13.1): URL chứa username/password, bắt buộc phải lưu trữ mã hóa; ra ngoài chỉ hiển thị kết quả đã mask.
 */

let db: Database;
let cryptor: Cryptor;
let repo: ProxyNodeRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  cryptor = new Cryptor(randomBytes(32));
  repo = new ProxyNodeRepository(db, cryptor);
});

afterEach(() => {
  db.close();
});

describe('打码', () => {
  it('带账号密码的 URL 打码后不含明文用户名密码', () => {
    const masked = maskProxyUrl('http://alice:s3cr3t@proxy.example.com:8080');
    expect(masked).not.toContain('alice');
    expect(masked).not.toContain('s3cr3t');
    expect(masked).toContain('proxy.example.com:8080');
  });

  it('不含账号密码的 URL 打码后仍显示主机', () => {
    expect(maskProxyUrl('socks5://proxy.example.com:1080')).toBe('socks5://proxy.example.com:1080');
  });

  it('无法解析的字符串整体打码，不泄露原始内容', () => {
    expect(maskProxyUrl('not a url')).toBe('***');
  });
});

describe('协议识别', () => {
  it('按 scheme 归类', () => {
    expect(protocolOf('http://x:1')).toBe('http');
    expect(protocolOf('https://x:1')).toBe('https');
    expect(protocolOf('socks5://u:p@x:1')).toBe('socks5');
    expect(protocolOf('ftp://x:1')).toBe('http'); // Không nhận diện được đều quy về http
  });
});

describe('加密存储与解密', () => {
  it('创建后数据库里不含明文 URL', () => {
    const row = repo.create({ name: '节点 A', url: 'http://alice:s3cr3t@proxy.example.com:8080' });
    const raw = db.prepare('SELECT url_enc FROM proxy_nodes WHERE id = ?').get(row.id) as {
      url_enc: Uint8Array;
    };
    expect(Buffer.from(raw.url_enc).toString('utf8')).not.toContain('s3cr3t');
  });

  it('resolveActiveUrl 能正确解密出原始 URL', () => {
    const row = repo.create({ name: '节点 A', url: 'http://alice:s3cr3t@proxy.example.com:8080' });
    expect(repo.resolveActiveUrl(row.id)).toBe('http://alice:s3cr3t@proxy.example.com:8080');
  });

  it('停用的节点 resolveActiveUrl 返回 null', () => {
    const row = repo.create({ name: '节点 A', url: 'http://proxy.example.com:8080', enabled: false });
    expect(repo.resolveActiveUrl(row.id)).toBeNull();
  });

  it('不存在的节点 resolveActiveUrl 返回 null', () => {
    expect(repo.resolveActiveUrl('missing')).toBeNull();
  });
});

describe('CRUD', () => {
  it('update 修改 url 后重新加密，旧密文不再可用', () => {
    const row = repo.create({ name: 'A', url: 'http://a.example.com:8080' });
    repo.update(row.id, { url: 'http://b.example.com:9090' });
    expect(repo.resolveActiveUrl(row.id)).toBe('http://b.example.com:9090');
  });

  it('remove 删除节点', () => {
    const row = repo.create({ name: 'A', url: 'http://a.example.com:8080' });
    expect(repo.remove(row.id)).toBe(true);
    expect(repo.findById(row.id)).toBeUndefined();
  });

  it('list 按 priority 降序、created_at 升序排列', () => {
    repo.create({ name: 'low', url: 'http://a:1', priority: 1 });
    repo.create({ name: 'high', url: 'http://b:1', priority: 10 });
    const list = repo.list();
    expect(list[0]?.name).toBe('high');
  });
});

describe('绑定账号', () => {
  it('boundAccountIds 返回绑定该节点的账号', () => {
    const row = repo.create({ name: 'A', url: 'http://a:1' });
    db.prepare(
      `INSERT INTO accounts (id, tid, oid, status, source, proxy_node_id, created_at, updated_at)
       VALUES (?, ?, ?, 'online', 'oauth', ?, ?, ?)`,
    ).run('acc_1', 'tid_1', 'oid_1', row.id, Date.now(), Date.now());
    expect(repo.boundAccountIds(row.id)).toEqual(['acc_1']);
  });
});

describe('健康检查结果写回', () => {
  it('recordCheck 更新状态、延迟、失败计数、冷却', () => {
    const row = repo.create({ name: 'A', url: 'http://a:1' });
    repo.recordCheck(row.id, { status: 'healthy', latencyMs: 42, failureCount: 0, cooldownUntil: null });
    const updated = repo.findById(row.id);
    expect(updated?.status).toBe('healthy');
    expect(updated?.latency_ms).toBe(42);
  });
});
