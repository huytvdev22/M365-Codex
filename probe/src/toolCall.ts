import {
  buildToolInstruction,
  PromptToolScanner,
} from '../../apps/server/dist/tools/promptProtocol.js';
import { ToolRegistry, type ParsedTool } from '../../apps/server/dist/tools/registry.js';
import type { ToolDeclaration, UpstreamEvent } from '../../apps/server/dist/adapter/protocol.js';
import { extractText, runText } from './caseHelpers.js';
import type { InvocationOutcome, ProbeContext } from './types.js';

/**
 * Logic dùng chung cho thăm dò gọi công cụ (§3.1 mục 12-16 + ngưỡng mô phỏng prompt §3.5).
 *
 * Upstream có khái niệm công cụ có cấu trúc gốc hay không vẫn chưa được xác nhận, nên mỗi yêu cầu mở đồng thời cả hai kênh:
 * - Gốc: `InvocationInput.tools` mang khai báo có cấu trúc, nếu upstream thực sự hỗ trợ,
 *   `codecV1.mapMessageToEvents` sẽ sinh các sự kiện `tool_call_*` từ `msg.toolCalls`;
 * - Prompt: Viết danh mục công cụ vào văn bản (tái sử dụng `buildToolInstruction`
 *   trong `tools/promptProtocol.ts`), nội dung trả về được phân tích bằng cùng một `PromptToolScanner`.
 *
 * Việc phán đoán khớp hai kênh hoàn toàn độc lập, vì vậy một yêu cầu đơn lẻ có thể xác định "upstream đã đi theo kênh nào",
 * không cần đoán mò hay gửi thêm yêu cầu để phân biệt.
 */

export function toParsedTools(declarations: readonly ToolDeclaration[]): ParsedTool[] {
  return declarations.map((decl) => ({
    name: decl.name,
    description: decl.description ?? null,
    parameters: decl.parameters ?? null,
    sideEffect: true,
  }));
}

export function buildRegistry(declarations: readonly ToolDeclaration[]): ToolRegistry {
  return new ToolRegistry(toParsedTools(declarations));
}

/** Ghép prompt và danh mục công cụ thành văn bản cuối cùng mở đồng thời cả hai kênh "gốc + prompt". */
export function buildDualChannelText(promptText: string, declarations: readonly ToolDeclaration[]): string {
  const instruction = buildToolInstruction(toParsedTools(declarations));
  return instruction === '' ? promptText : `${promptText}\n\n${instruction}`;
}

export type ToolCallChannel = 'native' | 'prompt' | 'none';

export interface ToolCallDetection {
  channel: ToolCallChannel;
  name: string | null;
  callId: string | null;
  argumentsJson: string | null;
  /** Có gọi công cụ chưa được khai báo trong registry hay không (không khớp chữ hoa/thường hoặc khoảng trắng cũng tính là chưa khai báo) */
  undeclared: boolean;
  /** Nội dung còn lại sau khi bóc tách gọi công cụ (dưới kênh native thì là toàn bộ nội dung, vì gọi công cụ vốn không nằm trong văn bản) */
  bodyText: string;
  /** Trong nội dung có nghi vấn lặp lại JSON gọi công cụ dưới dạng nội dung hay không */
  duplicateJsonInBody: boolean;
  /** Tổng số tool_call_begin gốc khớp trong vòng này (dùng để phán đoán gọi công cụ song song) */
  nativeCallCount: number;
  /** Tổng số tool_call prompt khớp trong vòng này (dùng để phán đoán gọi công cụ song song) */
  promptCallCount: number;
}

function collectArgs(events: readonly UpstreamEvent[], callId: string): string {
  return events
    .filter(
      (event): event is Extract<UpstreamEvent, { kind: 'tool_call_args_delta' }> =>
        event.kind === 'tool_call_args_delta' && event.callId === callId,
    )
    .map((event) => event.delta)
    .join('');
}

/** Phát hiện gọi công cụ từ kết quả một invocation, phán đoán đã đi theo kênh gốc hay prompt. */
export function detectToolCall(outcome: InvocationOutcome, registry: ToolRegistry): ToolCallDetection {
  const nativeBegins = outcome.events.filter(
    (event): event is Extract<UpstreamEvent, { kind: 'tool_call_begin' }> => event.kind === 'tool_call_begin',
  );

  if (nativeBegins.length > 0) {
    const first = nativeBegins[0] as Extract<UpstreamEvent, { kind: 'tool_call_begin' }>;
    const bodyText = extractText(outcome);
    return {
      channel: 'native',
      name: first.name,
      callId: first.callId,
      argumentsJson: collectArgs(outcome.events, first.callId),
      undeclared: !registry.has(first.name),
      bodyText,
      duplicateJsonInBody: looksLikeDuplicateToolJson(bodyText, first.name),
      nativeCallCount: nativeBegins.length,
      promptCallCount: 0,
    };
  }

  const rawText = extractText(outcome);
  const scanner = new PromptToolScanner();
  const pushed = scanner.push(rawText);
  const flushed = scanner.flush();
  const events = [...pushed.events, ...flushed.events];
  const bodyText = pushed.text + flushed.text;

  const promptBegins = events.filter(
    (event): event is Extract<UpstreamEvent, { kind: 'tool_call_begin' }> => event.kind === 'tool_call_begin',
  );

  if (promptBegins.length === 0) {
    return {
      channel: 'none',
      name: null,
      callId: null,
      argumentsJson: null,
      undeclared: false,
      bodyText,
      duplicateJsonInBody: false,
      nativeCallCount: 0,
      promptCallCount: 0,
    };
  }

  const first = promptBegins[0] as Extract<UpstreamEvent, { kind: 'tool_call_begin' }>;
  return {
    channel: 'prompt',
    name: first.name,
    callId: first.callId,
    argumentsJson: collectArgs(events, first.callId),
    undeclared: !registry.has(first.name),
    bodyText,
    duplicateJsonInBody: looksLikeDuplicateToolJson(bodyText, first.name),
    nativeCallCount: 0,
    promptCallCount: promptBegins.length,
  };
}

