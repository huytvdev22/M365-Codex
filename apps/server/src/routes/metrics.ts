import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { createAdminGuard } from '../gateway/auth.js';
import { CONTENT_TYPE_PROMETHEUS } from '../observability/metrics.js';

/**
 * `GET /metrics` (tương ứng kế hoạch triển khai §17, hợp đồng §3).
 *
 * Cả hai công tắc đều đi theo cấu hình:
 * - `METRICS_ENABLED` (mặc định bật): Khi tắt thì xem như toàn bộ endpoint không tồn tại, trả về 404,
 *   không để lộ thông tin dạng "chức năng này đã bị vô hiệu hóa";
 * - `METRICS_REQUIRE_AUTH` (mặc định bật): Chỉ số sẽ để lộ số lượng tài khoản và phân phối lỗi,
 *   mặc định yêu cầu phiên quản trị; chỉ khi tắt rõ ràng mới cho phép scrape không cần xác thực (mở cho Prometheus nội bộ).
 *
 * Các giá trị tức thời (gauge) chỉ tính toán khi scrape được điền ngay tại đây thay vì cập nhật liên tục — số lượng tài khoản,
 * số yêu cầu đang xử lý, dung lượng database và tệp chiếm dụng đều là "ảnh chụp tức thời tại thời điểm truy vấn", không cần thiết phải
 * tính lại toàn bộ mỗi khi trạng thái thay đổi.
 */
export function registerMetricsRoutes(app: FastifyInstance, context: AppContext): void {
  if (!context.config.metrics.enabled) return;

  const adminGuard = createAdminGuard(context);

  app.get('/metrics', { preHandler: context.config.metrics.requireAuth ? adminGuard : undefined }, async (_request, reply) => {
    fillGauges(context);
    reply.header('content-type', CONTENT_TYPE_PROMETHEUS);
    return context.metrics.render();
  });
}

/** Trạng thái tài khoản bản thân nó là enum hữu hạn, an toàn khi làm nhãn (label); không chứa bất kỳ định danh tài khoản nào. */
function fillGauges(context: AppContext): void {
  const accounts = context.accounts.listViews();
  const byStatus = new Map<string, number>();
  for (const account of accounts) {
    byStatus.set(account.status, (byStatus.get(account.status) ?? 0) + 1);
  }
  for (const [status, count] of byStatus) {
    context.metrics.setGauge('m365codex_accounts', '各状态账号数', count, { status });
  }

  context.metrics.setGauge('m365codex_requests_in_flight', '当前在途请求数', context.inFlight.size);

  const usage = context.backup.usage();
  context.metrics.setGauge('m365codex_db_bytes', 'SQLite 数据库文件占用字节数', usage.dbBytes);
  context.metrics.setGauge('m365codex_files_bytes', '已上传文件占用字节数', usage.filesBytes);
  context.metrics.setGauge('m365codex_files_count', '已上传文件数量', usage.fileCount);
}
