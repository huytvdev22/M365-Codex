import type { Logger } from 'pino';
import type { ProtocolCodec, RawMessage, UpstreamEvent } from '../../apps/server/dist/adapter/protocol.js';
import type { AccountRepository } from '../../apps/server/dist/repo/accounts.js';
import type { OAuthClient } from '../../apps/server/dist/oauth/client.js';
import type { TokenManager } from '../../apps/server/dist/oauth/tokenManager.js';

/**
 * Các kiểu dữ liệu công khai của probe (tương ứng kế hoạch triển khai §3.4, §3.3).
 *
 * Probe hoạt động ở "tầng adapter" chứ không phải tầng gateway Responses đầy đủ: kết nối trực tiếp với WebSocket upstream
 * để chạy 29 case của §3.1, tạo ra bằng chứng đã khử nhạy cảm. Tầng nghiệp vụ (Responses/vòng lặp công cụ/bộ điều phối) đã được
 * triển khai ở M3-M8 bằng giá trị mô hình hóa, sản phẩm của probe là dùng để hiệu chuẩn các giá trị mô hình hóa đó, không phải triển khai lại gateway.
 */

/** Enum trạng thái năng lực (§3.4). */
export const CAPABILITY_STATUSES = [
  'native',
  'adaptable',
  'partial',
  'unsupported',
  'unstable',
  'unknown',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Sản phẩm của việc thăm dò năng lực đơn lẻ (bao phủ toàn bộ các trường theo yêu cầu §3.3). */
export interface CapabilityResult {
  /** id ổn định, như `basic_text_chat`, nhất quán giữa báo cáo và mã nguồn để dễ truy vết */
  id: string;
  /** Số thứ tự theo §3.1 (1-29) */
  index: number;
  /** Tên định danh */
  name: string;
  status: CapabilityStatus;
  /** Tóm tắt bằng chứng sau khi khử nhạy cảm (cho con người đọc) */
  summary: string;
  /** Thời gian bắt đầu gửi yêu cầu (epoch ms) */
  requestedAt: number;
  /** Thời gian thực thi (mili-giây) */
  durationMs: number;
  /** Phân loại lỗi upstream (null nếu không có lỗi), tương ứng `UpstreamDisposition` hoặc phân loại tùy chỉnh của probe */
  errorCategory: string | null;
  /** Bằng chứng đã khử nhạy cảm có cấu trúc; chỉ xuất qua `evidence.ts`, tuyệt đối không chứa Token/nội dung hội thoại thật */
  evidence: Record<string, unknown>;
}

/** Kết quả thu thập thô của một invocation đơn lẻ, dùng cho các case và lấy mẫu evidence. */
export interface InvocationOutcome {
  /** Sự kiện chuẩn hóa (dùng cho phán đoán năng lực) */
  events: UpstreamEvent[];
  /** Frame gốc (dùng cho lấy mẫu cấu trúc / sai khác hiệu chuẩn, bắt buộc chỉ xuất qua khử nhạy cảm) */
  rawMessages: RawMessage[];
  /** Mã đóng WebSocket (đóng bình thường là 1000, chưa đóng là null) */
  closeCode: number | null;
  closeReason: string | null;
  /** Lý do thất bại phân loại; null nếu thành công */
  errorCategory: string | null;
  errorMessage: string | null;
  /** Số mili-giây làm nguội phân tích được trong kịch bản 429 (§3.1 mục 25), null nếu không có thông tin */
  retryAfterMs: number | null;
  durationMs: number;
  /** Định danh phiên do server gửi xuống (nếu upstream trả về), dùng cho các case "phiên liên tục", "khôi phục phiên" */
  conversationRef: string | null;
}

/** Cấu hình liên quan đến kết nối upstream (tương ứng `UpstreamConfig` trong `apps/server/src/config/index.ts`). */
export interface ProbeUpstreamConfig {
  readonly wsBase: string;
  /** Header X-Scenario bắt buộc phải có khi bắt tay, xem UpstreamConfig.scenario của server */
  readonly scenario: string;
  readonly pathTemplate: string;
  readonly protocolVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly handshakeTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

/** Ngữ cảnh cần thiết để chạy một case đơn lẻ. Mỗi case tự mở kết nối, không chia sẻ trạng thái khả biến với nhau. */
export interface ProbeContext {
  account: { id: string; oid: string; tid: string; email: string | null };
  /** Lấy một access token khả dụng hiện tại; phía gọi dùng xong hủy bỏ, tuyệt đối không cache ra ngoài ctx */
  getAccessToken: () => Promise<string>;
  upstream: ProbeUpstreamConfig;
  codec: ProtocolCodec;
  logger: Logger;
  /** Khoảng nghỉ giữa mỗi case (§6 an toàn và lịch sự) */
  delayMs: number;
  /** Số lần lấy mẫu của các case thống kê (bốn chỉ số ngưỡng §3.5) */
  repeat: number;
  /** Timeout tổng thể của một invocation đơn lẻ (mili-giây) */
  invocationTimeoutMs: number;
  /** Kho lưu trữ tài khoản: Chỉ dùng cho các case refresh Token đọc xem "có thay đổi hay không", tuyệt đối không đọc nội dung rồi ghi đĩa */
  accounts: AccountRepository;
  oauthClient: OAuthClient;
  tokenManager: TokenManager;
}

export interface CaseDefinition {
  id: string;
  index: number;
  name: string;
  run: (ctx: ProbeContext) => Promise<CapabilityResult>;
}
