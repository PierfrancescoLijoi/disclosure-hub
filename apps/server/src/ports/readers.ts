export type SubscriptionKind = 'email' | 'webhook';
export type SubscriptionStatus = 'pending' | 'active' | 'unsubscribed';

/** A reader following announcements. Everything is optional filtering: null means "any". */
export interface Subscription {
  id: string;
  kind: SubscriptionKind;
  /** An email address or an https webhook URL; replaced by a hash marker when the reader leaves. */
  target: string;
  issuerId: string | null;
  jurisdiction: string | null;
  category: string | null;
  status: SubscriptionStatus;
  createdAt: string;
  confirmedAt: string | null;
}

export interface SubscriptionMatch {
  issuerId: string;
  jurisdiction: string;
  category: string;
}

export interface SubscriptionsStore {
  insert(s: Subscription): Promise<void>;
  get(id: string): Promise<Subscription | null>;
  update(id: string, patch: Partial<Pick<Subscription, 'status' | 'confirmedAt' | 'target'>>): Promise<void>;
  /** Active subscriptions of one reader plus unconfirmed ones created at or after `pendingSince`, to cap abuse. */
  countByTarget(kind: SubscriptionKind, target: string, pendingSince: string): Promise<number>;
  /** Removes unconfirmed subscriptions older than `before`: their confirmation link has expired. */
  deleteExpiredPending(before: string): Promise<void>;
  /** Active subscriptions that follow this announcement, in id order, after `afterId`. */
  matching(m: SubscriptionMatch, afterId: string | null, limit: number): Promise<Subscription[]>;
}

export interface NotificationRecord {
  subscriptionId: string;
  announcementId: string;
  status: 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  at: string;
}

/** The per-recipient ledger that makes at-least-once event delivery safe: one row per reader and announcement. */
export interface NotificationsStore {
  get(subscriptionId: string, announcementId: string): Promise<NotificationRecord | null>;
  record(n: NotificationRecord): Promise<void>;
  /** Clears stored error text for a subscription that was erased: it may quote the address. */
  scrubErrors(subscriptionId: string): Promise<void>;
}

// ------------------------------------------------------------------ channels

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable form for webhooks. */
  data: Record<string, unknown>;
  /** One-click unsubscribe target (RFC 8058) for email, included in the signed body for webhooks. */
  unsubscribeUrl: string;
  /** Signs webhook bodies; absent for email. */
  signingSecret?: string;
}

/** Transient failures are retried, permanent ones (bad address, refused) are recorded and skipped. */
export class ChannelError extends Error {
  constructor(
    readonly kind: 'transient' | 'permanent',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export interface NotificationChannel {
  readonly kind: SubscriptionKind;
  readonly name: string;
  send(msg: OutboundMessage): Promise<void>;
}

export class ChannelRegistry {
  private readonly channels = new Map<SubscriptionKind, NotificationChannel>();
  register(c: NotificationChannel): this {
    this.channels.set(c.kind, c);
    return this;
  }
  get(kind: SubscriptionKind): NotificationChannel | undefined {
    return this.channels.get(kind);
  }
}
