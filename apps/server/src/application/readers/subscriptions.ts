import { createHash, randomUUID } from 'node:crypto';
import { badRequest, DomainError, notFound } from '../../domain/errors.js';
import type { PolicyRegistry } from '../../domain/policy.js';
import { ChannelError, type ChannelRegistry, type Clock, type Logger, type Store, type Subscription, type SubscriptionKind } from '../../ports/index.js';
import { signToken, verifyToken, webhookSecret } from './tokens.js';
import { parseWebhookUrl } from './webhook-url.js';

const CONFIRM_TTL_MS = 48 * 3_600_000;
const MAX_PER_TARGET = 10;
// A bare address only: no display name, angle brackets, commas or semicolons, which a mail library would split into other recipients.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_~-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}$/;

export interface ReaderConfig {
  /** Public address of the site: links in messages point here. */
  baseUrl: string;
  tokenKey: string;
  allowPrivateWebhooks: boolean;
}

export interface FollowInput {
  kind: SubscriptionKind;
  target: string;
  issuerId?: string;
  jurisdiction?: string;
  category?: string;
}

interface Deps {
  store: Store;
  policies: PolicyRegistry;
  channels: ChannelRegistry;
  clock: Clock;
  log: Logger;
  config: ReaderConfig;
}

/** A reader follows companies and topics, confirms the address, and can always leave with one click. */
export class SubscriptionService {
  constructor(private readonly d: Deps) {}

  hasChannel(kind: SubscriptionKind): boolean {
    return this.d.channels.get(kind) !== undefined;
  }

  private unsubscribeToken(subscriptionId: string): string {
    return encodeURIComponent(signToken(this.d.config.tokenKey, 'unsubscribe', subscriptionId));
  }

  /** The page a person opens from the message. */
  unsubscribeUrl(subscriptionId: string): string {
    return `${this.d.config.baseUrl}/public/unsubscribe?token=${this.unsubscribeToken(subscriptionId)}`;
  }

  /** The endpoint a mail client posts to for RFC 8058 one-click unsubscribe (List-Unsubscribe header). */
  oneClickUrl(subscriptionId: string): string {
    return `${this.d.config.baseUrl}/api/public/subscriptions/unsubscribe?token=${this.unsubscribeToken(subscriptionId)}`;
  }

