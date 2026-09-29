import { ApiError } from '@m365-codex/shared';
import { z } from 'zod';

/**
 * Kiểm tra xác thực yêu cầu Responses (tương ứng kế hoạch triển khai §4.2).
 *
 * Các điểm trọng yếu về rào chắn:
 * - `model` và `reasoning.effort` chỉ truyền nguyên dạng, không enum hóa giá trị, không viết lại;
 * - Nội dung ảnh hưởng đến ngữ nghĩa mà không thể thực hiện thì bắt buộc phải trả về lỗi rõ ràng, không được âm thầm giả vờ có hiệu lực:
 *   `input_file` lấy văn bản đã trích xuất của gateway này theo file_id; `input_image` có cho qua hay không phụ thuộc vào
 *   `UPSTREAM_IMAGE_INPUT` (năng lực upstream thực tế cần probe M0 hiệu chuẩn, mặc định không giả vờ hỗ trợ).
 * - Các client đặt `store:false` như Codex ở mỗi lượt sẽ nhét **toàn bộ lịch sử đối thoại** vào `input` (xem
 *   giải thích chi tiết ở đầu `extractInputText`), do đó trong `input` ngoài message /
 *   function_call_output, còn xuất hiện các mục phát lại lịch sử như function_call, reasoning,
 *   cũng như các loại mục mới trong tương lai mà chúng ta chưa nhận diện được — đều không nên khiến cả lượt yêu cầu bị lỗi 400.
 */

const inputTextPart = z.object({
  type: z.literal('input_text'),
  text: z.string(),
});

// Tin nhắn lịch sử của assistant dùng output_text để chứa văn bản (khác với input_text phía user).
const outputTextPart = z.object({ type: z.literal('output_text'), text: z.string() }).passthrough();

const inputImagePart = z
  .object({
    type: z.literal('input_image'),
    image_url: z.string().optional(),
    file_id: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

const inputFilePart = z
  .object({
    type: z.literal('input_file'),
    file_id: z.string({ required_error: 'input_file 必须提供 file_id' }),
  })
  .passthrough();

// Loại đoạn nội dung chưa nhận diện: client sẽ phát triển thêm các dạng part mới, nếu không nhận ra thì bỏ qua part đó,
// không để cả lượt yêu cầu thất bại chỉ vì có thêm một content part lạ lẫm.
const unknownContentPart = z.object({ type: z.string() }).passthrough();

const contentPart = z.union([inputTextPart, outputTextPart, inputImagePart, inputFilePart, unknownContentPart]);

const inputMessage = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(contentPart)]),
});

const functionCallOutput = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.string(),
});

/**
 * Phát lại lệnh gọi công cụ của mô hình ở vòng trước (khi `store:false`, Codex sẽ gửi lại toàn bộ lịch sử theo từng vòng).
 * Bắt gói tin thực tế chỉ mang 4 key type/call_id/name/arguments, không có id/status; ở đây vẫn đánh dấu là
 * optional, tránh việc các phiên bản tương lai thêm bớt trường làm lỗi parse.
 */
const functionCallReplay = z
  .object({
    type: z.literal('function_call'),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  })
  .passthrough();

/** Phát lại tóm tắt suy nghĩ; summary/encrypted_content là mờ đối với upstream, chỉ nhận diện, không đưa vào văn bản ngữ cảnh tái dựng. */
const reasoningReplay = z.object({ type: z.literal('reasoning') }).passthrough();

/**
 * Loại mục lịch sử thực sự chưa nhận diện được: Các client như Codex liên tục cải tiến, không thể vì có thêm một
 * loại chưa từng thấy mà đánh 400 cả lượt yêu cầu. Bỏ qua và ghi lại loại này giao cho tầng trên (nơi giữ logger) ghi 1 dòng warn;
 * Các loại nội dung người dùng thấy được (input_text/input_image/input_file) không bị ảnh hưởng, lỗi nào cần báo vẫn báo bình thường.
 */
const unknownItem = z.object({ type: z.string() }).passthrough();

