import { EVENT } from '../../domain/events.js';
import { ChannelError, type ChannelRegistry, type Clock, type Consumer, type Logger, type OutboundMessage, type PublicItem, type Store, type Subscription } from '../../ports/index.js';
import type { SubscriptionService } from './subscriptions.js';
import { webhookSecret } from './tokens.js';

const PAGE = 200;
const PARALLEL = 10;

interface Deps {
  store: Store;
  channels: ChannelRegistry;
  subscriptions: SubscriptionService;
  clock: Clock;
  log: Logger;
  baseUrl: string;
  tokenKey: string;
}

/**
 * Tells followers when an announcement is published. Event delivery is at-least-once, so a
 * per-reader ledger (notifications) makes a redelivery skip whoever was already told; a transient
 * failure for any reader makes the whole event retry, a permanent one is recorded and skipped.
 */
export function notifierConsumer(d: Deps): Consumer {
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
    handles: [EVENT.published],
    async handle(event, ctx) {
      const item = await d.store.read.announcements.publicGet(event.aggregateId);
      if (!item) return;
      let after: string | null = null;
      let retries = 0;
      for (;;) {
        const page: Subscription[] = await d.store.read.subscriptions.matching({ issuerId: item.issuerId, jurisdiction: item.jurisdiction, category: item.category }, after, PAGE);
        if (page.length === 0) break;
        after = page[page.length - 1]!.id;
        for (let i = 0; i < page.length; i += PARALLEL) {
          // The reactor stopped waiting: stop sending, or the retry would run alongside this pass. The ledger lets the retry resume.
          if (ctx?.signal.aborted) throw new Error('notifier stopped: timed out, will resume from the ledger');
          const results = await Promise.all(page.slice(i, i + PARALLEL).map((s) => notify(s, item)));
          retries += results.filter((r) => r === 'retry').length;
        }
      }
      if (retries > 0) throw new Error(`${retries} notification(s) failed transiently; will retry the rest`);
    },
  };
}
