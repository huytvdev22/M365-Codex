import { inflateRawSync } from 'node:zlib';

/**
 * Trích xuất văn bản OOXML (docx/xlsx/pptx), triển khai trực tiếp không dùng thư viện ngoài (tương ứng với Kế hoạch thực hiện §M6).
 *
 * Tệp OOXML bản chất là một gói ZIP chứa nhiều thành phần XML bên trong. Ở đây chỉ triển khai tập con tối thiểu cần thiết để đọc:
 * Định vị Central Directory (End of Central Directory → Central Directory File Header),
 * đọc theo nhu cầu local file header của entry chỉ định và giải nén bằng `node:zlib.inflateRawSync` (compression
 * method 8 = deflate; 0 = store, không cần giải nén). Không hỗ trợ ZIP64 (kích thước tài liệu OOXML thực tế
 * nhỏ hơn nhiều so với ngưỡng ZIP64, nếu gặp sẽ ném lỗi rõ ràng thay vì parse sai).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

/** Tìm kiếm ngược từ cuối buffer để tìm bản ghi EOCD, trả về offset bắt đầu. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipFormatError('未找到 ZIP 中央目录结束记录（EOCD），文件可能已损坏或不是合法的 ZIP/OOXML');
}

/** Phân tích Central Directory của ZIP, liệt kê toàn bộ các entry (không đọc nội dung). */
export function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset === 0xffffffff || totalEntries === 0xffff) {
    throw new ZipFormatError('文件使用了 ZIP64 格式，本实现不支持');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipFormatError('中央目录条目签名不合法，文件可能已损坏');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Đọc nội dung sau khi giải nén của entry chỉ định; trả về null nếu tệp không tồn tại. */
export function readZipEntry(buffer: Buffer, entries: readonly ZipEntry[], name: string): Buffer | null {
  const entry = entries.find((e) => e.name === name);
  if (entry === undefined) return null;

  if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new ZipFormatError(`条目 ${name} 的本地文件头签名不合法`);
  }
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new ZipFormatError(`条目 ${name} 使用了不支持的压缩方式 (${entry.method})`);
}

/** Unescape các thực thể XML dạng số / đặt tên, bao phủ các dạng phổ biến xuất hiện trong phần văn bản OOXML. */
export function unescapeXmlEntities(text: string): string {
  return text
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function readEntryText(buffer: Buffer, entries: readonly ZipEntry[], name: string): string | null {
  const raw = readZipEntry(buffer, entries, name);
  return raw === null ? null : raw.toString('utf8');
}

/**
 * docx: trong word/document.xml `<w:p>` là đoạn văn, `<w:t>` là mẩu văn bản, `<w:tab/>`
 * là tab, `<w:br/>` là xuống dòng. Các mẩu trong đoạn ghép trực tiếp, giữa các đoạn cách nhau bằng xuống dòng.
 */
export function extractDocxText(buffer: Buffer): string {
  const entries = listZipEntries(buffer);
  const xml = readEntryText(buffer, entries, 'word/document.xml');
  if (xml === null) {
    throw new ZipFormatError('未找到 word/document.xml，文件不是合法的 docx');
  }

  const paragraphs = xml.split(/<w:p\b[^>]*>/).slice(1);
  const lines = paragraphs.map((paragraph) => {
    let text = '';
    const tagPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^/]*\/>|<w:br\b[^/]*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(paragraph)) !== null) {
      if (match[1] !== undefined) {
        text += unescapeXmlEntities(match[1]);
      } else if (match[0].startsWith('<w:tab')) {
        text += '\t';
      } else {
        text += '\n';
      }
    }
    return text;
  });
  return lines.join('\n').trim();
}

/** Phân tích xl/sharedStrings.xml: mỗi `<si>` là một chuỗi dùng chung, bên trong có thể chứa nhiều mẩu `<t>`. */
function parseSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const items = xml.split(/<si>/).slice(1);
  return items.map((item) => {
    const texts = [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXmlEntities(m[1] ?? ''));
    return texts.join('');
  });
}

/** Phân tích một worksheet XML, ghép thành văn bản phân tách bằng tab theo hàng/cột. */
function parseSheetText(xml: string, sharedStrings: readonly string[]): string {
  const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  const lines: string[] = [];
  for (const rowMatch of rows) {
    const rowXml = rowMatch[1] ?? '';
    const cells = [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)];
    const values = cells.map((cellMatch) => {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const inner = cellMatch[2] ?? '';
      const typeMatch = /\st="([^"]+)"/.exec(attrs);
      const type = typeMatch?.[1];

      if (type === 's') {
        const idxMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = idxMatch === null ? NaN : Number(idxMatch[1]);
        return sharedStrings[idx] ?? '';
      }
      if (type === 'inlineStr') {
        const textMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        return textMatch === null ? '' : unescapeXmlEntities(textMatch[1] ?? '');
      }
      const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      return valueMatch === null ? '' : unescapeXmlEntities(valueMatch[1] ?? '');
    });
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

/** xlsx: Duyệt xl/worksheets/sheetN.xml theo thứ tự số của tên worksheet, ghép từng sheet. */
export function extractXlsxText(buffer: Buffer): string {
  const entries = listZipEntries(buffer);
  const sharedStrings = parseSharedStrings(readEntryText(buffer, entries, 'xl/sharedStrings.xml'));

  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => sheetNumber(a.name) - sheetNumber(b.name));

  if (sheetEntries.length === 0) {
    throw new ZipFormatError('未找到任何 xl/worksheets/sheetN.xml，文件不是合法的 xlsx');
  }

  const sheets = sheetEntries.map((entry) => {
    const xml = readEntryText(buffer, entries, entry.name) ?? '';
    return parseSheetText(xml, sharedStrings);
  });
  return sheets.join('\n\n').trim();
}

function sheetNumber(name: string): number {
  const match = /sheet(\d+)\.xml$/.exec(name);
  return match?.[1] !== undefined ? Number(match[1]) : 0;
}

/** pptx: Duyệt ppt/slides/slideN.xml theo thứ tự số của slide, trích xuất văn bản `<a:t>`. */
export function extractPptxText(buffer: Buffer): string {
  const entries = listZipEntries(buffer);
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  if (slideEntries.length === 0) {
    throw new ZipFormatError('未找到任何 ppt/slides/slideN.xml，文件不是合法的 pptx');
  }

  const slides = slideEntries.map((entry) => {
    const xml = readEntryText(buffer, entries, entry.name) ?? '';
    const paragraphs = xml.split(/<a:p\b[^>]*>/).slice(1);
    const lines = paragraphs.map((paragraph) =>
      [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((m) => unescapeXmlEntities(m[1] ?? ''))
        .join(''),
    );
    return lines.join('\n').trim();
  });
  return slides.filter((s) => s !== '').join('\n\n');
}

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match?.[1] !== undefined ? Number(match[1]) : 0;
}
