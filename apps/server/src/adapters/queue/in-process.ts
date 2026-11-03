import type { JobQueue } from '../../ports/index.js';

/**
 * Local-mode queue: a bounded-concurrency pump plus timers for delays. It is only a wake-up
 * mechanism; durability comes from the publications table and the sweeper.
 */
export class InProcessQueue implements JobQueue {
  private handler: ((id: string) => Promise<void>) | undefined;
  private readonly ready: string[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private running = 0;

  constructor(
    private readonly concurrency = 4,
    private readonly onError: (err: unknown, id: string) => void = (err, id) => console.error('job failed', id, err),
  ) {}

  async enqueue(id: string, opts?: { delayMs?: number }): Promise<void> {
    const delay = opts?.delayMs ?? 0;
    if (delay <= 0) return this.push(id);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.push(id);
    }, delay);
    t.unref();
    this.timers.add(t);
  }

  async start(handler: (id: string) => Promise<void>): Promise<void> {
    this.handler = handler;
    this.pump();
  }

  /** Resolves when nothing is queued, delayed or running. Used by tests and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.ready.length || this.timers.size || this.running) await new Promise((r) => setTimeout(r, 5));
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ready.length = 0;
    while (this.running) await new Promise((r) => setTimeout(r, 5));
    this.handler = undefined;
  }

  private push(id: string): void {
    this.ready.push(id);
    this.pump();
  }

  private pump(): void {
    while (this.handler && this.running < this.concurrency && this.ready.length) {
      const id = this.ready.shift()!;
      this.running++;
      this.handler(id)
        .catch((err) => this.onError(err, id))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
