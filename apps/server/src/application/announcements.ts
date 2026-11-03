import { randomUUID } from 'node:crypto';
import { conflict, DomainError, forbidden, notFound, unprocessable } from '../domain/errors.js';
import { contentHash, verifyAuditChain } from '../domain/hash.js';
import { approvedContentProblem } from '../domain/integrity.js';
import {
  APPROVER_ROLES,
  assertCapability,
  availableActions,
  requirementSatisfied,
  type ActionName,
} from '../domain/permissions.js';
import type { JurisdictionPolicy, PolicyRegistry, RuleContext } from '../domain/policy.js';
import { nextStatus } from '../domain/state-machine.js';
import type {
  Actor,
  Announcement,
  Approval,
  ApprovalRequirement,
  AuditEvent,
  Issuer,
  Publication,
  Revision,
  Status,
  ValidationReport,
} from '../domain/types.js';
import type { Clock, JobQueue, ListQuery, Logger, PublicQuery, Store, StoreTx } from '../ports/index.js';

export interface ServiceDeps {
  store: Store;
  policies: PolicyRegistry;
  clock: Clock;
  queue: JobQueue;
  maxAttempts: number;
  log: Logger;
}

export interface DraftInput {
  headline: string;
  body: string;
  metadata: Record<string, unknown>;
}
export interface CreateInput extends DraftInput {
  jurisdiction: string;
  category: string;
}

export interface TimingView {
  deadline: { at: string | null; basis: string } | null;
  overdue: boolean;
  window: { open: boolean; nextOpenAt: string | null };
}

export interface AnnouncementView {
  announcement: Announcement;
  revision: Revision;
  validation: ValidationReport | null;
  approvals: Approval[];
  publication: Omit<Publication, 'leaseToken'> | null;
  timing: TimingView | null;
  actions: ActionName[];
  /** Follow-up duties the policy attaches to a published release. */
  obligations: string[];
}

export interface StepResult {
  status: Status;
  report: ValidationReport;
  ok: boolean;
}

const iso = (d: Date) => d.toISOString();

/** Rule context needs parsed metadata; null when the metadata does not match the category schema. */
export function ruleContext(
  policy: JurisdictionPolicy,
  a: Announcement,
  rev: Revision,
  issuer: Issuer,
  now: Date,
): RuleContext | null {
  const parsed = policy.parseMetadata(a.category, rev.metadata);
  if (!parsed.success) return null;
  return {
    announcementId: a.id,
    jurisdiction: a.jurisdiction,
    category: a.category,
    issuer,
    headline: rev.headline,
    body: rev.body,
    meta: parsed.data,
    now,
  };
}

export class AnnouncementService {
  constructor(private readonly d: ServiceDeps) {}

  // ----------------------------------------------------------------- drafting

