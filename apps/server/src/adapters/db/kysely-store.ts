import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { conflict } from '../../domain/errors.js';
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
import type { Store, StoreTx } from '../../ports/index.js';
import type { DB } from './schema.js';

type Row<T extends keyof DB> = Selectable<DB[T]>;
const json = <T>(s: string): T => JSON.parse(s) as T;

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
          items: page.map((r) => ({ ...toAnnouncement(r), headline: r.headline })),
          nextCursor:
            rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
        };
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
          if (isUniqueViolation(err)) throw conflict('CONCURRENT_UPDATE', 'Concurrent change detected while recording the audit trail');
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
          })
          .execute();
      },
      async latest(announcementId) {
        const r = await db
          .selectFrom('ai_reports')
          .selectAll()
          .where('announcement_id', '=', announcementId)
          .orderBy('at', 'desc')
          .limit(1)
          .executeTakeFirst();
        return r
          ? { id: r.id, announcementId: r.announcement_id, revision: r.revision, provider: r.provider, report: json(r.report), at: r.at }
          : null;
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
  };
  return tx;
}

const toActor = (r: Row<'users'>): Actor => ({ id: r.id, name: r.name, issuerId: r.issuer_id, roles: json(r.roles) });
const toIssuer = (r: Row<'issuers'>): Issuer => ({ id: r.id, name: r.name, profiles: json(r.profiles) });

export function createStore(db: Kysely<DB>): Store {
  return {
    read: buildTx(db),
    tx: (fn) => db.transaction().execute((trx) => fn(buildTx(trx))),
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
      return {
        publicationsByStatus: await count('publications'),
        announcementsByStatus: await count('announcements'),
        oldestWaitingSeconds: oldest?.at ? Math.max(0, (Date.parse(now) - Date.parse(oldest.at as string)) / 1000) : 0,
      };
    },
  };
}
