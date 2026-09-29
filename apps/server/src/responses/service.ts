import { ApiError } from '@m365-codex/shared';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { ToolsConfig } from '../config/index.js';
import type { UpstreamEvent } from '../adapter/protocol.js';
import type { DispatchRequest, UpstreamDispatcher } from '../scheduler/dispatcher.js';
import type { Metrics } from '../observability/metrics.js';
import type { ResponseRepository } from '../repo/responses.js';
import type { ToolCallRepository } from '../repo/toolCalls.js';
import type { FilesService } from '../files/service.js';
import { buildToolInstruction, PromptToolScanner } from '../tools/promptProtocol.js';
import { ToolRegistry, type ValidationReason } from '../tools/registry.js';
import { SHUTDOWN_ABORT_REASON } from './inFlight.js';
import { ResponseStreamBuilder } from './builder.js';
import {
  buildPassthrough,
  extractInputText,
  extractReasoningEffort,
  type ExtractInputDeps,
  type ResponsesRequest,
  type ToolResult,
} from './schema.js';
import type { ResponseObject, SseEvent } from './types.js';

/**
 * Responses Service: Kết nối dispatch → máy trạng thái → lưu trữ dữ liệu, và thực hiện vòng lặp proxy gọi công cụ hoàn chỉnh
 * (tương ứng kế hoạch triển khai §7).
 *
 * Các quy tắc về độ tin cậy (§7.3) được áp dụng tại đây:
 * - **Chỉ gọi các công cụ đã khai báo**: Lần gọi chưa khai báo sẽ yêu cầu sửa trước, nếu sửa không thành công sẽ bỏ qua và đánh giá thất bại, tuyệt đối không gửi cho client;
 * - **Tham số phải là JSON hợp lệ**: Sửa không thành công cũng đánh giá thất bại (gửi đi client cũng không parse được);
 * - **Tham số không khớp với schema**: Khi sửa không thành công vẫn gửi nguyên bản và ghi log cảnh báo — schema có thể chỉ là kỳ vọng của client,
 *   do client tự quyết định cách xử lý, khả dụng hơn là làm thất bại cả vòng;
 * - **Mỗi lần gọi có call_id duy nhất**, **không phát trùng lặp do kết nối lại**: Dựa vào ràng buộc của bảng tool_calls
 *   `UNIQUE (response_id, call_id)`;
 * - **Kết quả trả về phải khớp với call_id chưa hoàn thành**: Xác thực đồng bộ trong create(), trước bất kỳ hành động upstream nào;
 * - **Giai đoạn tác dụng phụ không phát lại qua tài khoản khác**: Request mang kết quả công cụ được đánh dấu sideEffect, bộ điều phối đảm bảo dừng ngay khi thất bại;
 * - **JSON công cụ không xuất hiện lặp lại trong nội dung chính**: Chế độ mô phỏng prompt được PromptToolScanner tách ra khỏi luồng văn bản.
 */

export interface CreateResponseInput {
  request: ResponsesRequest;
  apiKeyId: string | null;
  signal?: AbortSignal | undefined;
  idempotencyKey?: string | null;
  /**
   * Giới hạn trên số lượt gọi công cụ tích lũy của chuỗi hội thoại này sau khi siết chặt theo API Key (§10.1); phía gọi
   * (`routes/v1.ts`/`routes/chat.ts`) đã truyền vào giá trị `min(cài đặt của Key, trần cấu hình toàn cục)` được tính toán
   * bởi `gateway/auth.ts`. Khi không truyền sẽ quay về cấu hình toàn cục
   * `tools.maxTotalCalls`, hành vi hoàn toàn nhất quán như trước.
   */
  toolCallsCeiling?: number;
}

export interface ResponseExecution {
  responseId: string;
  stream: AsyncGenerator<SseEvent>;
  getFinal: () => ResponseObject;
  getError: () => ApiError | null;
  /** Tên công cụ client đã khai báo nhưng gateway này không thể thực thi và đã bị bỏ qua (để route ghi header phản hồi thông báo phía gọi) */
  skippedTools: readonly string[];
}

