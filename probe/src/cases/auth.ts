import { extractText, makeResult, runText } from '../caseHelpers.js';
import { TokenUnavailableError } from '../../../apps/server/dist/oauth/tokenManager.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

/**
 * Các case liên quan đến refresh Token (§3.1 mục 22/23/28).
 *
 * Quy tắc sắt: Ở đây chỉ so sánh kết quả boolean "có thay đổi trước và sau refresh hay không" trong bộ nhớ, tuyệt đối không đưa
 * plain text, đặc trưng độ dài hoặc bất kỳ đoạn nào có thể khôi phục của access/refresh token vào `CapabilityResult.evidence`.
 */

interface RefreshComparison {
  success: boolean;
  accessTokenExpiryExtended: boolean | null;
  refreshTokenRotated: boolean | null;
  errorMessage: string | null;
}

async function refreshAndCompare(ctx: ProbeContext): Promise<RefreshComparison> {
  const before = ctx.accounts.readAccessToken(ctx.account.id);
  const beforeRefresh = ctx.accounts.readRefreshToken(ctx.account.id);

  try {
    await ctx.tokenManager.refresh(ctx.account.id);
  } catch (error) {
    const message =
      error instanceof TokenUnavailableError
        ? `${error.reason}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { success: false, accessTokenExpiryExtended: null, refreshTokenRotated: null, errorMessage: message };
  }

  const after = ctx.accounts.readAccessToken(ctx.account.id);
  const afterRefresh = ctx.accounts.readRefreshToken(ctx.account.id);

  const accessTokenExpiryExtended =
    before?.expiresAt !== null && before?.expiresAt !== undefined && after?.expiresAt !== null && after?.expiresAt !== undefined
      ? after.expiresAt > before.expiresAt
      : null;
  const refreshTokenRotated =
    beforeRefresh !== null && afterRefresh !== null ? beforeRefresh !== afterRefresh : null;

  return { success: true, accessTokenExpiryExtended, refreshTokenRotated, errorMessage: null };
}

/** #22 Refresh Access Token: Có đổi thành công access token mới hay không (và thời gian hết hạn thực sự được gia hạn). */
export async function caseAccessTokenRefresh(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const result = await refreshAndCompare(ctx);

  return makeResult({
    id: 'access_token_refresh',
    index: 22,
    name: 'Access Token 刷新',
    status: result.success ? 'native' : 'unsupported',
    summary: result.success
      ? `刷新成功${result.accessTokenExpiryExtended === true ? '，且过期时间确实延后' : '（未能判断过期时间是否延后）'}。`
      : `刷新失败：${result.errorMessage ?? '未知错误'}。`,
    requestedAt,
    durationMs: Date.now() - requestedAt,
    errorCategory: result.success ? null : 'refresh_failed',
    evidence: {
      refresh_succeeded: result.success,
      access_token_expiry_extended: result.accessTokenExpiryExtended,
      error_message: result.errorMessage,
    },
  });
}

/** #23 Xoay vòng Refresh Token: Microsoft không phải lần refresh nào cũng cấp refresh_token mới, ở đây chỉ ghi nhận trung thực việc có xoay vòng hay không. */
export async function caseRefreshTokenRotation(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const result = await refreshAndCompare(ctx);

  let status: CapabilityResult['status'];
  if (!result.success) status = 'unknown';
  else if (result.refreshTokenRotated === null) status = 'unknown';
  else status = 'native'; // Dù xoay vòng hay không đều là năng lực vốn có "gateway quan sát và xử lý chính xác", cả hai đều đánh giá là native

  return makeResult({
    id: 'refresh_token_rotation',
    index: 23,
    name: 'Refresh Token 轮换',
    status,
    summary: !result.success
      ? `刷新失败：${result.errorMessage ?? '未知错误'}。`
      : result.refreshTokenRotated === null
        ? '无法判断是否轮换（缺少可比较的前置状态）。'
        : result.refreshTokenRotated
          ? '本次刷新后观察到新的 refresh_token（已轮换），网关会原子替换旧值。'
          : '本次刷新未下发新的 refresh_token（未轮换），网关按既有逻辑保留旧值，符合 Microsoft 的常见行为。',
    requestedAt,
    durationMs: Date.now() - requestedAt,
    errorCategory: result.success ? null : 'refresh_failed',
    evidence: {
      refresh_succeeded: result.success,
      refresh_token_rotated: result.refreshTokenRotated,
      error_message: result.errorMessage,
    },
  });
}

const REMEMBER_NAME = '探针续接标记九号';
const REMEMBER_PROMPT = `请记住一个标记词：「${REMEMBER_NAME}」，仅回复「已记住」。`;
const RECALL_PROMPT = '我刚才让你记住的标记词是什么？只回复那个词。';

/** #28 Cùng một phiên có thể tiếp tục sau khi refresh Token không: trước tiên thiết lập phiên, ép buộc refresh Token, sau đó dùng Token mới để nối tiếp cùng conversationRef. */
export async function caseSessionContinueAfterTokenRefresh(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const first = await runText(ctx, REMEMBER_PROMPT);
  if (first.errorCategory !== null || first.conversationRef === null) {
    return makeResult({
      id: 'session_continue_after_token_refresh',
      index: 28,
      name: '同一会话在刷新 Token 后能否继续',
      status: 'unknown',
      summary: '未能拿到可用的会话标识，无法验证 Token 刷新后的续接。',
      requestedAt,
      durationMs: first.durationMs,
      errorCategory: first.errorCategory,
      evidence: { conversation_ref_present: first.conversationRef !== null },
    });
  }

  const refresh = await refreshAndCompare(ctx);
  if (!refresh.success) {
    return makeResult({
      id: 'session_continue_after_token_refresh',
      index: 28,
      name: '同一会话在刷新 Token 后能否继续',
      status: 'unknown',
      summary: `建立会话后强制刷新 Token 失败：${refresh.errorMessage ?? '未知错误'}，无法继续验证。`,
      requestedAt,
      durationMs: first.durationMs,
      errorCategory: 'refresh_failed',
      evidence: { refresh_succeeded: false },
    });
  }

  // ctx.getAccessToken() sẽ đọc lại DB, lúc này lẽ ra đã nhận được access token mới sau khi refresh
  const resumed = await runText(ctx, RECALL_PROMPT, { conversationRef: first.conversationRef });
  const remembered = extractText(resumed).includes(REMEMBER_NAME);

  return makeResult({
    id: 'session_continue_after_token_refresh',
    index: 28,
    name: '同一会话在刷新 Token 后能否继续',
    status: resumed.errorCategory !== null ? 'unstable' : remembered ? 'native' : 'partial',
    summary: remembered
      ? 'Token 刷新后，用新 access token 续接同一 conversationRef 仍能拿到正确的上下文。'
      : `Token 刷新后续接${resumed.errorCategory !== null ? '请求失败' : '未观察到上下文延续'}。`,
    requestedAt,
    durationMs: first.durationMs + resumed.durationMs,
    errorCategory: resumed.errorCategory,
    evidence: {
      refresh_succeeded: true,
      conversation_ref_present: true,
      remembered,
      close_code: resumed.closeCode,
    },
  });
}
