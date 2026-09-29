import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@m365-codex/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { openDatabase, runMigrations, type Database } from '../src/db/index.js';
import { FilesService } from '../src/files/service.js';
import { FileStorage } from '../src/files/storage.js';
import { ApiKeyRepository } from '../src/repo/apiKeys.js';
import { FileRepository } from '../src/repo/files.js';
import { testEnv } from './helpers/testApp.js';

describe('FilesService', () => {
  let db: Database;
  let dir: string;
  let service: FilesService;
  let apiKeyId: string;
  let otherKeyId: string;

  function build(overrides: Record<string, string> = {}) {
    const config = loadConfig(testEnv(overrides));
    service = new FilesService({
      files: new FileRepository(db),
      storage: new FileStorage(dir),
      config: config.files,
    });
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'm365-codex-filesservice-'));
    const apiKeys = new ApiKeyRepository(db);
    apiKeyId = apiKeys.create({ name: 'k1' }).id;
    otherKeyId = apiKeys.create({ name: 'k2' }).id;
    build();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('接收纯文本文件：分类、提取、落盘、入库一次做完', async () => {
    const row = await service.ingest({
      apiKeyId,
      filename: 'note.txt',
      purpose: 'user_data',
      declaredMimeType: 'text/plain',
      content: Buffer.from('hello world', 'utf8'),
    });
    expect(row.status).toBe('processed');
    expect(row.extracted_text).toBe('hello world');
    expect(row.kind).toBe('text');

    const { content } = service.getContent(row.id, apiKeyId);
    expect(content.toString('utf8')).toBe('hello world');
  });

  it('未识别的二进制只存储不提取，status 仍是 processed', async () => {
    const row = await service.ingest({
      apiKeyId,
      filename: 'mystery.bin',
      purpose: 'user_data',
      declaredMimeType: null,
      content: Buffer.from([0xc0, 0xc1, 0xf5, 0xff]),
    });
    expect(row.status).toBe('processed');
    expect(row.extracted_text).toBeNull();
    // Khi chạy toàn bộ pipeline, không có tín hiệu cấu trúc + nội dung UTF-8 không hợp lệ sẽ bị xác định ở giai đoạn classify là
    // không đáng tin cậy (khác với nhánh "không phán đoán" được kích hoạt khi truyền trusted=true trong unit test extract.ts)
    expect(row.extraction_note).toContain('不可信');
  });

  it('超过单文件大小上限时拒绝，返回 413', async () => {
    build({ FILES_MAX_FILE_BYTES: '1024' });
    await expect(
      service.ingest({
        apiKeyId,
        filename: 'big.txt',
        purpose: 'user_data',
        declaredMimeType: 'text/plain',
        content: Buffer.alloc(2048, 'a'),
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('累计存储超过单 Key 上限时拒绝', async () => {
    build({ FILES_MAX_FILE_BYTES: '1024000', FILES_MAX_TOTAL_BYTES_PER_KEY: '1500' });
    await service.ingest({
      apiKeyId,
      filename: 'a.txt',
      purpose: 'user_data',
      declaredMimeType: 'text/plain',
      content: Buffer.alloc(1000, 'a'),
    });
    await expect(
      service.ingest({
        apiKeyId,
        filename: 'b.txt',
        purpose: 'user_data',
        declaredMimeType: 'text/plain',
        content: Buffer.alloc(600, 'b'), // 1000 + 600 > 1500 giới hạn trên
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('跨 Key 不可读：getOwned 对非属主抛 404', async () => {
    const row = await service.ingest({
      apiKeyId,
      filename: 'a.txt',
      purpose: 'user_data',
      declaredMimeType: 'text/plain',
      content: Buffer.from('secret'),
    });
    expect(() => service.getOwned(row.id, otherKeyId)).toThrow(ApiError);
    try {
      service.getOwned(row.id, otherKeyId);
    } catch (error) {
      expect((error as ApiError).status).toBe(404);
    }
  });

  it('删除后不可再读', async () => {
    const row = await service.ingest({
      apiKeyId,
      filename: 'a.txt',
      purpose: 'user_data',
      declaredMimeType: 'text/plain',
      content: Buffer.from('bye'),
    });
    service.delete(row.id, apiKeyId);
    expect(() => service.getOwned(row.id, apiKeyId)).toThrow(ApiError);
  });

  it('resolveOwnedText 只对属主返回文本，且他人 Key 拿不到', async () => {
    const row = await service.ingest({
      apiKeyId,
      filename: 'note.txt',
      purpose: 'user_data',
      declaredMimeType: 'text/plain',
      content: Buffer.from('文件内容'),
    });
    expect(service.resolveOwnedText(row.id, apiKeyId)).toEqual({ filename: 'note.txt', text: '文件内容' });
    expect(service.resolveOwnedText(row.id, otherKeyId)).toBeNull();
  });

  it('resolveOwnedImageDataUrl 只认已识别为图片的文件', async () => {
    const textRow = await service.ingest({
      apiKeyId,
      filename: 'a.txt',
      purpose: 'user_data',
      declaredMimeType: 'text/plain',
      content: Buffer.from('not an image'),
    });
    expect(service.resolveOwnedImageDataUrl(textRow.id, apiKeyId)).toBeNull();

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fakepngbytes')]);
    const imageRow = await service.ingest({
      apiKeyId,
      filename: 'pic.png',
      purpose: 'vision',
      declaredMimeType: 'image/png',
      content: png,
    });
    const resolved = service.resolveOwnedImageDataUrl(imageRow.id, apiKeyId);
    expect(resolved?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
