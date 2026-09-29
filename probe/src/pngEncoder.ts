import { deflateSync } from 'node:zlib';

/**
 * Bộ mã hóa PNG tối giản: Chỉ dùng để tạo ảnh thử nghiệm đơn sắc có sẵn của probe (§3.2 "Một ảnh thử nghiệm có sẵn").
 *
 * Không import bất kỳ thư viện ảnh nào, cũng không dùng file của người dùng — nội dung ảnh được tạo hoàn toàn tất định bởi file này,
 * đồng nhất với phong cách tự viết ZIP trong phân tích file (`files/ooxml.ts`): tự viết, đã kiểm chứng định dạng bằng công cụ thực tế,
 * thay vì đưa dependency vào chỉ vì một bức ảnh đơn sắc vài pixel.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buf: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

export interface SolidColorPngOptions {
  size?: number;
  rgb?: readonly [number, number, number];
}

/** Tạo một ảnh PNG đơn sắc kích thước `size x size` (truecolor 8-bit, không filter). */
export function generateSolidColorPng(options: SolidColorPngOptions = {}): Buffer {
  const size = options.size ?? 4;
  const [r, g, b] = options.rgb ?? [90, 140, 255];

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bit depth
  ihdr[9] = 2; // Color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * rowBytes] = 0; // Filter type mỗi dòng: 0 (không lọc)
    for (let x = 0; x < size; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Tạo dạng data URL, dùng cho `ImageInputDescriptor.url`. */
export function generateSolidColorPngDataUrl(options: SolidColorPngOptions = {}): string {
  return `data:image/png;base64,${generateSolidColorPng(options).toString('base64')}`;
}
