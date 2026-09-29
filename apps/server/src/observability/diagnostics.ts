import type { AccountStatus } from '@m365-codex/shared';

/**
 * Gói chẩn đoán hệ thống (tương ứng kế hoạch triển khai §17).
 *
 * Mục đích: khi người dùng báo sự cố có thể cung cấp 1 lần thông tin "đủ để xác định vấn đề", và **khi cung cấp ra ngoài sẽ không làm lộ bất cứ thứ gì**.
 * Do đó ở đây là pure function + whitelist rõ ràng: chỉ tổng hợp các bộ đếm có cấu trúc và tóm tắt cấu hình,
 * tuyệt đối không chạm vào prompt, nội dung output, email, token, tên file.
 *
 * Tiêu chuẩn đánh giá một mục có nên đưa vào gói chẩn đoán hay không rất đơn giản: dán nó vào một issue công khai có gây hối hận hay không.
 */

export type SystemStatus =
  | 'normal'
  | 'degraded'
  | 'maintenance'
  | 'upstream_unavailable'
  | 'migration_failed';

export interface DiagnosticsInput {
  appVersion: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  startedAt: number;
  now: number;
  /** Số lượng tài khoản theo từng trạng thái, không chứa bất kỳ định danh tài khoản nào */
  accountsByStatus: Record<AccountStatus, number>;
  /** Đếm lỗi theo loại trong khoảng thời gian gần đây, không chứa nội dung thông điệp lỗi gốc */
  recentErrorsByType: Record<string, number>;
  inFlightRequests: number;
  /** Tóm tắt cấu hình, bắt buộc đã làm mờ/khử nhạy cảm (kết quả của summarizeConfig) */
  configSummary: Record<string, unknown>;
  storage: { dbBytes: number; filesBytes: number; fileCount: number };
  maintenanceJobs: { name: string; lastRunAt: number | null; lastError: string | null }[];
  readiness: { name: string; ok: boolean }[];
}

export interface DiagnosticsReport {
  generated_at: number;
  app_version: string;
  system_status: SystemStatus;
  uptime_ms: number;
  schema: { current: number; expected: number; ok: boolean };
  accounts: Record<string, number>;
  accounts_usable: number;
  in_flight_requests: number;
  recent_errors: Record<string, number>;
  storage: { db_bytes: number; files_bytes: number; file_count: number };
  maintenance: { name: string; last_run_at: number | null; last_error: string | null }[];
  readiness: { name: string; ok: boolean }[];
  config: Record<string, unknown>;
  notes: string[];
}

/** Trạng thái có thể được scheduler lựa chọn. Các trạng thái khác (cooldown, cần cấp quyền lại, vô hiệu...) không tính là khả dụng. */
const USABLE_STATUSES: AccountStatus[] = ['online', 'busy'];

/**
 * Phán đoán trạng thái hệ thống (enum trạng thái theo §17).
 * Thứ tự được sắp xếp có chủ đích: migration thất bại là nghiêm trọng nhất, kế đến là hoàn toàn không có tài khoản khả dụng, sau đó là "có nhưng không khỏe".
 */
export function deriveSystemStatus(input: {
  schemaOk: boolean;
  readinessOk: boolean;
  usableAccounts: number;
  totalAccounts: number;
}): SystemStatus {
  if (!input.schemaOk) return 'migration_failed';
  if (!input.readinessOk) return 'degraded';
  // Chưa từng thêm tài khoản nào, thuộc về "chưa cấu hình xong", không phải upstream bị sập
  if (input.totalAccounts > 0 && input.usableAccounts === 0) return 'upstream_unavailable';
  if (input.totalAccounts === 0) return 'degraded';
  return 'normal';
}

export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  const schemaOk = input.schemaVersion === input.expectedSchemaVersion;
  const totalAccounts = Object.values(input.accountsByStatus).reduce((sum, n) => sum + n, 0);
  const usableAccounts = USABLE_STATUSES.reduce(
    (sum, status) => sum + (input.accountsByStatus[status] ?? 0),
    0,
  );
  const readinessOk = input.readiness.every((check) => check.ok);

  const notes: string[] = [];
  if (!schemaOk) {
    notes.push(`数据库结构版本 v${input.schemaVersion} 与程序期望的 v${input.expectedSchemaVersion} 不一致`);
  }
  if (totalAccounts === 0) {
    notes.push('尚未添加任何 Microsoft 账号，请先在管理界面完成 PKCE 授权');
  } else if (usableAccounts === 0) {
    notes.push('所有账号当前都不可调度（冷却、需重新授权或已停用）');
  }
  for (const job of input.maintenanceJobs) {
    if (job.lastError !== null) notes.push(`维护任务 ${job.name} 上次执行失败`);
  }

  return {
    generated_at: input.now,
    app_version: input.appVersion,
    system_status: deriveSystemStatus({ schemaOk, readinessOk, usableAccounts, totalAccounts }),
    uptime_ms: input.now - input.startedAt,
    schema: { current: input.schemaVersion, expected: input.expectedSchemaVersion, ok: schemaOk },
    accounts: { ...input.accountsByStatus },
    accounts_usable: usableAccounts,
    in_flight_requests: input.inFlightRequests,
    recent_errors: { ...input.recentErrorsByType },
    storage: {
      db_bytes: input.storage.dbBytes,
      files_bytes: input.storage.filesBytes,
      file_count: input.storage.fileCount,
    },
    maintenance: input.maintenanceJobs.map((job) => ({
      name: job.name,
      last_run_at: job.lastRunAt,
      last_error: job.lastError,
    })),
    readiness: input.readiness.map((check) => ({ name: check.name, ok: check.ok })),
    config: input.configSummary,
    notes,
  };
}
