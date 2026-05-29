/**
 * Minimal async mutex. Used to serialize orchestration runs so the webhook
 * consumer and the safety-net poll never scan/claim the same repo at the same
 * time (which could otherwise dispatch a worker twice before either run labels
 * the issue).
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
