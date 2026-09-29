import type { CapabilityResult, CapabilityStatus } from './types.js';
import type { ToolCallStats } from './toolCall.js';

/**
 * Phán đoán tiêu chuẩn vượt qua theo §3.5.
 *
 * Đọc từng kết quả thăm dò của case id cố định, mọi trạng thái "native", "adaptable" đều tính là vượt qua (cả hai đều là
 * "upstream hỗ trợ trực tiếp" hoặc "state machine M365-Codex chuyển đổi đáng tin cậy", phù hợp định nghĩa §3.4);
 * "partial" tùy theo mục cụ thể để quyết định có tính là tạm vượt qua hay không; "unsupported", "unstable", "unknown"
 * đều không tính là vượt qua.
 */

export interface ChecklistItem {
  label: string;
  passed: boolean;
  detail: string;
}

export interface StatGateItem {
  metric: string;
  threshold: string;
  observed: string;
  passed: boolean;
}

export interface Verdict {
  checklist: ChecklistItem[];
  overallChecklistPassed: boolean;
  toolsAreLikelyPromptOnly: boolean;
  statGates: StatGateItem[] | null;
  statGatesPassed: boolean | null;
  sampleSizeWarning: string | null;
  conclusion: '可进入完整开发' | '需缩小首发范围';
  narrowedScopeSuggestions: string[];
}

function byId(results: readonly CapabilityResult[], id: string): CapabilityResult | undefined {
  return results.find((r) => r.id === id);
}

function passed(result: CapabilityResult | undefined, okStatuses: readonly CapabilityStatus[] = ['native', 'adaptable']): boolean {
  return result !== undefined && okStatuses.includes(result.status);
}

/** Lấy `ToolCallStats` từ bằng chứng của case 13/14/15 ra để tổng hợp (ngưỡng §3.5). */
export function extractToolCallStats(results: readonly CapabilityResult[]): ToolCallStats | null {
  const single = byId(results, 'single_tool_call');
  const stats = single?.evidence.tool_call_stats as ToolCallStats | undefined;
  if (stats === undefined) return null;
  return stats;
}

