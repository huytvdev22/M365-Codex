/**
 * Số liệu vận hành (tương ứng kế hoạch triển khai §17).
 *
 * Tự hiện thực một registry định dạng Prometheus text tối giản, không dùng thư viện prom-client: chỉ cần
 * 2 loại là counter và histogram, bộ số liệu là cố định, thêm 1 dependency chỉ để bớt 40 dòng mã là không kinh tế.
 *
 * **Ranh giới đỏ về riêng tư**: Trong metric tuyệt đối không xuất hiện email, prompt, nội dung output, token, tên file.
 * Giá trị của label bắt buộc phải là enum hữu hạn (tên model, phân loại lỗi, account ID...), nếu không sẽ làm
 * bùng nổ chuỗi thời gian (cardinality explosion), cũng như dễ mang nội dung người dùng ra ngoài. Vì vậy ở đây thực hiện lọc label theo kiểu whitelist.
 */

export type Labels = Record<string, string>;

/**
 * Hình thái JWT / Bearer Token: 3 phần base64url phân tách bởi dấu chấm, hoặc bắt đầu bằng `eyJ` (base64 của `{"`).
 * Ngưỡng nhận diện mở rộng hơn JWT thực tế — cái giá của việc nhận nhầm chỉ là giá trị label bị biến thành redacted,
 * còn cái giá của việc bỏ sót là ghi thông tin xác thực vào metric, hai rủi ro này bất đối xứng.
 */
const TOKEN_SHAPE = /^(eyJ[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,})/;
/** Dạng API Key đối ngoại bắt đầu bằng `sk-`. */
const API_KEY_SHAPE = /^sk-[A-Za-z0-9]{8,}$/;

/**
 * Làm sạch giá trị nhãn (label).
 *
 * Hai lớp bảo vệ:
 * 1. Whitelist ký tự — chuyển prompt tiếng Trung, ký tự `@` của email thành dấu gạch dưới, đồng thời giới hạn độ dài,
 *    tránh nhãn có độ biến thiên cao làm nổ chuỗi thời gian;
 * 2. Nhận diện hình thái — JWT và Key `sk-` đều gồm các ký tự nằm trong whitelist nên charset không chặn được,
 *    vì vậy thay thế toàn bộ theo hình thái. Vốn dĩ bên gọi không được đưa thông tin xác thực vào nhãn, đây là lớp phòng thủ cuối.
 */
function sanitizeLabelValue(value: string): string {
  if (TOKEN_SHAPE.test(value) || API_KEY_SHAPE.test(value)) return 'redacted';
  return value.replace(/[^A-Za-z0-9_:.\-/]/g, '_').slice(0, 64);
}

function labelsKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${sanitizeLabelValue(v)}"`).join(',');
}

interface Series {
  labels: string;
  value: number;
}

class Counter {
  readonly #series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelsKey(labels);
    const existing = this.#series.get(key);
    if (existing === undefined) {
      this.#series.set(key, { labels: key, value: delta });
      return;
    }
    existing.value += delta;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.#series.size === 0) {
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const series of this.#series.values()) {
      const suffix = series.labels === '' ? '' : `{${series.labels}}`;
      lines.push(`${this.name}${suffix} ${series.value}`);
    }
    return lines;
  }

  /**
   * Tổng hợp bộ đếm theo giá trị của một nhãn cụ thể (tích lũy trong vòng đời tiến trình, khởi động lại về 0).
   * Dành cho các kịch bản như `/admin/overview` (tỷ lệ pass của công cụ) và `/admin/diagnostics` (thống kê phân loại lỗi)
   * tái sử dụng lại số liệu đã đo đạc sẵn mà không cần thêm bảng mới chỉ để hiển thị một con số tổng quan.
   */
  sumByLabel(labelName: string): Record<string, number> {
    const out: Record<string, number> = {};
    const pattern = new RegExp(`(?:^|,)${labelName}="([^"]*)"`);
    for (const series of this.#series.values()) {
      const match = pattern.exec(series.labels);
      if (match?.[1] === undefined) continue;
      out[match[1]] = (out[match[1]] ?? 0) + series.value;
    }
    return out;
  }
}

