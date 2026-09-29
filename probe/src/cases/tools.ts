import { randomUUID } from 'node:crypto';
import { buildEvidence, extractText, makeResult, runText } from '../caseHelpers.js';
import {
  TOOL_ECHO,
  TOOL_GET_TIME,
  TOOL_PROMPT_BAD_ARGS_HINT,
  TOOL_PROMPT_FOLLOWUP,
  TOOL_PROMPT_PARALLEL,
  TOOL_PROMPT_SINGLE,
  ownLiterals,
} from '../testInputs.js';
import {
  buildDualChannelText,
  buildRegistry,
  detectToolCall,
  mergeStats,
  runSingleToolTrial,
  type ToolCallStats,
} from '../toolCall.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusFromStats(stats: ToolCallStats): CapabilityResult['status'] {
  if (stats.trials === 0) return 'unknown';
  const callRate = (stats.nativeHits + stats.promptHits) / stats.trials;
  if (callRate === 0) return 'unsupported';
  const nameRate = stats.toolNameRecognized / Math.max(1, stats.nativeHits + stats.promptHits);
  const firstPassRate = stats.firstPassSchemaOk / Math.max(1, stats.nativeHits + stats.promptHits);
  const repairedRate = stats.passWithinTwoRepairs / Math.max(1, stats.nativeHits + stats.promptHits);
  const meetsGate = nameRate >= 0.99 && firstPassRate >= 0.95 && repairedRate >= 0.99 && stats.undeclaredToolCalls === 0 && stats.duplicateJsonInBody === 0;

  if (stats.nativeHits >= stats.promptHits && stats.nativeHits > 0) {
    return meetsGate ? 'native' : 'partial';
  }
  return meetsGate ? 'adaptable' : callRate >= 0.5 ? 'partial' : 'unstable';
}

/** #12 Hiểu định nghĩa công cụ: Upstream có khái niệm công cụ gốc hay chỉ có thể dựa vào prompt ràng buộc. */
export async function caseToolDefinitionUnderstanding(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const declarations = [TOOL_GET_TIME, TOOL_ECHO];
  const registry = buildRegistry(declarations);
  const text = buildDualChannelText(TOOL_PROMPT_SINGLE, declarations);
  const outcome = await runText(ctx, text, { tools: declarations });
  const detection = detectToolCall(outcome, registry);

  const status: CapabilityResult['status'] =
    outcome.errorCategory !== null
      ? 'unknown'
      : detection.channel === 'native'
        ? 'native'
        : detection.channel === 'prompt'
          ? 'adaptable'
          : 'unsupported';

  return makeResult({
    id: 'tool_definition_understanding',
    index: 12,
    name: '工具定义理解（原生工具概念 / 提示词约束）',
    status,
    summary: `本轮工具调用通道判定为：${detection.channel}（native = 上游原生识别 tools 字段；prompt = 只能靠提示词模拟；none = 都未观察到）。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(TOOL_PROMPT_SINGLE), {
      channel: detection.channel,
      detected_name: detection.name,
      undeclared: detection.undeclared,
    }),
  });
}

/**
 * #13 Gọi công cụ đơn lẻ (đồng thời là case lấy mẫu cho 4 ngưỡng thống kê §3.5).
 * Chạy nhiều lần thử nghiệm độc lập theo `--repeat`, mỗi lần thử cho phép tối đa 2 lần sửa tham số (§7.3).
 */
export async function caseSingleToolCall(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const declarations = [TOOL_GET_TIME];
  const perTrial: ToolCallStats[] = [];
  let totalDurationMs = 0;
  let lastErrorCategory: string | null = null;

  for (let i = 0; i < ctx.repeat; i += 1) {
    const { stats, lastOutcome } = await runSingleToolTrial(ctx, TOOL_PROMPT_SINGLE, declarations);
    perTrial.push(stats);
    totalDurationMs += lastOutcome.durationMs;
    lastErrorCategory = lastOutcome.errorCategory;
    if (i < ctx.repeat - 1) await sleep(Math.max(200, Math.floor(ctx.delayMs / 2)));
  }

  const stats = mergeStats(...perTrial);
  const status = statusFromStats(stats);

  return makeResult({
    id: 'single_tool_call',
    index: 13,
    name: '单次工具调用',
    status,
    summary: `采样 ${stats.trials} 次：命中调用 ${stats.nativeHits + stats.promptHits} 次（native ${stats.nativeHits} / prompt ${stats.promptHits} / 无 ${stats.noCallHits}），首次参数通过 ${stats.firstPassSchemaOk} 次，两次修复内通过 ${stats.passWithinTwoRepairs} 次，未声明工具调用 ${stats.undeclaredToolCalls} 次，正文重复输出 ${stats.duplicateJsonInBody} 次。${stats.trials < 20 ? '样本量不足 20，门槛判定置信度低，建议增大 --repeat 后重跑。' : ''}`,
    requestedAt,
    durationMs: totalDurationMs,
    errorCategory: lastErrorCategory,
    evidence: { tool_call_stats: stats },
  });
}

/** #14 Gọi công cụ nhiều vòng: Hai vòng liên tiếp trong cùng một hội thoại đều cần gọi công cụ. */
export async function caseMultiRoundToolCall(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const declarations = [TOOL_GET_TIME, TOOL_ECHO];
  const registry = buildRegistry(declarations);

  const firstText = buildDualChannelText(TOOL_PROMPT_SINGLE, declarations);
  const first = await runText(ctx, firstText, { tools: declarations });
  const firstDetection = detectToolCall(first, registry);

  if (firstDetection.channel === 'none') {
    return makeResult({
      id: 'multi_round_tool_call',
      index: 14,
      name: '多轮工具调用',
      status: first.errorCategory !== null ? 'unknown' : 'unsupported',
      summary: '第一轮就没有观察到工具调用，无法继续验证第二轮。',
      requestedAt,
      durationMs: first.durationMs,
      errorCategory: first.errorCategory,
      evidence: buildEvidence(first, ownLiterals(TOOL_PROMPT_SINGLE)),
    });
  }

  const second = await runText(ctx, TOOL_PROMPT_FOLLOWUP, {
    tools: declarations,
    conversationRef: first.conversationRef ?? undefined,
  });
  const secondDetection = detectToolCall(second, registry);

  // Đến được đây firstDetection.channel đã loại trừ 'none' (ở trên đã return sớm), chỉ cần xem tiếp vòng hai
  const bothCalled = secondDetection.channel !== 'none';

  return makeResult({
    id: 'multi_round_tool_call',
    index: 14,
    name: '多轮工具调用',
    status: second.errorCategory !== null ? 'unknown' : bothCalled ? 'native' : 'partial',
    summary: bothCalled
      ? `连续两轮都观察到工具调用（第一轮 ${firstDetection.channel}，第二轮 ${secondDetection.channel}）。`
      : `第二轮未观察到工具调用（通道：${secondDetection.channel}）。`,
    requestedAt,
    durationMs: first.durationMs + second.durationMs,
    errorCategory: second.errorCategory,
    evidence: {
      round1: buildEvidence(first, ownLiterals(TOOL_PROMPT_SINGLE), { channel: firstDetection.channel }),
      round2: buildEvidence(second, ownLiterals(TOOL_PROMPT_FOLLOWUP), { channel: secondDetection.channel }),
    },
  });
}

/** #15 Gọi công cụ song song: Trong cùng một vòng có thể tạo ra nhiều lệnh gọi công cụ cùng lúc không. */
export async function caseParallelToolCalls(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const declarations = [TOOL_GET_TIME, TOOL_ECHO];
  const registry = buildRegistry(declarations);
  const text = buildDualChannelText(TOOL_PROMPT_PARALLEL, declarations);
  const outcome = await runText(ctx, text, { tools: declarations });
  const detection = detectToolCall(outcome, registry);
  const callCount = detection.nativeCallCount + detection.promptCallCount;

  let status: CapabilityResult['status'];
  if (outcome.errorCategory !== null) status = 'unknown';
  else if (callCount >= 2) status = detection.channel === 'native' ? 'native' : 'adaptable';
  else if (callCount === 1) status = 'partial';
  else status = 'unsupported';

  return makeResult({
    id: 'parallel_tool_calls',
    index: 15,
    name: '并行工具调用',
    status,
    summary: `同一轮观察到 ${callCount} 个工具调用（通道：${detection.channel}）。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(TOOL_PROMPT_PARALLEL), {
      call_count: callCount,
      channel: detection.channel,
    }),
  });
}

