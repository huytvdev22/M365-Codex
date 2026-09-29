import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractDocxText,
  extractPptxText,
  extractXlsxText,
  listZipEntries,
  ZipFormatError,
} from '../src/files/ooxml.js';

/**
 * Dùng cấu trúc ZIP thật được tạo bởi `zipfile` (nén deflate) của Python làm fixture,
 * thay vì tự viết ZIP rồi tự đọc — tránh vấn đề "đọc và ghi tự xác nhận lẫn nhau nhưng cả hai đều sai".
 */
function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

describe('listZipEntries', () => {
  it('列出 docx 内部条目', () => {
    const entries = listZipEntries(fixture('sample.docx'));
    expect(entries.map((e) => e.name)).toContain('word/document.xml');
  });

  it('非 ZIP 内容抛出 ZipFormatError', () => {
    expect(() => listZipEntries(Buffer.from('not a zip'))).toThrow(ZipFormatError);
  });
});

describe('extractDocxText', () => {
  it('提取段落文本，制表符/换行/实体正确还原', () => {
    const text = extractDocxText(fixture('sample.docx'));
    expect(text).toContain('Hello OOXML');
    expect(text).toContain('Second\tParagraph');
    expect(text).toContain('Line1\nLine2');
    expect(text).toContain('& <escaped> 中文');
  });

  it('缺少 word/document.xml 时报错', () => {
    expect(() => extractDocxText(fixture('plain.zip'))).toThrow(ZipFormatError);
  });
});

describe('extractXlsxText', () => {
  it('按共享字符串 / 内联字符串 / 数值提取单元格', () => {
    const text = extractXlsxText(fixture('sample.xlsx'));
    const lines = text.split('\n');
    expect(lines[0]).toBe('Name\tAlice');
    expect(lines[1]).toBe('Direct\t42');
  });
});

describe('extractPptxText', () => {
  it('按幻灯片顺序提取文本', () => {
    const text = extractPptxText(fixture('sample.pptx'));
    expect(text.indexOf('Slide One Title')).toBeLessThan(text.indexOf('Slide Two'));
    expect(text).toContain('Bullet A');
  });
});