export interface ResponsesServiceDeps {
  dispatcher: UpstreamDispatcher;
  responses: ResponseRepository;
  toolCalls: ToolCallRepository;
  tools: ToolsConfig;
  logger: Logger;
  /** Bổ sung M6: Phân giải tham chiếu file_id của input_file / input_image (giới hạn quyền sở hữu theo API Key gửi request) */
  files?: FilesService;
  /** Bổ sung M6: Upstream có thực sự hỗ trợ đầu vào hình ảnh không (UPSTREAM_IMAGE_INPUT, mặc định false) */
  upstreamImageInput?: boolean;
  /** Bổ sung M6: Văn bản ngữ cảnh tái dựng vượt quá bao nhiêu ký tự thì bắt đầu cắt tỉa từ lịch sử cũ nhất */
  contextMaxChars?: number;
  /** Bổ sung M7: Thu thập số liệu trên đường dẫn quan trọng, phục vụ /admin/overview và /metrics M8 tương lai */
  metrics?: Metrics;
}

/** Lần gọi công cụ trong bộ đệm (tích lũy tham số theo call_id). */
interface PendingToolCall {
  callId: string;
  name: string;
  args: string;
}

/** Kết luận kiểm tra một vòng gọi công cụ. */
interface RoundVerdict {
  /** Vấn đề nghiêm trọng bắt buộc phải yêu cầu sửa, và nếu sửa không được thì không thể phát đi */
  fatal: string[];
  /** Chỉ là không khớp schema, sửa không được thì vẫn có thể phát đi */
  soft: string[];
  /** Lần gọi chưa khai báo hoặc tham số không hợp lệ, không cho phép gửi cho client */
  rejected: Set<string>;
}

export class ResponsesService {
  readonly #deps: ResponsesServiceDeps;

  constructor(deps: ResponsesServiceDeps) {
    this.#deps = deps;
  }

  create(input: CreateResponseInput): ResponseExecution {
    const { request } = input;
    // Tham chiếu file_id của input_file / input_image được giới hạn quyền sở hữu theo API Key gửi request,
    // không cho phép đọc nội dung tệp do người khác tải lên qua Key khác (xem resolveOwned* trong files/service.ts).
    const extracted = extractInputText(request, this.#buildExtractDeps(input.apiKeyId)); // Nội dung không hỗ trợ sẽ ném lỗi rõ ràng tại đây
    if (extracted.truncatedChars > 0) {
      // Không im lặng: Ngữ cảnh bị cắt bớt do vượt quá CONTEXT_MAX_CHARS, để lại dấu vết để dễ chẩn đoán hiện tượng "mô hình đột nhiên mất trí nhớ"
      this.#deps.logger.info(
        { truncated_chars: extracted.truncatedChars },
        '重建的对话上下文超过字符上限，已从最旧历史开始截断',
      );
    }
    if (extracted.skippedItemTypes.length > 0) {
      this.#deps.logger.warn(
        { skipped_item_types: extracted.skippedItemTypes },
        'input 中出现无法识别的历史项类型，已跳过（不影响用户可见内容）',
      );
    }
    const registry = ToolRegistry.fromRequest(request.tools);
    const previousResponseId = request.previous_response_id ?? null;

    // Trả về kết quả công cụ: Bắt buộc phải khớp với lượt gọi đã phát ra và không vượt quá giới hạn kích thước kết quả.
    // Đặt ở đây (thay vì trong generator) nhằm trả về 4xx rõ ràng cho client trước khi tương tác với upstream.
    this.#validateToolResults(extracted.toolResults, previousResponseId);

