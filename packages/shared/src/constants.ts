/** Hằng số dùng chung toàn dự án. */

/** Tiền tố API Key đối ngoại, đồng bộ với quy ước của client OpenAI. */
export const API_KEY_PREFIX = 'sk-';

/** Độ dài phần ngẫu nhiên của API Key (ký tự Base62), yêu cầu ≥ 48. */
export const API_KEY_BODY_LENGTH = 52;

/** Độ dài đoạn tiền tố dùng cho chỉ mục CSDL: `sk-` + 8 ký tự ngẫu nhiên. */
export const API_KEY_LOOKUP_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

/** Số byte yêu cầu sau khi giải mã khóa mã hóa chủ (AES-256). */
export const MASTER_KEY_BYTES = 32;

/** Cổng lắng nghe mặc định. */
export const DEFAULT_PORT = 8080;

/** Thư mục dữ liệu mặc định. */
export const DEFAULT_DATA_DIR = '/data';

/** Thời hạn hiệu lực mặc định của phiên quản trị: 12 giờ. */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Header phản hồi Request ID. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Giao thức truyền tải duy nhất mà Codex hỗ trợ (`chat` đã bị loại bỏ từ 2026-02). */
export const CODEX_WIRE_API = 'responses';
