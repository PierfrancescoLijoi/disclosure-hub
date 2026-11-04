import type { Kysely, Selectable } from 'kysely';
import type { NotificationsStore, Subscription, SubscriptionKind, SubscriptionStatus, SubscriptionsStore } from '../../ports/readers.js';
import type { DB } from './schema.js';

const toSubscription = (r: Selectable<DB['subscriptions']>): Subscription => ({
  id: r.id,
  kind: r.kind as SubscriptionKind,
  target: r.target,
  issuerId: r.issuer_id,
  jurisdiction: r.jurisdiction,
  category: r.category,
  status: r.status as SubscriptionStatus,
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
});

export function buildSubscriptionsStore(db: Kysely<DB>): SubscriptionsStore {
  return {
    async insert(s) {
      await db
        .insertInto('subscriptions')
        .values({
          id: s.id,
          kind: s.kind,
          target: s.target,
          issuer_id: s.issuerId,
          jurisdiction: s.jurisdiction,
          category: s.category,
          status: s.status,
          created_at: s.createdAt,
          confirmed_at: s.confirmedAt,
        })
        .execute();
    },

    async get(id) {
      const r = await db.selectFrom('subscriptions').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? toSubscription(r) : null;
    },

    async update(id, patch) {
      await db
        .updateTable('subscriptions')
        .set({
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.confirmedAt !== undefined && { confirmed_at: patch.confirmedAt }),
          ...(patch.target !== undefined && { target: patch.target }),
        })
        .where('id', '=', id)
        .execute();
    },

    async countByTarget(kind, target, pendingSince) {
      const r = await db
        .selectFrom('subscriptions')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('kind', '=', kind)
        .where('target', '=', target)
        .where((eb) => eb.or([eb('status', '=', 'active'), eb.and([eb('status', '=', 'pending'), eb('created_at', '>=', pendingSince)])]))
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    },

    async deleteExpiredPending(before) {
      await db.deleteFrom('subscriptions').where('status', '=', 'pending').where('created_at', '<', before).execute();
    },

    async matching(m, afterId, limit) {
      let q = db
        .selectFrom('subscriptions')
        .selectAll()
        .where('status', '=', 'active')
        .where((eb) => eb.or([eb('issuer_id', 'is', null), eb('issuer_id', '=', m.issuerId)]))
        .where((eb) => eb.or([eb('jurisdiction', 'is', null), eb('jurisdiction', '=', m.jurisdiction)]))
        .where((eb) => eb.or([eb('category', 'is', null), eb('category', '=', m.category)]));
      if (afterId) q = q.where('id', '>', afterId);
      const rows = await q.orderBy('id').limit(limit).execute();
      return rows.map(toSubscription);
    },
  };
}

export function buildNotificationsStore(db: Kysely<DB>): NotificationsStore {
  return {
    async get(subscriptionId, announcementId) {
      const r = await db
        .selectFrom('notifications')
        .selectAll()
        .where('subscription_id', '=', subscriptionId)
        .where('announcement_id', '=', announcementId)
        .executeTakeFirst();
      return r
        ? { subscriptionId: r.subscription_id, announcementId: r.announcement_id, status: r.status as 'sent' | 'failed', attempts: r.attempts, lastError: r.last_error, at: r.at }
        : null;
    },
    async record(n) {
      await db
        .insertInto('notifications')
        .values({ subscription_id: n.subscriptionId, announcement_id: n.announcementId, status: n.status, attempts: n.attempts, last_error: n.lastError, at: n.at })
        .onConflict((oc) => oc.columns(['subscription_id', 'announcement_id']).doUpdateSet({ status: n.status, attempts: n.attempts, last_error: n.lastError, at: n.at }))
        .execute();
    },
    async scrubErrors(subscriptionId) {
      await db.updateTable('notifications').set({ last_error: null }).where('subscription_id', '=', subscriptionId).execute();
    },
  };
}