/** Phán đoán heuristic: Trong nội dung sau khi phân tích/bóc tách có còn nghi vấn xuất lặp lại JSON gọi công cụ như nội dung văn bản không. */
function looksLikeDuplicateToolJson(bodyText: string, toolName: string): boolean {
  if (bodyText.includes('<tool_call>')) return true;
  const nameHit = bodyText.includes(toolName);
  const jsonShapeHit = /"name"\s*:\s*"/.test(bodyText) || /"arguments"\s*:/.test(bodyText);
  return nameHit && jsonShapeHit;
}

/** Thống kê gọi công cụ đơn lẻ (dùng cho ngưỡng §3.5). */
export interface ToolCallStats {
  trials: number;
  toolNameRecognized: number;
  firstPassSchemaOk: number;
  passWithinTwoRepairs: number;
  undeclaredToolCalls: number;
  duplicateJsonInBody: number;
  /** Phân bố kênh thực tế quan sát được, dùng cho khuyến nghị hiệu chuẩn */
  nativeHits: number;
  promptHits: number;
  noCallHits: number;
}

export function emptyStats(): ToolCallStats {
  return {
    trials: 0,
    toolNameRecognized: 0,
    firstPassSchemaOk: 0,
    passWithinTwoRepairs: 0,
    undeclaredToolCalls: 0,
    duplicateJsonInBody: 0,
    nativeHits: 0,
    promptHits: 0,
    noCallHits: 0,
  };
}

export function mergeStats(...stats: readonly ToolCallStats[]): ToolCallStats {
  const merged = emptyStats();
  for (const s of stats) {
    merged.trials += s.trials;
    merged.toolNameRecognized += s.toolNameRecognized;
    merged.firstPassSchemaOk += s.firstPassSchemaOk;
    merged.passWithinTwoRepairs += s.passWithinTwoRepairs;
    merged.undeclaredToolCalls += s.undeclaredToolCalls;
    merged.duplicateJsonInBody += s.duplicateJsonInBody;
    merged.nativeHits += s.nativeHits;
    merged.promptHits += s.promptHits;
    merged.noCallHits += s.noCallHits;
  }
  return merged;
}

/**
 * Lượt thử đơn lẻ: Gửi một yêu cầu "kích hoạt gọi probe_get_time", phát hiện kênh,
 * nếu tham số không thỏa mãn schema thì yêu cầu sửa tối đa hai lần (mức trần §7.3), trả về số gia thống kê của lượt thử này.
 */
export async function runSingleToolTrial(
  ctx: ProbeContext,
  promptText: string,
  declarations: readonly ToolDeclaration[],
): Promise<{ stats: ToolCallStats; lastDetection: ToolCallDetection; lastOutcome: InvocationOutcome }> {
  const registry = buildRegistry(declarations);
  const text = buildDualChannelText(promptText, declarations);
  let outcome = await runText(ctx, text, { tools: declarations });
  let detection = detectToolCall(outcome, registry);

  const stats = emptyStats();
  stats.trials = 1;
  tallyChannel(stats, detection);

  if (detection.channel === 'none') {
    return { stats, lastDetection: detection, lastOutcome: outcome };
  }

  stats.toolNameRecognized += detection.undeclared ? 0 : 1;
  if (detection.undeclared) stats.undeclaredToolCalls += 1;
  if (detection.duplicateJsonInBody) stats.duplicateJsonInBody += 1;

  let validation = registry.validateArguments(detection.name ?? '', detection.argumentsJson ?? '{}');
  if (validation.valid) {
    stats.firstPassSchemaOk += 1;
    stats.passWithinTwoRepairs += 1;
    return { stats, lastDetection: detection, lastOutcome: outcome };
  }

  // Tối đa 2 lần sửa (mức trần §7.3), tái sử dụng cùng định danh phiên để nối tiếp (nếu upstream từng trả về)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repairPrompt = `你上一次调用 ${detection.name ?? '该工具'} 的参数不满足要求：${validation.errors.join('；')}。请重新按 JSON Schema 输出一次正确的工具调用。`;
    outcome = await runText(ctx, repairPrompt, {
      tools: declarations,
      conversationRef: outcome.conversationRef ?? undefined,
    });
    detection = detectToolCall(outcome, registry);
    if (detection.channel === 'none') continue;
    if (detection.undeclared) stats.undeclaredToolCalls += 1;
    if (detection.duplicateJsonInBody) stats.duplicateJsonInBody += 1;
    validation = registry.validateArguments(detection.name ?? '', detection.argumentsJson ?? '{}');
    if (validation.valid) {
      stats.passWithinTwoRepairs += 1;
      break;
    }
  }

  return { stats, lastDetection: detection, lastOutcome: outcome };
}

function tallyChannel(stats: ToolCallStats, detection: ToolCallDetection): void {
  if (detection.channel === 'native') stats.nativeHits += 1;
  else if (detection.channel === 'prompt') stats.promptHits += 1;
  else stats.noCallHits += 1;
}
