import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertReportClean } from './evidence.js';
import { buildCalibrationNotes } from './calibration.js';
import { evaluateVerdict, type Verdict } from './verdict.js';
import type { CapabilityResult } from './types.js';

export interface AccountRunResult {
  /** Nhãn hiển thị, đã khử nhạy cảm (ví dụ email đã mask + 8 ký tự đầu của tid), tuyệt đối không chứa email đầy đủ thật */
  label: string;
  results: CapabilityResult[];
}

export interface ProbeRunReport {
  generatedAt: number;
  toolVersion: string;
  accounts: AccountRunResult[];
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'native':
      return '✅ native';
    case 'adaptable':
      return '🟢 adaptable';
    case 'partial':
      return '🟡 partial';
    case 'unstable':
      return '🟠 unstable';
    case 'unsupported':
      return '⛔ unsupported';
    default:
      return '❓ unknown';
  }
}

function renderCapabilityTable(results: readonly CapabilityResult[]): string {
  const rows = [...results]
    .sort((a, b) => a.index - b.index)
    .map(
      (r) =>
        `| ${r.index} | ${r.name} | ${statusEmoji(r.status)} | ${r.durationMs} | ${r.errorCategory ?? '-'} | ${escapeCell(r.summary)} |`,
    );
  return [
    '| # | 能力 | 状态 | 耗时(ms) | 错误分类 | 证据摘要 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderVerdict(verdict: Verdict): string {
  const lines: string[] = [];
  lines.push('#### §3.5 通过标准逐条判定');
  lines.push('');
  lines.push('| 条目 | 是否通过 | 说明 |');
  lines.push('| --- | --- | --- |');
  for (const item of verdict.checklist) {
    lines.push(`| ${item.label} | ${item.passed ? '✅' : '❌'} | ${escapeCell(item.detail)} |`);
  }
  lines.push('');
  lines.push(`**总体结论：${verdict.conclusion}**`);
  lines.push('');

  if (verdict.statGates !== null) {
    lines.push('#### 工具调用仅靠提示词模拟时的四项统计门槛（§3.5）');
    lines.push('');
    lines.push('| 指标 | 门槛 | 实测 | 是否达标 |');
    lines.push('| --- | --- | --- | --- |');
    for (const gate of verdict.statGates) {
      lines.push(`| ${gate.metric} | ${gate.threshold} | ${gate.observed} | ${gate.passed ? '✅' : '❌'} |`);
    }
    lines.push('');
    if (verdict.sampleSizeWarning !== null) {
      lines.push(`> ⚠️ ${verdict.sampleSizeWarning}`);
      lines.push('');
    }
  }

  if (verdict.narrowedScopeSuggestions.length > 0) {
    lines.push('#### 建议缩小的范围');
    lines.push('');
    for (const s of verdict.narrowedScopeSuggestions) lines.push(`- ${s}`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderCalibration(results: readonly CapabilityResult[]): string {
  const notes = buildCalibrationNotes(results);
  const lines: string[] = [];
  lines.push('#### 校准建议');
  lines.push('');
  lines.push(`- 建议 \`TOOLS_MODE\` 取值：\`${notes.suggestedToolsMode}\``);
  lines.push(
    `- \`UPSTREAM_IMAGE_INPUT\`：${notes.suggestedUpstreamImageInput ? '可以尝试打开（观察到图片输入疑似生效）' : '暂不建议打开（未观察到可靠的图片理解证据）'}`,
  );
  lines.push(
    `- 观察到的 Retry-After（毫秒）：${notes.observedRetryAfterMs.length > 0 ? notes.observedRetryAfterMs.join(', ') : '本轮未自然触发限流，无数据'}`,
  );
  lines.push('');
  lines.push('观察到的真实帧字段与 `codecV1.ts` 建模字段的差异：');
  lines.push('');
  lines.push(
    `- 观察到但未在 codecV1.ts 建模的字段：${notes.observedButUnmodeled.length > 0 ? notes.observedButUnmodeled.join(', ') : '（无）'}`,
  );
  lines.push(
    `- codecV1.ts 建模了但本轮从未观察到的字段：${notes.modeledButUnobserved.length > 0 ? notes.modeledButUnobserved.join(', ') : '（无）'}`,
  );
  lines.push('');
  return lines.join('\n');
}

function renderAccountSection(account: AccountRunResult): string {
  const verdict = evaluateVerdict(account.results);
  return [
    `### 账号：${account.label}`,
    '',
    renderCapabilityTable(account.results),
    '',
    renderVerdict(verdict),
    renderCalibration(account.results),
  ].join('\n');
}

function renderCrossAccountSection(accounts: readonly AccountRunResult[]): string {
  if (accounts.length < 2) return '';
  const ids = new Set<string>();
  for (const account of accounts) for (const result of account.results) ids.add(result.id);
  const sortedIds = [...ids].sort();

  const header = ['| 能力 | ' + accounts.map((a) => a.label).join(' | ') + ' |', '| --- | ' + accounts.map(() => '---').join(' | ') + ' |'];
  const rows = sortedIds.map((id) => {
    const cells = accounts.map((account) => {
      const r = account.results.find((x) => x.id === id);
      return r === undefined ? '-' : statusEmoji(r.status);
    });
    const name = accounts[0]?.results.find((x) => x.id === id)?.name ?? id;
    return `| ${name} | ${cells.join(' | ')} |`;
  });

  return ['## 账号 / 租户能力差异（§3.1 第 26 项）', '', ...header, ...rows, ''].join('\n');
}

export function renderMarkdownReport(report: ProbeRunReport): string {
  const generatedAtIso = new Date(report.generatedAt).toISOString();
  const parts: string[] = [
    '# M365-Codex M0 上游能力探针报告',
    '',
    '> ⚠️ 本报告涉及未公开的逆向上游协议，探测行为可能违反 Microsoft 服务条款并影响账号状态，',
    '> 使用者需自行承担风险，本工具与本报告不构成官方兼容承诺。',
    '',
    `生成时间：${generatedAtIso}`,
    '',
    `本工具版本：${report.toolVersion}`,
    '',
    '本报告已经过强制脱敏处理（见 `probe/src/evidence.ts`）：不含 access/refresh/id token、',
    'OAuth code、PKCE verifier、Cookie、完整认证 Header、真实文件内容或真实对话原文；',
    '邮箱只保留掩码形态，租户/对象 ID 只保留前 8 位，响应结构样本只留字段名与类型。',
    '',
    ...report.accounts.map(renderAccountSection),
    renderCrossAccountSection(report.accounts),
  ];
  return parts.filter((p) => p !== '').join('\n\n');
}

export function renderJsonReport(report: ProbeRunReport): string {
  const payload = {
    generated_at: report.generatedAt,
    tool_version: report.toolVersion,
    accounts: report.accounts.map((account) => ({
      label: account.label,
      results: account.results,
      verdict: evaluateVerdict(account.results),
      calibration: buildCalibrationNotes(account.results),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Kiểm tra khử nhạy cảm thống nhất một lần trước khi ghi ra đĩa (ranh giới đỏ cứng §4), bất kỳ vị trí nào thất bại đều không ghi đĩa. */
export function writeReportFiles(outDir: string, report: ProbeRunReport): { markdownPath: string; jsonPath: string } {
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date(report.generatedAt).toISOString().replaceAll(/[:.]/g, '-');
  const markdownPath = join(outDir, `probe-${timestamp}.md`);
  const jsonPath = join(outDir, `probe-${timestamp}.json`);

  const markdown = renderMarkdownReport(report);
  const json = renderJsonReport(report);

  assertReportClean(markdown);
  assertReportClean(json);

  writeFileSync(markdownPath, markdown, 'utf8');
  writeFileSync(jsonPath, json, 'utf8');

  return { markdownPath, jsonPath };
}
