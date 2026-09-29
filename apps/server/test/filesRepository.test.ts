import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { ApiKeyRepository } from '../src/repo/apiKeys.js';
import { FileRepository, UploadRepository } from '../src/repo/files.js';

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function setup(): { files: FileRepository; uploads: UploadRepository; apiKeyId: string; otherKeyId: string } {
  db = openDatabase(':memory:');
  runMigrations(db);
  const apiKeys = new ApiKeyRepository(db);
  const key = apiKeys.create({ name: 'k1' });
  const other = apiKeys.create({ name: 'k2' });
  return {
    files: new FileRepository(db),
    uploads: new UploadRepository(db),
    apiKeyId: key.id,
    otherKeyId: other.id,
  };
}

describe('FileRepository', () => {
  it('创建后可按 id 读回', () => {
    const { files, apiKeyId } = setup();
    const row = files.create({
      id: 'file_1',
      apiKeyId,
      filename: 'a.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      kind: 'text',
      bytes: 5,
      sha256: 'x'.repeat(64),
      status: 'processed',
      extractedText: 'hello',
      extractionNote: null,
      expiresAt: null,
    });
    expect(row.id).toBe('file_1');
    expect(files.findById('file_1')?.extracted_text).toBe('hello');
  });

  it('跨 Key 不可见：findOwnedActive 对非属主返回 undefined', () => {
    const { files, apiKeyId, otherKeyId } = setup();
    files.create({
      id: 'file_2',
      apiKeyId,
      filename: 'a.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      kind: 'text',
      bytes: 1,
      sha256: 'y'.repeat(64),
      status: 'processed',
      extractedText: null,
      extractionNote: null,
      expiresAt: null,
    });
    expect(files.findOwnedActive('file_2', otherKeyId)).toBeUndefined();
    expect(files.findOwnedActive('file_2', apiKeyId)).toBeDefined();
  });

  it('list 只返回该 Key 名下未删除的文件', () => {
    const { files, apiKeyId, otherKeyId } = setup();
    files.create({
      id: 'file_3', apiKeyId, filename: 'mine.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'a'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: null,
    });
    files.create({
      id: 'file_4', apiKeyId: otherKeyId, filename: 'theirs.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'b'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: null,
    });
    const mine = files.listByApiKey(apiKeyId);
    expect(mine.map((f) => f.id)).toEqual(['file_3']);
  });

  it('softDelete 后不再出现在 list 与 findOwnedActive 中', () => {
    const { files, apiKeyId } = setup();
    files.create({
      id: 'file_5', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'c'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: null,
    });
    expect(files.softDelete('file_5', apiKeyId)).toBe(true);
    expect(files.findOwnedActive('file_5', apiKeyId)).toBeUndefined();
    expect(files.listByApiKey(apiKeyId)).toEqual([]);
  });

  it('softDelete 对非属主返回 false，不删除他人文件', () => {
    const { files, apiKeyId, otherKeyId } = setup();
    files.create({
      id: 'file_6', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'd'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: null,
    });
    expect(files.softDelete('file_6', otherKeyId)).toBe(false);
    expect(files.findOwnedActive('file_6', apiKeyId)).toBeDefined();
  });

  it('sumActiveBytes 累加未删除、未过期文件的大小', () => {
    const { files, apiKeyId } = setup();
    const now = Date.now();
    files.create({
      id: 'file_7', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 100, sha256: 'e'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: null,
    });
    files.create({
      id: 'file_8', apiKeyId, filename: 'b.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 50, sha256: 'f'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: now - 1000, // Đã hết hạn, không tính vào
    });
    expect(files.sumActiveBytes(apiKeyId, now)).toBe(100);
  });

  it('findExpired 找出已过期未清理的文件', () => {
    const { files, apiKeyId } = setup();
    const now = Date.now();
    files.create({
      id: 'file_9', apiKeyId, filename: 'a.txt', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'g'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: now - 1,
    });
    const expired = files.findExpired(now);
    expect(expired.map((f) => f.id)).toContain('file_9');
  });
});

describe('UploadRepository', () => {
  it('创建、追加分片、按顺序列出', () => {
    const { uploads, apiKeyId } = setup();
    const upload = uploads.create({
      id: 'upload_1', apiKeyId, filename: 'big.bin', purpose: 'user_data',
      mimeType: 'application/octet-stream', bytes: 100, expiresAt: Date.now() + 3600_000,
    });
    expect(upload.status).toBe('pending');
    const p1 = uploads.addPart('upload_1', 10);
    const p2 = uploads.addPart('upload_1', 20);
    expect(p1.part_number).toBe(1);
    expect(p2.part_number).toBe(2);
    expect(uploads.listParts('upload_1').map((p) => p.id)).toEqual([p1.id, p2.id]);
  });

  it('完成后 status=completed 且带上 file_id', () => {
    const { uploads, files, apiKeyId } = setup();
    uploads.create({
      id: 'upload_2', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: Date.now() + 1000,
    });
    files.create({
      id: 'file_final', apiKeyId, filename: 'x', purpose: 'user_data', mimeType: 'text/plain',
      kind: 'text', bytes: 1, sha256: 'h'.repeat(64), status: 'processed', extractedText: null,
      extractionNote: null, expiresAt: null,
    });
    uploads.markCompleted('upload_2', 'file_final');
    const row = uploads.findById('upload_2');
    expect(row?.status).toBe('completed');
    expect(row?.file_id).toBe('file_final');
  });

  it('取消后不能再次取消或完成（只从 pending 转移一次）', () => {
    const { uploads, apiKeyId } = setup();
    uploads.create({
      id: 'upload_3', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: Date.now() + 1000,
    });
    expect(uploads.markCancelled('upload_3')).toBe(true);
    expect(uploads.markCancelled('upload_3')).toBe(false);
    uploads.markCompleted('upload_3', 'file_x');
    expect(uploads.findById('upload_3')?.status).toBe('cancelled');
  });

  it('跨 Key 不可见：findOwned 对非属主返回 undefined', () => {
    const { uploads, apiKeyId, otherKeyId } = setup();
    uploads.create({
      id: 'upload_4', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: Date.now() + 1000,
    });
    expect(uploads.findOwned('upload_4', otherKeyId)).toBeUndefined();
    expect(uploads.findOwned('upload_4', apiKeyId)).toBeDefined();
  });

  it('findExpiredPending 只找过期的 pending', () => {
    const { uploads, apiKeyId } = setup();
    const now = Date.now();
    uploads.create({
      id: 'upload_5', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: now - 1,
    });
    uploads.create({
      id: 'upload_6', apiKeyId, filename: 'x', purpose: 'user_data',
      mimeType: 'text/plain', bytes: 1, expiresAt: now + 100_000,
    });
    const expired = uploads.findExpiredPending(now);
    expect(expired.map((u) => u.id)).toEqual(['upload_5']);
  });
});
