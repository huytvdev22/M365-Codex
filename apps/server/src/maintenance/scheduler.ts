import type { Logger } from 'pino';

/**
 * Lập lịch tác vụ bảo trì định kỳ (tương ứng "dọn dẹp định kỳ" trong kế hoạch triển khai §18).
 *
 * Chỉ làm 3 việc: chạy theo chu kỳ, một tác vụ thất bại không ảnh hưởng tới tác vụ khác, ghi nhận kết quả lần trước phục vụ hiển thị trên giao diện quản trị.
 * Không sử dụng thư viện cron: các tác vụ ở đây đều là "chạy mỗi N phút một lần", không cần biểu thức cron.
 *
 * Đánh đổi thiết kế:
 * - Các tác vụ thực thi tuần tự. Các tác vụ dọn dẹp đều ghi vào cùng một SQLite, chạy đồng thời chỉ tranh chấp khóa (lock);
 * - Vòng đầu tiên trì hoãn một khoảng thời gian ngắn rồi mới chạy, tránh tranh chấp I/O với migration và làm ấm (warm-up) ngay khi vừa khởi động;
 * - `unref()` bộ định thời, để tiến trình có thể thoát bình thường, không bị tác vụ dọn dẹp giữ treo.
 */

export interface MaintenanceJob {
  name: string;
  /** Chu kỳ chạy (mili-giây) */
  intervalMs: number;
  /** Trả về số bản ghi được xử lý, dùng cho log và hiển thị trên giao diện quản trị */
  run: () => number | Promise<number>;
}

export interface JobStatus {
  name: string;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastAffected: number | null;
  lastError: string | null;
  runCount: number;
}

export class MaintenanceScheduler {
  readonly #jobs: MaintenanceJob[] = [];
  readonly #status = new Map<string, JobStatus>();
  readonly #logger: Logger;
  readonly #timers: NodeJS.Timeout[] = [];
  #started = false;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  register(job: MaintenanceJob): void {
    if (this.#started) throw new Error('调度已启动后不能再注册任务');
    this.#jobs.push(job);
    this.#status.set(job.name, {
      name: job.name,
      lastRunAt: null,
      lastDurationMs: null,
      lastAffected: null,
      lastError: null,
      runCount: 0,
    });
  }

  /** Thực thi ngay lập tức một tác vụ (nút "Dọn dẹp ngay" trên giao diện quản trị đi qua đây). */
  async runNow(name: string): Promise<JobStatus> {
    const job = this.#jobs.find((j) => j.name === name);
    if (job === undefined) throw new Error(`没有名为 ${name} 的维护任务`);
    await this.#execute(job);
    return this.#status.get(name) as JobStatus;
  }

  /** Chạy toàn bộ một lượt, trả về trạng thái từng tác vụ. */
  async runAll(): Promise<JobStatus[]> {
    for (const job of this.#jobs) {
      await this.#execute(job);
    }
    return this.statuses();
  }

  start(options: { initialDelayMs?: number } = {}): void {
    if (this.#started) return;
    this.#started = true;
    const initialDelay = options.initialDelayMs ?? 30_000;

    for (const job of this.#jobs) {
      const timer = setInterval(() => {
        void this.#execute(job);
      }, job.intervalMs);
      timer.unref();
      this.#timers.push(timer);

      const kickoff = setTimeout(() => {
        void this.#execute(job);
      }, initialDelay);
      kickoff.unref();
      this.#timers.push(kickoff);
    }
    this.#logger.info({ jobs: this.#jobs.map((j) => j.name) }, '维护任务调度已启动');
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    this.#started = false;
  }

  statuses(): JobStatus[] {
    return [...this.#status.values()];
  }

  async #execute(job: MaintenanceJob): Promise<void> {
    const status = this.#status.get(job.name) as JobStatus;
    const startedAt = Date.now();
    try {
      const affected = await job.run();
      status.lastAffected = affected;
      status.lastError = null;
      if (affected > 0) {
        this.#logger.info({ job: job.name, affected }, '维护任务清理了记录');
      }
    } catch (error) {
      // Một tác vụ nổ không được làm ảnh hưởng tới các tác vụ khác, cũng không được đánh sập tiến trình
      status.lastError = (error as Error).message;
      status.lastAffected = null;
      this.#logger.warn({ job: job.name, err_msg: status.lastError }, '维护任务执行失败');
    } finally {
      status.lastRunAt = startedAt;
      status.lastDurationMs = Date.now() - startedAt;
      status.runCount += 1;
    }
  }
}
