import type {
  Announcement,
  Approval,
  AuditEvent,
  DistributionPayload,
  Issuer,
  Actor,
  Publication,
  PublicationStatus,
  Revision,
  Status,
  ValidationReport,
} from '../domain/types.js';
import type { EventsStore, EventStats } from './events.js';
import type { NotificationsStore, SubscriptionsStore } from './readers.js';

export * from './events.js';
export * from './readers.js';

export interface Clock {
  now(): Date;
}

/** Subset of pino's API, so Fastify's logger can be passed straight in. */
export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

// ---------------------------------------------------------------- persistence

export interface ListQuery {
  status?: Status;
  jurisdiction?: string;
  limit: number;
  cursor?: string;
}

/** List rows carry the current headline so the UI needs no second query per row. */
export type ListItem = Announcement & {
  headline: string;
  /** A reviewer asked for changes to the current revision (it came back to the author as a draft). */
  changesRequested: boolean;
};

/** What a stranger may read about a published announcement: no people, no approvals, no metadata. */
export interface PublicItem {
  id: string;
  issuerId: string;
  jurisdiction: string;
  category: string;
  headline: string;
  /** The first words of the body, for lists, feeds and notifications. */
  excerpt: string;
  issuerName: string;
  receipt: string;
  filingDate: string | null;
  publishedAt: string;
}
export type PublicDetail = PublicItem & { body: string };
export interface PublicQuery {
  issuerId?: string;
  jurisdiction?: string;
  category?: string;
  /** Inclusive publication dates, YYYY-MM-DD (UTC). */
  from?: string;
  to?: string;
  /** Words matched against headline, body and company name. */
  q?: string;
  limit: number;
  cursor?: string;
}