  /**
   * Starts a subscription as pending and sends the confirmation to the address itself, which is
   * what proves the reader controls it. For email the answer never reveals whether the address
   * was already known or over its limit.
   */
  async follow(input: FollowInput): Promise<void> {
    const { store, policies, channels, clock, config } = this.d;
    const channel = channels.get(input.kind);
    if (!channel) throw new DomainError(501, 'CHANNEL_NOT_AVAILABLE', `${input.kind} notifications are not available in this deployment`);

    const target = input.kind === 'email' ? input.target.trim().toLowerCase() : input.target.trim();
    if (input.kind === 'email' ? !EMAIL.test(target) : !parseWebhookUrl(target, config.allowPrivateWebhooks)) {
      throw badRequest('INVALID_TARGET', input.kind === 'email' ? 'That does not look like an email address' : 'A webhook must be an https URL without credentials');
    }
    if (input.issuerId && !(await store.read.issuers.get(input.issuerId))) throw notFound('Company');
    if (input.jurisdiction) {
      const policy = policies.list().find((p) => p.code === input.jurisdiction);
      if (!policy) throw badRequest('UNKNOWN_JURISDICTION', 'Unknown jurisdiction');
      if (input.category && !policy.hasCategory(input.category)) throw badRequest('UNKNOWN_CATEGORY', 'Unknown category for that jurisdiction');
    } else if (input.category) {
      throw badRequest('CATEGORY_NEEDS_JURISDICTION', 'Choose a jurisdiction to follow one of its categories');
    }

    const now = clock.now();
    // Unconfirmed rows count only while their link still works, so nobody can fill an address's quota for good.
    const pendingSince = new Date(now.getTime() - CONFIRM_TTL_MS).toISOString();
    await store.read.subscriptions.deleteExpiredPending(pendingSince);
    if ((await store.read.subscriptions.countByTarget(input.kind, target, pendingSince)) >= MAX_PER_TARGET) {
      this.d.log.warn({ kind: input.kind }, 'subscription limit reached for a reader; ignored');
      return;
    }
    const sub: Subscription = {
      id: randomUUID(),
      kind: input.kind,
      target,
      issuerId: input.issuerId ?? null,
      jurisdiction: input.jurisdiction ?? null,
      category: input.category ?? null,
      status: 'pending',
      createdAt: now.toISOString(),
      confirmedAt: null,
    };
    await store.read.subscriptions.insert(sub);

    const token = signToken(config.tokenKey, 'confirm', sub.id, now.getTime() + CONFIRM_TTL_MS);
    const confirmUrl = `${config.baseUrl}/public/confirm?token=${encodeURIComponent(token)}`;
    const signingSecret = input.kind === 'webhook' ? webhookSecret(config.tokenKey, sub.id) : undefined;
    try {
      await channel.send({
        to: target,
        subject: 'Confirm your subscription to regulatory announcements',
        text: `Someone asked to send regulatory announcements to this address.\nConfirm: ${confirmUrl}\nThe link works for 48 hours. If it was not you, ignore this message and nothing will be sent.`,
        // The secret travels only here, to the endpoint that is being confirmed: it is what the receiver verifies x-hub-signature with.
        data: { type: 'subscription.confirm', subscriptionId: sub.id, token, confirmUrl, filters: this.filters(sub), ...(signingSecret && { signingSecret }) },
        unsubscribeUrl: this.oneClickUrl(sub.id),
        signingSecret,
      });
    } catch (err) {
      await this.erase(sub);
      // The detail stays in the log: it can name internal hosts or quote the address, and this route is anonymous.
      this.d.log.warn({ kind: input.kind, permanent: err instanceof ChannelError && err.kind === 'permanent' }, 'confirmation could not be delivered');
      if (input.kind === 'webhook') throw badRequest('WEBHOOK_UNREACHABLE', 'The endpoint did not accept the confirmation; check the address and try again');
    }
  }

  async confirm(token: string): Promise<{ kind: SubscriptionKind; filters: Record<string, string | null>; issuerName: string | null }> {
    const id = verifyToken(this.d.config.tokenKey, 'confirm', token, this.d.clock.now().getTime());
    const sub = id ? await this.d.store.read.subscriptions.get(id) : null;
    if (!sub) throw badRequest('INVALID_TOKEN', 'This confirmation link is invalid or has expired');
    if (sub.status === 'unsubscribed') throw new DomainError(410, 'SUBSCRIPTION_GONE', 'This subscription was cancelled');
    if (sub.status === 'pending') {
      await this.d.store.read.subscriptions.update(sub.id, { status: 'active', confirmedAt: this.d.clock.now().toISOString() });
    }
    const issuer = sub.issuerId ? await this.d.store.read.issuers.get(sub.issuerId) : null;
    return { kind: sub.kind, filters: this.filters(sub), issuerName: issuer?.name ?? null };
  }

  /** Idempotent and silent about unknown links: leaving must always look like it worked. */
  async unsubscribe(token: string): Promise<void> {
    const id = verifyToken(this.d.config.tokenKey, 'unsubscribe', token, this.d.clock.now().getTime());
    if (!id) throw badRequest('INVALID_TOKEN', 'This unsubscribe link is invalid');
    const sub = await this.d.store.read.subscriptions.get(id);
    if (sub && sub.status !== 'unsubscribed') await this.erase(sub);
  }

  /** The address is personal data: once a reader leaves, only an irreversible marker stays. */
  private async erase(sub: Subscription): Promise<void> {
    const marker = `erased:${createHash('sha256').update(sub.target).digest('hex').slice(0, 16)}`;
    await this.d.store.read.subscriptions.update(sub.id, { status: 'unsubscribed', target: marker });
    await this.d.store.read.notifications.scrubErrors(sub.id); // a transport error can quote the address
  }

  private filters(s: Subscription): Record<string, string | null> {
    return { issuerId: s.issuerId, jurisdiction: s.jurisdiction, category: s.category };
  }
}
