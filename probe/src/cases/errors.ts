import { randomUUID } from 'node:crypto';
import { buildEvidence, extractText, makeResult, runText } from '../caseHelpers.js';
import { ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

const PING_TEXT = '请回复「收到」二字即可，用于连通性与错误分类基线测试。';

/**
 * #24 Phân loại lỗi cho 401/403/429/5xx và close code của WebSocket.
 *
 * Bản thân hàm phân loại (`classifyHttpStatus` / `classifyCloseCode`) đã được test vét cạn ở M3 với mock upstream
 * (`connection.test.ts`), ở đây chỉ gửi một yêu cầu thật để ghi nhận trung thực
 * phân loại khớp trong lần này; độ bao phủ ma trận lỗi đầy đủ phụ thuộc vào các status code xuất hiện tự nhiên qua nhiều lần chạy,
 * do `report.ts` tổng hợp phân bố `errorCategory` của tất cả các case trong toàn bộ lượt chạy, không chủ động
 * tạo dựng 401/403/429 ở đây (việc tạo dựng sẽ tiêu tốn quota thật và có nguy cơ kích hoạt kiểm soát rủi ro, xem tuyên bố rủi ro trong README).
 */
export async function caseErrorClassification(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, PING_TEXT);

  const status: CapabilityResult['status'] = outcome.errorCategory === null ? 'adaptable' : 'native';

  return makeResult({
    id: 'error_classification',
    index: 24,
    name: '错误分类（401/403/429/5xx/WS 关闭码）',
    status,
    summary:
      outcome.errorCategory === null
        ? '本次请求成功，只验证了「无错误」这一路径；分类函数已在 M3 用模拟上游穷举覆盖，完整真实错误矩阵见本轮报告的错误分布汇总。'
        : `本次请求命中真实错误分类：${outcome.errorCategory}（${outcome.errorMessage ?? ''}）。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(PING_TEXT)),
  });
}

/**
 * #25 Retry-After và hành vi giới hạn tần suất: Tương tự áp dụng quan sát thụ động — probe này mặc định chạy tuần tự + có khoảng nghỉ,
 * không chủ động đánh sập tài khoản để kích hoạt rate limit; nếu lượt này tự nhiên gặp 429, ở đây sẽ ghi nhận trung thực thời gian chờ đã phân tích được.
 */
export async function caseRetryAfterBehavior(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const outcome = await runText(ctx, PING_TEXT);
  const rateLimited = outcome.errorCategory === 'rate_limited';

  return makeResult({
    id: 'retry_after_behavior',
    index: 25,
    name: 'Retry-After 与限流行为',
    status: rateLimited ? 'native' : 'unknown',
    summary: rateLimited
      ? `本次请求自然触发限流，解析出的冷却时间：${outcome.retryAfterMs ?? '无法解析'} 毫秒。`
      : '本次请求未触发限流（这是预期的正常情况——探针刻意不主动构造 429，避免影响账号）。如需专门验证 Retry-After 解析，需要在人工监督下另行安排小流量压测，不在默认安全跑法范围内。',
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(PING_TEXT)),
  });
}

/**
 * #26 Khác biệt năng lực tài khoản / tenant: Một tài khoản đơn lẻ không thể tự thể hiện "khác biệt", ở đây chỉ sinh ra
 * dấu vân tay năng lực của tài khoản này để `report.ts` so sánh ngang trong kịch bản nhiều tài khoản `--all`; không phát thêm yêu cầu.
 */
export function caseAccountTenantVariance(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  return Promise.resolve(
    makeResult({
      id: 'account_tenant_variance',
      index: 26,
      name: '账号 / 租户能力差异',
      status: 'unknown',
      summary:
        '单个账号的探测结果本身无法体现「差异」；请用 `--all` 对多个账号跑一遍，报告会在「账号间差异」章节按 case 状态做横向对比。本项不发起额外上游请求。',
      requestedAt,
      durationMs: 0,
      errorCategory: null,
      evidence: { account_id_prefix: ctx.account.id.slice(0, 8), tid_prefix: ctx.account.tid.slice(0, 8) },
    }),
  );
}

const BINDING_MARK = `绑定测试标记-${randomUUID().slice(0, 8)}`;
const BINDING_REMEMBER_PROMPT = `请记住一个标记词：「${BINDING_MARK}」，仅回复「已记住」。`;
const BINDING_RECALL_PROMPT = '我刚才让你记住的标记词是什么？只回复那个词，不知道就说不知道。';

/**
 * #27 Mối quan hệ ràng buộc giữa phiên và tài khoản: Dùng một conversationRef "tự bịa ra, chưa từng được upstream cấp"
 * để nối tiếp, kiểm tra xem có vô tình đọc được nội dung phiên thật khác của tài khoản này hay không (kiểm tra liên quan đến tính toàn vẹn ràng buộc bảo mật).
 */
export async function caseSessionAccountBinding(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const established = await runText(ctx, BINDING_REMEMBER_PROMPT);

  const fabricatedRef = `probe-fabricated-${randomUUID()}`;
  const probed = await runText(ctx, BINDING_RECALL_PROMPT, { conversationRef: fabricatedRef });
  const leaked = extractText(probed).includes(BINDING_MARK);

  return makeResult({
    id: 'session_account_binding',
    index: 27,
    name: '会话与账号绑定关系',
    status: probed.errorCategory !== null ? 'unknown' : leaked ? 'unstable' : 'native',
    summary: leaked
      ? '警告：用一个凭空捏造的 conversationRef 续接后，回复中出现了另一次真实会话设置的标记词，说明上游可能没有严格按会话标识隔离上下文，需要人工进一步确认。'
      : '用凭空捏造的 conversationRef 续接没有读到其他会话的内容，会话与账号/会话标识的绑定看起来是隔离的。',
    requestedAt,
    durationMs: established.durationMs + probed.durationMs,
    errorCategory: probed.errorCategory,
    evidence: {
      established_turn: buildEvidence(established, ownLiterals(BINDING_REMEMBER_PROMPT)),
      fabricated_ref_turn: buildEvidence(probed, ownLiterals(BINDING_RECALL_PROMPT)),
      leaked_other_session_content: leaked,
    },
  });
}
