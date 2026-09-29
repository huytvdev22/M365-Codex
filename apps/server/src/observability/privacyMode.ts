import type { LogPrivacyMode } from '@m365-codex/shared';

/**
 * Container khả biến lưu trữ chế độ riêng tư log đang có hiệu lực hiện tại (tương ứng tự động hết hạn debug trong kế hoạch triển khai §15.3).
 *
 * `AppConfig` là snapshot được khóa lại và `Object.freeze` lúc khởi động; trong `settings/service.ts`
 * ngoại trừ `logging.log_level` thì các mục khác đều phải đợi khởi động lại mới có hiệu lực, danh sách `pending_restart`
 * tồn tại chính vì điều này. Tuy nhiên việc tự động hết hạn debug của `log_privacy_mode` bắt buộc phải là ngoại lệ —
 * mức debug sẽ ghi lại nhiều thông tin yêu cầu hơn, nếu việc "hết hạn" chỉ đổi giá trị trong bảng `settings` về lại
 * strict còn hiệu lực thực tế phải đợi đến lần khởi động lại tiếp theo (không biết khi nào), thì trong khoảng thời gian cửa sổ này dịch vụ vẫn
 * ghi log theo debug, cơ chế an toàn coi như bị vô hiệu hóa.
 *
 * Vì vậy `log_privacy_mode` cũng giống như `log_level` được thiết kế có hiệu lực nóng (hot-reload): các nơi khi đọc "chế độ riêng tư
 * hiện tại" sẽ chuyển sang dùng container khả biến này (`context.privacyMode.current`), thay vì
 * `config.logPrivacyMode` (đó là giá trị ban đầu lúc khởi động, vẫn dùng cho `/admin/settings`
 * hiển thị nguồn default và làm chuẩn xác định `pending_restart`).
 */
export class PrivacyModeHolder {
  #current: LogPrivacyMode;

  constructor(initial: LogPrivacyMode) {
    this.#current = initial;
  }

  get current(): LogPrivacyMode {
    return this.#current;
  }

  set(mode: LogPrivacyMode): void {
    this.#current = mode;
  }
}
