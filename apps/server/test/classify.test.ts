import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyFile } from '../src/files/classify.js';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

describe('classifyFile', () => {
  it('扩展名 + MIME + 魔数一致时判定为 text', () => {
    const result = classifyFile('note.txt', 'text/plain', Buffer.from('hello world', 'utf8'));
    expect(result).toEqual({ kind: 'text', trusted: true });
  });

  it('通用 MIME（octet-stream）不算有意见，仅凭扩展名+魔数即可判定', () => {
    const result = classifyFile('note.txt', 'application/octet-stream', Buffer.from('hello', 'utf8'));
    expect(result).toEqual({ kind: 'text', trusted: true });
  });

  it('声称 .txt 但内容是非法 UTF-8 时按不可信处理', () => {
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x20]);
    const result = classifyFile('note.txt', 'text/plain', binary);
    expect(result.trusted).toBe(false);
    expect(result.kind).toBe('unknown');
  });

  it('扩展名与 MIME 冲突时按不可信处理', () => {
    const result = classifyFile('note.txt', 'application/pdf', Buffer.from('hello', 'utf8'));
    expect(result).toEqual({ kind: 'unknown', trusted: false });
  });

  it('PDF 魔数正确识别', () => {
    const pdf = fixture('sample.pdf');
    const result = classifyFile('doc.pdf', 'application/pdf', pdf);
    expect(result).toEqual({ kind: 'pdf', trusted: true });
  });

  it('docx 的 ZIP 签名 + 扩展名一致时判定为 docx', () => {
    const docx = fixture('sample.docx');
    const result = classifyFile('report.docx', null, docx);
    expect(result).toEqual({ kind: 'docx', trusted: true });
  });

  it('普通 zip 不冒充任何 OOXML 类型', () => {
    const zip = fixture('plain.zip');
    const result = classifyFile('archive.zip', 'application/zip', zip);
    expect(result).toEqual({ kind: 'unknown', trusted: false });
  });

  it('扩展名与内容都无法识别的二进制不猜测内容', () => {
    // 0xC0/0xC1/0xF5.. là các byte tiền tố UTF-8 luôn không hợp lệ, đảm bảo phán đoán magic number cũng không thể đưa ra kết luận "text"
    const binary = Buffer.from([0xc0, 0xc1, 0xf5, 0xff]);
    const result = classifyFile('mystery.bin', null, binary);
    expect(result).toEqual({ kind: 'unknown', trusted: false });
  });

  it('无结构信号时，魔数单独可识别的内容仍可判定（如无扩展名的纯文本）', () => {
    const result = classifyFile('noext', null, Buffer.from('plain readable text', 'utf8'));
    expect(result).toEqual({ kind: 'text', trusted: true });
  });

  it('图片扩展名与魔数不一致时按不可信处理', () => {
    const jpeg = fixture('sample.pdf'); // Cố ý đưa sai nội dung
    const result = classifyFile('photo.jpg', 'image/jpeg', jpeg);
    expect(result.trusted).toBe(false);
  });
});
