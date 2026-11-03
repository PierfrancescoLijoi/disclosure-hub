import { randomUUID } from 'node:crypto';
import { approvedContentProblem } from '../domain/integrity.js';
import { nextStatus } from '../domain/state-machine.js';
import type { Publication } from '../domain/types.js';
import {
  GatewayError,
  type Clock,
  type GatewayRegistry,
  type JobQueue,
  type Logger,
  type PublishAck,
  type Store,
} from '../ports/index.js';
import type { PolicyRegistry } from '../domain/policy.js';
import { ruleContext } from './announcements.js';

export interface RunnerConfig {
  leaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Concurrent calls per external gateway, per worker process: protects vendor rate limits. */
  gatewayConcurrency: number;
  /** Hold releases while the channel is closed (RNS hours, EDGAR hours) instead of sending. */
  enforceWindows: boolean;
}

export interface RunnerDeps {
  store: Store;
  policies: PolicyRegistry;
  gateways: GatewayRegistry;
  clock: Clock;
  queue: JobQueue;
  log: Logger;
  config: RunnerConfig;
  random?: () => number;
}

export type RunOutcome = 'skipped' | 'published' | 'retry_scheduled' | 'deferred' | 'failed' | 'lease_lost';

class Semaphore {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const iso = (d: Date) => d.toISOString();

/** A hung vendor call must free its semaphore slot and fail as transient before the lease expires. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayError('transient', 'GATEWAY_TIMEOUT', `No answer from the gateway within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
const SWEEP_BATCH = 100;
const RECHECK_CLOSED_MS = 3_600_000;

/**
 * Takes one publication to a terminal state. The publication row is the source of truth;
 * the queue only says "look at this id". Safe to run twice for the same id: the lease
 * claim, the gateway idempotency key and the lease-checked finish make a duplicate harmless.
 */
export class PublicationRunner {
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(private readonly d: RunnerDeps) {}

  async run(publicationId: string): Promise<RunOutcome> {
    const { store, clock, config } = this.d;
    const token = randomUUID();
    const claimed = await store.read.publications.claim(publicationId, iso(clock.now()), config.leaseMs, token);
    if (!claimed) {
      await this.rewakeIfEarly(publicationId);
      return 'skipped';
    }
    try {
      return await this.execute(claimed, token);
    } catch (err) {
      // Anything unexpected after the claim must end in a state a person can see and act on,
      // not in a lease that expires and is reclaimed forever.
      this.d.log.error({ publicationId, err }, 'publication run crashed');
      return this.onGatewayError(claimed, token, err);
    }
  }

  private async execute(claimed: Publication, token: string): Promise<RunOutcome> {
    const { store, clock } = this.d;
    const a = await store.read.announcements.get(claimed.issuerId, claimed.announcementId);
    const rev = a && (await store.read.revisions.get(a.id, claimed.revision));
    const issuer = a && (await store.read.issuers.get(a.issuerId));
    if (!a || !rev || !issuer || a.status !== 'publishing' || a.currentRevision !== claimed.revision) {
      return this.reject(claimed, token, 'STATE_MISMATCH', 'Announcement is no longer in a publishable state', false);
    }

    const policy = this.d.policies.get(a.jurisdiction);
    const now = clock.now();
    const ctx = ruleContext(policy, a, rev, issuer, now);
    if (!ctx) return this.reject(claimed, token, 'METADATA_INVALID', 'Revision metadata no longer matches the category schema');

    const problem = approvedContentProblem(a, rev, await store.read.approvals.list(a.id, rev.number));
    if (problem) return this.reject(claimed, token, 'APPROVAL_STALE', problem);

    if (this.d.config.enforceWindows) {
      const { window } = policy.timing(ctx);
      // A closed channel always holds the release; with no known opening, look again in an hour.
      if (!window.open) return this.defer(claimed, token, window.nextOpenAt ?? new Date(now.getTime() + RECHECK_CLOSED_MS));
    }

    let ack: PublishAck;
    try {
      const gateway = this.d.gateways.get(policy.channel.id);
      ack = await this.semaphore(policy.channel.id).use(async () => {
        // Reconcile first: a previous attempt may have been accepted whose ack we never saw.
        const call = async () => {
          const already = await gateway.find(claimed.idempotencyKey);
          return already ?? gateway.submit({ idempotencyKey: claimed.idempotencyKey, payload: policy.render(ctx) });
        };
        return withTimeout(call(), this.d.config.leaseMs / 2);
      });
    } catch (err) {
      return this.onGatewayError(claimed, token, err);
    }

    const obligations = policy.postPublication(ctx);
    return store.tx(async (tx) => {
      const at = iso(clock.now());
      const owned = await tx.publications.finish(
        claimed.id,
        token,
        { status: 'acked', externalRef: ack.externalRef, ack: { ...ack }, lastError: null },
        at,
      );
      if (!owned) return 'lease_lost';
      const fresh = await tx.announcements.get(a.issuerId, a.id);
      if (!fresh) return 'lease_lost';
      await tx.announcements.update(a.issuerId, a.id, fresh.version, { status: nextStatus(fresh.status, 'published') }, at);
      await tx.audit.append(
        {
          announcementId: a.id,
          issuerId: a.issuerId,
          type: 'published',
          actorId: 'system',
          data: { externalRef: ack.externalRef, filingDate: ack.filingDate ?? null, attempts: claimed.attempts, obligations },
        },
        at,
      );
      return 'published' as const;
    });
  }

