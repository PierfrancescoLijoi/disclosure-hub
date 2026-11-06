import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { conflict, DomainError } from '../../domain/errors.js';
import { auditHash, GENESIS_HASH } from '../../domain/hash.js';
import type {
  Actor,
  Announcement,
  Approval,
  AuditEvent,
  Issuer,
  Publication,
  Revision,
  Status,
  ValidationReport,
} from '../../domain/types.js';
import type { AiReportRecord, PublicItem, Store, StoreTx } from '../../ports/index.js';
import { buildEventsStore } from './event-store.js';
import { buildNotificationsStore, buildSubscriptionsStore } from './reader-store.js';
import type { DB } from './schema.js';

type Row<T extends keyof DB> = Selectable<DB[T]>;
const json = <T>(s: string): T => JSON.parse(s) as T;

const MAX_SEARCH_WORDS = 5;

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return (
    err.code === '23505' ||
    (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) ||
    /UNIQUE constraint failed/i.test(err.message ?? '')
  );
}

const toAnnouncement = (r: Row<'announcements'>): Announcement => ({
  id: r.id,
  issuerId: r.issuer_id,
  jurisdiction: r.jurisdiction,
  category: r.category,
  status: r.status as Status,
  currentRevision: r.current_revision,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  approvalRequirement: r.approval_requirement ? json(r.approval_requirement) : null,
  failureReason: r.failure_reason,
});

const toRevision = (r: Row<'revisions'>): Revision => ({
  announcementId: r.announcement_id,
  number: r.number,
  headline: r.headline,
  body: r.body,
  metadata: json(r.metadata),
  contentHash: r.content_hash,
  authorId: r.author_id,
  createdAt: r.created_at,
});

const toApproval = (r: Row<'approvals'>): Approval => ({
  id: r.id,
  announcementId: r.announcement_id,
  revision: r.revision,
  contentHash: r.content_hash,
  approverId: r.approver_id,
  roles: json(r.roles),
  decision: r.decision as Approval['decision'],
  comment: r.comment,
  at: r.at,
  voidedAt: r.voided_at,
});

