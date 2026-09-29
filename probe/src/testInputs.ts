import type { ToolDeclaration } from '../../apps/server/dist/adapter/protocol.js';
import { generateSolidColorPngDataUrl } from './pngEncoder.js';

/**
 * Đầu vào thử nghiệm cố định theo §3.2.
 *
 * Toàn bộ là nội dung không có thông tin nhạy cảm do chính probe này tự tạo/viết, không chứa file thật, hội thoại thật của người dùng.
 * Mỗi case biết rõ mình đã gửi những gì, do đó có thể truyền các chuỗi nguyên bản này cho
 * allowlist của `evidence.ts` để giữ tính dễ đọc trong bằng chứng đã khử nhạy cảm, mà không ảnh hưởng quy tắc cứng
 * "tất cả các chuỗi còn lại đều thay bằng <string:độ_dài>".
 */

export const TEXT_SHORT = '你好，这是 M365-Codex 探针的简短测试文本，请用一句话回复确认收到。';

export const TEXT_INSTRUCTIONS =
  '你是 M365-Codex 探针使用的测试助手。回答一律使用简体中文，且不超过两句话，不要输出与本次测试无关的内容。';

/** Văn bản dài: Lặp lại đoạn văn cố định đến khoảng 20.000 ký tự, cuối đoạn kèm một câu hỏi rõ ràng, kiểm tra khả năng chịu tải ngữ cảnh dài. */
export const TEXT_LONG = buildLongText();

function buildLongText(): string {
  const paragraph =
    'M365-Codex 探针长上下文测试段落：本段文字为固定重复内容，不含任何真实用户信息，仅用于验证上游能否承载较长的单轮输入而不报错或截断。';
  const repeated = paragraph.repeat(Math.ceil(20_000 / paragraph.length));
  return `${repeated}\n\n以上是重复的固定测试文本，请只回复「已收到长文本，长度正常」，不要复述内容。`;
}

export const TEXT_FILE_SAMPLE =
  '（模拟文本附件内容）M365-Codex 是一个把 Microsoft 365 Copilot 作为唯一模型上游、对外提供 OpenAI 兼容接口的个人非官方网关项目。本段内容为探针自带的固定示例文本，不涉及任何真实文件。';

export const TEXT_FILE_SUMMARY_PROMPT = `请用一句话总结下面这段固定测试文本的主题：\n\n${TEXT_FILE_SAMPLE}`;

export const PDF_LIKE_TEXT =
  '（模拟从 PDF 提取出的文本）第一章 概述：本文档描述了一个示例流程，共三个步骤：准备、执行、复核。本段内容为探针自带的固定示例文本，不涉及任何真实文档。';

export const PDF_SUMMARY_PROMPT = `请用一句话总结下面这段固定「PDF 提取文本」的主题：\n\n${PDF_LIKE_TEXT}`;

export const JSON_OUTPUT_PROMPT =
  '仅输出如下 JSON 结构，不要输出任何多余文字、不要使用 Markdown 代码块：{"answer": "一个简短的字符串", "confidence": 0.0 到 1.0 之间的数字}。问题：1 加 1 等于几？';

export const CANCELLATION_PROMPT =
  '请用不少于 300 字详细介绍分布式系统中的 CAP 定理，包含具体例子（本请求会在收到首个分片后被主动取消，用于测试取消行为）。';

/** Ảnh thử nghiệm đơn sắc có sẵn của probe (4x4, màu xanh lam), không sử dụng file của người dùng. */
export const TEST_IMAGE_DATA_URL = generateSolidColorPngDataUrl({ size: 4, rgb: [90, 140, 255] });

export const IMAGE_PROMPT = '这张图片的主要颜色是什么？请用一个颜色词回答（例如：红色/蓝色/绿色）。';

export const TOOL_GET_TIME: ToolDeclaration = {
  name: 'probe_get_time',
  description: '返回一个固定格式的测试时间字符串，仅供 M0 探针联通性测试使用，不产生任何真实副作用。',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai' } },
    required: ['timezone'],
  },
};

export const TOOL_ECHO: ToolDeclaration = {
  name: 'probe_echo',
  description: '原样返回 message 参数，仅供 M0 探针测试工具参数传递，不产生任何真实副作用。',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
};

export const TOOL_PROMPT_SINGLE =
  "现在几点？请调用 probe_get_time 工具查询，timezone 参数填 'Asia/Shanghai'，不要自己编造时间。";

export const TOOL_PROMPT_FOLLOWUP =
  '刚才查到的时间基础上，请再调用一次 probe_echo 工具，message 参数填这个时间字符串，用于确认工具结果可以正确回传。';

export const TOOL_PROMPT_PARALLEL =
  "请在同一次回复中调用两个工具：probe_get_time（timezone='Asia/Shanghai'）和 probe_echo（message='ping'），并把两个工具的结果都告诉我。";

export const TOOL_PROMPT_BAD_ARGS_HINT =
  '请调用 probe_get_time 工具查询时间。';

/** Tập hợp văn bản thử nghiệm cố định xuất hiện trong các lượt gửi của probe, dùng cho việc lấy mẫu cấu trúc của `evidence.ts` cho phép theo nguyên bản. */
export function ownLiterals(...extra: readonly string[]): ReadonlySet<string> {
  return new Set<string>([
    TEXT_SHORT,
    TEXT_INSTRUCTIONS,
    TEXT_LONG,
    TEXT_FILE_SAMPLE,
    TEXT_FILE_SUMMARY_PROMPT,
    PDF_LIKE_TEXT,
    PDF_SUMMARY_PROMPT,
    JSON_OUTPUT_PROMPT,
    CANCELLATION_PROMPT,
    IMAGE_PROMPT,
    TOOL_PROMPT_SINGLE,
    TOOL_PROMPT_FOLLOWUP,
    TOOL_PROMPT_PARALLEL,
    TOOL_PROMPT_BAD_ARGS_HINT,
    ...extra,
  ]);
}