  /** Re-enqueues work whose wake-up was lost (crash, Redis flush, abandoned lease). */
  async sweep(): Promise<number> {
    const due = await this.d.store.read.publications.overdue(iso(this.d.clock.now()), this.d.config.leaseMs / 4, SWEEP_BATCH);
    for (const p of due) await this.d.queue.enqueue(p.id);
    if (due.length) this.d.log.warn({ count: due.length }, 'sweeper re-enqueued overdue publications');
    return due.length;
  }

  /**
   * A delayed wake-up can land a few milliseconds before next_attempt_at (timer or Redis clock
   * skew against the database clock). Dropping it would strand the job until the sweeper;
   * instead wait out the remainder. The remainder can already be zero by the time the row is
   * re-read (the claim failed a millisecond ago), so it never drops the wake-up: at worst it
   * retries 1 ms later.
   */
  private async rewakeIfEarly(publicationId: string): Promise<void> {
    const p = await this.d.store.read.publications.get(publicationId);
    if (!p || (p.status !== 'pending' && p.status !== 'retry')) return;
    const wait = Date.parse(p.nextAttemptAt) - this.d.clock.now().getTime();
    await this.d.queue.enqueue(publicationId, { delayMs: Math.max(wait, 0) + 1 });
  }

  private semaphore(channel: string): Semaphore {
    let s = this.semaphores.get(channel);
    if (!s) this.semaphores.set(channel, (s = new Semaphore(this.d.config.gatewayConcurrency)));
    return s;
  }

  private backoffMs(attempt: number): number {
    const { retryBaseMs, retryMaxMs } = this.d.config;
    const jitter = 0.8 + (this.d.random ?? Math.random)() * 0.4;
    return Math.round(Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1)) * jitter);
  }

  private async onGatewayError(pub: Publication, token: string, err: unknown): Promise<RunOutcome> {
    const e = err instanceof GatewayError ? err : new GatewayError('transient', 'UNEXPECTED', (err as Error).message ?? String(err));
    if (e.kind === 'permanent') return this.reject(pub, token, e.code, e.message);
    if (pub.attempts >= pub.maxAttempts) return this.finishFailed(pub, token, 'exhausted', e.code, e.message);

    const delayMs = this.backoffMs(pub.attempts);
    const retryAt = iso(new Date(this.d.clock.now().getTime() + delayMs));
    const owned = await this.d.store.tx(async (tx) => {
      const at = iso(this.d.clock.now());
      if (!(await tx.publications.finish(pub.id, token, { status: 'retry', nextAttemptAt: retryAt, lastError: `${e.code}: ${e.message}` }, at))) return false;
      await tx.audit.append(
        { announcementId: pub.announcementId, issuerId: pub.issuerId, type: 'publish_attempt_failed', actorId: 'system', data: { attempt: pub.attempts, code: e.code, message: e.message, retryAt } },
        at,
      );
      return true;
    });
    if (!owned) return 'lease_lost';
    await this.d.queue.enqueue(pub.id, { delayMs });
    this.d.log.warn({ publicationId: pub.id, attempt: pub.attempts, code: e.code, delayMs }, 'publish attempt failed, retry scheduled');
    return 'retry_scheduled';
  }

  private async defer(pub: Publication, token: string, until: Date): Promise<RunOutcome> {
    const owned = await this.d.store.tx(async (tx) => {
      const at = iso(this.d.clock.now());
      // The wait is not an attempt: give the claimed attempt back.
      if (!(await tx.publications.finish(pub.id, token, { status: 'retry', attempts: pub.attempts - 1, nextAttemptAt: iso(until) }, at))) return false;
      await tx.audit.append(
        { announcementId: pub.announcementId, issuerId: pub.issuerId, type: 'publish_deferred', actorId: 'system', data: { reason: 'channel closed', until: iso(until) } },
        at,
      );
      return true;
    });
    if (!owned) return 'lease_lost';
    await this.d.queue.enqueue(pub.id, { delayMs: Math.max(0, until.getTime() - this.d.clock.now().getTime()) });
    return 'deferred';
  }

  private reject(pub: Publication, token: string, code: string, message: string, failAnnouncement = true): Promise<RunOutcome> {
    return this.finishFailed(pub, token, 'rejected', code, message, failAnnouncement);
  }

  private async finishFailed(
    pub: Publication,
    token: string,
    status: 'rejected' | 'exhausted',
    code: string,
    message: string,
    failAnnouncement = true,
  ): Promise<RunOutcome> {
    const owned = await this.d.store.tx(async (tx) => {
      const at = iso(this.d.clock.now());
      if (!(await tx.publications.finish(pub.id, token, { status, lastError: `${code}: ${message}` }, at))) return false;
      const a = await tx.announcements.get(pub.issuerId, pub.announcementId);
      if (a && failAnnouncement && a.status === 'publishing') {
        await tx.announcements.update(a.issuerId, a.id, a.version, { status: nextStatus(a.status, 'publish_failed'), failureReason: `${code}: ${message}` }, at);
      }
      await tx.audit.append(
        { announcementId: pub.announcementId, issuerId: pub.issuerId, type: 'publish_failed', actorId: 'system', data: { outcome: status, attempts: pub.attempts, code, message } },
        at,
      );
      return true;
    });
    if (!owned) return 'lease_lost';
    this.d.log.error({ publicationId: pub.id, status, code }, 'publication failed');
    return 'failed';
  }
}