export function evaluateVerdict(results: readonly CapabilityResult[]): Verdict {
  const checklist: ChecklistItem[] = [
    {
      label: '文本请求稳定成功',
      passed: passed(byId(results, 'basic_text_chat')),
      detail: describe(byId(results, 'basic_text_chat')),
    },
    {
      label: '流式响应可稳定解析',
      passed: passed(byId(results, 'streaming_text'), ['native', 'adaptable', 'partial']),
      detail: describe(byId(results, 'streaming_text')),
    },
    {
      label: 'Token 可以可靠刷新',
      passed: passed(byId(results, 'access_token_refresh')),
      detail: describe(byId(results, 'access_token_refresh')),
    },
    {
      label: '连续会话可以恢复，或可通过本地上下文重建',
      // M3 đã triển khai cơ chế dự phòng "tái tạo ngữ cảnh cục bộ" (xem tiến độ milestone), vì vậy ở đây bất kỳ cách nào thành công đều tính là vượt qua
      passed:
        passed(byId(results, 'multi_turn_conversation'), ['native', 'adaptable', 'partial']) ||
        passed(byId(results, 'session_resume_after_disconnect'), ['native', 'adaptable', 'partial']),
      detail: `${describe(byId(results, 'multi_turn_conversation'))}；本地重建兜底已在 M3 落地，不依赖上游原生续接。`,
    },
    {
      label: '图片输入可用',
      passed: passed(byId(results, 'image_understanding'), ['native', 'adaptable', 'partial']),
      detail: describe(byId(results, 'image_understanding')),
    },
    {
      label: '工具调用可通过约束输出转换成有效 JSON',
      passed: passed(byId(results, 'tool_definition_understanding')) || passed(byId(results, 'single_tool_call')),
      detail: describe(byId(results, 'single_tool_call')),
    },
    {
      label: '工具结果回传后可继续推理',
      passed: passed(byId(results, 'tool_result_continuation')),
      detail: describe(byId(results, 'tool_result_continuation')),
    },
    {
      label: '401/403/429 与上游故障可分类',
      passed: passed(byId(results, 'error_classification'), ['native', 'adaptable']),
      detail: '分类函数已在 M3 用模拟上游穷举覆盖；' + describe(byId(results, 'error_classification')),
    },
    {
      label: '至少能实现 Codex 的单工具代理循环',
      passed: passed(byId(results, 'single_tool_call')) && passed(byId(results, 'tool_result_continuation')),
      detail: '单次工具调用 + 结果回传续接均需成立。',
    },
  ];

  const overallChecklistPassed = checklist.every((item) => item.passed);

  const toolDefinition = byId(results, 'tool_definition_understanding');
  const toolsAreLikelyPromptOnly = toolDefinition?.status === 'adaptable';

  let statGates: StatGateItem[] | null = null;
  let statGatesPassed: boolean | null = null;
  let sampleSizeWarning: string | null = null;

  const stats = extractToolCallStats(results);
  if (toolsAreLikelyPromptOnly && stats !== null) {
    const totalCalls = stats.nativeHits + stats.promptHits;
    const nameRate = ratio(stats.toolNameRecognized, totalCalls);
    const firstPassRate = ratio(stats.firstPassSchemaOk, totalCalls);
    const repairedRate = ratio(stats.passWithinTwoRepairs, totalCalls);

    statGates = [
      gate('工具名称识别成功率', 0.99, nameRate, `${stats.toolNameRecognized}/${totalCalls}`),
      gate('首次参数 Schema 通过率', 0.95, firstPassRate, `${stats.firstPassSchemaOk}/${totalCalls}`),
      gate('最多两次参数修复后通过率', 0.99, repairedRate, `${stats.passWithinTwoRepairs}/${totalCalls}`),
      {
        metric: '调用未声明工具',
        threshold: '0 次',
        observed: `${stats.undeclaredToolCalls} 次`,
        passed: stats.undeclaredToolCalls === 0,
      },
      {
        metric: '工具 JSON 当正文重复输出',
        threshold: '0 次',
        observed: `${stats.duplicateJsonInBody} 次`,
        passed: stats.duplicateJsonInBody === 0,
      },
    ];
    statGatesPassed = statGates.every((g) => g.passed);
    if (stats.trials < 20) {
      sampleSizeWarning = `样本量为 ${stats.trials}（低于 20），门槛判定置信度低，建议增大 --repeat 后重跑再下结论。`;
    }
  }

  const narrowedScopeSuggestions: string[] = [];
  for (const item of checklist) {
    if (!item.passed) narrowedScopeSuggestions.push(`「${item.label}」未通过：${item.detail}`);
  }
  if (statGatesPassed === false) {
    narrowedScopeSuggestions.push(
      '工具调用只能靠提示词模拟，且未达 §3.5 四项统计门槛，建议首发禁用工具调用或标记为 unstable，不默认开启。',
    );
  }

  const conclusion: Verdict['conclusion'] =
    overallChecklistPassed && statGatesPassed !== false ? '可进入完整开发' : '需缩小首发范围';

  return {
    checklist,
    overallChecklistPassed,
    toolsAreLikelyPromptOnly: toolsAreLikelyPromptOnly ?? false,
    statGates,
    statGatesPassed,
    sampleSizeWarning,
    conclusion,
    narrowedScopeSuggestions,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function gate(metric: string, threshold: number, observed: number, observedLabel: string): StatGateItem {
  return {
    metric,
    threshold: `≥ ${(threshold * 100).toFixed(0)}%`,
    observed: `${observedLabel}（${(observed * 100).toFixed(1)}%）`,
    passed: observed >= threshold,
  };
}

function describe(result: CapabilityResult | undefined): string {
  if (result === undefined) return '未找到对应用例结果。';
  return `状态=${result.status}；${result.summary}`;
}
