import { sql, type Kysely, type Migration } from 'kysely';

const text = 'text' as const;
const int = 'integer' as const;

/** Same DDL for both dialects: one migration path, no per-database branches. */
export const migrations: Record<string, Migration> = {
  '001_init': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('issuers')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('name', text, (c) => c.notNull())
        .addColumn('profiles', text, (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('users')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('issuer_id', text, (c) => c.notNull().references('issuers.id'))
        .addColumn('name', text, (c) => c.notNull())
        .addColumn('roles', text, (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('announcements')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('issuer_id', text, (c) => c.notNull().references('issuers.id'))
        .addColumn('jurisdiction', text, (c) => c.notNull())
        .addColumn('category', text, (c) => c.notNull())
        .addColumn('status', text, (c) => c.notNull())
        .addColumn('current_revision', int, (c) => c.notNull())
        .addColumn('version', int, (c) => c.notNull())
        .addColumn('created_by', text, (c) => c.notNull())
        .addColumn('created_at', text, (c) => c.notNull())
        .addColumn('updated_at', text, (c) => c.notNull())
        .addColumn('idempotency_key', text)
        .addColumn('approval_requirement', text)
        .addColumn('failure_reason', text)
        .addUniqueConstraint('announcements_idem', ['issuer_id', 'idempotency_key'])
        .execute();
      await db.schema
        .createIndex('announcements_by_issuer')
        .on('announcements')
        .columns(['issuer_id', 'created_at', 'id'])
        .execute();

      await db.schema
        .createTable('revisions')
        .addColumn('announcement_id', text, (c) => c.notNull().references('announcements.id'))
        .addColumn('number', int, (c) => c.notNull())
        .addColumn('headline', text, (c) => c.notNull())
        .addColumn('body', text, (c) => c.notNull())
        .addColumn('metadata', text, (c) => c.notNull())
        .addColumn('content_hash', text, (c) => c.notNull())
        .addColumn('author_id', text, (c) => c.notNull())
        .addColumn('created_at', text, (c) => c.notNull())
        .addPrimaryKeyConstraint('revisions_pk', ['announcement_id', 'number'])
        .execute();

      await db.schema
        .createTable('validations')
        .addColumn('announcement_id', text, (c) => c.notNull().references('announcements.id'))
        .addColumn('revision', int, (c) => c.notNull())
        .addColumn('ok', int, (c) => c.notNull())
        .addColumn('issues', text, (c) => c.notNull())
        .addColumn('at', text, (c) => c.notNull())
        .addPrimaryKeyConstraint('validations_pk', ['announcement_id', 'revision'])
        .execute();

      await db.schema
        .createTable('approvals')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('announcement_id', text, (c) => c.notNull().references('announcements.id'))
        .addColumn('revision', int, (c) => c.notNull())
        .addColumn('content_hash', text, (c) => c.notNull())
        .addColumn('approver_id', text, (c) => c.notNull())
        .addColumn('roles', text, (c) => c.notNull())
        .addColumn('decision', text, (c) => c.notNull())
        .addColumn('comment', text, (c) => c.notNull())
        .addColumn('at', text, (c) => c.notNull())
        .addColumn('voided_at', text)
        .execute();
      await db.schema.createIndex('approvals_by_revision').on('approvals').columns(['announcement_id', 'revision']).execute();

      await db.schema
        .createTable('publications')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('announcement_id', text, (c) => c.notNull().references('announcements.id'))
        .addColumn('issuer_id', text, (c) => c.notNull())
        .addColumn('revision', int, (c) => c.notNull())
        .addColumn('idempotency_key', text, (c) => c.notNull().unique())
        .addColumn('status', text, (c) => c.notNull())
        .addColumn('attempts', int, (c) => c.notNull())
        .addColumn('max_attempts', int, (c) => c.notNull())
        .addColumn('next_attempt_at', text, (c) => c.notNull())
        .addColumn('lease_until', text)
        .addColumn('lease_token', text)
        .addColumn('last_error', text)
        .addColumn('external_ref', text)
        .addColumn('ack', text)
        .addColumn('created_at', text, (c) => c.notNull())
        .addColumn('updated_at', text, (c) => c.notNull())
        .addUniqueConstraint('publications_per_revision', ['announcement_id', 'revision'])
        .execute();
      await db.schema.createIndex('publications_due').on('publications').columns(['status', 'next_attempt_at']).execute();

      await db.schema
        .createTable('audit_events')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('announcement_id', text, (c) => c.notNull().references('announcements.id'))
        .addColumn('issuer_id', text, (c) => c.notNull())
        .addColumn('seq', int, (c) => c.notNull())
        .addColumn('type', text, (c) => c.notNull())
        .addColumn('actor_id', text, (c) => c.notNull())
        .addColumn('at', text, (c) => c.notNull())
        .addColumn('data', text, (c) => c.notNull())
        .addColumn('prev_hash', text, (c) => c.notNull())
        .addColumn('hash', text, (c) => c.notNull())
        .addUniqueConstraint('audit_chain_position', ['announcement_id', 'seq'])
        .execute();

      await db.schema
        .createTable('ai_reports')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('announcement_id', text, (c) => c.notNull().references('announcements.id'))
        .addColumn('revision', int, (c) => c.notNull())
        .addColumn('provider', text, (c) => c.notNull())
        .addColumn('report', text, (c) => c.notNull())
        .addColumn('at', text, (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('settings')
        .addColumn('key', text, (c) => c.primaryKey())
        .addColumn('value', text, (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('ext_receipts')
        .addColumn('channel', text, (c) => c.notNull())
        .addColumn('seq', int, (c) => c.notNull())
        .addColumn('idempotency_key', text, (c) => c.notNull())
        .addColumn('external_ref', text, (c) => c.notNull())
        .addColumn('accepted_at', text, (c) => c.notNull())
        .addColumn('filing_date', text)
        .addColumn('detail', text, (c) => c.notNull())
        .addPrimaryKeyConstraint('ext_receipts_pk', ['channel', 'seq'])
        .addUniqueConstraint('ext_receipts_idem', ['channel', 'idempotency_key'])
        .execute();
    },
  },

  // The sweeper and the claim only ever look at non-terminal rows. Partial indexes keep them
  // small and fast however many publications have already reached a final state.
  '002_partial_indexes': {
    async up(db: Kysely<any>) {
      await sql`create index publications_waiting on publications (next_attempt_at) where status in ('pending', 'retry')`.execute(db);
      await sql`create index publications_leased on publications (lease_until) where status = 'in_flight'`.execute(db);
    },
  },
};
