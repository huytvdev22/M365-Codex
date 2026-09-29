import { randomUUID } from 'node:crypto';
import type {
  RawMessage,
  ToolDeclaration,
  ToolResultInput,
  UpstreamEvent,
} from '../../apps/server/dist/adapter/protocol.js';
import { buildProbeUrl } from './upstreamConfig.js';
import { runRawSession } from './rawSession.js';
import { buildStructureSample } from './evidence.js';
import type { CapabilityResult, CapabilityStatus, InvocationOutcome, ProbeContext } from './types.js';

/** Các tham số tùy chọn cho invocation dạng text đơn lẻ. */
export interface RunTextOptions {
  conversationRef?: string | undefined;
  passthrough?: Record<string, unknown> | undefined;
  tools?: readonly ToolDeclaration[] | undefined;
  toolResults?: readonly ToolResultInput[] | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: UpstreamEvent, raw: RawMessage) => void) | undefined;
  /** Ghi đè timeout tổng thể mặc định (mili-giây), dùng cho các case cần nhiều thời gian hơn như ngữ cảnh dài */
  totalTimeoutMs?: number | undefined;
  /** Có gửi stop frame khi hủy hay không, xem tùy chọn cùng tên trong `rawSession.ts` */
  sendCancelOnAbort?: boolean | undefined;
}

/** Khởi tạo một invocation và chờ hoàn thành/thất bại/timeout, trả về kết quả tổng hợp. Mỗi lần gọi mở kết nối độc lập. */
export async function runText(
  ctx: ProbeContext,
  text: string,
  options: RunTextOptions = {},
): Promise<InvocationOutcome> {
  const accessToken = await ctx.getAccessToken();
  const url = buildProbeUrl(ctx.upstream, ctx.account, accessToken);
  return runRawSession({
    url,
    codec: ctx.codec,
    invocationId: randomUUID(),
    text,
    conversationRef: options.conversationRef,
    passthrough: options.passthrough,
    tools: options.tools,
    toolResults: options.toolResults,
    handshakeTimeoutMs: ctx.upstream.handshakeTimeoutMs,
    scenario: ctx.upstream.scenario,
    // Client thật sẽ gửi kèm participant.id, probe cũng gửi kèm, nếu không hình thái thăm dò được sẽ không chuẩn xác
    oid: ctx.account.oid,
    idleTimeoutMs: ctx.upstream.idleTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs ?? ctx.invocationTimeoutMs,
    signal: options.signal,
    onEvent: options.onEvent,
    sendCancelOnAbort: options.sendCancelOnAbort,
  });
}

/** Ghép nối nội dung của toàn bộ `text_delta` trong một invocation. */
export function extractText(outcome: InvocationOutcome): string {
  return outcome.events
    .filter((event): event is Extract<UpstreamEvent, { kind: 'text_delta' }> => event.kind === 'text_delta')
    .map((event) => event.text)
    .join('');
}

export function hasEventKind(outcome: InvocationOutcome, kind: UpstreamEvent['kind']): boolean {
  return outcome.events.some((event) => event.kind === kind);
}

export function countEventKind(outcome: InvocationOutcome, kind: UpstreamEvent['kind']): number {
  return outcome.events.filter((event) => event.kind === kind).length;
}

/** Chuyển frame gốc của một invocation thành mẫu cấu trúc đã khử nhạy cảm, giữ tối đa vài frame đầu (đủ để xem cấu trúc). */
export function sampleRawFrames(
  outcome: InvocationOutcome,
  literals: ReadonlySet<string>,
  maxFrames = 5,
): unknown[] {
  return outcome.rawMessages.slice(0, maxFrames).map((message) => buildStructureSample(message, literals));
}

/** Lắp ráp đối tượng bằng chứng chuẩn hóa: mọi case dùng chung một bộ trường cơ sở, thuận tiện cho việc so sánh ngang trong báo cáo. */
export function buildEvidence(
  outcome: InvocationOutcome,
  literals: ReadonlySet<string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_kinds: outcome.events.map((event) => event.kind),
    frame_count: outcome.rawMessages.length,
    raw_frame_structure_sample: sampleRawFrames(outcome, literals),
    close_code: outcome.closeCode,
    close_reason: outcome.closeReason,
    error_category: outcome.errorCategory,
    error_message: outcome.errorMessage,
    retry_after_ms: outcome.retryAfterMs,
    conversation_ref_present: outcome.conversationRef !== null,
    duration_ms: outcome.durationMs,
    ...extra,
  };
}

/** Lắp ráp `CapabilityResult`, thống nhất logic kết thúc của các case. */
export function makeResult(input: {
  id: string;
  index: number;
  name: string;
  status: CapabilityStatus;
  summary: string;
  requestedAt: number;
  durationMs: number;
  errorCategory?: string | null;
  evidence: Record<string, unknown>;
}): CapabilityResult {
  return {
    id: input.id,
    index: input.index,
    name: input.name,
    status: input.status,
    summary: input.summary,
    requestedAt: input.requestedAt,
    durationMs: input.durationMs,
    errorCategory: input.errorCategory ?? null,
    evidence: input.evidence,
  };
}

/** Kết quả dự phòng khi nội bộ case ném ra ngoại lệ: không thể để ngoại lệ của một case làm gián đoạn toàn bộ lượt thăm dò (§6). */
export function makeErrorResult(
  id: string,
  index: number,
  name: string,
  requestedAt: number,
  error: unknown,
): CapabilityResult {
  const message = error instanceof Error ? error.message : String(error);
  return makeResult({
    id,
    index,
    name,
    status: 'unknown',
    summary: `用例执行时抛出异常，判定为 unknown：${message}`,
    requestedAt,
    durationMs: Date.now() - requestedAt,
    errorCategory: 'probe_internal_error',
    evidence: { exception_message: message },
  });
}

/** Bọc thống nhất một tầng try/catch, mọi ngoại lệ nội bộ case đều chuyển thành trạng thái `unknown` thay vì làm gián đoạn toàn bộ lượt thăm dò. */
export async function runCaseSafely(
  id: string,
  index: number,
  name: string,
  fn: () => Promise<CapabilityResult>,
): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  try {
    return await fn();
  } catch (error) {
    return makeErrorResult(id, index, name, requestedAt, error);
  }
}
