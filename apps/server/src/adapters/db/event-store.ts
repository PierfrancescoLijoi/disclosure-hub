import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../../domain/events.js';
import type { ClaimedDelivery, DeliveryStatus, EventsStore } from '../../ports/events.js';
import type { DB } from './schema.js';

const toEvent = (r: { id: string; type: string; issuer_id: string; aggregate_id: string; payload: string; created_at: string }): DomainEvent => ({
  id: r.id,
  type: r.type,
  issuerId: r.issuer_id,
  aggregateId: r.aggregate_id,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  at: r.created_at,
});

/** Outbox and leased deliveries, same compare-and-set pattern as publications. */
export function buildEventsStore(db: Kysely<DB>): EventsStore {
  return {
    async insert(event, consumers, at) {
      await db
        .insertInto('domain_events')
        .values({
          id: event.id,
          type: event.type,
          issuer_id: event.issuerId,
          aggregate_id: event.aggregateId,
          payload: JSON.stringify(event.payload),
          created_at: event.at,
        })
        .execute();
      if (consumers.length === 0) return;
      await db
        .insertInto('event_deliveries')
        .values(
          consumers.map((consumer) => ({
            id: randomUUID(),
            event_id: event.id,
            consumer,
            status: 'pending',
            attempts: 0,
            next_attempt_at: at,
            lease_until: null,
            lease_token: null,
            last_error: null,
            updated_at: at,
          })),
        )
        .execute();
    },

    async claim(consumers, now, leaseMs, token, limit) {
      if (consumers.length === 0) return [];
      const due = (eb: import('kysely').ExpressionBuilder<DB, 'event_deliveries'>) =>
        eb.or([
          eb.and([eb('status', '=', 'pending'), eb('next_attempt_at', '<=', now)]),
          eb.and([eb('status', '=', 'in_flight'), eb('lease_until', '<', now)]),
        ]);
      const candidates = await db
        .selectFrom('event_deliveries')
        .select('id')
        .where('consumer', 'in', consumers)
        .where(due)
        .orderBy('next_attempt_at')
        .limit(limit)
        .execute();
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const claimed: ClaimedDelivery[] = [];
      for (const { id } of candidates) {
        const res = await db
          .updateTable('event_deliveries')
          .set({ status: 'in_flight', lease_token: token, lease_until: leaseUntil, attempts: sql<number>`attempts + 1`, updated_at: now })
          .where('id', '=', id)
          .where(due)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) continue;
        const row = await db
          .selectFrom('event_deliveries')
          .innerJoin('domain_events', 'domain_events.id', 'event_deliveries.event_id')
          .select(['event_deliveries.id as delivery_id', 'event_deliveries.consumer', 'event_deliveries.attempts', 'domain_events.id', 'domain_events.type', 'domain_events.issuer_id', 'domain_events.aggregate_id', 'domain_events.payload', 'domain_events.created_at'])
          .where('event_deliveries.id', '=', id)
          .executeTakeFirstOrThrow();
        claimed.push({ id: row.delivery_id, consumer: row.consumer, attempts: row.attempts, event: toEvent(row) });
      }
      return claimed;
    },

    async complete(id, token, at) {
      const res = await db
        .updateTable('event_deliveries')
        .set({ status: 'done', lease_token: null, lease_until: null, last_error: null, updated_at: at })
        .where('id', '=', id)
        .where('lease_token', '=', token)
        .where('status', '=', 'in_flight')
        .executeTakeFirst();
      return Number(res.numUpdatedRows) === 1;
    },

    async fail(id, token, patch, at) {
      const res = await db
        .updateTable('event_deliveries')
        .set({
          status: patch.dead ? 'dead' : 'pending',
          next_attempt_at: patch.nextAttemptAt,
          last_error: patch.error.slice(0, 500),
          lease_token: null,
          lease_until: null,
          updated_at: at,
        })
        .where('id', '=', id)
        .where('lease_token', '=', token)
        .where('status', '=', 'in_flight')
        .executeTakeFirst();
      return Number(res.numUpdatedRows) === 1;
    },

    async forAggregate(aggregateId) {
      const rows = await db
        .selectFrom('event_deliveries')
        .innerJoin('domain_events', 'domain_events.id', 'event_deliveries.event_id')
        .select(['event_deliveries.consumer', 'event_deliveries.status', 'event_deliveries.attempts', 'event_deliveries.last_error', 'domain_events.id', 'domain_events.type', 'domain_events.issuer_id', 'domain_events.aggregate_id', 'domain_events.payload', 'domain_events.created_at'])
        .where('domain_events.aggregate_id', '=', aggregateId)
        .orderBy('domain_events.created_at')
        .orderBy('event_deliveries.consumer')
        .execute();
      return rows.map((r) => ({ event: toEvent(r), consumer: r.consumer, status: r.status as DeliveryStatus, attempts: r.attempts, lastError: r.last_error }));
    },
  };
}
