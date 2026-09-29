/**
 * Abort reason dùng để hủy các yêu cầu đang bay (in-flight) khi tắt êm (graceful shutdown) (tương ứng kế hoạch triển khai §19).
 *
 * Hàm `#run` của `responses/service.ts` dựa vào giá trị sentinel này để phân biệt giữa "người dùng/client chủ động hủy"
 * (`/v1/responses/:id/cancel`, `DELETE`, client ngắt kết nối — những trường hợp này cần lưu DB thành
 * `cancelled`) và "tiến trình đang tắt êm" — trường hợp sau do `server.ts` xử lý thống nhất theo
 * cùng một cơ chế "in_progress → incomplete" của `maintenance/recovery.ts`,
 * `#run` tự nó không ghi đè trạng thái nữa, tránh việc hai nơi ghi đồng thời vào cùng một dòng gây tranh chấp và tạo ra hai bộ ngữ nghĩa.
 */
export const SHUTDOWN_ABORT_REASON = 'm365-codex:graceful-shutdown';

/**
 * Bảng đăng ký hủy bỏ các Response đang xử lý.
 *
 * Ánh xạ responseId tới AbortController của nó, giúp `POST /v1/responses/:id/cancel`
 * và `DELETE /v1/responses/:id` có thể hủy cuộc hội thoại upstream đang chạy của luồng yêu cầu khác.
 * Chỉ tồn tại trong bộ nhớ — các yêu cầu đang bay vốn gắn liền với kết nối của tiến trình này.
 */
export class InFlightRegistry {
  readonly #controllers = new Map<string, AbortController>();

  register(responseId: string, controller: AbortController): void {
    this.#controllers.set(responseId, controller);
  }

  unregister(responseId: string): void {
    this.#controllers.delete(responseId);
  }

  /** Hủy bỏ response chỉ định; trả về liệu có thực sự có yêu cầu đang xử lý bị hủy hay không. */
  cancel(responseId: string): boolean {
    const controller = this.#controllers.get(responseId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /**
   * Dành riêng cho tắt êm (graceful shutdown): Hủy toàn bộ kết nối upstream của các yêu cầu đang bay (đóng WebSocket / hủy dispatch),
   * và làm rỗng bảng đăng ký. Trả về danh sách responseId bị hủy, để bên gọi cập nhật các bản ghi tương ứng vào DB thành
   * incomplete (xem `gracefulShutdown` của `server.ts`).
   */
  cancelAll(): string[] {
    const ids = [...this.#controllers.keys()];
    for (const controller of this.#controllers.values()) {
      controller.abort(SHUTDOWN_ABORT_REASON);
    }
    this.#controllers.clear();
    return ids;
  }

  get size(): number {
    return this.#controllers.size;
  }
}