  async create(actor: Actor, input: CreateInput, idempotencyKey?: string): Promise<{ id: string; replay: boolean }> {
    assertCapability(actor, 'author');
    const policy = this.d.policies.get(input.jurisdiction);
    if (!policy.hasCategory(input.category)) {
      throw unprocessable('UNKNOWN_CATEGORY', `${policy.name} has no category "${input.category}"`);
    }
    const hash = contentHash({ jurisdiction: input.jurisdiction, category: input.category, ...pick(input) });

    try {
      return await this.d.store.tx(async (tx) => {
        if (idempotencyKey) {
          const existing = await tx.announcements.findByIdempotencyKey(actor.issuerId, idempotencyKey);
          if (existing) {
            const first = await tx.revisions.get(existing.id, 1);
            if (first?.contentHash !== hash) {
              throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different content');
            }
            return { id: existing.id, replay: true };
          }
        }
        const now = iso(this.d.clock.now());
        const id = randomUUID();
        await tx.announcements.insert(
          {
            id,
            issuerId: actor.issuerId,
            jurisdiction: input.jurisdiction,
            category: input.category,
            status: 'draft',
            currentRevision: 1,
            version: 1,
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
            approvalRequirement: null,
            failureReason: null,
          },
          idempotencyKey ?? null,
        );
        await tx.revisions.insert({
          announcementId: id,
          number: 1,
          ...pick(input),
          contentHash: hash,
          authorId: actor.id,
          createdAt: now,
        });
        await this.audit(tx, actor, id, 'created', { jurisdiction: input.jurisdiction, category: input.category, contentHash: hash }, now);
        return { id, replay: false };
      });
    } catch (e) {
      // Two concurrent creates with one key: the loser re-reads the winner. Business errors pass through.
      if (!idempotencyKey || e instanceof DomainError) throw e;
      const winner = await this.d.store.read.announcements.findByIdempotencyKey(actor.issuerId, idempotencyKey);
      if (!winner) throw e;
      // Same rule as the sequential path: a replay is only a replay if the content is the same.
      const first = await this.d.store.read.revisions.get(winner.id, 1);
      if (first?.contentHash !== hash) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with different content');
      }
      return { id: winner.id, replay: true };
    }
  }

  async saveRevision(actor: Actor, id: string, input: DraftInput & { expectedVersion?: number }): Promise<{ changed: boolean }> {
    assertCapability(actor, 'author');
    return this.d.store.tx(async (tx) => {
      const { a, rev } = await this.load(tx, actor, id);
      if (input.expectedVersion !== undefined && input.expectedVersion !== a.version) {
        throw conflict('STALE_VERSION', 'The announcement changed since you loaded it');
      }
      nextStatus(a.status, 'edit');
      const hash = contentHash({ jurisdiction: a.jurisdiction, category: a.category, ...pick(input) });
      if (hash === rev.contentHash) return { changed: false };

      const now = iso(this.d.clock.now());
      const number = a.currentRevision + 1;
      await tx.revisions.insert({ announcementId: a.id, number, ...pick(input), contentHash: hash, authorId: actor.id, createdAt: now });
      await tx.approvals.voidActive(a.id, a.currentRevision, now);
      await tx.announcements.update(
        a.issuerId,
        a.id,
        a.version,
        { status: 'draft', currentRevision: number, approvalRequirement: null, failureReason: null },
        now,
      );
      await this.audit(tx, actor, a.id, 'revision_saved', { revision: number, contentHash: hash, previousStatus: a.status }, now);
      return { changed: true };
    });
  }

  // --------------------------------------------------------------- validation

  async validate(actor: Actor, id: string): Promise<StepResult> {
    assertCapability(actor, 'author');
    return this.d.store.tx(async (tx) => {
      const { a, rev, issuer, policy } = await this.load(tx, actor, id);
      nextStatus(a.status, 'validation_passed');
      const now = this.d.clock.now();
      const report = this.runValidation(policy, a, rev, issuer, now);
      const status = nextStatus(a.status, report.ok ? 'validation_passed' : 'validation_failed');
      await tx.validations.save(report);
      await tx.announcements.update(a.issuerId, a.id, a.version, { status }, iso(now));
      await this.audit(tx, actor, a.id, 'validated', summarise(report), iso(now));
      return { status, report, ok: report.ok };
    });
  }

  // ------------------------------------------------------------------- review

  /** Re-validates, then moves to review. A failing re-validation sends it back to draft and says why. */
  async submit(actor: Actor, id: string): Promise<StepResult> {
    assertCapability(actor, 'author');
    return this.d.store.tx(async (tx) => {
      const { a, rev, issuer, policy } = await this.load(tx, actor, id);
      nextStatus(a.status, 'submit');
      const now = this.d.clock.now();
      const report = this.runValidation(policy, a, rev, issuer, now);
      await tx.validations.save(report);

      if (!report.ok) {
        await tx.announcements.update(a.issuerId, a.id, a.version, { status: nextStatus(a.status, 'validation_failed') }, iso(now));
        await this.audit(tx, actor, a.id, 'submit_rejected', summarise(report), iso(now));
        return { status: 'draft', report, ok: false };
      }
      const ctx = ruleContext(policy, a, rev, issuer, now)!;
      const requirement = policy.approvalRequirement(ctx);
      await tx.announcements.update(
        a.issuerId,
        a.id,
        a.version,
        { status: nextStatus(a.status, 'submit'), approvalRequirement: requirement },
        iso(now),
      );
      await this.audit(tx, actor, a.id, 'submitted', { requirement, contentHash: rev.contentHash, ...summarise(report) }, iso(now));
      return { status: 'in_review', report, ok: true };
    });
  }

  /** `reviewedRevision`: the revision the approver actually looked at; an approval never lands on a newer one. */
  async approve(actor: Actor, id: string, comment = '', reviewedRevision?: number): Promise<{ status: Status; complete: boolean }> {
    assertCapability(actor, 'approver');
    return this.d.store.tx(async (tx) => {
      const { a, rev } = await this.load(tx, actor, id);
      nextStatus(a.status, 'approvals_complete');
      if (reviewedRevision !== undefined && reviewedRevision !== a.currentRevision) {
        throw conflict('STALE_REVISION', `Revision ${reviewedRevision} was replaced by revision ${a.currentRevision}; review it before approving`);
      }
      if (rev.authorId === actor.id) {
        throw forbidden('FOUR_EYES', 'The author of this revision cannot approve it');
      }
      const existing = await tx.approvals.list(a.id, a.currentRevision);
      if (existing.some((x) => x.approverId === actor.id && x.decision === 'approve' && !x.voidedAt)) {
        throw conflict('ALREADY_APPROVED', 'You already approved this revision');
      }
      const now = iso(this.d.clock.now());
      const approval: Approval = {
        id: randomUUID(),
        announcementId: a.id,
        revision: a.currentRevision,
        contentHash: rev.contentHash,
        approverId: actor.id,
        roles: actor.roles.filter((r) => APPROVER_ROLES.includes(r)),
        decision: 'approve',
        comment,
        at: now,
        voidedAt: null,
      };
      await tx.approvals.insert(approval);
      const complete = requirementSatisfied(requirementOf(a), [...existing, approval]);
      const status = complete ? nextStatus(a.status, 'approvals_complete') : a.status;
      await tx.announcements.update(a.issuerId, a.id, a.version, { status }, now);
      await this.audit(tx, actor, a.id, 'approved', { revision: a.currentRevision, roles: approval.roles, complete }, now);
      return { status, complete };
    });
  }

  async requestChanges(actor: Actor, id: string, comment: string): Promise<{ status: Status }> {
    assertCapability(actor, 'approver');
    if (!comment.trim()) throw unprocessable('COMMENT_REQUIRED', 'Say what needs to change');
    return this.d.store.tx(async (tx) => {
      const { a } = await this.load(tx, actor, id);
      const status = nextStatus(a.status, 'request_changes');
      const now = iso(this.d.clock.now());
      await tx.approvals.insert({
        id: randomUUID(),
        announcementId: a.id,
        revision: a.currentRevision,
        contentHash: (await tx.revisions.get(a.id, a.currentRevision))!.contentHash,
        approverId: actor.id,
        roles: actor.roles.filter((r) => APPROVER_ROLES.includes(r)),
        decision: 'request_changes',
        comment,
        at: now,
        voidedAt: now,
      });
      await tx.approvals.voidActive(a.id, a.currentRevision, now);
      await tx.announcements.update(a.issuerId, a.id, a.version, { status, approvalRequirement: null }, now);
      await this.audit(tx, actor, a.id, 'changes_requested', { comment }, now);
      return { status };
    });
  }

  // -------------------------------------------------------------- publication

  /** Idempotent: pressing publish twice returns the same publication. */
  async publish(actor: Actor, id: string): Promise<AnnouncementView> {
    assertCapability(actor, 'publisher');
    const out = await this.d.store.tx(async (tx) => {
      const { a, rev } = await this.load(tx, actor, id);
      if (a.status === 'publishing' || a.status === 'published') return { wake: null };
      nextStatus(a.status, 'publish');

      const approvals = await tx.approvals.list(a.id, a.currentRevision);
      const problem = approvedContentProblem(a, rev, approvals);
      if (problem) throw conflict('APPROVAL_STALE', problem);

      const now = iso(this.d.clock.now());
      // The version check goes first: of two concurrent publishes, the loser gets a clean 409 here.
      await tx.announcements.update(a.issuerId, a.id, a.version, { status: nextStatus(a.status, 'publish'), failureReason: null }, now);
      const existing = await tx.publications.forRevision(a.id, rev.number);
      const publicationId = existing?.id ?? randomUUID();
      if (existing) {
        await tx.publications.update(existing.id, { status: 'pending', attempts: 0, nextAttemptAt: now, lastError: null }, now);
      } else {
        await tx.publications.insert({
          id: publicationId,
          announcementId: a.id,
          issuerId: a.issuerId,
          revision: rev.number,
          idempotencyKey: `${a.id}:${rev.number}`,
          status: 'pending',
          attempts: 0,
          maxAttempts: this.d.maxAttempts,
          nextAttemptAt: now,
          leaseUntil: null,
          leaseToken: null,
          lastError: null,
          externalRef: null,
          ack: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      await this.audit(tx, actor, a.id, 'publish_requested', { revision: rev.number, publicationId }, now);
      return { wake: publicationId };
    });
    if (out.wake) await this.wake(out.wake);
    return this.get(actor, id);
  }

  /** After exhausted transient retries. A rejected release needs a new revision instead. */
  async retry(actor: Actor, id: string): Promise<AnnouncementView> {
    assertCapability(actor, 'publisher');
    const publicationId = await this.d.store.tx(async (tx) => {
      const { a } = await this.load(tx, actor, id);
      const status = nextStatus(a.status, 'retry');
      const pub = await tx.publications.forRevision(a.id, a.currentRevision);
      if (!pub || pub.status !== 'exhausted') {
        throw conflict('RETRY_NOT_ALLOWED', 'Only a release that ran out of retries can be retried; a rejected one needs a corrected revision');
      }
      const now = iso(this.d.clock.now());
      await tx.publications.update(pub.id, { status: 'pending', attempts: 0, nextAttemptAt: now }, now);
      await tx.announcements.update(a.issuerId, a.id, a.version, { status, failureReason: null }, now);
      await this.audit(tx, actor, a.id, 'publish_retry_requested', { publicationId: pub.id }, now);
      return pub.id;
    });
    await this.wake(publicationId);
    return this.get(actor, id);
  }

  async reopen(actor: Actor, id: string, reason = ''): Promise<{ status: Status }> {
    assertCapability(actor, 'approver', 'publisher');
    return this.d.store.tx(async (tx) => {
      const { a } = await this.load(tx, actor, id);
      const status = nextStatus(a.status, 'reopen');
      const now = iso(this.d.clock.now());
      await tx.approvals.voidActive(a.id, a.currentRevision, now);
      await tx.announcements.update(a.issuerId, a.id, a.version, { status, approvalRequirement: null }, now);
      await this.audit(tx, actor, a.id, 'reopened', { from: a.status, reason }, now);
      return { status };
    });
  }

  async withdraw(actor: Actor, id: string, reason = ''): Promise<{ status: Status }> {
    assertCapability(actor, 'author');
    return this.d.store.tx(async (tx) => {
      const { a } = await this.load(tx, actor, id);
      const status = nextStatus(a.status, 'withdraw');
      const now = iso(this.d.clock.now());
      await tx.approvals.voidActive(a.id, a.currentRevision, now);
      await tx.announcements.update(a.issuerId, a.id, a.version, { status }, now);
      await this.audit(tx, actor, a.id, 'withdrawn', { from: a.status, reason }, now);
      return { status };
    });
  }

  // -------------------------------------------------------------------- reads

  async get(actor: Actor, id: string): Promise<AnnouncementView> {
    const tx = this.d.store.read;
    const { a, rev, issuer, policy } = await this.load(tx, actor, id);
    const now = this.d.clock.now();
    const ctx = ruleContext(policy, a, rev, issuer, now);
    const pub = await tx.publications.forRevision(a.id, rev.number);
    const timing = ctx ? policy.timing(ctx) : null;
    const { leaseToken: _lease, ...publication } = pub ?? ({} as Publication);
    return {
      announcement: a,
      revision: rev,
      validation: await tx.validations.get(a.id, rev.number),
      approvals: await tx.approvals.list(a.id, rev.number),
      publication: pub ? publication : null,
      timing: timing && {
        deadline: timing.deadline && { at: timing.deadline.at ? iso(timing.deadline.at) : null, basis: timing.deadline.basis },
        overdue: timing.overdue,
        window: { open: timing.window.open, nextOpenAt: timing.window.nextOpenAt ? iso(timing.window.nextOpenAt) : null },
      },
      actions: availableActions(a.status, actor),
      obligations: a.status === 'published' && ctx ? policy.postPublication(ctx) : [],
    };
  }

  async list(actor: Actor, q: ListQuery) {
    return this.d.store.read.announcements.list(actor.issuerId, q);
  }

  /** The announcement as the channel will receive it, so an author can check it before submitting. */
  async preview(actor: Actor, id: string) {
    const { a, rev, issuer, policy } = await this.load(this.d.store.read, actor, id);
    const ctx = ruleContext(policy, a, rev, issuer, this.d.clock.now());
    return {
      channel: policy.channel,
      payload: ctx ? policy.render(ctx) : null,
      problem: ctx ? null : 'The jurisdiction details do not match the category yet, so the filing cannot be rendered.',
    };
  }

  /** Recent activity of the caller's company. */
  async activity(actor: Actor, limit: number) {
    return this.d.store.read.audit.recent(actor.issuerId, limit);
  }

  /** The caller's company's publication jobs. */
  async publications(actor: Actor, limit: number) {
    return this.d.store.read.publications.listByIssuer(actor.issuerId, limit);
  }

  /** Public reading of published announcements. Adds the channel and category labels the store does not know. */
  async publicFeed(q: PublicQuery) {
    const { items, nextCursor } = await this.d.store.read.announcements.publicFeed(q);
    return { items: items.map((i) => this.publicLabels(i)), nextCursor };
  }

  async publicGet(id: string) {
    const item = await this.d.store.read.announcements.publicGet(id);
    if (!item) throw notFound('Announcement');
    return this.publicLabels(item);
  }

  private publicLabels<T extends { jurisdiction: string; category: string }>(item: T) {
    const info = this.d.policies.get(item.jurisdiction).describe();
    return {
      ...item,
      channelName: info.channel.name,
      categoryLabel: info.categories.find((c) => c.key === item.category)?.label ?? item.category,
    };
  }

  async revisions(actor: Actor, id: string): Promise<Revision[]> {
    const a = await this.d.store.read.announcements.get(actor.issuerId, id);
    if (!a) throw notFound('Announcement');
    return this.d.store.read.revisions.list(id);
  }

  async auditTrail(actor: Actor, id: string): Promise<{ events: AuditEvent[]; chain: ReturnType<typeof verifyAuditChain> }> {
    const a = await this.d.store.read.announcements.get(actor.issuerId, id);
    if (!a) throw notFound('Announcement');
    const events = await this.d.store.read.audit.list(id);
    return { events, chain: verifyAuditChain(events) };
  }

  // ---------------------------------------------------------------- internals

  private async load(tx: StoreTx, actor: Actor, id: string) {
    const a = await tx.announcements.get(actor.issuerId, id);
    if (!a) throw notFound('Announcement');
    const rev = await tx.revisions.get(a.id, a.currentRevision);
    const issuer = await tx.issuers.get(a.issuerId);
    if (!rev || !issuer) throw notFound('Announcement data');
    return { a, rev, issuer, policy: this.d.policies.get(a.jurisdiction) };
  }

  private runValidation(policy: JurisdictionPolicy, a: Announcement, rev: Revision, issuer: Issuer, now: Date): ValidationReport {
    const issues = policy.validate({
      announcementId: a.id,
      category: a.category,
      issuer,
      headline: rev.headline,
      body: rev.body,
      metadata: rev.metadata,
      now,
    });
    return { announcementId: a.id, revision: rev.number, ok: !issues.some((i) => i.severity === 'error'), issues, at: iso(now) };
  }

  private audit(tx: StoreTx, actor: Actor, announcementId: string, type: string, data: Record<string, unknown>, at: string) {
    return tx.audit.append({ announcementId, issuerId: actor.issuerId, type, actorId: actor.id, data }, at);
  }

  /** Queue is a wake-up only; if this fails the sweeper picks the publication up. */
  private async wake(publicationId: string) {
    try {
      await this.d.queue.enqueue(publicationId);
    } catch (err) {
      this.d.log.warn({ err, publicationId }, 'enqueue failed; sweeper will recover');
    }
  }
}

const pick = (i: DraftInput): DraftInput => ({ headline: i.headline, body: i.body, metadata: i.metadata });

const summarise = (r: ValidationReport) => ({
  ok: r.ok,
  errors: r.issues.filter((i) => i.severity === 'error').length,
  warnings: r.issues.filter((i) => i.severity === 'warning').length,
  codes: r.issues.map((i) => i.code),
});

function requirementOf(a: Announcement): ApprovalRequirement {
  if (!a.approvalRequirement) throw conflict('NO_REQUIREMENT', 'Announcement is in review without an approval requirement');
  return a.approvalRequirement;
}