class Histogram {
  readonly #buckets: number[];
  readonly #series = new Map<string, { labels: string; counts: number[]; sum: number; total: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[],
  ) {
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelsKey(labels);
    let series = this.#series.get(key);
    if (series === undefined) {
      series = { labels: key, counts: new Array<number>(this.#buckets.length).fill(0), sum: 0, total: 0 };
      this.#series.set(key, series);
    }
    series.sum += value;
    series.total += 1;
    for (let i = 0; i < this.#buckets.length; i += 1) {
      if (value <= (this.#buckets[i] as number)) series.counts[i] = (series.counts[i] as number) + 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const series of this.#series.values()) {
      const base = series.labels === '' ? '' : `${series.labels},`;
      for (let i = 0; i < this.#buckets.length; i += 1) {
        lines.push(`${this.name}_bucket{${base}le="${this.#buckets[i]}"} ${series.counts[i]}`);
      }
      lines.push(`${this.name}_bucket{${base}le="+Inf"} ${series.total}`);
      const suffix = series.labels === '' ? '' : `{${series.labels}}`;
      lines.push(`${this.name}_sum${suffix} ${series.sum}`);
      lines.push(`${this.name}_count${suffix} ${series.total}`);
    }
    return lines;
  }
}

/**
 * Registry số liệu. Tên metric và ý nghĩa được định nghĩa tập trung tại đây, bên gọi chỉ việc gọi ghi nhận.
 */
export class Metrics {
  readonly requests = new Counter('m365codex_requests_total', '按端点与状态分类的请求数');
  readonly requestDuration = new Histogram(
    'm365codex_request_duration_seconds',
    '请求耗时（秒）',
    [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  );
  readonly upstreamAttempts = new Counter('m365codex_upstream_attempts_total', '上游调用次数（按结果分类）');
  readonly upstreamErrors = new Counter('m365codex_upstream_errors_total', '上游错误数（按错误分类）');
  readonly sseInterrupted = new Counter('m365codex_sse_interrupted_total', 'SSE 中断次数');
  readonly toolCalls = new Counter('m365codex_tool_calls_total', '发出的工具调用数');
  readonly toolRounds = new Histogram('m365codex_tool_rounds', '单条对话链的工具轮次', [1, 2, 3, 5, 8, 13, 21]);
  readonly toolArgValidations = new Counter(
    'm365codex_tool_arg_validations_total',
    '工具参数校验结果（pass / repaired / rejected）',
  );
  readonly tokenRefresh = new Counter('m365codex_token_refresh_total', 'Token 刷新结果');
  readonly accountStates = new Counter('m365codex_account_state_transitions_total', '账号状态迁移');
  /** Số lần chạm giới hạn cấp API Key, phân loại theo lý do (rpm/daily/concurrency/endpoint/model), tương ứng §10 */
  readonly rateLimitRejections = new Counter(
    'm365codex_rate_limit_rejections_total',
    'API Key 级限额拒绝次数（按原因分类）',
  );

  /** Giá trị tức thời được phía ngoài điền vào khi scrape (số lượng tài khoản, dung lượng file...). */
  #gauges = new Map<string, { help: string; value: number; labels: string }>();

  setGauge(name: string, help: string, value: number, labels: Labels = {}): void {
    this.#gauges.set(`${name}|${labelsKey(labels)}`, { help, value, labels: labelsKey(labels) });
  }

  /** Render thành định dạng Prometheus text. */
  render(): string {
    const lines: string[] = [];
    for (const metric of [
      this.requests,
      this.upstreamAttempts,
      this.upstreamErrors,
      this.sseInterrupted,
      this.toolCalls,
      this.toolArgValidations,
      this.tokenRefresh,
      this.accountStates,
      this.rateLimitRejections,
    ]) {
      lines.push(...metric.render());
    }
    lines.push(...this.requestDuration.render());
    lines.push(...this.toolRounds.render());

    const seen = new Set<string>();
    for (const [key, gauge] of this.#gauges) {
      const name = key.split('|')[0] as string;
      if (!seen.has(name)) {
        lines.push(`# HELP ${name} ${gauge.help}`, `# TYPE ${name} gauge`);
        seen.add(name);
      }
      const suffix = gauge.labels === '' ? '' : `{${gauge.labels}}`;
      lines.push(`${name}${suffix} ${gauge.value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const CONTENT_TYPE_PROMETHEUS = 'text/plain; version=0.0.4; charset=utf-8';
