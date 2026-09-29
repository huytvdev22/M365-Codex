/**
 * Đánh giá loại trừ `NO_PROXY`.
 *
 * Bối cảnh: `config/index.ts` phân tích và hiển thị `NO_PROXY`, nhưng trước đây chưa từng
 * so sánh máy chủ đích trước khi quyết định có dùng proxy hay không — `HTTPS_PROXY`/`HTTP_PROXY`
 * thực sự đã nối vào proxy outbound, nhưng `NO_PROXY` chỉ là hình thức. Điều này tệ hơn là "không có tính năng":
 * Quản trị viên cấu hình `NO_PROXY=xxx` theo tài liệu `.env.example`, tưởng rằng host tương ứng sẽ kết nối trực tiếp,
 * thực tế vẫn đi qua proxy.
 *
 * Ngữ nghĩa đồng bộ với quy ước thông dụng của `NO_PROXY` trong hệ sinh thái curl/Node:
 * - Phân tách nhiều mục bằng dấu phẩy hoặc khoảng trắng;
 * - `*` đứng một mình biểu thị tất cả các máy chủ đều không qua proxy;
 * - Mục có thể là tên miền trần (`example.com` — khớp cả chính nó và bất kỳ tên miền con nào, đây là hành vi thực tế
 *   của hầu hết các thư viện, không phải chỉ khớp chính xác theo nghĩa đen), wildcard tên miền con rõ ràng
 *   (`*.example.com`), dấu chấm ở đầu (`.example.com`, tương đương `*.example.com`),
 *   IP literal, `localhost`;
 * - Mục có thể kèm cổng (port), khi so sánh bỏ qua cổng (chỉ xem xét hostname);
 * - Không phân biệt chữ hoa chữ thường (case-insensitive);
 * - Khớp hậu tố so sánh theo ranh giới dấu chấm: `notexample.com` sẽ không bị khớp bởi mục `example.com`.
 */

/** Xác định xem một hostname đích có nên bỏ qua proxy hay không (khớp danh sách NO_PROXY). */
export function shouldBypassProxy(hostname: string, noProxy: string | null | undefined): boolean {
  if (noProxy == null) return false;
  const host = normalizeHost(hostname);
  if (host === '') return false;

  for (const rawEntry of splitEntries(noProxy)) {
    if (rawEntry === '*') return true;
    const entry = stripEntryPort(normalizeHost(rawEntry));
    if (entry === '') continue;
    if (matchesEntry(host, entry)) return true;
  }
  return false;
}

/** Lấy hostname từ URL đích; trả về null khi phân tích thất bại (bên gọi coi là không khớp NO_PROXY, không chặn request). */
export function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function splitEntries(noProxy: string): string[] {
  return noProxy
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Loại bỏ số cổng có thể có trong mục cấu hình. Chỉ xử lý khi "chính xác một dấu hai chấm",
 * tránh ảnh hưởng nhầm IPv6 literal (chứa nhiều dấu hai chấm) — upstream/OAuth hiện chưa dùng IPv6 nên xử lý đơn giản.
 */
function stripEntryPort(entry: string): string {
  const idx = entry.lastIndexOf(':');
  if (idx <= 0) return entry;
  if (entry.indexOf(':') !== idx) return entry;
  return entry.slice(0, idx);
}

function matchesEntry(host: string, entryRaw: string): boolean {
  let entry = entryRaw;
  if (entry.startsWith('*.')) entry = entry.slice(1); // '*.example.com' -> '.example.com'
  if (entry.startsWith('.')) {
    return host === entry.slice(1) || host.endsWith(entry);
  }
  // Tên miền trần khớp cả chính nó và tên miền con; so sánh ranh giới chấm đảm bảo notexample.com không khớp example.com
  return host === entry || host.endsWith(`.${entry}`);
}
