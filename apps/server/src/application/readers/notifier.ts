import { EVENT } from '../../domain/events.js';
import { ChannelError, type ChannelRegistry, type Clock, type Consumer, type Logger, type OutboundMessage, type PublicItem, type Store, type Subscription } from '../../ports/index.js';
import type { EventBus } from '../reactor.js';
import type { SubscriptionService } from './subscriptions.js';
import { webhookSecret } from './tokens.js';

const PAGE = 200;
const PARALLEL = 10;
/** Followers one delivery handles before it hands the rest to a continuation, so a delivery stays well inside its lease and a big audience never ends up dead. */
const CHUNK = 1000;

interface Deps {
  store: Store;
  events: EventBus;
  channels: ChannelRegistry;
  subscriptions: SubscriptionService;
  clock: Clock;
  log: Logger;
  baseUrl: string;
  tokenKey: string;
  /** Followers per delivery; tests lower it. */
  chunk?: number;
  /** Wall-clock time one delivery may spend before it hands the rest on, so a slow channel never runs into the lease. */
  budgetMs?: number;
}

const isDuplicateKey = (err: unknown) => /unique|duplicate|constraint/i.test((err as Error)?.message ?? '');

/**
 * Tells followers when an announcement is published. Event delivery is at-least-once, so a
 * per-reader ledger (notifications) makes a redelivery skip whoever was already told; a transient
 * failure for any reader makes the delivery retry, a permanent one is recorded and skipped.
 *
 * One delivery handles one chunk of followers (in id order) and then writes a continuation event
 * carrying the last id it reached. The chain is sequential, so throughput is the send rate of one
 * consumer (PARALLEL sends at a time); past that, split the audience over a queue (docs/MODULES.md).
 */
export function notifierConsumer(d: Deps): Consumer {
  const chunk = d.chunk ?? CHUNK;
  const budgetMs = d.budgetMs ?? 15_000;
  const message = (s: Subscription, item: PublicItem): OutboundMessage => {
    const url = `${d.baseUrl}/public/announcements/${item.id}`;
    const unsubscribeUrl = d.subscriptions.oneClickUrl(s.id);
    const unsubscribePage = d.subscriptions.unsubscribeUrl(s.id);
    return {
      to: s.target,
      subject: `${item.issuerName}: ${item.headline}`,
      text: `${item.issuerName} published a regulatory announcement (${item.receipt}).\n\n${item.headline}\n\n${item.excerpt}\n\nRead it: ${url}\n\nStop receiving these: ${unsubscribePage}`,
      data: {
        type: 'announcement.published',
        unsubscribePage,
        announcement: { id: item.id, company: item.issuerName, jurisdiction: item.jurisdiction, category: item.category, headline: item.headline, receipt: item.receipt, publishedAt: item.publishedAt, url },
      },
      unsubscribeUrl,
      signingSecret: s.kind === 'webhook' ? webhookSecret(d.tokenKey, s.id) : undefined,
    };
  };

  async function notify(s: Subscription, item: PublicItem): Promise<'sent' | 'failed' | 'retry' | 'skipped'> {
    if (await d.store.read.notifications.get(s.id, item.id)) return 'skipped';
    const channel = d.channels.get(s.kind);
    const at = () => d.clock.now().toISOString();
    try {
      if (!channel) throw new ChannelError('permanent', `no ${s.kind} channel in this deployment`);
      await channel.send(message(s, item));
      await d.store.read.notifications.record({ subscriptionId: s.id, announcementId: item.id, status: 'sent', attempts: 1, lastError: null, at: at() });
      return 'sent';
    } catch (err) {
      if (err instanceof ChannelError && err.kind === 'transient') return 'retry';
      await d.store.read.notifications.record({ subscriptionId: s.id, announcementId: item.id, status: 'failed', attempts: 1, lastError: (err as Error).message.slice(0, 300), at: at() });
      return 'failed';
    }
  }

  return {
    id: 'notifier',
    handles: [EVENT.published, EVENT.notifyContinue],
    async handle(event, ctx) {
      const item = await d.store.read.announcements.publicGet(event.aggregateId);
      if (!item) return;
      // A continuation carries where the previous chunk stopped; the first delivery starts from the beginning.
      let after: string | null = typeof event.payload.after === 'string' ? event.payload.after : null;
      let handled = 0;
      let retries = 0;
      let more = false;
      const startedAt = Date.now();
      while (!more) {
        const page: Subscription[] = await d.store.read.subscriptions.matching({ issuerId: item.issuerId, jurisdiction: item.jurisdiction, category: item.category }, after, Math.min(PAGE, chunk - handled));
        if (page.length === 0) break;
        for (let i = 0; i < page.length; i += PARALLEL) {
          // The reactor stopped waiting: stop sending, or the retry would run alongside this pass. The ledger lets the retry resume.
          if (ctx?.signal.aborted) throw new Error('notifier stopped: timed out, will resume from the ledger');
          const results = await Promise.all(page.slice(i, i + PARALLEL).map((s) => notify(s, item)));
          retries += results.filter((r) => r === 'retry').length;
        }
        after = page[page.length - 1]!.id;
        handled += page.length;
        more = handled >= chunk || Date.now() - startedAt > budgetMs;
      }
      if (ctx?.signal.aborted) throw new Error('notifier stopped: timed out, will resume from the ledger');
      // The chunk is full (or out of time): there may be more followers. Ask for the next chunk instead of holding this
      // delivery. Done before a retry is raised, so one follower that keeps failing never blocks the audience behind it,
      // and with an id taken from where the chunk ended, so a redelivered chunk cannot start a second chain.
      if (more) {
        try {
          await d.store.tx((tx) =>
            d.events.emit(tx, { type: EVENT.notifyContinue, issuerId: event.issuerId, aggregateId: event.aggregateId, payload: { after } }, undefined, `${EVENT.notifyContinue}:${event.aggregateId}:${after}`),
          );
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
        }
      }
      if (retries > 0) throw new Error(`${retries} notification(s) failed transiently; will retry the rest`);
    },
  };
}
