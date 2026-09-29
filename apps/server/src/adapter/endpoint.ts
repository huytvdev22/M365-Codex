import type { UpstreamConfig } from '../config/index.js';

/**
 * Xây dựng địa chỉ kết nối WebSocket upstream.
 *
 * Endpoint upstream có thể thay đổi, vì vậy URL gốc và template đường dẫn đều lấy từ cấu hình. Tại đây thực hiện hai việc:
 * 1. Dùng oid / tid của tài khoản để điền vào template đường dẫn;
 * 2. Đính kèm access_token dưới dạng query parameter.
 *
 * access_token không được ghi cứng vào template và không xuất hiện trong bất kỳ cấu trúc trả về bên ngoài nào;
 * Khi cần in URL ra log, luôn sử dụng `redactWsUrl` để che giấu thông tin nhạy cảm.
 */

export interface BuildEndpointInput {
  config: UpstreamConfig;
  oid: string;
  tid: string;
  accessToken: string;
  /** Tham số truy vấn bổ sung (ví dụ: cờ tính năng phiên làm việc), mặc định rỗng */
  extraParams?: Record<string, string>;
}

export function buildUpstreamUrl(input: BuildEndpointInput): string {
  const path = input.config.pathTemplate
    .replaceAll('{oid}', encodeURIComponent(input.oid))
    .replaceAll('{tid}', encodeURIComponent(input.tid));

  const base = input.config.wsBase.replace(/\/+$/, '');
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));

  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  // Đặt access_token ở cuối để giảm nguy cơ xuất hiện đầy đủ trong các bản ghi log bị cắt ngắn
  url.searchParams.set('access_token', input.accessToken);
  return url.toString();
}

/** Thay thế giá trị access_token trong URL thành mặt nạ che giấu, dùng cho ghi log. */
export function redactWsUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', '[已脱敏]');
    }
    return url.toString();
  } catch {
    // Dự phòng khi URL không hợp lệ: dùng regex để che đi
    return rawUrl.replace(/(access_token=)[^&]*/gi, '$1[已脱敏]');
  }
}
