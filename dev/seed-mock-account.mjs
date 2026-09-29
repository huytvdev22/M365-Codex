#!/usr/bin/env node
/**
 * Đưa một tài khoản Microsoft **giả** vào cơ sở dữ liệu, chỉ dùng để nghiệm thu end-to-end với mock upstream.
 *
 * Lý do cần script này: Tài khoản chỉ có thể được thêm qua luồng ủy quyền PKCE (đây là ràng buộc bảo mật có chủ đích), mà PKCE yêu cầu
 * đăng nhập Microsoft thật. Để xác minh bản thân gateway (Responses/SSE/vòng lặp công cụ/
 * file đính kèm) khi không có tài khoản thật, cần có một bản ghi tài khoản để bộ điều phối (dispatcher) có thể chọn.
 *
 * Lưu ý bảo mật: access/refresh token ghi vào đây hoàn toàn là chuỗi giả (`mock-*`), vô nghĩa đối với dịch vụ Microsoft
 * thật; bắt buộc phải dùng kèm UPSTREAM_WS_BASE trỏ tới mock upstream. **Không chạy trên DB production.**
 *
 * Cách dùng (cục bộ, cần chạy npm run build trước):
 *   M365_CODEX_MASTER_KEY=... node dev/seed-mock-account.mjs --db ./data/m365-codex.db
 * Cách dùng (trong container):
 *   node /app/dev/seed-mock-account.mjs --db /data/m365-codex.db --dist /app/apps/server/dist
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const dbPath = arg('db', './data/m365-codex.db');
const distDir = resolve(arg('dist', './apps/server/dist'));
const count = Number(arg('count', '1'));

const masterKeyRaw = process.env.M365_CODEX_MASTER_KEY;
if (!masterKeyRaw) {
  console.error('缺少 M365_CODEX_MASTER_KEY，无法加密写入 Token');
  process.exit(1);
}
const masterKey = Buffer.from(masterKeyRaw, 'base64');
if (masterKey.byteLength !== 32) {
  console.error('主密钥解码后不是 32 字节');
  process.exit(1);
}

const load = (rel) => import(pathToFileURL(resolve(distDir, rel)).href);

const { openDatabase, runMigrations } = await load('db/index.js');
const { Cryptor } = await load('crypto/index.js');
const { AccountRepository } = await load('repo/accounts.js');

const db = openDatabase(dbPath);
runMigrations(db);

const accounts = new AccountRepository(db, new Cryptor(masterKey, Number(process.env.MASTER_KEY_VERSION ?? 1)));

for (let i = 1; i <= count; i += 1) {
  const view = accounts.upsert({
    tid: 'mock-tenant',
    oid: `mock-object-${i}`,
    email: `mock${i}@upstream.example.invalid`,
    displayName: `模拟账号 ${i}`,
    source: 'oauth',
    tokens: {
      accessToken: `mock-access-token-${i}`,
      refreshToken: `mock-refresh-token-${i}`,
      expiresAt: Date.now() + 24 * 3600 * 1000,
    },
  });
  accounts.forceStatus(view.id, 'online');
  console.log(`已写入假账号 ${view.id}（${view.email}）`);
}

db.close();
console.log('完成。请确认 UPSTREAM_WS_BASE 指向模拟上游，否则这些假 Token 对真实上游无效。');