/** One row of a company's publication console. */
export interface PublicationJob {
  id: string;
  announcementId: string;
  jurisdiction: string;
  headline: string;
  revision: number;
  status: PublicationStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One line of a company's activity stream. */
export interface ActivityEvent {
  announcementId: string;
  headline: string;
  jurisdiction: string;
  type: string;
  actorId: string;
  at: string;
  revision: number | null;
}

export type AnnouncementPatch = Partial<
  Pick<Announcement, 'status' | 'currentRevision' | 'approvalRequirement' | 'failureReason'>
>;

export interface AuditInput {
  announcementId: string;
  issuerId: string;
  type: string;
  actorId: string;
  data: Record<string, unknown>;
}

export interface PublicationPatch {
  status?: PublicationStatus;
  attempts?: number;
  nextAttemptAt?: string;
  lastError?: string | null;
  externalRef?: string | null;
  ack?: Record<string, unknown> | null;
}

export interface AiReportRecord {
  id: string;
  announcementId: string;
  revision: number;
  provider: string;
  report: unknown;
  at: string;
  /** Which agent wrote it ('precheck' for the on-demand button). */
  agent: string;
  /** The event that triggered it; a redelivered event writes one report. */
  eventId: string | null;
}

/** Every method that touches tenant data takes issuerId and filters on it in the query. */
export interface StoreTx {
  users: {
    get(id: string): Promise<Actor | null>;
    list(): Promise<Actor[]>;
    /** Names for one company's screens; never crosses a company boundary. */
    listByIssuer(issuerId: string): Promise<Actor[]>;
    /** Remembers who signed in (the identity provider stays the source of truth for roles). */
    upsert(actor: Actor): Promise<void>;
  };
  issuers: { get(id: string): Promise<Issuer | null>; list(): Promise<Issuer[]> };
  announcements: {
    insert(a: Announcement, idempotencyKey: string | null): Promise<void>;
    get(issuerId: string, id: string): Promise<Announcement | null>;
    findByIdempotencyKey(issuerId: string, key: string): Promise<Announcement | null>;
    list(issuerId: string, q: ListQuery): Promise<{ items: ListItem[]; nextCursor: string | null }>;
    /** Published announcements across all companies, newest first. The only query that crosses a company boundary. */
    publicFeed(q: PublicQuery): Promise<{ items: PublicItem[]; nextCursor: string | null }>;
    publicGet(id: string): Promise<PublicDetail | null>;
    /** Companies with at least one published announcement. */
    publicIssuers(): Promise<{ id: string; name: string }[]>;
    /** Compare-and-set on version; bumps version. Throws a 409 when the version moved. */
    update(issuerId: string, id: string, expectedVersion: number, patch: AnnouncementPatch, at: string): Promise<void>;
  };
  revisions: {
    insert(r: Revision): Promise<void>;
    get(announcementId: string, n: number): Promise<Revision | null>;
    list(announcementId: string): Promise<Revision[]>;
  };
  validations: {
    save(v: ValidationReport): Promise<void>;
    get(announcementId: string, revision: number): Promise<ValidationReport | null>;
  };
  approvals: {
    insert(a: Approval): Promise<void>;
    list(announcementId: string, revision: number): Promise<Approval[]>;
    voidActive(announcementId: string, revision: number, at: string): Promise<void>;
  };
  publications: {
    insert(p: Publication): Promise<void>;
    get(id: string): Promise<Publication | null>;
    forRevision(announcementId: string, revision: number): Promise<Publication | null>;
    update(id: string, patch: PublicationPatch, at: string): Promise<void>;
    /** Compare-and-set lease. Returns null when someone else owns the work or it is not due. */
    claim(id: string, now: string, leaseMs: number, token: string): Promise<Publication | null>;
    /** Write that only succeeds for the current lease holder; false when the lease was lost. */
    finish(id: string, token: string, patch: PublicationPatch, at: string): Promise<boolean>;
    /** The company's recent publication jobs, newest activity first. */
    listByIssuer(issuerId: string, limit: number): Promise<PublicationJob[]>;
    /** Due work with no worker on it for longer than graceMs: the sweeper's safety net. */
    overdue(now: string, graceMs: number, limit: number): Promise<Publication[]>;
  };
  audit: {
    /** Appends with per-announcement sequence and hash chain. */
    append(e: AuditInput, at: string): Promise<AuditEvent>;
    list(announcementId: string): Promise<AuditEvent[]>;
    /** The company's most recent events across all its announcements. */
    recent(issuerId: string, limit: number): Promise<ActivityEvent[]>;
  };
  aiReports: {
    insert(r: AiReportRecord): Promise<void>;
    latest(announcementId: string, agent?: string): Promise<AiReportRecord | null>;
    forEvent(agent: string, eventId: string): Promise<AiReportRecord | null>;
    forRevision(announcementId: string, revision: number): Promise<AiReportRecord[]>;
  };
  settings: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  events: EventsStore;
  subscriptions: SubscriptionsStore;
  notifications: NotificationsStore;
}

/** Cross-tenant operational counts for metrics. Never exposed to tenants, never carries content. */
export interface OpsStats {
  publicationsByStatus: Record<string, number>;
  announcementsByStatus: Record<string, number>;
  /** Age in seconds of the oldest publication waiting for a worker; 0 when none is waiting. */
  oldestWaitingSeconds: number;
  events: EventStats;
}

export interface Store {
  tx<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  read: StoreTx;
  stats(now: string): Promise<OpsStats>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------- queue

export interface JobQueue {
  /** Wake-up call only: the publication row is the source of truth. Safe to call twice. */
  enqueue(publicationId: string, opts?: { delayMs?: number }): Promise<void>;
  /** Start consuming (worker and "all" roles). */
  start(handler: (publicationId: string) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

// -------------------------------------------------------------------- gateway

export interface PublishAck {
  externalRef: string;
  acceptedAt: string;
  filingDate?: string;
  detail: Record<string, unknown>;
}

/** Transient errors are retried, permanent ones need a human (and usually a new revision). */
export class GatewayError extends Error {
  constructor(
    readonly kind: 'transient' | 'permanent',
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface PublishGateway {
  readonly channel: string;
  /** Has this idempotency key already been accepted? Used to reconcile after a lost ack. */
  find(idempotencyKey: string): Promise<PublishAck | null>;
  submit(req: { idempotencyKey: string; payload: DistributionPayload }): Promise<PublishAck>;
}

export class GatewayRegistry {
  private readonly gateways = new Map<string, PublishGateway>();
  register(g: PublishGateway): this {
    this.gateways.set(g.channel, g);
    return this;
  }
  get(channel: string): PublishGateway {
    const g = this.gateways.get(channel);
    if (!g) throw new GatewayError('permanent', 'NO_GATEWAY', `No gateway registered for channel "${channel}"`);
    return g;
  }
}

// ------------------------------------------------------------------------ AI

export type PreCheckInput = {
  jurisdiction: string;
  category: string;
  categories: string[];
  issuerName: string;
  headline: string;
  body: string;
  metadata: Record<string, unknown>;
};

export interface PreCheckProvider {
  readonly name: string;
  analyze(input: PreCheckInput): Promise<unknown>;
}
