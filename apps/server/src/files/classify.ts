import type { FileKind } from './types.js';

/**
 * Kiểm tra kết hợp phần mở rộng (extension) + MIME + Magic number của tệp (tương ứng với Kế hoạch thực hiện §11:
 * "Kiểm tra kết hợp đuôi tệp, MIME và magic number", "Không đoán mò nội dung binary chưa nhận diện").
 *
 * Thiết kế: Ba tín hiệu đánh giá độc lập một kind (nếu không chắc chắn là 'unknown', tức "không có ý kiến",
 * không ép buộc phân loại). Thu thập các tín hiệu có ý kiến:
 * - Không có tín hiệu nào có ý kiến → Không nhận diện được, kind='unknown', trusted=false;
 * - Các ý kiến đồng nhất (giá trị duy nhất) → trusted=true, xử lý theo kind đó;
 * - Ý kiến xung đột → Không đáng tin, kind='unknown', trusted=false (không phỏng đoán, chỉ lưu trữ không trích xuất).
 *
 * OOXML (docx/xlsx/pptx) ở tầng byte chia sẻ cùng signature ZIP, tín hiệu magic number chỉ cho ra
 * 'ooxml-zip' khái quát, cụ thể là loại nào để phần mở rộng / MIME quyết định; khi cả hai không có ý kiến thì không đoán mò,
 * đều xử lý theo unknown — tránh việc ép parse bất kỳ file .zip nào thành tài liệu Office.
 */

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log',
  '.yml', '.yaml', '.xml', '.ini', '.conf', '.toml',
  '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bash', '.ps1',
  '.sql', '.html', '.htm', '.css', '.svg',
]);

const EXTENSION_KIND: ReadonlyMap<string, FileKind> = new Map<string, FileKind>([
  ...[...TEXT_EXTENSIONS].map((ext): [string, FileKind] => [ext, 'text']),
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.gif', 'image'],
  ['.webp', 'image'],
]);

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
  'application/xml',
  'application/javascript',
  'application/x-sh',
  'application/toml',
  'application/sql',
]);

const MIME_KIND_EXACT: ReadonlyMap<string, FileKind> = new Map([
  ['application/pdf', 'pdf'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xlsx',
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['image/gif', 'image'],
  ['image/webp', 'image'],
]);

/** MIME chung chung / không chứa thông tin: Client thường gửi fallback các giá trị này, không tính là tín hiệu "có ý kiến". */
const GENERIC_MIME = new Set(['application/octet-stream', 'application/zip', '']);

export function extKindOf(filename: string): FileKind | 'unknown' {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return 'unknown';
  const ext = filename.slice(idx).toLowerCase();
  return EXTENSION_KIND.get(ext) ?? 'unknown';
}

export function mimeKindOf(mime: string | null): FileKind | 'unknown' {
  if (mime === null) return 'unknown';
  const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (GENERIC_MIME.has(normalized)) return 'unknown';
  const exact = MIME_KIND_EXACT.get(normalized);
  if (exact !== undefined) return exact;
  if (TEXT_MIME_EXACT.has(normalized)) return 'text';
  if (TEXT_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'text';
  return 'unknown';
}

type MagicKind = FileKind | 'ooxml-zip';

/** Đánh giá cấp độ byte đối với các chữ ký nhị phân đã biết; văn bản không có magic number, dựa vào kiểm tra giải mã UTF-8 hợp lệ. */
export function magicKindOf(buffer: Buffer): MagicKind {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image'; // PNG
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image'; // JPEG
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image'; // GIF8
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image';
  }
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'ooxml-zip'; // ZIP local file header

  return isLikelyUtf8Text(buffer) ? 'text' : 'unknown';
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * UTF-8 hợp lệ và không chứa byte NUL được coi là văn bản. `TextDecoder({fatal:true})` đối với hầu hết
 * định dạng nhị phân (có header byte cố định) sẽ ném lỗi trực tiếp, đủ phân biệt; thà bảo thủ (coi là unknown)
 * chứ không đoán mò.
 */
function isLikelyUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export interface ClassifyResult {
  kind: FileKind;
  trusted: boolean;
}

export function classifyFile(filename: string, declaredMime: string | null, buffer: Buffer): ClassifyResult {
  const extKind = extKindOf(filename);
  const mimeKind = mimeKindOf(declaredMime);
  const magicKind = magicKindOf(buffer);

  // Tín hiệu cấu trúc (phần mở rộng / MIME) tự đưa ra ý kiến trước; ooxml-zip ở bước này tạm coi là "không có ý kiến",
  // lát sau dựa vào tín hiệu cấu trúc có thống nhất hay không để quyết định có tin cậy nó hay không.
  const structural = new Set<FileKind>();
  if (extKind !== 'unknown') structural.add(extKind);
  if (mimeKind !== 'unknown') structural.add(mimeKind);

  if (structural.size > 1) {
    // Đuôi mở rộng và MIME tự thân đã lệch nhau, không cần xem tiếp magic number
    return { kind: 'unknown', trusted: false };
  }

  const agreedStructuralKind = structural.size === 1 ? [...structural][0] : undefined;

  if (magicKind === 'ooxml-zip') {
    if (agreedStructuralKind !== undefined && isOoxmlKind(agreedStructuralKind)) {
      return { kind: agreedStructuralKind, trusted: true };
    }
    // Chỉ dựa vào chữ ký ZIP không nhận biết được cụ thể là tài liệu Office nào, không đoán
    return { kind: 'unknown', trusted: false };
  }

  // Không có bất kỳ tín hiệu cấu trúc nào (đuôi lạ, MIME generic): chỉ dựa vào magic number để kết luận.
  if (agreedStructuralKind === undefined) {
    return magicKind === 'unknown' ? { kind: 'unknown', trusted: false } : { kind: magicKind, trusted: true };
  }

  // Có tín hiệu cấu trúc: Nội dung byte phải thực sự chứng minh được nó, magic number không cho ra cùng kết luận
  // (gồm magicKind==='unknown', tức byte vừa không phải text hợp lệ vừa không khớp signature đã biết) đều tính là không thống nhất.
  if (magicKind === agreedStructuralKind) {
    return { kind: agreedStructuralKind, trusted: true };
  }
  return { kind: 'unknown', trusted: false };
}

function isOoxmlKind(kind: FileKind): boolean {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx';
}
