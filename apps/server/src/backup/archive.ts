import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Đóng gói / giải nén tar (ustar) tối giản (tương ứng với sao lưu và khôi phục trong Kế hoạch thực hiện §15.4).
 *
 * Lý do không dùng thư viện ngoài: Gói sao lưu chỉ cần "nhiều tệp đóng thành một luồng, có thể mở bằng lệnh tar hệ thống".
 * Sử dụng tar.gz tiêu chuẩn thay vì định dạng tự chế nhằm cho phép quản trị viên dù không có dự án này vẫn dùng được
 * `tar -tzf` xem nội dung, `tar -xzf` giải nén lấy nội dung — giá trị của sao lưu là có thể đọc được ở bất kỳ lúc nào.
 *
 * Chỉ hỗ trợ tệp thông thường (typeflag '0'), tên tệp phân tách theo prefix/name của ustar,
 * đủ bao phủ độ sâu thư mục như `files/<uuid>/<stt>`.
 */

const BLOCK = 512;

export interface ArchiveEntry {
  /** Đường dẫn bên trong file lưu trữ, dùng dấu / phân cách, không cho phép bắt đầu bằng / hoặc chứa .. */
  path: string;
  content: Buffer;
  /** Quyền Unix, mặc định 0o644 */
  mode?: number;
  /** Thời gian sửa đổi (mili-giây), mặc định lấy thời điểm đóng gói do bên gọi truyền vào */
  mtimeMs?: number;
}

function assertSafePath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`归档路径不合法：${path}`);
  }
}

/** Các trường số trong header ustar là chuỗi bát phân (octal) độn số 0, kết thúc bằng một ký tự NUL. */
function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function buildHeader(entry: ArchiveEntry, mtimeMs: number): Buffer {
  const header = Buffer.alloc(BLOCK);

  // Đường dẫn dài tách thành prefix(155) + name(100)
  let name = entry.path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) {
      throw new Error(`归档路径过长：${entry.path}`);
    }
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }

  header.write(name, 0, 100, 'utf8');
  writeOctal(header, entry.mode ?? 0o644, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, entry.content.byteLength, 124, 12);
  writeOctal(header, Math.floor(mtimeMs / 1000), 136, 12);
  header.write('        ', 148, 8, 'ascii'); // Checksum ban đầu điền khoảng trắng
  header.write('0', 156, 1, 'ascii'); // typeflag: tệp thông thường
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix !== '') header.write(prefix, 345, 155, 'utf8');

  // Cách sắp xếp trường checksum là ngoại lệ duy nhất trong ustar: 6 ký tự bát phân + NUL + khoảng trắng,
  // không phải dạng "bát phân độn 0 + NUL" như các trường khác. Viết sai cách này,
  // lệnh tar hệ thống sẽ báo ngay là "định dạng lưu trữ không nhận diện được".
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  return header;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/** Đóng gói thành file tar.gz. */
export function packArchive(entries: readonly ArchiveEntry[], now: number): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    assertSafePath(entry.path);
    chunks.push(buildHeader(entry, entry.mtimeMs ?? now), entry.content, padding(entry.content.byteLength));
  }
  // tar kết thúc bằng 2 khối toàn số 0
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}

/** Giải nén file tar.gz. Bỏ qua các loại mục lạ, ném lỗi nếu đường dẫn không an toàn. */
export function unpackArchive(archive: Buffer): ArchiveEntry[] {
  const buffer = gunzipSync(archive);
  const entries: ArchiveEntry[] = [];

  let offset = 0;
  while (offset + BLOCK <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // Khối toàn 0 báo hiệu kết thúc
    if (header.every((byte) => byte === 0)) break;

    const readString = (start: number, length: number): string =>
      header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const readOctal = (start: number, length: number): number => {
      const text = readString(start, length).trim();
      return text === '' ? 0 : Number.parseInt(text, 8);
    };

    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const size = readOctal(124, 12);
    const typeflag = readString(156, 1);
    const mode = readOctal(100, 8);
    const mtimeMs = readOctal(136, 12) * 1000;

    offset += BLOCK;
    const content = buffer.subarray(offset, offset + size);
    offset += size + padding(size).byteLength;

    // '' và '0' đều là tệp thông thường; các loại khác (thư mục, symlink...) bỏ qua
    if (typeflag !== '' && typeflag !== '0') continue;

    const path = prefix === '' ? name : `${prefix}/${name}`;
    assertSafePath(path);
    entries.push({ path, content: Buffer.from(content), mode, mtimeMs });
  }

  return entries;
}
