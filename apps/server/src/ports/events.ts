import type { DomainEvent } from '../domain/events.js';

/**
 * Something that reacts to events. Delivery is at-least-once, one delivery per event and
 * consumer, retried with backoff, so `handle` must be idempotent. Throwing means "retry".
 */
export interface Consumer {
  readonly id: string;
  readonly handles: readonly string[];
  /** `signal` aborts when the reactor gives up waiting: a consumer that loops should stop and throw, it will be retried. */
  handle(event: DomainEvent, ctx?: { signal: AbortSignal }): Promise<void>;
}

export class ConsumerRegistry {
  private readonly consumers = new Map<string, Consumer>();

  register(c: Consumer): this {
    if (this.consumers.has(c.id)) throw new Error(`Consumer "${c.id}" is already registered`);
    this.consumers.set(c.id, c);
    return this;
  }

  get(id: string): Consumer | undefined {
    return this.consumers.get(id);
  }

  list(): Consumer[] {
    return [...this.consumers.values()];
  }

  /** Ids of the consumers that want this event type: the fan-out decided when the event is written. */
  idsFor(type: string): string[] {
    return this.list().filter((c) => c.handles.includes(type)).map((c) => c.id);
  }
}

export type DeliveryStatus = 'pending' | 'in_flight' | 'done' | 'dead';

export interface ClaimedDelivery {
  id: string;
  consumer: string;
  attempts: number;
  event: DomainEvent;
}

export interface EventsStore {
  /** Writes the event and one pending delivery per consumer; call inside the transaction that caused it. */
  insert(event: DomainEvent, consumers: string[], at: string): Promise<void>;
  /** Compare-and-set leases on due deliveries (pending and due, or in flight with an expired lease). */
  claim(consumers: string[], now: string, leaseMs: number, token: string, limit: number): Promise<ClaimedDelivery[]>;
  /** Only the current lease holder may finish; false when the lease was lost. */
  complete(id: string, token: string, at: string): Promise<boolean>;
  fail(id: string, token: string, patch: { error: string; nextAttemptAt: string; dead: boolean }, at: string): Promise<boolean>;
  /** Deletes finished deliveries older than `before`, then events no delivery refers to any more; dead and waiting ones stay. At most `limit` rows per table. */
  prune(before: string, limit: number): Promise<{ deliveries: number; events: number }>;
  forAggregate(aggregateId: string): Promise<{ event: DomainEvent; consumer: string; status: DeliveryStatus; attempts: number; lastError: string | null }[]>;
}

export interface EventStats {
  pendingDeliveries: number;
  deadDeliveries: number;
  /** Age in seconds of the oldest delivery waiting for a consumer; 0 when none waits. */
  oldestPendingSeconds: number;
}
