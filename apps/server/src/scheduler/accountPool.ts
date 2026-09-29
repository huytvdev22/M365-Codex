import type { AccountRepository, AccountView } from '../repo/accounts.js';

/**
 * Lựa chọn tài khoản trong pool và đếm đồng thời.
 *
 * Chiến lược lựa chọn: Weighted least-connections (kết nối ít nhất có trọng số).
 * - Chỉ chọn trong các tài khoản "khả dụng": Trạng thái online / probing / busy, và không trong thời gian cooldown;
 * - Số kết nối càng ít càng ưu tiên; nếu hòa thì số lần thất bại liên tiếp ít hơn được ưu tiên;
 * - Hỗ trợ tập loại trừ (các tài khoản đã thử trong request này và bị thất bại).
 *
 * Bộ đếm đồng thời được lưu trong bộ nhớ — phản ánh "số kết nối tiến trình này đang chiếm dụng của tài khoản đó",
 * thuộc trạng thái runtime, không cần lưu trữ vĩnh viễn.
 */

/** Các trạng thái tài khoản có thể tham gia điều phối. */
const SCHEDULABLE_STATUSES = new Set(['online', 'probing', 'busy']);

export interface PickOptions {
  /** Các tài khoản đã loại trừ trong request này (đã thử và thất bại) */
  exclude?: ReadonlySet<string>;
  /** Tài khoản ưu tiên thử (tính bám dính: tài khoản đã liên kết ở vòng trước) */
  prefer?: string | null;
  now?: number;
}

export class AccountPool {
  readonly #accounts: AccountRepository;
  /** accountId → Số kết nối đang hoạt động */
  readonly #active = new Map<string, number>();

  constructor(accounts: AccountRepository) {
    this.#accounts = accounts;
  }

  activeCount(accountId: string): number {
    return this.#active.get(accountId) ?? 0;
  }

  acquire(accountId: string): void {
    this.#active.set(accountId, this.activeCount(accountId) + 1);
  }

  release(accountId: string): void {
    const next = this.activeCount(accountId) - 1;
    if (next <= 0) this.#active.delete(accountId);
    else this.#active.set(accountId, next);
  }

  /** Hiện có tài khoản nào có thể điều phối không (bỏ qua tập loại trừ). Dùng để phân biệt "pool rỗng" và "tất cả đều bị loại trừ". */
  hasAnySchedulable(now = Date.now()): boolean {
    return this.#accounts.listViews().some((account) => this.#isUsable(account, now));
  }

  /**
   * Chọn một tài khoản. Trả về null nếu không có tài khoản khả dụng (bên gọi dựa vào đây trả về 503).
   * Khi prefer trúng và khả dụng sẽ trả về trực tiếp, hiện thực hóa tính bám dính request ↔ tài khoản.
   */
  pick(options: PickOptions = {}): AccountView | null {
    const now = options.now ?? Date.now();
    const exclude = options.exclude ?? new Set<string>();
    const candidates = this.#accounts
      .listViews()
      .filter((account) => this.#isUsable(account, now) && !exclude.has(account.id));

    if (candidates.length === 0) return null;

    if (options.prefer != null && !exclude.has(options.prefer)) {
      const preferred = candidates.find((account) => account.id === options.prefer);
      if (preferred !== undefined) return preferred;
    }

    // Weighted least-connections: So sánh số kết nối hoạt động trước, sau đó so số lần thất bại liên tiếp, cuối cùng so updated_at để giữ tính ổn định
    return candidates.sort((a, b) => {
      const activeDiff = this.activeCount(a.id) - this.activeCount(b.id);
      if (activeDiff !== 0) return activeDiff;
      const failDiff = a.consecutive_failures - b.consecutive_failures;
      if (failDiff !== 0) return failDiff;
      return a.updated_at - b.updated_at;
    })[0] as AccountView;
  }

  #isUsable(account: AccountView, now: number): boolean {
    if (!SCHEDULABLE_STATUSES.has(account.status)) return false;
    if (account.cooldown_until !== null && account.cooldown_until > now) return false;
    return true;
  }
}
