import { runCaseSafely } from '../caseHelpers.js';
import type { CaseDefinition } from '../types.js';
import { caseHandshakeAuth } from './handshake.js';
import {
  caseBasicTextChat,
  caseInstructionsInjection,
  caseLongContext,
  caseMultiTurnConversation,
  caseSessionResumeAfterDisconnect,
  caseStreamingText,
} from './conversation.js';
import { caseImageUnderstanding, casePdfOfficeAttachment, caseTextAttachment } from './multimodal.js';
import { caseStructuredJsonOutput } from './structuredOutput.js';
import {
  caseMultiRoundToolCall,
  caseParallelToolCalls,
  caseSingleToolCall,
  caseToolDefinitionUnderstanding,
  caseToolResultContinuation,
} from './tools.js';
import { caseClientDisconnectCancel, caseRequestCancellation } from './control.js';
import {
  caseCitationsSources,
  caseModelSelection,
  caseReportedUpstreamModel,
  caseTokenUsageEstimate,
} from './observability.js';
import { caseAccessTokenRefresh, caseRefreshTokenRotation, caseSessionContinueAfterTokenRefresh } from './auth.js';
import {
  caseAccountTenantVariance,
  caseErrorClassification,
  caseRetryAfterBehavior,
  caseSessionAccountBinding,
} from './errors.js';

/**
 * Registry toàn bộ 29 mục thăm dò năng lực theo §3.1, sắp xếp theo số thứ tự.
 *
 * `index.ts` (CLI entry) chạy từng mục theo thứ tự, chèn khoảng nghỉ `--delay-ms` giữa mỗi mục;
 * Bất kỳ mục nào ném ngoại lệ đều được `runCaseSafely` bắt lại và chuyển thành trạng thái `unknown`, không ảnh hưởng các case tiếp theo.
 */
interface RawCase {
  id: string;
  index: number;
  name: string;
  fn: CaseDefinition['run'];
}

const CASES: readonly RawCase[] = [
  { id: 'ws_handshake_auth', index: 1, name: 'WebSocket 握手与鉴权', fn: caseHandshakeAuth },
  { id: 'basic_text_chat', index: 2, name: '普通文本对话', fn: caseBasicTextChat },
  { id: 'streaming_text', index: 3, name: '流式文本响应', fn: caseStreamingText },
  { id: 'image_understanding', index: 4, name: '图片理解', fn: caseImageUnderstanding },
  { id: 'text_attachment', index: 5, name: '文本附件', fn: caseTextAttachment },
  { id: 'pdf_office_attachment', index: 6, name: 'PDF 与 Office 附件', fn: casePdfOfficeAttachment },
  { id: 'multi_turn_conversation', index: 7, name: '连续会话（同一 conversation 内多轮）', fn: caseMultiTurnConversation },
  {
    id: 'session_resume_after_disconnect',
    index: 8,
    name: '上游会话恢复（断线后续接同一 conversation）',
    fn: caseSessionResumeAfterDisconnect,
  },
  { id: 'long_context', index: 9, name: '长上下文承载能力', fn: caseLongContext },
  { id: 'instructions_injection', index: 10, name: 'Instructions / 系统级指令注入方式', fn: caseInstructionsInjection },
  { id: 'structured_json_output', index: 11, name: '结构化 JSON 输出', fn: caseStructuredJsonOutput },
  {
    id: 'tool_definition_understanding',
    index: 12,
    name: '工具定义理解（原生工具概念 / 提示词约束）',
    fn: caseToolDefinitionUnderstanding,
  },
  { id: 'single_tool_call', index: 13, name: '单次工具调用', fn: caseSingleToolCall },
  { id: 'multi_round_tool_call', index: 14, name: '多轮工具调用', fn: caseMultiRoundToolCall },
  { id: 'parallel_tool_calls', index: 15, name: '并行工具调用', fn: caseParallelToolCalls },
  { id: 'tool_result_continuation', index: 16, name: '工具结果回传后继续生成', fn: caseToolResultContinuation },
  { id: 'request_cancellation', index: 17, name: '请求取消', fn: caseRequestCancellation },
  { id: 'token_usage_estimate', index: 18, name: 'Token 使用量或可估算使用量', fn: caseTokenUsageEstimate },
  { id: 'citations_sources', index: 19, name: '引用与来源信息', fn: caseCitationsSources },
  { id: 'model_selection', index: 20, name: '模型名称选择（能否指定 / 是否被忽略）', fn: caseModelSelection },
  { id: 'reported_upstream_model', index: 21, name: '上游返回的实际模型信息', fn: caseReportedUpstreamModel },
  { id: 'access_token_refresh', index: 22, name: 'Access Token 刷新', fn: caseAccessTokenRefresh },
  { id: 'refresh_token_rotation', index: 23, name: 'Refresh Token 轮换', fn: caseRefreshTokenRotation },
  { id: 'error_classification', index: 24, name: '错误分类（401/403/429/5xx/WS 关闭码）', fn: caseErrorClassification },
  { id: 'retry_after_behavior', index: 25, name: 'Retry-After 与限流行为', fn: caseRetryAfterBehavior },
  { id: 'account_tenant_variance', index: 26, name: '账号 / 租户能力差异', fn: caseAccountTenantVariance },
  { id: 'session_account_binding', index: 27, name: '会话与账号绑定关系', fn: caseSessionAccountBinding },
  {
    id: 'session_continue_after_token_refresh',
    index: 28,
    name: '同一会话在刷新 Token 后能否继续',
    fn: caseSessionContinueAfterTokenRefresh,
  },
  { id: 'client_disconnect_cancel', index: 29, name: '客户端断开后上游是否可取消', fn: caseClientDisconnectCancel },
];

/** Registry các case xuất ra bên ngoài: mỗi mục được bọc một tầng `runCaseSafely`, ngoại lệ không làm gián đoạn toàn bộ lượt thăm dò. */
export const ALL_CASES: readonly CaseDefinition[] = CASES.map((c) => ({
  id: c.id,
  index: c.index,
  name: c.name,
  run: (ctx) => runCaseSafely(c.id, c.index, c.name, () => c.fn(ctx)),
}));

if (ALL_CASES.length !== 29) {
  throw new Error(`探针用例数量应为 29，实际为 ${ALL_CASES.length}（§3.1）`);
}