/** Mục input: Tin nhắn, output công cụ, hoặc mục phát lại lịch sử/chưa nhận diện. */
const inputItem = z.union([inputMessage, functionCallOutput, functionCallReplay, reasoningReplay, unknownItem]);

const reasoningSchema = z
  .object({
    // Giá trị hợp lệ của effort tùy thuộc vào mô hình (none/minimal/low/medium/high/xhigh/max…), không enum tại đây
    effort: z.string().optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export const responsesRequestSchema = z
  .object({
    model: z.string().min(1, 'model 不能为空'),
    input: z.union([z.string(), z.array(inputItem)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional().default(false),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    metadata: z.record(z.string()).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoning: reasoningSchema.optional(),
    store: z.boolean().optional(),
  })
  // Các trường như include / prompt_cache_key / client_metadata mà Codex có thể gửi không được mô hình hóa riêng,
  // hoàn toàn dựa vào passthrough ở đây để cho qua — chỉ ghi nhận, không diễn giải, không từ chối yêu cầu chỉ vì không nhận biết.
  .passthrough();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

export function parseResponsesRequest(payload: unknown): ResponsesRequest {
  const result = responsesRequestSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(issue?.message ?? '请求体不合法', issue?.path.join('.') || undefined);
  }
  return result.data;
}

export interface ToolResult {
  callId: string;
  output: string;
}

/** Hình ảnh thu thập được từ input_image, hình thái trung gian trước khi chuyển tiếp lên upstream (tương ứng kế hoạch triển khai §M6). */
export interface ExtractedImage {
  /** URL hoặc data URL (tham chiếu file_id sẽ được giải mã thành data URL tại đây) */
  url: string;
  detail: string | null;
}

export interface ExtractedInput {
  /** Văn bản ngữ cảnh hoàn chỉnh có gắn nhãn vai trò, được tái dựng theo thứ tự đối thoại (xem giải thích dài bên dưới) */
  text: string;
  /** instructions (chỉ thị hệ thống), nếu có; đã được gộp vào text làm đoạn hệ thống mở đầu */
  instructions: string | null;
  /** Kết quả thực thi công cụ gửi về (M5, mang theo khi tiếp tục nối chuỗi) */
  toolResults: ToolResult[];
  /** Ảnh đầu vào (chỉ không rỗng khi UPSTREAM_IMAGE_INPUT=true, xem §M6) */
  images: ExtractedImage[];
  /** Loại mục lịch sử bị bỏ qua do cải tiến phiên bản... (sau khi khử trùng lặp), để bên gọi ghi log warn */
  skippedItemTypes: string[];
  /** Số ký tự bị cắt bớt từ lịch sử cũ nhất do vượt trần ký tự ngữ cảnh; 0 biểu thị không bị cắt */
  truncatedChars: number;
}

/** Interface phân giải tham chiếu `file_id` trong `input_file` / `input_image`, do subsystem Files hiện thực. */
export interface FilesLookup {
  /** Lấy văn bản đã trích xuất theo file-id; không tồn tại/không thuộc Key hiện tại/chưa trích xuất được văn bản đều trả về null. */
  resolveText(fileId: string): { filename: string; text: string } | null;
  /** Lấy nội dung gốc theo file-id và đổi thành data URL; không tồn tại/không thuộc Key hiện tại/không phải ảnh đều trả về null. */
  resolveImageDataUrl(fileId: string): { dataUrl: string; filename: string } | null;
}

export interface ExtractInputDeps {
  files?: FilesLookup;
  /** Upstream có thực sự hỗ trợ ảnh đầu vào không, lấy từ UPSTREAM_IMAGE_INPUT (mặc định false, xem §M6) */
  imageInputEnabled?: boolean;
  /** Văn bản ngữ cảnh tái dựng vượt quá bao nhiêu ký tự thì bắt đầu cắt bớt từ lịch sử cũ nhất; mặc định đặt giá trị nới lỏng */
  contextMaxChars?: number;
}

/** Giá trị mặc định nới lỏng: Dành đủ không gian cho các client như Codex vốn gửi chỉ thị hệ thống hàng vạn ký tự. */
export const DEFAULT_CONTEXT_MAX_CHARS = 400_000;

/** Một lượt đối thoại được tái dựng: nhãn vai trò/công cụ + văn bản của lượt đó. */
export interface ConversationTurn {
  label: string;
  text: string;
}

export interface BuildConversationTextResult {
  text: string;
  /** Số ký tự bị loại bỏ do vượt giới hạn; 0 biểu thị không bị cắt */
  truncatedChars: number;
}

const TURN_SEPARATOR = '\n\n';

/**
 * Ghép "chỉ thị hệ thống + các lượt đối thoại" thành một đoạn văn bản, khi vượt quá `maxChars` sẽ bắt đầu loại bỏ
 * từ lịch sử cũ nhất (các lượt ở đầu mảng) cho đến khi vừa vặn; đoạn hệ thống luôn được giữ lại, và tối thiểu giữ lại
 * lượt cuối cùng (nếu không nội dung thực sự cần xử lý ở lượt này sẽ bị cắt mất).
 *
 * Tách thành hàm thuần túy để thuận tiện unit test trực tiếp biên cắt bớt, không cần lần nào cũng dựng một request hoàn chỉnh.
 */
export function buildConversationText(
  instructionsText: string | null,
  turns: readonly ConversationTurn[],
  maxChars: number,
): BuildConversationTextResult {
  const head = instructionsText !== null && instructionsText !== '' ? [`【系统指令】\n${instructionsText}`] : [];
  const turnSegments = turns.map((turn) => `${turn.label}\n${turn.text}`);

  const assemble = (segments: readonly string[]): string => segments.join(TURN_SEPARATOR);

  let kept = turnSegments;
  let full = assemble([...head, ...kept]);
  const originalLength = full.length;

  while (full.length > maxChars && kept.length > 1) {
    kept = kept.slice(1); // Bỏ lượt cũ nhất (đầu mảng = diễn ra sớm hơn)
    full = assemble([...head, ...kept]);
  }

  return { text: full, truncatedChars: originalLength - full.length };
}

function roleLabel(role: 'user' | 'assistant' | 'system' | 'developer'): string {
  switch (role) {
    case 'user':
      return '【用户】';
    case 'assistant':
      return '【助手】';
    case 'developer':
      return '【开发者指令】';
    case 'system':
      return '【系统消息】';
  }
}

interface MessageLike {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | { type: string; [key: string]: unknown }[];
}

/** Rút trích văn bản thuần từ một tin nhắn (nhiều content part nối lại bằng dấu xuống dòng) cùng với hình ảnh. */
function extractMessageContent(
  message: MessageLike,
  deps: ExtractInputDeps,
): { text: string; images: ExtractedImage[] } {
  if (typeof message.content === 'string') {
    return { text: message.content, images: [] };
  }

  const images: ExtractedImage[] = [];
  const fragments: string[] = [];
  for (const part of message.content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      fragments.push(typeof part.text === 'string' ? part.text : '');
    } else if (part.type === 'input_file') {
      fragments.push(resolveInputFile(part.file_id as string, deps));
    } else if (part.type === 'input_image') {
      const image = resolveInputImage(
        part as { image_url?: string; file_id?: string; detail?: string },
        deps,
      );
      if (image !== null) images.push(image);
    }
    // Các loại part chưa nhận diện khác: bỏ qua, không tham gia ghép văn bản, không báo lỗi cả lượt
  }
  return { text: fragments.join('\n'), images };
}

/**
 * Tái dựng ngữ cảnh đối thoại hoàn chỉnh từ input (phần mở rộng tự nhiên của việc
 * "chuyển tài khoản dùng nội dung cục bộ tái dựng ngữ cảnh" trong kế hoạch triển khai §M3, xem yêu cầu bổ sung §M6).
 *
 * **Tại sao phải tái dựng toàn bộ lịch sử, thay vì chỉ lấy văn bản mới thêm ở lượt này**: Các client như Codex khi
 * `store:false` không gửi kèm `previous_response_id`, mỗi lượt đều gửi lại toàn bộ lịch sử đối thoại kèm
 * theo `input`; phía gateway này nếu chỉ chọn lọc "văn bản user mới thêm" để gửi lên upstream, đồng nghĩa với việc mỗi lượt đều là
 * một cuộc trò chuyện hoàn toàn mới và mất trí nhớ — việc trò chuyện nhiều lượt hoàn toàn tê liệt. Do đó ở đây dựa theo thứ tự mảng input, chuyển đổi
 * toàn bộ chỉ thị developer/system, lời nhắn user, phản hồi assistant, lệnh gọi công cụ và kết quả công cụ
 * thành các lượt văn bản có gắn nhãn vai trò, `instructions` làm đoạn hệ thống mở đầu, ghép lại thành nội dung
 * gửi lên upstream.
 *
 * **Xử lý các loại item**:
 * - `function_call_output`: Vừa tính vào `toolResults` (dành cho vòng lặp công cụ M5 đi qua kênh cấu trúc),
 *   vừa xem là một lượt văn bản "【Kết quả công cụ】" đưa vào ngữ cảnh, đảm bảo upstream dù không nhận biết kênh cấu trúc đó thì
 *   vẫn nhìn thấy kết quả từ trong văn bản;
 * - `function_call`: Phát lại ý định gọi công cụ của mô hình ở vòng trước, chuyển thành "【Lần gọi công cụ X】";
 * - `reasoning`: Phát lại tóm tắt suy nghĩ, nội dung mờ hoặc vô nghĩa đối với upstream, không đưa vào văn bản ngữ cảnh
 *   (bỏ qua trong im lặng, không phải là "âm thầm giả vờ" — giả vờ là làm bộ đã làm nhưng thực tế không làm, ở đây chỉ là xác định
 *   chính xác rằng nó không đại diện cho văn bản khả dụng);
 * - Loại item không thể nhận diện: Không báo lỗi 400 cả lượt, bỏ qua và ghi nhận loại, giao cho bên gọi (nơi giữ
 *   logger) ghi 1 dòng log warn; Loại nội dung người dùng thấy được vẫn báo lỗi bình thường khi có lỗi.
 *
 * Khi vượt quá `contextMaxChars` sẽ bắt đầu cắt bớt từ lịch sử cũ nhất, xem `buildConversationText`.
 */
export function extractInputText(request: ResponsesRequest, deps: ExtractInputDeps = {}): ExtractedInput {
  const instructions = request.instructions ?? null;
  const maxChars = deps.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS;

  if (typeof request.input === 'string') {
    const turns: ConversationTurn[] = request.input === '' ? [] : [{ label: '【用户】', text: request.input }];
    const { text, truncatedChars } = buildConversationText(instructions, turns, maxChars);
    return { text, instructions, toolResults: [], images: [], skippedItemTypes: [], truncatedChars };
  }

  const toolResults: ToolResult[] = [];
  const images: ExtractedImage[] = [];
  const skippedItemTypes: string[] = [];
  const turns: ConversationTurn[] = [];

  for (const item of request.input) {
    // Chú ý: Nhánh `unknownItem` có kiểu trường `type` là `string` chung (không phải literal),
    // khiến TS không thể chỉ dựa vào `item.type === 'literal'` để loại trừ nó, dẫn đến trường cùng tên bị suy đoán thành
    // `unknown`. Phán đoán ở runtime đã đủ tin cậy (zod đã kiểm tra hình dạng tổng thể), ở đây ép kiểu tường minh theo
    // hình dạng cụ thể đã xác nhận, thay vì nới lỏng kiểu trường để lỗi lọt qua âm thầm.
    if ('type' in item && item.type === 'function_call_output') {
      const output = item as z.infer<typeof functionCallOutput>;
      toolResults.push({ callId: output.call_id, output: output.output });
      turns.push({ label: '【工具结果】', text: output.output });
      continue;
    }

    if ('type' in item && item.type === 'function_call') {
      const call = item as z.infer<typeof functionCallReplay>;
      const name = call.name ?? '(未知工具)';
      turns.push({ label: `【工具 ${name} 的调用】`, text: call.arguments ?? '{}' });
      continue;
    }

    if ('type' in item && item.type === 'reasoning') {
      continue; // Phát lại tóm tắt suy nghĩ: không đưa vào văn bản ngữ cảnh tái dựng
    }

    if ('type' in item && item.type !== 'message') {
      // Đến được đây chắc chắn là loại mục lịch sử chưa nhận diện: không phải bất kỳ loại nào ta biết, cũng không phải message ẩn
      skippedItemTypes.push(String(item.type));
      continue;
    }

    const message = item as MessageLike;
    const extracted = extractMessageContent(message, deps);
    images.push(...extracted.images);
    if (extracted.text !== '') {
      turns.push({ label: roleLabel(message.role), text: extracted.text });
    }
  }

  const { text, truncatedChars } = buildConversationText(instructions, turns, maxChars);
  return {
    text,
    instructions,
    toolResults,
    images,
    skippedItemTypes: [...new Set(skippedItemTypes)],
    truncatedChars,
  };
}

function resolveInputFile(fileId: string, deps: ExtractInputDeps): string {
  const resolved = deps.files?.resolveText(fileId) ?? null;
  if (resolved === null) {
    throw new ApiError({
      type: 'invalid_request_error',
      status: 404,
      message: `input_file 引用的文件 ${fileId} 不存在、不属于当前 API Key，或未提取到可用文本`,
      param: 'input',
    });
  }
  return `[文件: ${resolved.filename}]\n${resolved.text}`;
}

function resolveInputImage(
  part: { image_url?: string; file_id?: string; detail?: string },
  deps: ExtractInputDeps,
): ExtractedImage | null {
  if (deps.imageInputEnabled !== true) {
    throw new ApiError({
      type: 'unsupported_feature',
      status: 422,
      message:
        '图片输入当前未启用（UPSTREAM_IMAGE_INPUT=false）：上游是否真支持图片输入待 M0 探针校准，默认不假装支持',
      param: 'input',
    });
  }

  const detail = typeof part.detail === 'string' ? part.detail : null;
  if (typeof part.image_url === 'string' && part.image_url !== '') {
    return { url: part.image_url, detail };
  }
  if (typeof part.file_id === 'string' && part.file_id !== '') {
    const resolved = deps.files?.resolveImageDataUrl(part.file_id) ?? null;
    if (resolved === null) {
      throw new ApiError({
        type: 'invalid_request_error',
        status: 404,
        message: `input_image 引用的文件 ${part.file_id} 不存在、不属于当前 API Key，或不是图片类型`,
        param: 'input',
      });
    }
    return { url: resolved.dataUrl, detail };
  }
  throw ApiError.badRequest('input_image 必须提供 image_url 或 file_id', 'input');
}

/**
 * Lắp ráp các tham số chuyển tiếp nguyên bản lên upstream.
 * model và reasoning mang theo nguyên dạng, tuyệt đối không viết lại, không enum hóa, không tạo bí danh.
 */
export function buildPassthrough(request: ResponsesRequest): Record<string, unknown> {
  const passthrough: Record<string, unknown> = { model: request.model };
  if (request.reasoning !== undefined) passthrough.reasoning = request.reasoning;
  if (request.temperature !== undefined) passthrough.temperature = request.temperature;
  if (request.max_output_tokens !== undefined) passthrough.max_output_tokens = request.max_output_tokens;
  return passthrough;
}

/** Lấy reasoning.effort phục vụ ghi nhận (không viết lại, không kiểm tra giá trị). */
export function extractReasoningEffort(request: ResponsesRequest): string | null {
  const effort = request.reasoning?.effort;
  return typeof effort === 'string' ? effort : null;
}
