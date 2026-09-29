#!/usr/bin/env node
/**
 * Chạy danh sách kiểm tra nghiệm thu trên một phiên bản **đã triển khai** (tương ứng docs/trien-khai-va-nghiem-thu.md mục 2).
 *
 * Chỉ dùng API công khai, không chạm vào database, không đọc file, nên có thể chạy trên mọi triển khai — máy cục bộ, container, máy chủ từ xa.
 * Sẽ tạo một lượng nhỏ tài nguyên thử nghiệm (một API Key, một file upload), dùng xong tự dọn dẹp.
 *
 * Cách dùng:
 *   node dev/acceptance.mjs --base http://127.0.0.1:8080 --password <mat_khau_admin>
 *   node dev/acceptance.mjs --base http://192.168.0.5:18080 --password xxx --skip-upstream
 *
 * `--skip-upstream` bỏ qua các ca kiểm thử cần gọi upstream thật (dùng khi không có tài khoản khả dụng).
 */

import { Buffer } from 'node:buffer';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const BASE = (arg('base', 'http://127.0.0.1:8080') ?? '').replace(/\/$/, '');
const PASSWORD = arg('password', process.env.M365_CODEX_ADMIN_PASSWORD ?? '');
const SKIP_UPSTREAM = has('skip-upstream');

if (PASSWORD === '') {
  console.error('缺少管理密码：--password <密码> 或环境变量 M365_CODEX_ADMIN_PASSWORD');
  process.exit(2);
}

