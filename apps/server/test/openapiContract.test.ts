import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Ajv2020Cjs from 'ajv/dist/2020.js';

// ajv là module CJS, dưới NodeNext default import gắn vào namespace, class thật nằm trên .default
const Ajv2020 = Ajv2020Cjs.default;
import { createTestHarness, type TestHarness } from './helpers/testApp.js';
import { startMockSydneyServer, type MockSydneyServer } from './helpers/mockSydneyServer.js';

/**
 * Test hợp đồng OpenAPI (tương ứng DoD §M4 của kế hoạch triển khai).
 * Dùng schema trong openapi/openapi.json để kiểm tra phản hồi endpoint thật, đảm bảo triển khai không lệch hợp đồng.
 */

const openapiPath = fileURLToPath(new URL('../../../openapi/openapi.json', import.meta.url));
const openapi = JSON.parse(readFileSync(openapiPath, 'utf8')) as {
  components: { schemas: Record<string, object> };
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
// Đăng ký toàn bộ schema component, phục vụ phân giải $ref
for (const [name, schema] of Object.entries(openapi.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`);
}

function validator(name: string) {
  const schema = openapi.components.schemas[name];
  if (schema === undefined) throw new Error(`schema 不存在：${name}`);
  return ajv.compile(schema);
}

let harness: TestHarness | undefined;
let server: MockSydneyServer | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await server?.close();
  server = undefined;
});

async function setup(): Promise<{ h: TestHarness; apiKey: string }> {
  server = await startMockSydneyServer({
    kind: 'normal',
    chunks: ['契约', '测试'],
    citations: [{ url: 'https://src.example', title: '来源' }],
  });
  harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
  harness.context.accounts.upsert({
    tid: 't',
    oid: 'o',
    email: 'u@office.example.invalid',
    displayName: 'u',
    source: 'oauth',
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  });
  const key = harness.context.apiKeys.create({ name: 'k' });
  return { h: harness, apiKey: key.key };
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe('契约：/v1/models', () => {
  it('响应符合 ModelList schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/v1/models', headers: auth(apiKey) });
    const validate = validator('ModelList');
    expect(validate(res.json())).toBe(true);
  });
});

describe('契约：POST /v1/responses 非流式', () => {
  it('响应符合 Response schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: 'q' },
    });
    const validate = validator('Response');
    const ok = validate(res.json());
    if (!ok) {
      throw new Error(`不符合契约: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });
});

describe('契约：错误体', () => {
  it('503 符合 ErrorBody schema', async () => {
    server = await startMockSydneyServer({ kind: 'normal', chunks: ['x'] });
    harness = await createTestHarness({ UPSTREAM_WS_BASE: server.url });
    const key = harness.context.apiKeys.create({ name: 'k' });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(key.key),
      payload: { model: 'm', input: 'q' },
    });
    expect(res.statusCode).toBe(503);
    const validate = validator('ErrorBody');
    expect(validate(res.json())).toBe(true);
  });

  it('422 符合 ErrorBody schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'm', input: [{ role: 'user', content: [{ type: 'input_image' }] }] },
    });
    expect(res.statusCode).toBe(422);
    expect(validator('ErrorBody')(res.json())).toBe(true);
  });
});

describe('契约：SSE 完成事件里的 response 符合 schema', () => {
  it('response.completed.data.response 符合 Response schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', input: 'q', stream: true },
    });
    const completedBlock = res.body
      .split('\n\n')
      .find((block) => block.includes('event: response.completed'));
    expect(completedBlock).toBeDefined();
    const dataLine = completedBlock?.split('\n').find((l) => l.startsWith('data: '));
    const data = JSON.parse(dataLine!.slice('data: '.length)) as { response: unknown };
    const validate = validator('Response');
    const ok = validate(data.response);
    if (!ok) throw new Error(`不符合契约: ${JSON.stringify(validate.errors)}`);
    expect(ok).toBe(true);
  });
});

describe('契约：POST /v1/chat/completions（M6）', () => {
  it('非流式响应符合 ChatCompletionResponse schema', async () => {
    const { h, apiKey } = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(apiKey),
      payload: { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'q' }] },
    });
    const validate = validator('ChatCompletionResponse');
    const ok = validate(res.json());
    if (!ok) throw new Error(`不符合契约: ${JSON.stringify(validate.errors)}`);
    expect(ok).toBe(true);
  });
});

describe('契约：Files / Uploads（M6）', () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('POST /v1/files 响应符合 FileObject schema，GET /v1/files 符合 FileList schema', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'm365-codex-openapi-files-'));
    harness = await createTestHarness({ DATA_DIR: dataDir });
    const key = harness.context.apiKeys.create({ name: 'k' });

    const boundary = '----contractTestBoundary';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
      'utf8',
    );
    const createRes = await harness.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    const validateFile = validator('FileObject');
    const okFile = validateFile(createRes.json());
    if (!okFile) throw new Error(`不符合契约: ${JSON.stringify(validateFile.errors)}`);
    expect(okFile).toBe(true);

    const listRes = await harness.app.inject({
      method: 'GET',
      url: '/v1/files',
      headers: { authorization: `Bearer ${key.key}` },
    });
    const validateList = validator('FileList');
    expect(validateList(listRes.json())).toBe(true);
  });

  it('POST /v1/uploads 响应符合 UploadObject schema', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'm365-codex-openapi-uploads-'));
    harness = await createTestHarness({ DATA_DIR: dataDir });
    const key = harness.context.apiKeys.create({ name: 'k' });

    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: { authorization: `Bearer ${key.key}` },
      payload: { filename: 'a.txt', purpose: 'user_data', bytes: 5 },
    });
    const validate = validator('UploadObject');
    const ok = validate(res.json());
    if (!ok) throw new Error(`不符合契约: ${JSON.stringify(validate.errors)}`);
    expect(ok).toBe(true);
  });
});
