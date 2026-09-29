import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packArchive, unpackArchive } from '../src/backup/archive.js';

/**
 * Định dạng gói sao lưu: Có thể roundtrip nhất quán và **mở được bằng tar của hệ thống** — giá trị của sao lưu là
 * khi không có dự án này vẫn đọc ra được.
 */

const NOW = 1_700_000_000_000;

describe('打包与解包', () => {
  it('往返后内容一致', () => {
    const entries = [
      { path: 'manifest.json', content: Buffer.from('{"version":1}', 'utf8') },
      { path: 'db.sqlite', content: Buffer.from([0, 1, 2, 3, 255, 254]) },
      { path: 'files/9f1c/0001', content: Buffer.from('附件内容，含中文', 'utf8') },
    ];
    const restored = unpackArchive(packArchive(entries, NOW));
    expect(restored.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (let i = 0; i < entries.length; i += 1) {
      expect(restored[i]?.content.equals(entries[i]?.content as Buffer)).toBe(true);
    }
  });

  it('空文件与恰好 512 字节的文件都能正确还原', () => {
    const entries = [
      { path: 'empty', content: Buffer.alloc(0) },
      { path: 'exact-block', content: Buffer.alloc(512, 7) },
      { path: 'after', content: Buffer.from('尾部标记', 'utf8') },
    ];
    const restored = unpackArchive(packArchive(entries, NOW));
    expect(restored[0]?.content.byteLength).toBe(0);
    expect(restored[1]?.content.byteLength).toBe(512);
    expect(restored[2]?.content.toString('utf8')).toBe('尾部标记');
  });

  it('长路径走 ustar 的 prefix 拆分', () => {
    const deep = `files/${'a'.repeat(80)}/${'b'.repeat(60)}`;
    const restored = unpackArchive(packArchive([{ path: deep, content: Buffer.from('x') }], NOW));
    expect(restored[0]?.path).toBe(deep);
  });
});

describe('路径安全', () => {
  it('拒绝绝对路径与 .. 逃逸', () => {
    expect(() => packArchive([{ path: '/etc/passwd', content: Buffer.alloc(1) }], NOW)).toThrow(/不合法/);
    expect(() => packArchive([{ path: '../outside', content: Buffer.alloc(1) }], NOW)).toThrow(/不合法/);
  });

  it('解包时同样拒绝逃逸路径', () => {
    // Thủ công tạo một file tar hợp lệ có chứa ../: Trước tiên đóng gói đường dẫn bình thường, sau đó giả mạo tên file trong header
    const packed = packArchive([{ path: 'safe/name', content: Buffer.from('x') }], NOW);
    const raw = gunzipSync(packed);
    raw.fill(0, 0, 100);
    raw.write('../evil', 0, 100, 'utf8');
    // Tính lại checksum
    raw.write('        ', 148, 8, 'ascii');
    let checksum = 0;
    for (const byte of raw.subarray(0, 512)) checksum += byte;
    raw.write(`${checksum.toString(8).padStart(7, '0')}\0`, 148, 8, 'ascii');
    const tampered = gzipSync(raw);
    expect(() => unpackArchive(tampered)).toThrow(/不合法/);
  });
});

describe('与系统 tar 的互操作', () => {
  it('生成的包能被系统 tar 列出并解出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm365-tar-'));
    try {
      const archive = packArchive(
        [
          { path: 'manifest.json', content: Buffer.from('{"version":1}', 'utf8') },
          { path: 'files/a/1', content: Buffer.from('hello', 'utf8') },
        ],
        NOW,
      );
      const archivePath = join(dir, 'backup.tar.gz');
      writeFileSync(archivePath, archive);

      // Chỉ bỏ qua khi "môi trường hoàn toàn không có tar". Có tar mà không giải nén được bắt buộc phải báo lỗi —
      // trước đây catch ở đây quá rộng, coi cả việc "tar hệ thống báo định dạng không nhận diện được" là bỏ qua,
      // dẫn đến một bug định dạng thực tế bị che giấu dưới kết quả test xanh.
      let hasTar = true;
      try {
        execFileSync('tar', ['--version'], { stdio: 'ignore' });
      } catch {
        hasTar = false;
      }
      if (!hasTar) return;

      // Gọi tar bằng cwd + tên file tương đối, không truyền đường dẫn tuyệt đối Windows kiểu `C:\…` cho nó:
      // GNU tar đi kèm MSYS/Git-Bash sẽ coi `C:` là cú pháp từ xa `host:path`,
      // báo "Cannot connect to C: resolve failed" — cùng một file gói trên tar khác lại giải nén được,
      // khiến bài test này lúc xanh lúc đỏ trên các máy khác nhau.
      const listing = execFileSync('tar', ['-tzf', 'backup.tar.gz'], { encoding: 'utf8', cwd: dir });
      expect(listing).toContain('manifest.json');
      expect(listing).toContain('files/a/1');

      execFileSync('tar', ['-xzf', 'backup.tar.gz'], { cwd: dir });
      const extracted = readFileSync(join(dir, 'files', 'a', '1'), 'utf8');
      expect(extracted).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
