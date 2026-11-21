/** A counting semaphore for bounding concurrent async work. */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1)
      throw new RangeError('permits must be a positive integer');
    this.available = permits;
  }

  /** Resolves once a permit is held; call {@link release} afterwards. */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Returns a permit (hands it to the oldest waiter, if any). */
  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) this.available += 1;
    else next();
  }
}

/**
 * Runs tasks sharing a key one after the other, in submission order, while
 * tasks of different keys run concurrently.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Schedules `task` after the previous task of `key`; resolves with its result. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return current;
  }

  /** `true` while `key` has a queued or running task. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }

  /** Keys with queued or running tasks. */
  get size(): number {
    return this.tails.size;
  }
}