const CANNED_RESULT_MARKER = `探针工具结果标记-${randomUUID().slice(0, 8)}`;

/** #16 Tiếp tục sinh sau khi truyền lại kết quả công cụ: Sau khi truyền lại thứ tương đương `function_call_output` có cấu trúc, upstream có thể tiếp tục suy luận không. */
export async function caseToolResultContinuation(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const declarations = [TOOL_GET_TIME];
  const registry = buildRegistry(declarations);

  const firstText = buildDualChannelText(TOOL_PROMPT_BAD_ARGS_HINT, declarations);
  const first = await runText(ctx, firstText, { tools: declarations });
  const detection = detectToolCall(first, registry);

  if (detection.channel === 'none' || detection.callId === null) {
    return makeResult({
      id: 'tool_result_continuation',
      index: 16,
      name: '工具结果回传后继续生成',
      status: first.errorCategory !== null ? 'unknown' : 'unsupported',
      summary: '没有观察到可用的工具调用（含 call_id），无法验证结果回传后的续接。',
      requestedAt,
      durationMs: first.durationMs,
      errorCategory: first.errorCategory,
      evidence: buildEvidence(first, ownLiterals(TOOL_PROMPT_BAD_ARGS_HINT)),
    });
  }

  const canned = `现在时间是 2026-07-27T12:00:00+08:00（${CANNED_RESULT_MARKER}）。`;
  const second = await runText(ctx, '', {
    tools: declarations,
    conversationRef: first.conversationRef ?? undefined,
    toolResults: [{ callId: detection.callId, output: canned }],
  });

  const secondText = extractText(second);
  const referencedResult = secondText.includes(CANNED_RESULT_MARKER) || secondText.trim() !== '';
  const noRepeatCall = second.events.every((event) => event.kind !== 'tool_call_begin');

  const ok = second.errorCategory === null && referencedResult && noRepeatCall;

  return makeResult({
    id: 'tool_result_continuation',
    index: 16,
    name: '工具结果回传后继续生成',
    status: ok ? 'native' : second.errorCategory !== null ? 'unknown' : 'partial',
    summary: ok
      ? '回传工具结果后收到了延续性的文本回复，且没有重复发起同一个工具调用。'
      : `回传工具结果后${second.errorCategory !== null ? '请求失败' : '未观察到预期的延续回复'}。`,
    requestedAt,
    durationMs: first.durationMs + second.durationMs,
    errorCategory: second.errorCategory,
    evidence: {
      tool_call_round: buildEvidence(first, ownLiterals(TOOL_PROMPT_BAD_ARGS_HINT)),
      result_round: buildEvidence(second, ownLiterals(), { no_repeat_call: noRepeatCall }),
    },
  });
}
