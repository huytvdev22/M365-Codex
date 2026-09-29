import { buildEvidence, countEventKind, makeResult, runText } from '../caseHelpers.js';
import { CANCELLATION_PROMPT, ownLiterals } from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

/** #17 Hủy yêu cầu: Chủ động gửi stop frame sau khi nhận chunk đầu tiên, xem upstream có dừng kịp thời hay không. */
export async function caseRequestCancellation(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const controller = new AbortController();

  const outcome = await runText(ctx, CANCELLATION_PROMPT, {
    signal: controller.signal,
    sendCancelOnAbort: true,
    onEvent: (event) => {
      if (event.kind === 'text_delta' && !controller.signal.aborted) controller.abort();
    },
  });

  const deltaCount = countEventKind(outcome, 'text_delta');
  // Yêu cầu một câu trả lời dài "không dưới 300 từ", nếu việc hủy có hiệu lực, số chunk nhận được phải ít hơn rõ rệt so với câu trả lời hoàn chỉnh
  const cancelledEarly = outcome.closeReason === 'client_cancelled' || deltaCount <= 2;

  return makeResult({
    id: 'request_cancellation',
    index: 17,
    name: '请求取消',
    status: cancelledEarly ? 'native' : 'partial',
    summary: cancelledEarly
      ? `发送 stop 帧后连接及时停止，本轮只收到 ${deltaCount} 个文本分片。`
      : `发送 stop 帧后仍收到较多分片（${deltaCount} 个），上游对取消的响应可能有延迟。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(CANCELLATION_PROMPT), { text_delta_count: deltaCount }),
  });
}

/** #29 Upstream có thể hủy sau khi client ngắt kết nối không: không gửi stop frame, ngắt kết nối trực tiếp, quan sát xem hành vi tầng kết nối có dứt khoát không. */
export async function caseClientDisconnectCancel(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  const controller = new AbortController();

  const outcome = await runText(ctx, CANCELLATION_PROMPT, {
    signal: controller.signal,
    sendCancelOnAbort: false,
    onEvent: (event) => {
      if (event.kind === 'text_delta' && !controller.signal.aborted) controller.abort();
    },
  });

  const deltaCount = countEventKind(outcome, 'text_delta');
  const disconnectedCleanly = outcome.closeReason === 'client_disconnected';

  return makeResult({
    id: 'client_disconnect_cancel',
    index: 29,
    name: '客户端断开后上游是否可取消',
    status: disconnectedCleanly ? 'adaptable' : 'unknown',
    summary: disconnectedCleanly
      ? `本探针可以在不发送任何 stop 帧的情况下直接断开连接（本轮收到 ${deltaCount} 个分片后断开）；上游是否真的停止生成、是否计入配额，需要人工在真实账号的用量记录里核实（适配器层观察不到）。`
      : `断开流程未按预期完成：${outcome.errorMessage ?? '未知'}。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(CANCELLATION_PROMPT), {
      text_delta_count: deltaCount,
      note: '本项只能验证客户端侧断开是否干净；上游服务端是否真正停止生成不在适配器层可观测范围内',
    }),
  });
}
