import { maskEmail } from '../../apps/server/dist/util/redact.js';
import { redactWsUrl } from '../../apps/server/dist/adapter/endpoint.js';

/**
 * Tầng khử nhạy cảm bắt buộc (tương ứng ranh giới đỏ cứng §3.3 kế hoạch triển khai).
 *
 * Quy tắc sắt: Báo cáo chỉ có thể xuất qua các hàm của file này; không case nào được phép đưa access/refresh
 * token gốc, Cookie, Header xác thực đầy đủ, nội dung file thật của người dùng hoặc đối thoại thật trực tiếp vào
 * `CapabilityResult.evidence`。
 *
 * Ở đây cố ý thận trọng: Mặc định coi tất cả giá trị chuỗi là nội dung nhạy cảm, chỉ có các chuỗi ký tự cố định
 * do phía gọi cung cấp rõ ràng ("văn bản thử nghiệm cố định do chính chúng ta gửi đi") mới được giữ nguyên, còn lại đều
 * thay thế thành `<string:độ_dài>` (giữ lại tên trường và kiểu dữ liệu, không giữ nội dung).
 */

export { maskEmail, redactWsUrl };

/** Tenant / Object ID chỉ giữ lại 8 ký tự đầu (§3.3). */
export function maskId(id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null;
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/** Tên các key bị cấm rõ ràng không được xuất hiện trong bằng chứng (không phân biệt hoa thường), khi khớp sẽ loại bỏ toàn bộ trường đó. */
const FORBIDDEN_KEYS = new Set(
  [
    'access_token',
    'accesstoken',
    'refresh_token',
    'refreshtoken',
    'id_token',
    'idtoken',
    'code',
    'code_verifier',
    'codeverifier',
    'pkce',
    'cookie',
    'set-cookie',
    'authorization',
    'auth',
    'password',
    'secret',
    'client_secret',
    'clientsecret',
    'master_key',
    'masterkey',
  ].map((key) => key.toLowerCase()),
);

const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 8;

/**
 * Chuyển đổi giá trị bất kỳ (thường là frame gốc từ upstream) thành mẫu "chỉ giữ cấu trúc không giữ nội dung":
 * - Object: Giữ tên key, key khớp `FORBIDDEN_KEYS` sẽ thay thế toàn bộ bằng placeholder;
 * - String: Khớp allowlist thì giữ nguyên, ngược lại thay bằng `<string:độ_dài>`;
 * - Number / Boolean / null: Giữ nguyên (chúng là metadata có cấu trúc, không phải "nội dung");
 * - Array: Chuyển đổi từng phần tử, vượt quá giới hạn trên sẽ cắt ngắn và ghi nhận số lượng bị cắt.
 */
export function buildStructureSample(
  value: unknown,
  allowlist: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return '<truncated:max-depth>';

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sampleString(value, allowlist);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => buildStructureSample(item, allowlist, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`<truncated:${value.length - MAX_ARRAY_ITEMS}-more-items>`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        out[key] = '<redacted:forbidden-key>';
        continue;
      }
      out[key] = buildStructureSample(val, allowlist, depth + 1);
    }
    return out;
  }

  // function / symbol / bigint v.v. không nên xuất hiện trong JSON frame upstream, loại bỏ dự phòng
  return `<redacted:unsupported-type:${typeof value}>`;
}

function sampleString(text: string, allowlist: ReadonlySet<string>): string {
  if (allowlist.has(text)) return text;
  if (looksLikeSecret(text)) return '<redacted:looks-like-secret>';
  return `<string:${text.length}>`;
}

/** Nhận diện heuristic dạng JWT, access_token query, Bearer header v.v., phòng tuyến dự phòng. */
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/;
const ACCESS_TOKEN_QUERY_PATTERN = /[?&]access_token=[^&\s"']+/i;
const BEARER_PATTERN = /^Bearer\s+\S+$/i;

function looksLikeSecret(text: string): boolean {
  return (
    JWT_PATTERN.test(text) || ACCESS_TOKEN_QUERY_PATTERN.test(text) || BEARER_PATTERN.test(text)
  );
}

/**
 * Phòng tuyến cuối cùng: Quét toàn bộ đoạn văn bản đã render trước khi ghi báo cáo ra đĩa.
 * Khớp bất kỳ dạng nhạy cảm nào đều coi là bug triển khai "lẽ ra không nên đến bước này", ném lỗi trực tiếp thay vì
 * âm thầm khử nhạy cảm lần nữa — không thể công bố báo cáo với tâm lý cầu may "từng suýt làm lộ".
 */
export function assertReportClean(renderedText: string): void {
  const findings: string[] = [];
  if (JWT_PATTERN_GLOBAL.test(renderedText)) findings.push('疑似 JWT');
  if (/[?&]access_token=[^&\s"']+/i.test(renderedText)) findings.push('URL 中的 access_token 查询参数');
  if (/Bearer\s+[A-Za-z0-9._-]{10,}/i.test(renderedText)) findings.push('Bearer 认证头');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(renderedText) && !onlyMaskedEmails(renderedText)) {
    findings.push('疑似未脱敏的邮箱地址');
  }
  if (findings.length > 0) {
    throw new Error(`报告脱敏检查失败，检测到：${findings.join('、')}`);
  }
}

const JWT_PATTERN_GLOBAL = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;

/** Regex email sẽ khớp dạng mask của chính chúng ta (như `fo***@example.com`), loại trừ dạng này nếu vẫn khớp mới tính là rò rỉ thật. */
function onlyMaskedEmails(text: string): boolean {
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return emails.every((email) => /^[A-Za-z0-9._%+-]{0,2}\*{3}@/.test(email));
}
