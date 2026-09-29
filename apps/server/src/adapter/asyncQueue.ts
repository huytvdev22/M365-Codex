/**
 * Hàng đợi bất đồng bộ đơn nhà sản xuất / đơn người tiêu dùng (Single-producer / single-consumer).
 *
 * Dùng để cầu nối WebSocket hướng sự kiện (callback 'message') thành duyệt async dạng kéo (pull-based):
 * Producer đẩy (push) sự kiện, consumer chờ (await) next(). Hỗ trợ kết thúc bình thường và kết thúc bất thường.
 */
export class AsyncQueue<T> {
  readonly #items: T[] = [];
  #waiting: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | null =
    null;
  #ended = false;
  #error: unknown = null;

  push(item: T): void {
    if (this.#ended) return;
    if (this.#waiting !== null) {
      const waiter = this.#waiting;
      this.#waiting = null;
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  /** Kết thúc bình thường: Consumer sau khi lấy hết các mục còn lại sẽ nhận được done. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#waiting !== null && this.#items.length === 0) {
      const waiter = this.#waiting;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** Kết thúc bất thường: Consumer sau khi lấy hết các mục còn lại sẽ nhận được reject. */
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    if (this.#waiting !== null && this.#items.length === 0) {
      const waiter = this.#waiting;
      this.#waiting = null;
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      const value = this.#items.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.#ended) {
      // this.#error là lỗi upstream bất kỳ (có thể không phải instance của Error), bọc async để truyền nguyên bản
      if (this.#error !== null) return this.#rejected();
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  // Dùng hàm async để throw thay vì Promise.reject nhằm truyền nguyên vẹn nguyên nhân lỗi upstream không phải Error
  async #rejected(): Promise<IteratorResult<T>> {
    throw this.#error;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const result = await this.next();
      if (result.done === true) return;
      yield result.value;
    }
  }
}
