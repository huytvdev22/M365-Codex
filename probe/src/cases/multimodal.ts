import { buildEvidence, extractText, makeResult, runText } from '../caseHelpers.js';
import {
  IMAGE_PROMPT,
  PDF_LIKE_TEXT,
  PDF_SUMMARY_PROMPT,
  TEST_IMAGE_DATA_URL,
  TEXT_FILE_SAMPLE,
  TEXT_FILE_SUMMARY_PROMPT,
  ownLiterals,
} from '../testInputs.js';
import type { CapabilityResult, ProbeContext } from '../types.js';

const IMAGE_COLOR_HINTS = ['蓝', 'blue', 'navy', '靛'];

/** #4 Hiểu hình ảnh: Có chấp nhận một ảnh thử nghiệm đơn sắc có sẵn của probe và nói đúng màu sắc không. */
export async function caseImageUnderstanding(ctx: ProbeContext): Promise<CapabilityResult> {
  const requestedAt = Date.now();
  // Tên trường là quy ước mô hình hóa trong codecV1.ts (`SydneyArgument.images`), trường thực tế chờ M0 hiệu chuẩn
  const outcome = await runText(ctx, IMAGE_PROMPT, {
    passthrough: { images: [{ url: TEST_IMAGE_DATA_URL, detail: null }] },
  });
  const text = extractText(outcome).toLowerCase();
  const colorMatched = IMAGE_COLOR_HINTS.some((hint) => text.includes(hint));

  let status: CapabilityResult['status'];
  if (outcome.errorCategory === 'fatal_client') status = 'unsupported';
  else if (outcome.errorCategory !== null) status = 'unknown';
  else if (colorMatched) status = 'native';
  else if (text.trim() !== '') status = 'partial';
  else status = 'unsupported';

  return makeResult({
    id: 'image_understanding',
    index: 4,
    name: '图片理解',
    status,
    summary: colorMatched
      ? '回复中出现了与测试图片主色调匹配的颜色词，图片输入疑似被上游理解。'
      : `未在回复中匹配到预期颜色词（错误分类：${outcome.errorCategory ?? '无'}），图片输入的真实字段形态仍待人工确认。`,
    requestedAt,
    durationMs: outcome.durationMs,
    errorCategory: outcome.errorCategory,
    evidence: buildEvidence(outcome, ownLiterals(IMAGE_PROMPT), {
      image_field_convention: 'passthrough.images[].url（data URL），与 codecV1.ts SydneyArgument.images 一致',
      color_matched: colorMatched,
    }),
  });
}

interface AttachmentCaseSpec {
  id: string;
  index: number;
  name: string;
  sampleText: string;
  summaryPrompt: string;
}

async function runAttachmentCase(ctx: ProbeContext, spec: AttachmentCaseSpec): Promise<CapabilityResult> {
  const requestedAt = Date.now();

  // Cách 1: Chèn trực tiếp văn bản đã trích xuất vào nội dung tin nhắn (pipeline file hiện tại của M6 làm như vậy, kỳ vọng luôn hoạt động)
  const inline = await runText(ctx, spec.summaryPrompt);
  // Cách 2: Thử thêm một trường quy ước attachments do probe tự định nghĩa, thuần túy để thăm dò upstream có khái niệm tệp đính kèm gốc hay không
  const viaAttachmentField = await runText(ctx, `请总结附件内容。`, {
    passthrough: {
      attachments: [{ name: 'probe-sample.txt', mimeType: 'text/plain', textContent: spec.sampleText }],
    },
  });

  const inlineText = extractText(inline);
  const inlineOk = inline.errorCategory === null && inlineText.trim() !== '';
  const attachmentFieldText = extractText(viaAttachmentField);
  const attachmentFieldOk = viaAttachmentField.errorCategory === null && attachmentFieldText.trim() !== '';

  const status: CapabilityResult['status'] = inlineOk ? 'adaptable' : 'unknown';

  return makeResult({
    id: spec.id,
    index: spec.index,
    name: spec.name,
    status,
    summary: inlineOk
      ? '把提取文本内联进正文的方式可以正常获得摘要（现有文件管线的做法）；探针自定义的 attachments 字段是否有原生效果仍待人工判读回复内容。'
      : `内联文本摘要请求未成功：${inline.errorMessage ?? '无内容'}。`,
    requestedAt,
    durationMs: inline.durationMs + viaAttachmentField.durationMs,
    errorCategory: inline.errorCategory,
    evidence: {
      inline_text: buildEvidence(inline, ownLiterals(spec.summaryPrompt), { reply_length: inlineText.length }),
      via_attachments_field: buildEvidence(viaAttachmentField, ownLiterals(), {
        reply_length: attachmentFieldText.length,
        attachments_field_convention:
          '探针自定义：passthrough.attachments[].{name,mimeType,textContent}，非上游已知形态，仅供探测',
        note_attachment_field_ok: attachmentFieldOk,
      }),
    },
  });
}

/** #5 Tệp đính kèm văn bản: Có thể tóm tắt nội dung văn bản nội dòng hay không. */
export function caseTextAttachment(ctx: ProbeContext): Promise<CapabilityResult> {
  return runAttachmentCase(ctx, {
    id: 'text_attachment',
    index: 5,
    name: '文本附件',
    sampleText: TEXT_FILE_SAMPLE,
    summaryPrompt: TEXT_FILE_SUMMARY_PROMPT,
  });
}

/** #6 Tệp đính kèm PDF và Office: Có thể tóm tắt "văn bản PDF/Office đã trích xuất" không (việc trích xuất là trách nhiệm của M6 server, probe chỉ kiểm tra việc upstream xử lý kết quả trích xuất). */
export function casePdfOfficeAttachment(ctx: ProbeContext): Promise<CapabilityResult> {
  return runAttachmentCase(ctx, {
    id: 'pdf_office_attachment',
    index: 6,
    name: 'PDF 与 Office 附件',
    sampleText: PDF_LIKE_TEXT,
    summaryPrompt: PDF_SUMMARY_PROMPT,
  });
}
