import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './helpers/testApp.js';

/**
 * Test tích hợp toàn trình `/v1/files` `/v1/uploads` (tương ứng kế hoạch triển khai §11, §M6).
 * Dùng thư mục tạm thật làm bộ lưu trữ đĩa (DATA_DIR không thể là :memory:), dọn dẹp sau mỗi case.
 */

let harness: TestHarness | undefined;
let dataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'm365-codex-filesroutes-'));
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function setup(): Promise<{ h: TestHarness; apiKey: string; otherApiKey: string }> {
  harness = await createTestHarness({ DATA_DIR: dataDir });
  const key = harness.context.apiKeys.create({ name: 'k1' });
  const other = harness.context.apiKeys.create({ name: 'k2' });
  return { h: harness, apiKey: key.key, otherApiKey: other.key };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** Tự viết thủ công một body multipart/form-data, tránh import thêm package form-data để test. */
function multipartBody(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----m365CodexTestBoundary${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('POST /v1/files', () => {
  it('上传纯文本文件：返回 File 对象，提取出文本', async () => {
    const { h, apiKey } = await setup();
    const { body, contentType } = multipartBody(
      { purpose: 'user_data' },
      { field: 'file', filename: 'note.txt', contentType: 'text/plain', content: Buffer.from('hello world') },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...auth(apiKey), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const file = res.json() as { id: string; object: string; filename: string; status: string; bytes: number };
    expect(file.object).toBe('file');
    expect(file.filename).toBe('note.txt');
    expect(file.status).toBe('processed');
    expect(file.bytes).toBe(Buffer.byteLength('hello world'));
    expect(file.id.startsWith('file_')).toBe(true);
  });

  it('未提供 file 字段时返回 400', async () => {
    const { h, apiKey } = await setup();
    const { body, contentType } = multipartBody({ purpose: 'user_data' }, {
      field: 'not_file',
      filename: 'a.txt',
      contentType: 'text/plain',
      content: Buffer.from('x'),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...auth(apiKey), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/files 与归属', () => {
  async function uploadOne(h: TestHarness, apiKey: string, filename = 'a.txt'): Promise<string> {
    const { body, contentType } = multipartBody(
      {},
      { field: 'file', filename, contentType: 'text/plain', content: Buffer.from('content') },
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...auth(apiKey), 'content-type': contentType },
      payload: body,
    });
    return (res.json() as { id: string }).id;
  }

  it('列表只看到自己上传的文件', async () => {
    const { h, apiKey, otherApiKey } = await setup();
    await uploadOne(h, apiKey, 'mine.txt');
    await uploadOne(h, otherApiKey, 'theirs.txt');

    const res = await h.app.inject({ method: 'GET', url: '/v1/files', headers: auth(apiKey) });
    const list = res.json() as { object: string; data: { filename: string }[] };
    expect(list.object).toBe('list');
    expect(list.data.map((f) => f.filename)).toEqual(['mine.txt']);
  });

  it('跨 Key 读取单个文件返回 404', async () => {
    const { h, apiKey, otherApiKey } = await setup();
    const id = await uploadOne(h, apiKey);
    const res = await h.app.inject({ method: 'GET', url: `/v1/files/${id}`, headers: auth(otherApiKey) });
    expect(res.statusCode).toBe(404);
  });

  it('GET .../content 返回原始字节', async () => {
    const { h, apiKey } = await setup();
    const id = await uploadOne(h, apiKey);
    const res = await h.app.inject({ method: 'GET', url: `/v1/files/${id}/content`, headers: auth(apiKey) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('content');
  });

  it('DELETE 后再读取返回 404，且跨 Key 无法删除他人文件', async () => {
    const { h, apiKey, otherApiKey } = await setup();
    const id = await uploadOne(h, apiKey);

    const forbidden = await h.app.inject({ method: 'DELETE', url: `/v1/files/${id}`, headers: auth(otherApiKey) });
    expect(forbidden.statusCode).toBe(404);

    const del = await h.app.inject({ method: 'DELETE', url: `/v1/files/${id}`, headers: auth(apiKey) });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: boolean }).deleted).toBe(true);

    const after = await h.app.inject({ method: 'GET', url: `/v1/files/${id}`, headers: auth(apiKey) });
    expect(after.statusCode).toBe(404);
  });
});

describe('Uploads 分片上传流程', () => {
  it('create → parts → complete：拼出正确内容并生成 File', async () => {
    const { h, apiKey } = await setup();

    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: auth(apiKey),
      payload: { filename: 'big.txt', purpose: 'user_data', bytes: 10, mime_type: 'text/plain' },
    });
    expect(create.statusCode).toBe(201);
    const upload = create.json() as { id: string; status: string };
    expect(upload.status).toBe('pending');

    const part1 = multipartBody({}, { field: 'data', filename: 'p1', contentType: 'application/octet-stream', content: Buffer.from('hello ') });
    const res1 = await h.app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/parts`,
      headers: { ...auth(apiKey), 'content-type': part1.contentType },
      payload: part1.body,
    });
    expect(res1.statusCode).toBe(201);
    const p1 = res1.json() as { id: string; object: string };
    expect(p1.object).toBe('upload.part');

    const part2 = multipartBody({}, { field: 'data', filename: 'p2', contentType: 'application/octet-stream', content: Buffer.from('world') });
    const res2 = await h.app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/parts`,
      headers: { ...auth(apiKey), 'content-type': part2.contentType },
      payload: part2.body,
    });
    const p2 = res2.json() as { id: string };

    const complete = await h.app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/complete`,
      headers: auth(apiKey),
      payload: { part_ids: [p1.id, p2.id] },
    });
    expect(complete.statusCode).toBe(200);
    const completed = complete.json() as { status: string; file: { id: string; bytes: number } | null };
    expect(completed.status).toBe('completed');
    expect(completed.file).not.toBeNull();
    expect(completed.file?.bytes).toBe(Buffer.byteLength('hello world'));

    const content = await h.app.inject({
      method: 'GET',
      url: `/v1/files/${completed.file?.id}/content`,
      headers: auth(apiKey),
    });
    expect(content.body).toBe('hello world');
  });

  it('cancel 后不能再上传分片或完成', async () => {
    const { h, apiKey } = await setup();
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: auth(apiKey),
      payload: { filename: 'x', purpose: 'user_data', bytes: 5 },
    });
    const upload = create.json() as { id: string };

    const cancel = await h.app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/cancel`,
      headers: auth(apiKey),
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe('cancelled');

    const part = multipartBody({}, { field: 'data', filename: 'p', contentType: 'text/plain', content: Buffer.from('x') });
    const afterCancel = await h.app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/parts`,
      headers: { ...auth(apiKey), 'content-type': part.contentType },
      payload: part.body,
    });
    expect(afterCancel.statusCode).toBe(400);
  });

  it('跨 Key 不能操作他人的 Upload', async () => {
    const { h, apiKey, otherApiKey } = await setup();
    const create = await h.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: auth(apiKey),
      payload: { filename: 'x', purpose: 'user_data', bytes: 5 },
    });
    const upload = create.json() as { id: string };

    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/uploads/${upload.id}/cancel`,
      headers: auth(otherApiKey),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('大小与配额限制', () => {
  it('超过单文件上限返回 413', async () => {
    harness = await createTestHarness({ DATA_DIR: dataDir, FILES_MAX_FILE_BYTES: '1024' });
    const key = harness.context.apiKeys.create({ name: 'k' });
    const { body, contentType } = multipartBody(
      {},
      { field: 'file', filename: 'big.bin', contentType: 'application/octet-stream', content: Buffer.alloc(2048, 1) },
    );
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...auth(key.key), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
  });

  describe('API Key 级单文件大小上限（§10.1）', () => {
    it('比全局更严的 max_file_bytes 会先触发 413', async () => {
      harness = await createTestHarness({ DATA_DIR: dataDir, FILES_MAX_FILE_BYTES: '1024' });
      const key = harness.context.apiKeys.create({ name: '受限 Key', maxFileBytes: 100 });
      const { body, contentType } = multipartBody(
        {},
        { field: 'file', filename: 'mid.bin', contentType: 'application/octet-stream', content: Buffer.alloc(500, 1) },
      );
      const res = await harness.app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: { ...auth(key.key), 'content-type': contentType },
        payload: body,
      });
      expect(res.statusCode).toBe(413);
      expect(res.body).toContain('100');
    });

    it('Key 设置的值比全局更松时被裁剪到全局上限，不允许突破', async () => {
      harness = await createTestHarness({ DATA_DIR: dataDir, FILES_MAX_FILE_BYTES: '1024' });
      // Key tự đặt 10MB (rộng rãi hơn nhiều so với 1024 byte toàn cục), giới hạn hiệu lực vẫn phải là 1024 byte toàn cục.
      // Nội dung lấy 1025 byte: Vừa đúng nằm trong giới hạn fileSize của plugin Fastify multipart
      // (maxFileBytes toàn cục + 1 = 1025, xem đăng ký multipart trong app.ts),
      // nhờ đó xác nhận được chính assertFileSize của dịch vụ từ chối nó, chứ không phải bị
      // kiểm tra độc lập sớm hơn của plugin multipart chặn lại
      const key = harness.context.apiKeys.create({ name: '想突破全局上限', maxFileBytes: 10 * 1024 * 1024 });
      const { body, contentType } = multipartBody(
        {},
        { field: 'file', filename: 'big.bin', contentType: 'application/octet-stream', content: Buffer.alloc(1025, 1) },
      );
      const res = await harness.app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: { ...auth(key.key), 'content-type': contentType },
        payload: body,
      });
      expect(res.statusCode).toBe(413);
      expect(res.body).toContain('1024');
    });

    it('大小在 Key 收紧后的上限之内时正常通过', async () => {
      harness = await createTestHarness({ DATA_DIR: dataDir, FILES_MAX_FILE_BYTES: '1024' });
      const key = harness.context.apiKeys.create({ name: '受限但够用', maxFileBytes: 200 });
      const { body, contentType } = multipartBody(
        {},
        { field: 'file', filename: 'small.txt', contentType: 'text/plain', content: Buffer.from('hello') },
      );
      const res = await harness.app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: { ...auth(key.key), 'content-type': contentType },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
    });

    it('/v1/uploads 创建阶段也按 Key 收紧后的上限校验', async () => {
      harness = await createTestHarness({ DATA_DIR: dataDir, FILES_MAX_FILE_BYTES: '1024' });
      const key = harness.context.apiKeys.create({ name: '受限 Key', maxFileBytes: 100 });
      const res = await harness.app.inject({
        method: 'POST',
        url: '/v1/uploads',
        headers: auth(key.key),
        payload: { filename: 'a.bin', bytes: 500 },
      });
      expect(res.statusCode).toBe(413);
    });
  });
});
