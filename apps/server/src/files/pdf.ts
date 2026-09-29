/**
 * Trích xuất văn bản PDF, sử dụng legacy Node build của `pdfjs-dist` (tương ứng với Kế hoạch thực hiện §M6).
 *
 * Cài đặt dependency này vẫn đảm bảo `npm audit --audit-level=high` là 0 lỗ hổng nghiêm trọng, đáp ứng rào chắn an toàn,
 * do đó thực hiện trích xuất thực tế thay vì trả về `unsupported_feature`. Lấy các mục văn bản từ `getTextContent()`
 * theo từng trang và ghép lại, không tái tạo bố cục (không gộp ngắt dòng, không nhận diện bảng biểu),
 * chỉ bảo đảm "không mất nội dung văn bản".
 */

// pdfjs-dist không khai báo exports map, import trực tiếp đường dẫn con theo cấu trúc phân phối của package.json.
// Bản build legacy trong môi trường Node không có DOM/Worker có thể giải mã trực tiếp, không cần cấu hình thêm workerSrc.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export class PdfExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfExtractionError';
  }
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    throw new PdfExtractionError('无法解析 PDF：文件可能已损坏或不是合法的 PDF', { cause: error });
  }

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items as { str?: string }[];
      const text = items.map((item) => item.str ?? '').join('');
      pageTexts.push(text);
    }
    return pageTexts.join('\n\n').trim();
  } catch (error) {
    throw new PdfExtractionError('PDF 文本提取失败', { cause: error });
  } finally {
    await task.destroy();
  }
}
