/** Unbounded single-consumer async queue. `close()` ends iteration; `fail()` rejects it. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private closed = false;
  private error: unknown = undefined;

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): boolean {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined as never, done: true });
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.error = err ?? new Error("queue failed");
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(this.error);
  }

  /** Remove and return everything still buffered (used for fallbacks). */
  drain(): T[] {
    return this.items.splice(0);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}

/** Counting semaphore with abort support. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private permits: number) {}

  async acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.permits > 0) {
      this.permits--;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits++;
  }
}
