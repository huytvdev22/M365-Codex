import { describe, expect, it } from 'vitest';
import { evaluateVerdict } from '../src/verdict.js';
import type { CapabilityResult, CapabilityStatus } from '../src/types.js';
import type { ToolCallStats } from '../src/toolCall.js';

function stub(id: string, index: number, status: CapabilityStatus, evidence: Record<string, unknown> = {}): CapabilityResult {
  return {
    id,
    index,
    name: id,
    status,
    summary: `stub:${status}`,
    requestedAt: Date.now(),
    durationMs: 10,
    errorCategory: null,
    evidence,
  };
}

const CORE_PASSING: CapabilityResult[] = [
  stub('basic_text_chat', 2, 'native'),
  stub('streaming_text', 3, 'native'),
  stub('access_token_refresh', 22, 'native'),
  stub('multi_turn_conversation', 7, 'native'),
  stub('session_resume_after_disconnect', 8, 'native'),
  stub('image_understanding', 4, 'native'),
  stub('tool_definition_understanding', 12, 'native'),
  stub('single_tool_call', 13, 'native', {
    tool_call_stats: {
      trials: 20,
      toolNameRecognized: 20,
      firstPassSchemaOk: 20,
      passWithinTwoRepairs: 20,
      undeclaredToolCalls: 0,
      duplicateJsonInBody: 0,
      nativeHits: 20,
      promptHits: 0,
      noCallHits: 0,
    } satisfies ToolCallStats,
  }),
  stub('tool_result_continuation', 16, 'native'),
  stub('error_classification', 24, 'adaptable'),
];

describe('evaluateVerdict', () => {
  it('核心九条全部通过时结论为「可进入完整开发」', () => {
    const verdict = evaluateVerdict(CORE_PASSING);
    expect(verdict.overallChecklistPassed).toBe(true);
    expect(verdict.conclusion).toBe('可进入完整开发');
    expect(verdict.narrowedScopeSuggestions).toEqual([]);
  });

  it('原生工具调用场景不触发 §3.5 的四项统计门槛（门槛只针对提示词模拟）', () => {
    const verdict = evaluateVerdict(CORE_PASSING);
    expect(verdict.toolsAreLikelyPromptOnly).toBe(false);
    expect(verdict.statGates).toBeNull();
  });

  it('缺少关键用例结果时该条判定为未通过，总体结论「需缩小首发范围」', () => {
    const missingBasicText = CORE_PASSING.filter((r) => r.id !== 'basic_text_chat');
    const verdict = evaluateVerdict(missingBasicText);
    expect(verdict.overallChecklistPassed).toBe(false);
    expect(verdict.conclusion).toBe('需缩小首发范围');
    expect(verdict.narrowedScopeSuggestions.some((s) => s.includes('文本请求稳定成功'))).toBe(true);
  });

  it('提示词模拟且四项指标全部达标时 statGatesPassed 为 true', () => {
    const results = CORE_PASSING.map((r) =>
      r.id === 'tool_definition_understanding' ? stub(r.id, r.index, 'adaptable') : r,
    );
    const verdict = evaluateVerdict(results);
    expect(verdict.toolsAreLikelyPromptOnly).toBe(true);
    expect(verdict.statGatesPassed).toBe(true);
  });

  it('提示词模拟但首次通过率不达标（<95%）时 statGatesPassed 为 false 并给出缩小范围建议', () => {
    const lowPassRate: ToolCallStats = {
      trials: 20,
      toolNameRecognized: 20,
      firstPassSchemaOk: 10, // 50%, thấp hơn ngưỡng 95%
      passWithinTwoRepairs: 20,
      undeclaredToolCalls: 0,
      duplicateJsonInBody: 0,
      nativeHits: 0,
      promptHits: 20,
      noCallHits: 0,
    };
    const results = CORE_PASSING.map((r) => {
      if (r.id === 'tool_definition_understanding') return stub(r.id, r.index, 'adaptable');
      if (r.id === 'single_tool_call') return stub(r.id, r.index, 'partial', { tool_call_stats: lowPassRate });
      return r;
    });
    const verdict = evaluateVerdict(results);
    expect(verdict.statGatesPassed).toBe(false);
    expect(verdict.conclusion).toBe('需缩小首发范围');
    expect(verdict.narrowedScopeSuggestions.some((s) => s.includes('工具调用只能靠提示词模拟'))).toBe(true);
  });

  it('样本量不足 20 时给出置信度警告', () => {
    const smallSample: ToolCallStats = {
      trials: 5,
      toolNameRecognized: 5,
      firstPassSchemaOk: 5,
      passWithinTwoRepairs: 5,
      undeclaredToolCalls: 0,
      duplicateJsonInBody: 0,
      nativeHits: 0,
      promptHits: 5,
      noCallHits: 0,
    };
    const results = CORE_PASSING.map((r) => {
      if (r.id === 'tool_definition_understanding') return stub(r.id, r.index, 'adaptable');
      if (r.id === 'single_tool_call') return stub(r.id, r.index, 'adaptable', { tool_call_stats: smallSample });
      return r;
    });
    const verdict = evaluateVerdict(results);
    expect(verdict.sampleSizeWarning).not.toBeNull();
  });
});
