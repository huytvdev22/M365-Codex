import { writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadModels } from '../src/responses/models.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('loadModels', () => {
  it('加载仓库自带的模型目录', () => {
    const models = loadModels();
    expect(models.object).toBe('list');
    expect(models.data.some((m) => m.id === 'gpt-5-codex')).toBe(true);
    expect(models.data.every((m) => m.object === 'model')).toBe(true);
  });

  it('从自定义文件加载', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'm365-models-'));
    const path = join(tempDir, 'models.json');
    await writeFile(
      path,
      JSON.stringify({ data: [{ id: 'custom-model', owned_by: 'me' }] }),
      'utf8',
    );
    const models = loadModels(path);
    expect(models.data).toHaveLength(1);
    expect(models.data[0]?.id).toBe('custom-model');
  });

  it('文件缺失时回退到内置默认', () => {
    const models = loadModels('/不存在/models.json');
    expect(models.data.length).toBeGreaterThanOrEqual(1);
    expect(models.data[0]?.id).toBe('gpt-5-codex');
  });

  it('文件损坏时回退', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'm365-models-'));
    const path = join(tempDir, 'broken.json');
    await writeFile(path, '{ 坏的', 'utf8');
    expect(loadModels(path).data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('降级必须留痕', () => {
  // Đã từng bị lỗi giáng cấp im lặng: Image quên copy thư mục config/, trên production chỉ trả về 1 model trong khi config có 3,
  // vì trong catch không thông báo gì, khi điều tra hoàn toàn không thấy được.
  it('读不到文件时回调说明原因', () => {
    const reasons: string[] = [];
    const list = loadModels('/definitely/not/a/real/path/models.json', (r) => reasons.push(r));
    expect(list.data).toHaveLength(1);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('读取模型目录');
  });

  it('文件里没有 data 数组时同样回调', () => {
    const file = join(tmpdir(), `models-bad-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ object: 'list' }), 'utf8');
    try {
      const reasons: string[] = [];
      loadModels(file, (r) => reasons.push(r));
      expect(reasons[0]).toContain('没有 data 数组');
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('正常读取时不触发回调', () => {
    const reasons: string[] = [];
    loadModels(undefined, (r) => reasons.push(r));
    expect(reasons).toHaveLength(0);
  });
});
