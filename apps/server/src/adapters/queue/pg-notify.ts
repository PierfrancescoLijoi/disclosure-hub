import type { Pool, PoolClient } from 'pg';
import type { JobQueue } from '../../ports/index.js';
import { InProcessQueue } from './in-process.js';

const CHANNEL = 'hub_publications';
const RECONNECT_MS = 2_000;

/**
 * Production queue for a small deployment: PostgreSQL LISTEN/NOTIFY, no extra service to run,
 * secure or pay for. It only has to say "look at this publication id": the row in the database is
 * the source of truth, and the sweeper recovers anything a notification missed (a worker that was
 * restarting, a dropped connection, a delayed retry whose timer died with its process).
 *
 * Every listening worker hears every notification and tries the same lease claim, so exactly one
 * wins and the rest see 'skipped'. That is wasted work proportional to the number of workers, which
 * is fine for the handful a small deployment runs. Past that, use the Redis queue.
 */
export class PgNotifyQueue implements JobQueue {
  private readonly local: InProcessQueue;
  private readonly timers = new Set<NodeJS.Timeout>();
  private listener: PoolClient | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly opts: { concurrency: number; onError: (err: unknown, id?: string) => void },
  ) {
    this.local = new InProcessQueue(opts.concurrency, opts.onError);
  }

  async enqueue(id: string, opts?: { delayMs?: number }): Promise<void> {
    const delay = opts?.delayMs ?? 0;
    if (delay <= 0) return this.notify(id);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.notify(id).catch((err) => this.opts.onError(err, id));
    }, delay);
    t.unref();
    this.timers.add(t);
  }

  async start(handler: (id: string) => Promise<void>): Promise<void> {
    await this.local.start(handler);
    await this.listen();
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.reconnect) clearTimeout(this.reconnect);
    const client = this.listener;
    this.listener = undefined;
    if (client) {
      await client.query('UNLISTEN *').catch(() => undefined);
      client.release();
    }
    await this.local.close();
  }

  private async notify(id: string): Promise<void> {
    await this.pool.query('select pg_notify($1, $2)', [CHANNEL, id]);
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      client.on('notification', (m) => {
        if (m.channel === CHANNEL && m.payload) void this.local.enqueue(m.payload);
      });
      const lost = (err?: Error) => {
        if (this.listener !== client) return;
        this.listener = undefined;
        client?.release(err ?? true); // a truthy argument discards the connection instead of pooling it
        if (err) this.opts.onError(err);
        this.scheduleReconnect();
      };
      client.on('error', lost);
      client.on('end', () => lost());
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
    } catch (err) {
      client?.release(true);
      this.opts.onError(err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.listen();
    }, RECONNECT_MS);
    this.reconnect.unref();
  }
}