const results = [];
let adminToken = '';
let apiKey = '';
let apiKeyId = '';
let uploadedFileId = '';

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`  ✗ ${name} —— ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function req(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

const admin = (init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), authorization: `Bearer ${adminToken}` },
});
const withKey = (init = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), authorization: `Bearer ${apiKey}` },
});
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

console.log(`\n验收目标：${BASE}\n`);

console.log('基础');
await check('/healthz 存活', async () => {
  const r = await req('/healthz');
  expect(r.status === 200 && r.json?.status === 'ok', `状态 ${r.status}`);
  return `版本 ${r.json.version}`;
});
await check('/readyz 就绪', async () => {
  const r = await req('/readyz');
  expect(r.status === 200, `状态 ${r.status}：${r.text.slice(0, 120)}`);
  return `迁移 v${r.json.schema_version}`;
});
await check('/ 跳转到管理界面', async () => {
  const r = await fetch(`${BASE}/`, { redirect: 'manual' });
  expect(r.status === 302, `状态 ${r.status}`);
  expect((r.headers.get('location') ?? '').includes('/ui/'), '跳转目标不是 /ui/');
  return '302 → /ui/';
});
await check('管理界面页面可加载', async () => {
  const r = await req('/ui/');
  expect(r.status === 200 && r.text.includes('<div id="root"'), `状态 ${r.status}`);
  expect(!r.text.includes('管理界面尚未构建'), '返回的是「未构建」兜底页，说明镜像里没有前端产物');
  return `${r.text.length} 字节`;
});
await check('错误的管理密码被拒', async () => {
  const r = await req('/admin/login', json({ password: 'definitely-not-the-password' }));
  expect(r.status === 401, `状态 ${r.status}`);
  return '401';
});
await check('管理员登录', async () => {
  const r = await req('/admin/login', json({ password: PASSWORD }));
  expect(r.status === 200 && typeof r.json?.token === 'string', `状态 ${r.status}`);
  adminToken = r.json.token;
  return '拿到会话令牌';
});
await check('未带 API Key 调 /v1/models 被拒', async () => {
  const r = await req('/v1/models');
  expect(r.status === 401, `状态 ${r.status}`);
  return '401';
});

console.log('\n管理接口');
await check('概览', async () => {
  const r = await req('/admin/overview', admin());
  expect(r.status === 200, `状态 ${r.status}`);
  return `状态 ${r.json.system_status}，账号 ${r.json.accounts.total} 个（可用 ${r.json.accounts.online}）`;
});
await check('账号列表不含 Token', async () => {
  const r = await req('/admin/accounts', admin());
  expect(r.status === 200, `状态 ${r.status}`);
  expect(!/access_token|refresh_token"\s*:\s*"/.test(r.text), '响应里出现了 Token 字段');
  return `${r.json.data?.length ?? 0} 个账号`;
});
await check('设置分组齐全且环境变量项不可改', async () => {
  const r = await req('/admin/settings', admin());
  expect(r.status === 200, `状态 ${r.status}`);
  for (const group of ['network', 'scheduler', 'logging', 'oauth', 'tools', 'files']) {
    expect(r.json[group] !== undefined, `缺少分组 ${group}`);
  }
  const envFixed = Object.values(r.json)
    .flatMap((g) => Object.values(g))
    .filter((f) => f.source === 'env');
  expect(envFixed.every((f) => f.editable === false), '有 source=env 的项仍标为可编辑');
  return `6 组，其中 ${envFixed.length} 项由环境变量固定`;
});
await check('能力矩阵不谎报', async () => {
  const r = await req('/admin/capabilities', admin());
  expect(r.status === 200, `状态 ${r.status}`);
  const lying = (r.json.matrix ?? []).filter((m) => m.status === 'native');
  expect(lying.length === 0, `有 ${lying.length} 项在 M0 探针跑之前就标成了 native`);
  return `${r.json.matrix.length} 项能力`;
});
await check('Codex 配置生成', async () => {
  const r = await req('/admin/codex-config', admin());
  expect(r.status === 200 && r.json.toml.includes('wire_api = "responses"'), '生成的 TOML 不含 wire_api');
  return 'wire_api = responses';
});
await check('诊断包', async () => {
  const r = await req('/admin/diagnostics', admin());
  expect(r.status === 200, `状态 ${r.status}`);
  expect(!r.text.includes('@'), '诊断包里出现了邮箱形态的内容');
  return `系统状态 ${r.json.system_status}`;
});
await check('指标', async () => {
  const r = await req('/metrics', admin());
  expect(r.status === 200 && r.text.includes('m365codex_requests_total'), `状态 ${r.status}`);
  expect(!/eyJ[A-Za-z0-9_-]{6,}/.test(r.text), '指标里出现了 Token 形态的内容');
  return `${r.text.split('\n').length} 行`;
});
await check('备份可生成并下载', async () => {
  const created = await req('/admin/backup', admin(json({})));
  expect(created.status === 200 || created.status === 201, `状态 ${created.status}`);
  const id = created.json.id;
  const downloaded = await fetch(`${BASE}/admin/backup/${id}/download`, admin());
  expect(downloaded.status === 200, `下载状态 ${downloaded.status}`);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  // Magic number của gzip
  expect(bytes[0] === 0x1f && bytes[1] === 0x8b, '下载的不是 gzip 包');
  return `${bytes.length} 字节`;
});

console.log('\nAPI Key 与限额');
await check('创建 API Key（明文只此一次）', async () => {
  // Key chính không đặt hạn ngạch: các ca kiểm thử tính năng phía sau đều dùng nó, tránh hạn ngạch làm ảnh hưởng kiểm tra tính năng
  const r = await req('/admin/api-keys', admin(json({ name: 'acceptance-check' })));
  expect(r.status === 200 || r.status === 201, `状态 ${r.status}`);
  expect(typeof r.json.key === 'string' && r.json.key.startsWith('sk-'), '没有返回 sk- 明文');
  apiKey = r.json.key;
  apiKeyId = r.json.id;
  const list = await req('/admin/api-keys', admin());
  expect(!list.text.includes(apiKey), '列表接口里出现了 Key 明文');
  return `${r.json.masked_key}`;
});
await check('模型列表', async () => {
  const r = await req('/v1/models', withKey());
  expect(r.status === 200, `状态 ${r.status}`);
  return `${r.json.data.length} 个模型`;
});

if (!SKIP_UPSTREAM) {
  console.log('\n对外 API（需要可用账号或模拟上游）');
  await check('非流式 Responses', async () => {
    const r = await req('/v1/responses', withKey(json({ model: 'gpt-5-codex', input: 'hello' })));
    expect(r.status === 200, `状态 ${r.status}：${r.text.slice(0, 160)}`);
    expect(r.json.status === 'completed', `状态字段是 ${r.json.status}`);
    return `${r.json.output.length} 个输出项`;
  });
  await check('流式 Responses：事件带 type、序号单调、以 completed 收尾', async () => {
    const response = await fetch(`${BASE}/v1/responses`, withKey(json({ model: 'gpt-5-codex', input: 'hi', stream: true })));
    expect(response.status === 200, `状态 ${response.status}`);
    const body = await response.text();
    const events = body
      .split('\n\n')
      .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.length > 0, '没有解析到任何事件');
    expect(events.every((e) => typeof e.type === 'string'), '有事件的 data 里缺少 type 字段');
    const seqs = events.map((e) => e.sequence_number);
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), 'sequence_number 不是严格递增');
    expect(events.at(-1).type === 'response.completed', `最后一个事件是 ${events.at(-1).type}`);
    return `${events.length} 个事件`;
  });
  await check('每分钟限额生效（另建一把 rpm=1 的 Key）', async () => {
    const created = await req('/admin/api-keys', admin(json({ name: 'acceptance-rate-limit', rpm_limit: 1 })));
    expect(created.status === 200 || created.status === 201, `建 Key 失败：${created.status}`);
    const limited = created.json.key;
    const call = () =>
      req('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${limited}` },
        body: JSON.stringify({ model: 'gpt-5-codex', input: 'x' }),
      });

    const first = await call();
    expect(first.status === 200, `第一次就失败了：${first.status}`);
    const second = await call();
    expect(second.status === 429, `第二次状态 ${second.status}（期望 429）`);
    expect(second.headers.get('retry-after') !== null, '缺少 Retry-After 头');

    await fetch(`${BASE}/admin/api-keys/${created.json.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    return `第二次 429，Retry-After ${second.headers.get('retry-after')}`;
  });
}

console.log('\n文件');
await check('上传文件', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('验收测试文档，关键数字 42。', 'utf8')], { type: 'text/plain' }), 'acceptance.txt');
  const response = await fetch(`${BASE}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form });
  const body = await response.json();
  expect(response.status === 200 || response.status === 201, `状态 ${response.status}`);
  uploadedFileId = body.id;
  return `${body.id}（${body.bytes} 字节，${body.status}）`;
});
await check('图片输入默认被明确拒绝', async () => {
  const r = await req(
    '/v1/responses',
    withKey(
      json({
        model: 'gpt-5-codex',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] }],
      }),
    ),
  );
  expect(r.status === 422, `状态 ${r.status}（期望 422 unsupported_feature）`);
  return '422 unsupported_feature';
});

console.log('\n清理');
await check('删除测试文件', async () => {
  if (uploadedFileId === '') return '无需清理';
  const r = await fetch(`${BASE}/v1/files/${uploadedFileId}`, { method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` } });
  expect(r.status === 200, `状态 ${r.status}`);
  return '已删除';
});
await check('撤销测试 API Key', async () => {
  if (apiKeyId === '') return '无需清理';
  const r = await fetch(`${BASE}/admin/api-keys/${apiKeyId}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } });
  expect(r.status === 200, `状态 ${r.status}`);
  return '已撤销';
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(56)}`);
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const item of failed) console.log(`  - ${item.name}：${item.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);
