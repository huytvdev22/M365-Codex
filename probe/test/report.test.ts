import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderJsonReport, renderMarkdownReport, writeReportFiles } from '../src/report.js';
import type { CapabilityResult } from '../src/types.js';

function stub(id: string, index: number, evidence: Record<string, unknown> = {}): CapabilityResult {
  return {
    id,
    index,
    name: id,
    status: 'native',
    summary: '一切正常',
    requestedAt: Date.now(),
    durationMs: 1,
    errorCategory: null,
    evidence,
  };
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'm365-codex-probe-test-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('report 渲染与脱敏写盘防线', () => {
  it('正常内容渲染成 Markdown 与 JSON，且能写盘', () => {
    const report = {
      generatedAt: Date.parse('2026-07-27T00:00:00.000Z'),
      toolVersion: '0.1.0-test',
      accounts: [{ label: 'fo***@example.com · tid=01234567… · abcd1234', results: [stub('basic_text_chat', 2)] }],
    };
    const { markdownPath, jsonPath } = writeReportFiles(outDir, report);
    const markdown = readFileSync(markdownPath, 'utf8');
    const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as { tool_version: string };

    expect(markdown).toContain('M365-Codex M0 上游能力探针报告');
    expect(markdown).toContain('官方兼容承诺');
    expect(json.tool_version).toBe('0.1.0-test');
  });

  it('证据里混入未脱敏的疑似 token 时，写盘前的最终检查会抛异常，不落盘', () => {
    const poisoned = {
      generatedAt: Date.now(),
      toolVersion: 'test',
      accounts: [
        {
          label: 'fo***@example.com',
          results: [
            stub('leaky_case', 1, {
              // Nhét trực tiếp một chuỗi "nghi vấn JWT" vào bằng chứng (mô phỏng sai sót triển khai), không nên đi tới bước ghi ra đĩa
              oops: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
            }),
          ],
        },
      ],
    };
    expect(() => writeReportFiles(outDir, poisoned)).toThrow();
  });

  it('多账号时会渲染「账号 / 租户能力差异」对比表', () => {
    const report = {
      generatedAt: Date.now(),
      toolVersion: 'test',
      accounts: [
        { label: '账号A', results: [stub('basic_text_chat', 2)] },
        { label: '账号B', results: [stub('basic_text_chat', 2)] },
      ],
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain('账号 / 租户能力差异');
    expect(markdown).toContain('账号A');
    expect(markdown).toContain('账号B');
  });

  it('单账号时不渲染跨账号对比表', () => {
    const report = {
      generatedAt: Date.now(),
      toolVersion: 'test',
      accounts: [{ label: '账号A', results: [stub('basic_text_chat', 2)] }],
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).not.toContain('账号 / 租户能力差异');
  });

  it('JSON 报告包含每个账号的 verdict 与 calibration 字段', () => {
    const report = {
      generatedAt: Date.now(),
      toolVersion: 'test',
      accounts: [{ label: '账号A', results: [stub('basic_text_chat', 2)] }],
    };
    const parsed = JSON.parse(renderJsonReport(report)) as {
      accounts: { verdict: unknown; calibration: unknown }[];
    };
    expect(parsed.accounts[0]?.verdict).toBeDefined();
    expect(parsed.accounts[0]?.calibration).toBeDefined();
  });
});