const toPublication = (r: Row<'publications'>): Publication => ({
  id: r.id,
  announcementId: r.announcement_id,
  issuerId: r.issuer_id,
  revision: r.revision,
  idempotencyKey: r.idempotency_key,
  status: r.status as Publication['status'],
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  nextAttemptAt: r.next_attempt_at,
  leaseUntil: r.lease_until,
  leaseToken: r.lease_token,
  lastError: r.last_error,
  externalRef: r.external_ref,
  ack: r.ack ? json(r.ack) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toAudit = (r: Row<'audit_events'>): AuditEvent => ({
  id: r.id,
  announcementId: r.announcement_id,
  issuerId: r.issuer_id,
  seq: r.seq,
  type: r.type,
  actorId: r.actor_id,
  at: r.at,
  data: json(r.data),
  prevHash: r.prev_hash,
  hash: r.hash,
});

/** Published announcements with their acknowledged publication: what the public feed may expose, nothing else. */
const publishedQuery = (db: Kysely<DB>) =>
  db
    .selectFrom('announcements')
    .innerJoin('revisions', (j) =>
      j.onRef('revisions.announcement_id', '=', 'announcements.id').onRef('revisions.number', '=', 'announcements.current_revision'),
    )
    .innerJoin('publications', (j) =>
      j.onRef('publications.announcement_id', '=', 'announcements.id').onRef('publications.revision', '=', 'announcements.current_revision'),
    )
    .innerJoin('issuers', 'issuers.id', 'announcements.issuer_id')
    .select([
      'announcements.id',
      'announcements.issuer_id',
      'announcements.jurisdiction',
      'announcements.category',
      'revisions.headline',
      'revisions.body',
      'issuers.name as issuer_name',
      'publications.external_ref',
      'publications.ack',
      'publications.updated_at as published_at',
    ])
    .where('announcements.status', '=', 'published')
    .where('publications.status', '=', 'acked')
    .where('publications.external_ref', 'is not', null);

const toPublicItem = (r: {
  id: string;
  issuer_id: string;
  jurisdiction: string;
  category: string;
  headline: string;
  body: string;
  issuer_name: string;
  external_ref: string | null;
  ack: string | null;
  published_at: string;
}): PublicItem => ({
  id: r.id,
  issuerId: r.issuer_id,
  jurisdiction: r.jurisdiction,
  category: r.category,
  headline: r.headline,
  excerpt: r.body.replace(/\s+/g, ' ').trim().slice(0, 300),
  issuerName: r.issuer_name,
  receipt: r.external_ref ?? '',
  filingDate: r.ack ? (json<{ filingDate?: string }>(r.ack).filingDate ?? null) : null,
  publishedAt: r.published_at,
});

const publicationColumns = (p: import('../../ports/index.js').PublicationPatch) => ({
  ...(p.status !== undefined && { status: p.status }),
  ...(p.attempts !== undefined && { attempts: p.attempts }),
  ...(p.nextAttemptAt !== undefined && { next_attempt_at: p.nextAttemptAt }),
  ...(p.lastError !== undefined && { last_error: p.lastError }),
  ...(p.externalRef !== undefined && { external_ref: p.externalRef }),
  ...(p.ack !== undefined && { ack: p.ack ? JSON.stringify(p.ack) : null }),
});

function buildTx(db: Kysely<DB>): StoreTx {
  const tx: StoreTx = {
    users: {
      async get(id) {
        const r = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
        return r ? toActor(r) : null;
      },
      async list() {
        return (await db.selectFrom('users').selectAll().orderBy('name').execute()).map(toActor);
      },
      async listByIssuer(issuerId) {
        return (await db.selectFrom('users').selectAll().where('issuer_id', '=', issuerId).orderBy('name').execute()).map(toActor);
      },
      async upsert(actor) {
        const row = { id: actor.id, issuer_id: actor.issuerId, name: actor.name, roles: JSON.stringify(actor.roles) };
        await db
          .insertInto('users')
          .values(row)
          .onConflict((oc) => oc.column('id').doUpdateSet({ issuer_id: row.issuer_id, name: row.name, roles: row.roles }))
          .execute();
      },
    },

    issuers: {
      async get(id) {
        const r = await db.selectFrom('issuers').selectAll().where('id', '=', id).executeTakeFirst();
        return r ? toIssuer(r) : null;
      },
      async list() {
        return (await db.selectFrom('issuers').selectAll().orderBy('name').execute()).map(toIssuer);
      },
    },

    announcements: {
      async insert(a, idempotencyKey) {
        await db
          .insertInto('announcements')
          .values({
            id: a.id,
            issuer_id: a.issuerId,
            jurisdiction: a.jurisdiction,
            category: a.category,
            status: a.status,
            current_revision: a.currentRevision,
            version: a.version,
            created_by: a.createdBy,
            created_at: a.createdAt,
            updated_at: a.updatedAt,
            idempotency_key: idempotencyKey,
            approval_requirement: a.approvalRequirement ? JSON.stringify(a.approvalRequirement) : null,
            failure_reason: a.failureReason,
          })
          .execute();
      },

      async get(issuerId, id) {
        const r = await db
          .selectFrom('announcements')
          .selectAll()
          .where('issuer_id', '=', issuerId)
          .where('id', '=', id)
          .executeTakeFirst();
        return r ? toAnnouncement(r) : null;
      },

      async findByIdempotencyKey(issuerId, key) {
        const r = await db
          .selectFrom('announcements')
          .selectAll()
          .where('issuer_id', '=', issuerId)
          .where('idempotency_key', '=', key)
          .executeTakeFirst();
        return r ? toAnnouncement(r) : null;
      },

      async list(issuerId, q) {
        let query = db
          .selectFrom('announcements')
          .innerJoin('revisions', (j) =>
            j.onRef('revisions.announcement_id', '=', 'announcements.id').onRef('revisions.number', '=', 'announcements.current_revision'),
          )
          .selectAll('announcements')
          .select('revisions.headline')
          .select(
            sql<number>`(case when exists (select 1 from approvals ap where ap.announcement_id = announcements.id and ap.revision = announcements.current_revision and ap.decision = 'request_changes') then 1 else 0 end)`.as(
              'changes_requested',
            ),
          )
          .where('announcements.issuer_id', '=', issuerId);
        if (q.status) query = query.where('announcements.status', '=', q.status);
        if (q.jurisdiction) query = query.where('announcements.jurisdiction', '=', q.jurisdiction);
        if (q.cursor) {
          const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|') as [string, string];
          query = query.where((eb) =>
            eb.or([
              eb('announcements.created_at', '<', at),
              eb.and([eb('announcements.created_at', '=', at), eb('announcements.id', '<', id)]),
            ]),
          );
        }
        const rows = await query
          .orderBy('announcements.created_at', 'desc')
          .orderBy('announcements.id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const last = page.at(-1);
        return {
          items: page.map((r) => ({ ...toAnnouncement(r), headline: r.headline, changesRequested: Number(r.changes_requested) === 1 })),
          nextCursor:
            rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
        };
      },

      async publicFeed(q) {
        let query = publishedQuery(db);
        if (q.issuerId) query = query.where('announcements.issuer_id', '=', q.issuerId);
        if (q.jurisdiction) query = query.where('announcements.jurisdiction', '=', q.jurisdiction);
        if (q.category) query = query.where('announcements.category', '=', q.category);
        if (q.from) query = query.where('publications.updated_at', '>=', `${q.from}T00:00:00.000Z`);
        if (q.to) query = query.where('publications.updated_at', '<=', `${q.to}T23:59:59.999Z`);
        // Every word must appear in the headline, the body or the company name.
        // Capped: every word is a scan of every body, and a varied query defeats the cache.
        for (const word of (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS)) {
          const like = '%' + word.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
          query = query.where(
            sql<boolean>`(lower(revisions.headline) like ${like} escape '\\' or lower(revisions.body) like ${like} escape '\\' or lower(issuers.name) like ${like} escape '\\')`,
          );
        }
        if (q.cursor) {
          const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|') as [string, string];
          query = query.where((eb) =>
            eb.or([eb('publications.updated_at', '<', at), eb.and([eb('publications.updated_at', '=', at), eb('announcements.id', '<', id)])]),
          );
        }
        const rows = await query
          .orderBy('publications.updated_at', 'desc')
          .orderBy('announcements.id', 'desc')
          .limit(q.limit + 1)
          .execute();
        const page = rows.slice(0, q.limit);
        const last = page.at(-1);
        return {
          items: page.map(toPublicItem),
          nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.published_at}|${last.id}`).toString('base64url') : null,
        };
      },

      async publicIssuers() {
        const rows = await publishedQuery(db).clearSelect().select(['issuers.id as id', 'issuers.name as name']).groupBy(['issuers.id', 'issuers.name']).orderBy('issuers.name').execute();
        return rows.map((r) => ({ id: r.id, name: r.name }));
      },

      async publicGet(id) {
        const r = await publishedQuery(db).where('announcements.id', '=', id).executeTakeFirst();
        return r ? { ...toPublicItem(r), body: r.body } : null;
      },

      async update(issuerId, id, expectedVersion, patch, at) {
        const res = await db
          .updateTable('announcements')
          .set({
            version: expectedVersion + 1,
            updated_at: at,
            ...(patch.status !== undefined && { status: patch.status }),
            ...(patch.currentRevision !== undefined && { current_revision: patch.currentRevision }),
            ...(patch.approvalRequirement !== undefined && {
              approval_requirement: patch.approvalRequirement ? JSON.stringify(patch.approvalRequirement) : null,
            }),
            ...(patch.failureReason !== undefined && { failure_reason: patch.failureReason }),
          })
          .where('issuer_id', '=', issuerId)
          .where('id', '=', id)
          .where('version', '=', expectedVersion)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) {
          throw conflict('CONCURRENT_UPDATE', 'The announcement changed while you were working on it; reload and retry');
        }
      },
    },

    revisions: {
      async insert(r) {
        await db
          .insertInto('revisions')
          .values({
            announcement_id: r.announcementId,
            number: r.number,
            headline: r.headline,
            body: r.body,
            metadata: JSON.stringify(r.metadata),
            content_hash: r.contentHash,
            author_id: r.authorId,
            created_at: r.createdAt,
          })
          .execute();
      },
      async get(announcementId, n) {
        const r = await db
          .selectFrom('revisions')
          .selectAll()
          .where('announcement_id', '=', announcementId)
          .where('number', '=', n)
          .executeTakeFirst();
        return r ? toRevision(r) : null;
      },
      async list(announcementId) {
        return (
          await db.selectFrom('revisions').selectAll().where('announcement_id', '=', announcementId).orderBy('number').execute()
        ).map(toRevision);
      },
    },

    validations: {
      async save(v) {
        await db
          .insertInto('validations')
          .values({
            announcement_id: v.announcementId,
            revision: v.revision,
            ok: v.ok ? 1 : 0,
            issues: JSON.stringify(v.issues),
            at: v.at,
          })
          .onConflict((oc) =>
            oc.columns(['announcement_id', 'revision']).doUpdateSet({ ok: v.ok ? 1 : 0, issues: JSON.stringify(v.issues), at: v.at }),
          )
          .execute();
      },
      async get(announcementId, revision) {
        const r = await db
          .selectFrom('validations')
          .selectAll()
          .where('announcement_id', '=', announcementId)
          .where('revision', '=', revision)
          .executeTakeFirst();
        return r
          ? ({ announcementId, revision, ok: r.ok === 1, issues: json(r.issues), at: r.at } satisfies ValidationReport)
          : null;
      },
    },

    approvals: {
      async insert(a) {
        await db
          .insertInto('approvals')
          .values({
            id: a.id,
            announcement_id: a.announcementId,
            revision: a.revision,
            content_hash: a.contentHash,
            approver_id: a.approverId,
            roles: JSON.stringify(a.roles),
            decision: a.decision,
            comment: a.comment,
            at: a.at,
            voided_at: a.voidedAt,
          })
          .execute();
      },
      async list(announcementId, revision) {
        return (
          await db
            .selectFrom('approvals')
            .selectAll()
            .where('announcement_id', '=', announcementId)
            .where('revision', '=', revision)
            .orderBy('at')
            .execute()
        ).map(toApproval);
      },
      async voidActive(announcementId, revision, at) {
        await db
          .updateTable('approvals')
          .set({ voided_at: at })
          .where('announcement_id', '=', announcementId)
          .where('revision', '=', revision)
          .where('voided_at', 'is', null)
          .execute();
      },
    },

    publications: {
      async insert(p) {
        await db
          .insertInto('publications')
          .values({
            id: p.id,
            announcement_id: p.announcementId,
            issuer_id: p.issuerId,
            revision: p.revision,
            idempotency_key: p.idempotencyKey,
            status: p.status,
            attempts: p.attempts,
            max_attempts: p.maxAttempts,
            next_attempt_at: p.nextAttemptAt,
            lease_until: p.leaseUntil,
            lease_token: p.leaseToken,
            last_error: p.lastError,
            external_ref: p.externalRef,
            ack: p.ack ? JSON.stringify(p.ack) : null,
            created_at: p.createdAt,
            updated_at: p.updatedAt,
          })
          .execute();
      },

      async get(id) {
        const r = await db.selectFrom('publications').selectAll().where('id', '=', id).executeTakeFirst();
        return r ? toPublication(r) : null;
      },

      async forRevision(announcementId, revision) {
        const r = await db
          .selectFrom('publications')
          .selectAll()
          .where('announcement_id', '=', announcementId)
          .where('revision', '=', revision)
          .executeTakeFirst();
        return r ? toPublication(r) : null;
      },

      async update(id, patch, at) {
        await db
          .updateTable('publications')
          .set({ ...publicationColumns(patch), updated_at: at })
          .where('id', '=', id)
          .execute();
      },

      async claim(id, now, leaseMs, token) {
        const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
        const res = await db
          .updateTable('publications')
          .set({
            status: 'in_flight',
            lease_token: token,
            lease_until: leaseUntil,
            attempts: sql<number>`attempts + 1`,
            updated_at: now,
          })
          .where('id', '=', id)
          .where((eb) =>
            eb.or([
              eb.and([eb('status', 'in', ['pending', 'retry']), eb('next_attempt_at', '<=', now)]),
              eb.and([eb('status', '=', 'in_flight'), eb('lease_until', '<', now)]),
            ]),
          )
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) return null;
        return tx.publications.get(id);
      },

      async finish(id, token, patch, at) {
        const res = await db
          .updateTable('publications')
          .set({ ...publicationColumns(patch), lease_token: null, lease_until: null, updated_at: at })
          .where('id', '=', id)
          .where('lease_token', '=', token)
          .where('status', '=', 'in_flight')
          .executeTakeFirst();
        return Number(res.numUpdatedRows) === 1;
      },

      async listByIssuer(issuerId, limit) {
        const rows = await db
          .selectFrom('publications')
          .innerJoin('announcements', 'announcements.id', 'publications.announcement_id')
          .innerJoin('revisions', (j) =>
            j.onRef('revisions.announcement_id', '=', 'publications.announcement_id').onRef('revisions.number', '=', 'publications.revision'),
          )
          .selectAll('publications')
          .select(['announcements.jurisdiction', 'revisions.headline'])
          .where('publications.issuer_id', '=', issuerId)
          .orderBy('publications.updated_at', 'desc')
          .limit(limit)
          .execute();
        return rows.map((r) => ({
          id: r.id,
          announcementId: r.announcement_id,
          jurisdiction: r.jurisdiction,
          headline: r.headline,
          revision: r.revision,
          status: r.status as Publication['status'],
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
          nextAttemptAt: r.next_attempt_at,
          lastError: r.last_error,
          externalRef: r.external_ref,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
      },

      async overdue(now, graceMs, limit) {
        const dueBefore = new Date(Date.parse(now) - graceMs).toISOString();
        const rows = await db
          .selectFrom('publications')
          .selectAll()
          .where((eb) =>
            eb.or([
              eb.and([eb('status', 'in', ['pending', 'retry']), eb('next_attempt_at', '<=', dueBefore)]),
              eb.and([eb('status', '=', 'in_flight'), eb('lease_until', '<', now)]),
            ]),
          )
          .orderBy('next_attempt_at')
          .limit(limit)
          .execute();
        return rows.map(toPublication);
      },
    },

    audit: {
      async recent(issuerId, limit) {
        const rows = await db
          .selectFrom('audit_events')
          .innerJoin('announcements', 'announcements.id', 'audit_events.announcement_id')
          .innerJoin('revisions', (j) =>
            j.onRef('revisions.announcement_id', '=', 'announcements.id').onRef('revisions.number', '=', 'announcements.current_revision'),
          )
          .select([
            'audit_events.announcement_id',
            'audit_events.type',
            'audit_events.actor_id',
            'audit_events.at',
            'audit_events.data',
            'announcements.jurisdiction',
            'revisions.headline',
          ])
          .where('audit_events.issuer_id', '=', issuerId)
          .orderBy('audit_events.at', 'desc')
          .orderBy('audit_events.seq', 'desc')
          .limit(limit)
          .execute();
        return rows.map((r) => {
          const data = json<Record<string, unknown>>(r.data);
          return {
            announcementId: r.announcement_id,
            headline: r.headline,
            jurisdiction: r.jurisdiction,
            type: r.type,
            actorId: r.actor_id,
            at: r.at,
            revision: typeof data.revision === 'number' ? data.revision : null,
          };
        });
      },
      async append(e, at) {
        const last = await db
          .selectFrom('audit_events')
          .select(['seq', 'hash'])
          .where('announcement_id', '=', e.announcementId)
          .orderBy('seq', 'desc')
          .limit(1)
          .executeTakeFirst();
        const seq = (last?.seq ?? 0) + 1;
        const prevHash = last?.hash ?? GENESIS_HASH;
        const hash = auditHash(prevHash, {
          announcementId: e.announcementId,
          seq,
          type: e.type,
          actorId: e.actorId,
          at,
          data: e.data,
        });
        const event: AuditEvent = { id: randomUUID(), seq, at, prevHash, hash, ...e };
        try {
          await db
            .insertInto('audit_events')
            .values({
              id: event.id,
              announcement_id: event.announcementId,
              issuer_id: event.issuerId,
              seq,
              type: event.type,
              actor_id: event.actorId,
              at,
              data: JSON.stringify(event.data),
              prev_hash: prevHash,
              hash,
            })
            .execute();
        } catch (err) {
          // Two writers read the same last entry (a person and an advisory agent, say): the loser retries in `runTx`.
          if (isUniqueViolation(err)) throw conflict(AUDIT_SEQ_CONFLICT, 'Concurrent change detected while recording the audit trail');
          throw err;
        }
        return event;
      },
      async list(announcementId) {
        return (
          await db.selectFrom('audit_events').selectAll().where('announcement_id', '=', announcementId).orderBy('seq').execute()
        ).map(toAudit);
      },
    },

    aiReports: {
      async insert(r) {
        await db
          .insertInto('ai_reports')
          .values({
            id: r.id,
            announcement_id: r.announcementId,
            revision: r.revision,
            provider: r.provider,
            report: JSON.stringify(r.report),
            at: r.at,
            agent: r.agent,
            event_id: r.eventId,
          })
          .execute();
      },
      async latest(announcementId, agent = 'precheck') {
        const r = await db
          .selectFrom('ai_reports')
          .selectAll()
          .where('announcement_id', '=', announcementId)
          .where('agent', '=', agent)
          .orderBy('at', 'desc')
          .limit(1)
          .executeTakeFirst();
        return r ? toAiReport(r) : null;
      },
      async forEvent(agent, eventId) {
        const r = await db.selectFrom('ai_reports').selectAll().where('agent', '=', agent).where('event_id', '=', eventId).executeTakeFirst();
        return r ? toAiReport(r) : null;
      },
      async forRevision(announcementId, revision) {
        const rows = await db
          .selectFrom('ai_reports')
          .selectAll()
          .where('announcement_id', '=', announcementId)
          .where('revision', '=', revision)
          .orderBy('at')
          .execute();
        return rows.map(toAiReport);
      },
    },

    settings: {
      async get(key) {
        const r = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
        return r?.value ?? null;
      },
      async set(key, value) {
        await db
          .insertInto('settings')
          .values({ key, value })
          .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
          .execute();
      },
    },

    events: buildEventsStore(db),
    subscriptions: buildSubscriptionsStore(db),
    notifications: buildNotificationsStore(db),
  };
  return tx;
}

const toAiReport = (r: Row<'ai_reports'>): AiReportRecord => ({
  id: r.id,
  announcementId: r.announcement_id,
  revision: r.revision,
  provider: r.provider,
  report: json(r.report),
  at: r.at,
  agent: r.agent,
  eventId: r.event_id,
});

const toActor = (r: Row<'users'>): Actor => ({ id: r.id, name: r.name, issuerId: r.issuer_id, roles: json(r.roles) });
const toIssuer = (r: Row<'issuers'>): Issuer => ({ id: r.id, name: r.name, profiles: json(r.profiles) });

const AUDIT_SEQ_CONFLICT = 'AUDIT_SEQ_CONFLICT';
const AUDIT_RETRIES = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a transaction, and re-runs it when it lost a race for the next audit sequence number. The audit chain of one
 * announcement is linear, and a person's step and an agent's report can both want the next slot; the loser has rolled
 * back, so running it again re-reads the state and either succeeds or fails on its own merits (a real conflict, such
 * as a changed version, is a different error and is never retried).
 */
async function runTx<T>(db: Kysely<DB>, fn: (tx: StoreTx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().execute((trx) => fn(buildTx(trx)));
    } catch (err) {
      if (!(err instanceof DomainError) || err.code !== AUDIT_SEQ_CONFLICT) throw err;
      if (attempt >= AUDIT_RETRIES) throw conflict('CONCURRENT_UPDATE', 'Concurrent change detected while recording the audit trail');
      await sleep(attempt * 3 + Math.random() * 10);
    }
  }
}

export function createStore(db: Kysely<DB>): Store {
  return {
    read: buildTx(db),
    tx: (fn) => runTx(db, fn),
    close: () => db.destroy(),
    async stats(now) {
      const count = async (table: 'publications' | 'announcements') => {
        const rows = await db.selectFrom(table).select(['status', (eb) => eb.fn.countAll<string>().as('n')]).groupBy('status').execute();
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      };
      const oldest = await db
        .selectFrom('publications')
        .select((eb) => eb.fn.min('next_attempt_at').as('at'))
        .where('status', 'in', ['pending', 'retry'])
        .executeTakeFirst();
      const deliveries = await db.selectFrom('event_deliveries').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).groupBy('status').execute();
      const byStatus = Object.fromEntries(deliveries.map((r) => [r.status, Number(r.n)]));
      const oldestDelivery = await db
        .selectFrom('event_deliveries')
        .select((eb) => eb.fn.min('next_attempt_at').as('at'))
        .where('status', '=', 'pending')
        .where('next_attempt_at', '<=', now)
        .executeTakeFirst();
      return {
        publicationsByStatus: await count('publications'),
        announcementsByStatus: await count('announcements'),
        oldestWaitingSeconds: oldest?.at ? Math.max(0, (Date.parse(now) - Date.parse(oldest.at as string)) / 1000) : 0,
        events: {
          pendingDeliveries: byStatus.pending ?? 0,
          deadDeliveries: byStatus.dead ?? 0,
          oldestPendingSeconds: oldestDelivery?.at ? Math.max(0, (Date.parse(now) - Date.parse(oldestDelivery.at as string)) / 1000) : 0,
        },
      };
    },
  };
}
