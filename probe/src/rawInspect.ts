import type { RawMessage } from '../../apps/server/dist/adapter/protocol.js';

/**
 * Tìm kiếm heuristic theo mẫu tên key trong frame gốc (lượng sử dụng, tên mô hình v.v. §3.1 mục 18/20/21).
 *
 * Tên trường thực tế chưa biết, chỉ có thể quét tên key theo chiều rộng. Bản thân số/boolean là "metadata có cấu trúc",
 * không tính là "nội dung", có thể giữ trực tiếp trong bằng chứng; giá trị chuỗi vẫn xử lý theo quy tắc của `evidence.ts`
 * (phía gọi quyết định xem có cần đưa chuỗi khớp vào allowlist hay không).
 */
export interface FieldHit {
  path: string;
  value: unknown;
}

const MAX_HITS = 10;

export function findFieldsByKeyPattern(messages: readonly RawMessage[], pattern: RegExp): FieldHit[] {
  const hits: FieldHit[] = [];
  for (const message of messages) {
    walk(message, '$', pattern, hits);
    if (hits.length >= MAX_HITS) break;
  }
  return hits.slice(0, MAX_HITS);
}

function walk(value: unknown, path: string, pattern: RegExp, hits: FieldHit[], depth = 0): void {
  if (hits.length >= MAX_HITS || depth > 8) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, pattern, hits, depth + 1));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`;
    if (pattern.test(key)) {
      hits.push({ path: nextPath, value: typeof val === 'string' ? `<string:${val.length}>` : val });
      if (hits.length >= MAX_HITS) return;
    }
    walk(val, nextPath, pattern, hits, depth + 1);
  }
}