    const inherited = this.#inheritToolCounters(previousResponseId);
    const limits = this.#deps.tools;
    if (registry.size > 0 && inherited.round >= limits.maxRounds) {
      throw ApiError.badRequest(
        `本对话链已达最大工具轮次 ${limits.maxRounds}，不再继续代理循环`,
        'previous_response_id',
      );
    }

    const responseId = `resp_${randomBytes(16).toString('hex')}`;
    const now = Date.now();
    const sticky = this.#resolveSticky(previousResponseId);
    const reasoningEffort = extractReasoningEffort(request);
    const passthrough = buildPassthrough(request);
    if (extracted.images.length > 0) {
      // "Quy ước tầng adapter": Trường chuyển tiếp (passthrough) của invocation vốn là kênh mở rộng chung cho upstream
      // (model/reasoning/temperature đều đi qua đường này), hình ảnh dùng chung kênh này,
      // tên trường/cấu trúc online cụ thể chờ probe M0 hiệu chuẩn (xem chú thích trong adapter/protocol.ts).
      passthrough.images = extracted.images;
    }

    const builder = new ResponseStreamBuilder({
      responseId,
      model: request.model,
      previousResponseId,
      metadata: request.metadata ?? null,
      reasoningEffort,
      maxOutputTokens: request.max_output_tokens ?? null,
      temperature: request.temperature ?? null,
      createdAt: now,
    });

