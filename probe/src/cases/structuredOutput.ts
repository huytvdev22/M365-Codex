import { buildEvidence, extractText, makeResult, runText } from '../caseHelpers.js';
import { JSON_OUTPUT_PROMPT, ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

function tryParseJson(text: string): { parsed: unknown; strategy: 'direct' | 'extracted' } | null {
  const trimmed = text.trim();
  try {
    return { parsed: JSON.parse(trimmed), strategy: 'direct' };
  } catch {
    // Sai lệch phổ biến: Bên ngoài bọc một khối code Markdown hoặc văn bản giải thích, thử trích xuất {...} đầu tiên
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { parsed: JSON.parse(trimmed.slice(start, end + 1)), strategy: 'extracted' };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function hasExpectedShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return 'answer' in record && 'confidence' in record;
}

/** #11 Đầu ra JSON có cấu trúc: Prompt ràng buộc có thể lấy được JSON hợp lệ một cách ổn định hay không. */
export async function caseStructuredJsonOutput(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, JSON_OUTPUT_PROMPT);
  const text = extractText(outcome);
  const result = tryParseJson(text);

  let status: CapabilityResult['status'];
  if (outcome.errorCategory !== null) status = 'unknown';
  else if (result !== null && result.strategy === 'direct' && hasExpectedShape(result.parsed)) status = 'native';
  else if (result !== null && hasExpectedShape(result.parsed)) status = 'adaptable';
  else status = 'unsupported';

  return makeResult({
    id: 'structured_json_output',
    index: 11,
    name: '结构化 JSON 输出',
    status,
    summary:
      result === null
        ? '回复无法解析为 JSON（直接解析与「抠出首个花括号片段」两种方式都失败）。'
        : `回复可解析为 JSON（${result.strategy === 'direct' ? '直接解析' : '需要先剥离多余文字/代码块'}），字段形状${hasExpectedShape(result.parsed) ? '符合' : '不符合'}预期。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(JSON_OUTPUT_PROMPT), {
      parse_strategy: result?.strategy ?? 'failed',
      reply_length: text.length,
    }),
  });
}
