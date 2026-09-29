import { extractDocxText, extractPptxText, extractXlsxText, ZipFormatError } from './ooxml.js';
import { extractPdfText, PdfExtractionError } from './pdf.js';
import type { ExtractionResult, FileKind } from './types.js';

/**
 * Tổng điều phối trích xuất văn bản (tương ứng với Kế hoạch thực hiện §11, §M6).
 *
 * Bản thân việc trích xuất không nuốt lỗi: Có thể trích xuất được thì trả về văn bản, chủ động bỏ qua thì nêu rõ lý do,
 * thất bại thì trả về nguyên nhân lỗi — cả 3 trường hợp đều phân biệt rõ ràng trong `ExtractionResult`, không cho phép
 * trạng thái mơ hồ như "tưởng như thành công nhưng nội dung là chuỗi rỗng".
 */
export async function extractText(
  buffer: Buffer,
  kind: FileKind,
  trusted: boolean,
): Promise<ExtractionResult> {
  if (!trusted) {
    return skip('扩展名、MIME 与文件内容魔数三者不一致，按不可信处理，仅存储不提取');
  }

  switch (kind) {
    case 'text':
      return extractPlainText(buffer);
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractZipXml(() => extractDocxText(buffer));
    case 'xlsx':
      return extractZipXml(() => extractXlsxText(buffer));
    case 'pptx':
      return extractZipXml(() => extractPptxText(buffer));
    case 'image':
      // Hình ảnh đi qua kênh input_image của Responses, không phải đối tượng trích xuất văn bản
      return skip('图片文件用于图片输入，不做文本提取');
    case 'unknown':
      return skip('未识别的二进制文件，不猜测内容，仅存储');
  }
}

function skip(note: string): ExtractionResult {
  return { ok: false, text: null, note, skipped: true };
}

function extractPlainText(buffer: Buffer): ExtractionResult {
  try {
    // Giai đoạn classify đã giải mã bằng fatal để kiểm tra tính hợp lệ, giải mã lại ở đây để lấy chuỗi
    // nội dung thực sự; về lý thuyết sẽ không lỗi ở đây, nếu lỗi tính là nội dung không thể trích xuất chứ không ngắt quãng tiến trình.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { ok: true, text, note: null, skipped: false };
  } catch (error) {
    return {
      ok: false,
      text: null,
      note: `不是合法的 UTF-8 文本：${(error as Error).message}`,
      skipped: false,
    };
  }
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  try {
    const text = await extractPdfText(buffer);
    return { ok: true, text, note: null, skipped: false };
  } catch (error) {
    const message = error instanceof PdfExtractionError ? error.message : 'PDF 文本提取失败';
    return { ok: false, text: null, note: message, skipped: false };
  }
}

function extractZipXml(run: () => string): ExtractionResult {
  try {
    return { ok: true, text: run(), note: null, skipped: false };
  } catch (error) {
    const message = error instanceof ZipFormatError ? error.message : 'Office 文档文本提取失败';
    return { ok: false, text: null, note: message, skipped: false };
  }
}