    this.#deps.responses.create(
      {
        id: responseId,
        apiKeyId: input.apiKeyId,
        status: 'queued',
        requestedModel: request.model,
        requestedReasoningEffort: reasoningEffort,
        upstreamModelParameter: request.model,
        previousResponseId,
        idempotencyKey: input.idempotencyKey ?? null,
        toolRound: inherited.round,
        toolCallsTotal: inherited.total,
      },
      now,
    );

    if (registry.skipped.length > 0) {
      // Không im lặng: Công cụ được quản lý bị bỏ qua cần để lại dấu vết, router cũng sẽ thông báo cho phía gọi qua header phản hồi
      this.#deps.logger.warn(
        { response_id: responseId, skipped: registry.skipped.map((t) => `${t.type}:${t.name}`) },
        '声明了本网关执行不了的工具，已跳过',
      );
    }

    const errorHolder: { error: ApiError | null } = { error: null };
    const stream = this.#run({ input, extracted, sticky, passthrough, registry, builder, errorHolder, inherited });
    return {
      responseId,
      stream,
      getFinal: () => builder.snapshot(),
      getError: () => errorHolder.error,
      skippedTools: registry.skipped.map((t) => t.name),
    };
  }

  async *#run(ctx: {
    input: CreateResponseInput;
    extracted: ReturnType<typeof extractInputText>;
    sticky: { accountId: string; conversationRef: string | null } | null;
    passthrough: Record<string, unknown>;
    registry: ToolRegistry;
    builder: ResponseStreamBuilder;
    errorHolder: { error: ApiError | null };
    inherited: { round: number; total: number };
  }): AsyncGenerator<SseEvent> {
    const { builder, registry } = ctx;
    const limits = this.#deps.tools;
    // §10.1: Trần số lượt gọi công cụ ở cấp API Key chỉ có thể nghiêm ngặt hơn trần toàn cục;
    // ctx.input.toolCallsCeiling đã là giá trị hợp lệ được phía gọi tính bằng clampToCeiling
    const maxTotalCalls = ctx.input.toolCallsCeiling ?? limits.maxTotalCalls;
    const responseId = builder.responseId;

    yield* iter(builder.begin());
    this.#deps.responses.updateStatus(responseId, 'in_progress');

    // Tiếp nối: Đánh dấu các lệnh gọi công cụ phát ra ở vòng trước và mang kết quả trả về lần này là hoàn thành (idempotent)
    this.#markPriorToolCallsCompleted(ctx.input.request.previous_response_id ?? null, ctx.extracted.toolResults);

    const toolResults = ctx.extracted.toolResults.map((r) => ({ callId: r.callId, output: r.output }));
    const hasToolResults = toolResults.length > 0;
    const hasTools = registry.size > 0;
    // native / auto đi theo khai báo có cấu trúc; prompt / auto ghi thêm danh mục công cụ vào prompt (§3.5)
    const tools = hasTools && limits.mode !== 'prompt' ? registry.toDeclarations() : undefined;
    const instruction = hasTools && limits.mode !== 'native' ? buildToolInstruction(registry.list()) : '';
    const scanText = instruction !== '';
    const allowParallel = limits.allowParallel && ctx.input.request.parallel_tool_calls !== false;
    const maxPerRound = allowParallel ? limits.maxCallsPerRound : 1;

    let lastAccountId = '';
    let lastConversationRef: string | null = ctx.sticky?.conversationRef ?? null;
    let finalToolRound = ctx.inherited.round;

    try {
      let attempt = 0;
      let text = withInstruction(instruction, ctx.extracted.text);
      let sticky = ctx.sticky;
      let sideEffect = hasToolResults;
      let carryToolResults: typeof toolResults | undefined = hasToolResults ? toolResults : undefined;

      for (;;) {
        const request: DispatchRequest = {
          text,
          sticky,
          passthrough: ctx.passthrough,
          tools,
          toolResults: carryToolResults,
          sideEffect,
          signal: ctx.input.signal,
        };
        const dispatch = this.#deps.dispatcher.dispatch(request);
        const pending = new Map<string, PendingToolCall>();
        const order: string[] = [];
        const scanner = scanText ? new PromptToolScanner() : null;

        for await (const raw of dispatch.events) {
          for (const event of expand(raw, scanner)) {
            if (this.#accumulateToolEvent(event, pending, order)) continue;
            // Vòng sửa lỗi (attempt > 0) không lặp lại xuất văn bản cho client, chỉ lấy lệnh gọi công cụ
            if (attempt === 0) {
              yield* iter(builder.consume(event));
            }
          }
        }
        if (scanner !== null) {
          for (const event of flush(scanner)) {
            if (this.#accumulateToolEvent(event, pending, order)) continue;
            if (attempt === 0) yield* iter(builder.consume(event));
          }
        }
        lastAccountId = dispatch.accountId;
        lastConversationRef = dispatch.conversationRef;

        const toolCalls = order.map((id) => pending.get(id)).filter((c): c is PendingToolCall => c !== undefined);
        if (toolCalls.length === 0) {
          break; // Không có lệnh gọi công cụ, kết thúc vòng này
        }

        const verdict = this.#judgeRound(toolCalls, registry, maxPerRound, allowParallel);

        if ((verdict.fatal.length > 0 || verdict.soft.length > 0) && attempt < limits.maxArgRepairs) {
          attempt += 1;
          text = withInstruction(instruction, buildRepairPrompt([...verdict.fatal, ...verdict.soft]));
          sticky = { accountId: dispatch.accountId, conversationRef: dispatch.conversationRef };
          // Vòng sửa lỗi chỉ yêu cầu lại lệnh gọi công cụ, bản thân không tạo tác dụng phụ
          sideEffect = false;
          carryToolResults = undefined;
          this.#deps.logger.info(
            { response_id: responseId, attempt, fatal: verdict.fatal.length, soft: verdict.soft.length },
            '工具调用不合规，请求上游修复',
          );
          continue;
        }

        if (verdict.fatal.length > 0) {
          // Hết hạn mức sửa vẫn không hợp lệ: Công cụ chưa khai báo, JSON không hợp lệ tuyệt đối không gửi cho client
          throw new ApiError({
            type: 'upstream_error',
            status: 502,
            message: `上游的工具调用不合规且修复 ${limits.maxArgRepairs} 次后仍未纠正：${verdict.fatal.join('；')}`,
          });
        }

        const emitted = toolCalls.filter((tc) => !verdict.rejected.has(tc.callId));
        if (ctx.inherited.total + emitted.length > maxTotalCalls) {
          throw ApiError.badRequest(
            `本对话链累计工具调用数将超过上限 ${maxTotalCalls}，不再继续代理循环`,
          );
        }
        if (verdict.soft.length > 0) {
          this.#deps.logger.warn(
            { response_id: responseId, issues: verdict.soft.length },
            '工具参数不符合 schema，修复额度用尽后如实发出',
          );
        }

        // Thu thập số liệu phục vụ tools.calls_last_hour / arg_pass_rate của /admin/overview:
        // rejected là số lượng gọi bị phán định không hợp lệ trong vòng này và tuyệt đối không gửi cho client; emitted là số lượng thực tế gửi đi.
        if (verdict.rejected.size > 0) {
          this.#deps.metrics?.toolArgValidations.inc({ result: 'rejected' }, verdict.rejected.size);
        }
        if (emitted.length > 0) {
          this.#deps.metrics?.toolCalls.inc({}, emitted.length);
          this.#deps.metrics?.toolArgValidations.inc({ result: 'pass' }, emitted.length);
        }

        for (const tc of emitted) {
          yield* iter(builder.emitFunctionCall(tc.callId, tc.name, tc.args));
          this.#deps.toolCalls.recordEmitted({
            responseId,
            callId: tc.callId,
            name: tc.name,
            arguments: tc.args,
            sideEffect: registry.isSideEffect(tc.name),
          });
        }
        finalToolRound = ctx.inherited.round + 1;
        this.#deps.responses.setToolCounters(
          responseId,
          finalToolRound,
          ctx.inherited.total + emitted.length,
        );
        break;
      }

      if (ctx.input.signal?.aborted === true) {
        if (this.#isShutdownAbort(ctx.input.signal)) return; // Việc lưu DB do server.ts xử lý tập trung, xem chú thích của signal đó
        yield* iter(builder.cancel());
        this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
        return;
      }

      yield* iter(builder.finish());
      const finalStatus = builder.snapshot();
      if (finalStatus.status === 'failed') {
        ctx.errorHolder.error = new ApiError({
          type: 'upstream_error',
          status: 502,
          message: finalStatus.error?.message ?? '上游返回错误',
        });
      }
      // Chỉ ghi nhận một lần khi luồng kết thúc tự nhiên: Thống kê vòng lặp là "một chuỗi hội thoại cuối cùng dùng mấy vòng",
      // việc hủy/ngoại lệ giữa chừng không cấu thành một mẫu hoàn chỉnh
      if (finalStatus.status === 'completed' || finalStatus.status === 'failed') {
        this.#deps.metrics?.toolRounds.observe(finalToolRound);
      }
      this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
    } catch (error) {
      if (ctx.input.signal?.aborted === true) {
        if (this.#isShutdownAbort(ctx.input.signal)) return; // Tương tự trên: không ghi DB trùng lặp
        yield* iter(builder.cancel());
        this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
        return;
      }
      const apiError = error instanceof ApiError ? error : ApiError.internal('上游处理失败', error);
      ctx.errorHolder.error = apiError;
      this.#deps.logger.warn({ response_id: responseId, err_code: apiError.type }, 'Responses 执行失败');
      yield* iter(builder.fail(apiError.message, apiError.type));
      this.#persistFinal(responseId, lastAccountId, lastConversationRef, builder);
    }
  }

  /**
   * Thẩm định một vòng gọi công cụ: Số lượng có vượt quá không, công cụ đã khai báo chưa, tham số có hợp lệ không.
   * Chưa khai báo và JSON không hợp lệ sẽ vào rejected (tuyệt đối không gửi cho client), không khớp schema chỉ ghi nhận lỗi nhẹ.
   */
  #judgeRound(
    toolCalls: readonly PendingToolCall[],
    registry: ToolRegistry,
    maxPerRound: number,
    allowParallel: boolean,
  ): RoundVerdict {
    const verdict: RoundVerdict = { fatal: [], soft: [], rejected: new Set() };

    if (toolCalls.length > maxPerRound) {
      verdict.fatal.push(
        allowParallel
          ? `一轮最多 ${maxPerRound} 个工具调用，收到 ${toolCalls.length} 个`
          : `本次请求禁止并行工具调用，但收到 ${toolCalls.length} 个`,
      );
    }

    for (const call of toolCalls) {
      const result = registry.validateArguments(call.name, call.args);
      if (result.valid) continue;
      const summary = `工具 ${call.name}：${result.errors.join('；')}`;
      const reason: ValidationReason = result.reason ?? 'schema';
      if (reason === 'schema') {
        verdict.soft.push(summary);
      } else {
        verdict.fatal.push(summary);
        verdict.rejected.add(call.callId);
      }
    }
    return verdict;
  }

  /** Tích lũy sự kiện công cụ vào bộ đệm; trả về true nếu sự kiện đó là sự kiện công cụ (đã tiêu thụ). */
  #accumulateToolEvent(
    event: UpstreamEvent,
    pending: Map<string, PendingToolCall>,
    order: string[],
  ): boolean {
    switch (event.kind) {
      case 'tool_call_begin':
        if (!pending.has(event.callId)) {
          pending.set(event.callId, { callId: event.callId, name: event.name, args: '' });
          order.push(event.callId);
        }
        return true;
      case 'tool_call_args_delta': {
        const call = pending.get(event.callId);
        if (call !== undefined) call.args += event.delta;
        return true;
      }
      case 'tool_call_end':
        return true;
      default:
        return false;
    }
  }

  /** Xác thực kết quả công cụ trả về: Phải tương ứng với lần gọi đã phát ra và không vượt giới hạn kích thước (§7.3, §7.4). */
  #validateToolResults(toolResults: readonly ToolResult[], previousResponseId: string | null): void {
    const maxBytes = this.#deps.tools.maxResultBytes;
    for (const result of toolResults) {
      const size = Buffer.byteLength(result.output, 'utf8');
      if (size > maxBytes) {
        throw new ApiError({
          type: 'invalid_request_error',
          status: 413,
          message: `工具结果 ${size} 字节，超过上限 ${maxBytes} 字节`,
          param: 'input',
        });
      }
      const known =
        (previousResponseId === null
          ? undefined
          : this.#deps.toolCalls.findByCallId(previousResponseId, result.callId)) ??
        this.#deps.toolCalls.findAnyByCallId(result.callId);
      if (known === undefined) {
        throw ApiError.badRequest(
          `function_call_output 的 call_id ${result.callId} 不对应任何已发出的工具调用`,
          'input',
        );
      }
    }
  }

  /** Kế thừa số vòng công cụ và tổng số lần gọi tích lũy từ vòng trước. */
  #inheritToolCounters(previousResponseId: string | null): { round: number; total: number } {
    if (previousResponseId === null) return { round: 0, total: 0 };
    const parent = this.#deps.responses.findById(previousResponseId);
    return { round: parent?.tool_round ?? 0, total: parent?.tool_calls_total ?? 0 };
  }

  /** Khi tiếp nối, đánh dấu các lần gọi công cụ đã phát ở vòng trước và có kết quả lần này là hoàn thành (idempotent). */
  #markPriorToolCallsCompleted(
    previousResponseId: string | null,
    toolResults: readonly { callId: string; output: string }[],
  ): void {
    if (toolResults.length === 0) return;
    for (const result of toolResults) {
      const existing =
        (previousResponseId === null
          ? undefined
          : this.#deps.toolCalls.findByCallId(previousResponseId, result.callId)) ??
        this.#deps.toolCalls.findAnyByCallId(result.callId);
      if (existing === undefined) continue;
      // markCompleted chỉ có hiệu lực khi emitted→completed, gửi lại trùng lặp sẽ không xử lý lần 2
      this.#deps.toolCalls.markCompleted(existing.response_id, result.callId, result.output);
    }
  }

  #persistFinal(
    responseId: string,
    accountId: string,
    conversationRef: string | null,
    builder: ResponseStreamBuilder,
  ): void {
    const snapshot = builder.snapshot();
    if (accountId !== '') {
      this.#deps.responses.setAccount(responseId, accountId);
      this.#deps.responses.upsertBinding({
        response_id: responseId,
        account_id: accountId,
        upstream_conversation_ref: conversationRef,
        created_at: Date.now(),
      });
    }
    this.#deps.responses.complete(responseId, snapshot.status, snapshot, {
      errorMessage: snapshot.error?.message ?? null,
    });
  }

  /**
   * Phân biệt giữa "hủy do dừng hệ thống nhẹ nhàng (graceful shutdown)" và "người dùng/client chủ động hủy" (§19). Cái trước do
   * `gracefulShutdown` trong `server.ts` xử lý tập trung theo `maintenance/recovery.ts`,
   * lưu Response này xuống DB thành `incomplete`; nếu ở đây cũng gọi `builder.cancel()`
   * để ghi `cancelled`, sẽ có 2 tác nhân cạnh tranh ghi cùng một dòng, gây xung đột ngữ nghĩa trạng thái cuối cùng.
   */
  #isShutdownAbort(signal: AbortSignal): boolean {
    return signal.reason === SHUTDOWN_ABORT_REASON;
  }

  #resolveSticky(previousResponseId: string | null): { accountId: string; conversationRef: string | null } | null {
    if (previousResponseId === null) return null;
    const binding = this.#deps.responses.findBinding(previousResponseId);
    if (binding?.account_id == null) return null;
    return { accountId: binding.account_id, conversationRef: binding.upstream_conversation_ref };
  }

  /** Điều hợp FilesService thành interface tra cứu theo apiKeyId mà extractInputText yêu cầu. */
  #buildExtractDeps(apiKeyId: string | null): ExtractInputDeps {
    const files = this.#deps.files;
    if (files === undefined || apiKeyId === null) {
      return {
        imageInputEnabled: this.#deps.upstreamImageInput === true,
        contextMaxChars: this.#deps.contextMaxChars,
      };
    }
    return {
      imageInputEnabled: this.#deps.upstreamImageInput === true,
      contextMaxChars: this.#deps.contextMaxChars,
      files: {
        resolveText: (fileId) => files.resolveOwnedText(fileId, apiKeyId),
        resolveImageDataUrl: (fileId) => files.resolveOwnedImageDataUrl(fileId, apiKeyId),
      },
    };
  }
}

