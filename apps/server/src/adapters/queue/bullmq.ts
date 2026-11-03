import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobQueue } from '../../ports/index.js';

const QUEUE_NAME = 'publications';

/** Compose-mode queue. Same contract as the in-process one; Redis only carries the wake-up. */
export class BullMqQueue implements JobQueue {
  private readonly producer: Redis;
  private readonly queue: Queue;
  private worker: Worker | undefined;
  private workerConnection: Redis | undefined;

  constructor(
    private readonly url: string,
    private readonly opts: { concurrency: number; onError: (err: unknown, id?: string) => void },
  ) {
    this.producer = new Redis(url, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, { connection: this.producer });
  }

  async enqueue(id: string, opts?: { delayMs?: number }): Promise<void> {
    await this.queue.add(
      'publish',
      { publicationId: id },
      { delay: opts?.delayMs, removeOnComplete: true, removeOnFail: { age: 86_400 }, attempts: 1 },
    );
  }

  async start(handler: (id: string) => Promise<void>): Promise<void> {
    // BullMQ workers need their own blocking connection.
    this.workerConnection = new Redis(this.url, { maxRetriesPerRequest: null });
    this.worker = new Worker(QUEUE_NAME, async (job) => handler((job.data as { publicationId: string }).publicationId), {
      connection: this.workerConnection,
      concurrency: this.opts.concurrency,
    });
    this.worker.on('failed', (job, err) => this.opts.onError(err, job?.data?.publicationId));
    this.worker.on('error', (err) => this.opts.onError(err));
    await this.worker.waitUntilReady();
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.workerConnection?.disconnect();
    this.producer.disconnect();
  }
}
