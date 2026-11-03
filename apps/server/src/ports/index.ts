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
export type ListItem = Announcement & { headline: string };

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
}

/** Every method that touches tenant data takes issuerId and filters on it in the query. */
export interface StoreTx {
  users: { get(id: string): Promise<Actor | null>; list(): Promise<Actor[]> };
  issuers: { get(id: string): Promise<Issuer | null>; list(): Promise<Issuer[]> };
  announcements: {
    insert(a: Announcement, idempotencyKey: string | null): Promise<void>;
    get(issuerId: string, id: string): Promise<Announcement | null>;
    findByIdempotencyKey(issuerId: string, key: string): Promise<Announcement | null>;
    list(issuerId: string, q: ListQuery): Promise<{ items: ListItem[]; nextCursor: string | null }>;
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
    /** Due work with no worker on it for longer than graceMs: the sweeper's safety net. */
    overdue(now: string, graceMs: number, limit: number): Promise<Publication[]>;
  };
  audit: {
    /** Appends with per-announcement sequence and hash chain. */
    append(e: AuditInput, at: string): Promise<AuditEvent>;
    list(announcementId: string): Promise<AuditEvent[]>;
  };
  aiReports: {
    insert(r: AiReportRecord): Promise<void>;
    latest(announcementId: string): Promise<AiReportRecord | null>;
  };
  settings: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
}

/** Cross-tenant operational counts for metrics. Never exposed to tenants, never carries content. */
export interface OpsStats {
  publicationsByStatus: Record<string, number>;
  announcementsByStatus: Record<string, number>;
  /** Age in seconds of the oldest publication waiting for a worker; 0 when none is waiting. */
  oldestWaitingSeconds: number;
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
