import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerUiRoutes } from '../src/routes/ui.js';

/**
 * Lưu trữ tĩnh giao diện quản lý: Fallback SPA, loại tài nguyên, bảo vệ chống directory traversal, dự phòng khi thiếu build artifact.
 */

let app: FastifyInstance;
let dist: string;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'm365-web-'));
  app = Fastify();
});

afterEach(async () => {
  await app.close();
  rmSync(dist, { recursive: true, force: true });
});

function seedDist(): void {
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>控制台</title><div id="root"></div>');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
}

describe('构建产物存在时', () => {
  it('/ 重定向到 /ui/', async () => {
    seedDist();
    registerUiRoutes(app, { webDist: dist });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ui/');
  });

  it('/ui/ 返回 index.html', async () => {
    seedDist();
    registerUiRoutes(app, { webDist: dist });
    const res = await app.inject({ method: 'GET', url: '/ui/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('控制台');
  });

  it('带哈希的静态资源可长缓存，index.html 不缓存', async () => {
    seedDist();
    registerUiRoutes(app, { webDist: dist });
    const asset = await app.inject({ method: 'GET', url: '/ui/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');

    const html = await app.inject({ method: 'GET', url: '/ui/' });
    expect(html.headers['cache-control']).toBe('no-cache');
  });

  it('前端路由深链回落到 index.html（刷新不 404）', async () => {
    seedDist();
    registerUiRoutes(app, { webDist: dist });
    const res = await app.inject({ method: 'GET', url: '/ui/accounts/add' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it('目录逃逸被挡下：不会读到 dist 之外的文件', async () => {
    seedDist();
    // Đặt một file "bí mật" bên ngoài dist, xác nhận không lấy được
    const outside = join(dist, '..', 'outside-secret.txt');
    writeFileSync(outside, 'TOP-SECRET');
    registerUiRoutes(app, { webDist: dist });
    const res = await app.inject({ method: 'GET', url: '/ui/../outside-secret.txt' });
    expect(res.body).not.toContain('TOP-SECRET');
    rmSync(outside, { force: true });
  });
});

describe('构建产物缺失时', () => {
  it('给出说明页而不是 404', async () => {
    registerUiRoutes(app, { webDist: join(dist, 'not-built') });
    const res = await app.inject({ method: 'GET', url: '/ui/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('管理界面尚未构建');
    expect(res.body).toContain('npm run build');
  });
});