/** Ở chế độ mô phỏng prompt, danh mục công cụ được gửi kèm phía trước văn bản người dùng tới upstream. */
function withInstruction(instruction: string, text: string): string {
  return instruction === '' ? text : `${instruction}\n\n${text}`;
}

/** Khởi tạo prompt yêu cầu upstream sửa lỗi. */
function buildRepairPrompt(issues: readonly string[]): string {
  return `上一次的工具调用不符合要求，请仅重新发起工具调用并给出合法参数。\n${issues.join('\n')}`;
}

/** Ở chế độ mô phỏng prompt, tách các lệnh gọi công cụ trong nội dung văn bản ra; các sự kiện còn lại giữ nguyên. */
function expand(event: UpstreamEvent, scanner: PromptToolScanner | null): UpstreamEvent[] {
  if (scanner === null || event.kind !== 'text_delta') return [event];
  const { text, events } = scanner.push(event.text);
  return text === '' ? events : [{ kind: 'text_delta', text }, ...events];
}

function flush(scanner: PromptToolScanner): UpstreamEvent[] {
  const { text, events } = scanner.flush();
  return text === '' ? events : [{ kind: 'text_delta', text }, ...events];
}

function* iter(events: SseEvent[]): Generator<SseEvent> {
  for (const event of events) yield event;
}
