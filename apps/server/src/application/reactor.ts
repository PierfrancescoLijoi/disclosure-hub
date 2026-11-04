import { randomUUID } from 'node:crypto';
import type { DomainEvent, NewEvent } from '../domain/events.js';
import type { ClaimedDelivery, Clock, ConsumerRegistry, Logger, StoreTx, Store } from '../ports/index.js';

/**
 * Writes events into the caller's transaction, with one delivery per interested consumer.
 * Every process builds the full registry (an API that only writes events still has to know who
 * wants them); which consumers a process actually runs is the reactor's business.
 */
export class EventBus {
  constructor(
    private readonly consumers: ConsumerRegistry,
    private readonly clock: Clock,
  ) {}

  /** `id` makes the write idempotent: a second emit with the same id fails on the primary key instead of duplicating. */
  async emit(tx: StoreTx, e: NewEvent, at = this.clock.now().toISOString(), id: string = randomUUID()): Promise<DomainEvent> {
    const event: DomainEvent = { ...e, id, at };
    await tx.events.insert(event, this.consumers.idsFor(e.type), at);
    return event;
  }
}

export interface ReactorConfig {
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  batch: number;
  /** Consumer ids this process runs; undefined runs all of them. */
  only?: string[];
}

interface Deps {
  store: Store;
  consumers: ConsumerRegistry;
  clock: Clock;
  log: Logger;
  config: ReactorConfig;
  random?: () => number;
}

const TIMEOUT_ERROR = 'consumer timed out';

/** Dead at once, whatever the attempt count says. */
class GiveUp extends Error {}

/**
 * Runs consumers against due deliveries: lease, handle, complete or back off. The delivery row
 * is the truth; this loop is only a poller, so a crash loses nothing and a second instance
 * simply claims other rows.
 */
export class Reactor {
  constructor(private readonly d: Deps) {}

  private ids(): string[] {
    const all = this.d.consumers.list().map((c) => c.id);
    const only = this.d.config.only;
    return only ? all.filter((id) => only.includes(id)) : all;
  }

  /**
   * One pass over what is due; returns how many deliveries were handled (success or failure).
   * The batch runs in parallel so every handler starts inside the lease taken for the whole batch.
   */
  async tick(): Promise<number> {
    const { store, clock, config } = this.d;
    const token = randomUUID();
    const claimed = await store.read.events.claim(this.ids(), clock.now().toISOString(), config.leaseMs, token, config.batch);
    await Promise.all(claimed.map((delivery) => this.handle(delivery, token)));
    return claimed.length;
  }

  private async handle(delivery: ClaimedDelivery, token: string): Promise<void> {
    const { store, clock, config, log } = this.d;
    const consumer = this.d.consumers.get(delivery.consumer);
    const abort = new AbortController();
    try {
      // Claiming counts an attempt, so a delivery that keeps killing the process shows up here as over the limit.
      if (delivery.attempts > config.maxAttempts) throw new GiveUp('gave up: attempts exhausted, the process may have crashed while handling it');
      if (!consumer) throw new Error(`no consumer "${delivery.consumer}" in this process`);
      await withTimeout(consumer.handle(delivery.event, { signal: abort.signal }), config.leaseMs / 2, abort);
    } catch (err) {
      const dead = err instanceof GiveUp || delivery.attempts >= config.maxAttempts;
      const message = (err as Error).message ?? String(err);
      log.warn({ consumer: delivery.consumer, eventId: delivery.event.id, attempts: delivery.attempts, dead, err: message }, 'event delivery failed');
      const now = clock.now();
      const held = await store.read.events.fail(
        delivery.id,
        token,
        { error: message, dead, nextAttemptAt: new Date(now.getTime() + this.backoffMs(delivery.attempts)).toISOString() },
        now.toISOString(),
      );
      if (!held) log.warn({ consumer: delivery.consumer, eventId: delivery.event.id }, 'delivery lease was lost before the failure was recorded');
      return;
    }
    // Outside the try: a failed bookkeeping write must not be recorded as the handler failing.
    const held = await store.read.events.complete(delivery.id, token, clock.now().toISOString());
    if (!held) log.warn({ consumer: delivery.consumer, eventId: delivery.event.id }, 'delivery lease was lost before completion; another worker may have handled it too');
  }

  /** Runs passes until nothing is due: events that cause events (agent chains) settle in one call. */
  async drain(maxPasses = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxPasses; i++) {
      const n = await this.tick();
      if (n === 0) break;
      total += n;
    }
    return total;
  }

  private backoffMs(attempt: number): number {
    const { retryBaseMs, retryMaxMs } = this.d.config;
    const jitter = 0.8 + (this.d.random ?? Math.random)() * 0.4;
    return Math.round(Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)) * jitter);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, abort: AbortController): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(TIMEOUT_ERROR));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
