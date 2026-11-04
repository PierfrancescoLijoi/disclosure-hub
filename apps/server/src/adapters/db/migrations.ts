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

  // Events, consumers, readers. The outbox is written in the same transaction as the state
  // change; deliveries are leased like publications, one row per event and consumer.
  '003_events_and_readers': {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('domain_events')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('type', text, (c) => c.notNull())
        .addColumn('issuer_id', text, (c) => c.notNull())
        .addColumn('aggregate_id', text, (c) => c.notNull())
        .addColumn('payload', text, (c) => c.notNull())
        .addColumn('created_at', text, (c) => c.notNull())
        .execute();
      await db.schema.createIndex('domain_events_by_aggregate').on('domain_events').columns(['aggregate_id', 'created_at']).execute();

      await db.schema
        .createTable('event_deliveries')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('event_id', text, (c) => c.notNull().references('domain_events.id'))
        .addColumn('consumer', text, (c) => c.notNull())
        .addColumn('status', text, (c) => c.notNull())
        .addColumn('attempts', int, (c) => c.notNull())
        .addColumn('next_attempt_at', text, (c) => c.notNull())
        .addColumn('lease_until', text)
        .addColumn('lease_token', text)
        .addColumn('last_error', text)
        .addColumn('updated_at', text, (c) => c.notNull())
        .addUniqueConstraint('event_deliveries_once', ['event_id', 'consumer'])
        .execute();
      await sql`create index event_deliveries_waiting on event_deliveries (consumer, next_attempt_at) where status = 'pending'`.execute(db);
      await sql`create index event_deliveries_leased on event_deliveries (lease_until) where status = 'in_flight'`.execute(db);

      await db.schema
        .createTable('subscriptions')
        .addColumn('id', text, (c) => c.primaryKey())
        .addColumn('kind', text, (c) => c.notNull())
        .addColumn('target', text, (c) => c.notNull())
        .addColumn('issuer_id', text)
        .addColumn('jurisdiction', text)
        .addColumn('category', text)
        .addColumn('status', text, (c) => c.notNull())
        .addColumn('created_at', text, (c) => c.notNull())
        .addColumn('confirmed_at', text)
        .execute();
      await sql`create index subscriptions_active on subscriptions (issuer_id, jurisdiction, category) where status = 'active'`.execute(db);
      await db.schema.createIndex('subscriptions_by_target').on('subscriptions').columns(['kind', 'target']).execute();

      await db.schema
        .createTable('notifications')
        .addColumn('subscription_id', text, (c) => c.notNull().references('subscriptions.id'))
        .addColumn('announcement_id', text, (c) => c.notNull())
        .addColumn('status', text, (c) => c.notNull())
        .addColumn('attempts', int, (c) => c.notNull())
        .addColumn('last_error', text)
        .addColumn('at', text, (c) => c.notNull())
        .addPrimaryKeyConstraint('notifications_pk', ['subscription_id', 'announcement_id'])
        .execute();

      // Every agent writes its advisory report here; the pre-check was the first one.
      await db.schema.alterTable('ai_reports').addColumn('agent', text, (c) => c.notNull().defaultTo('precheck')).execute();
      await db.schema.alterTable('ai_reports').addColumn('event_id', text).execute();
      await sql`create unique index ai_reports_once_per_event on ai_reports (agent, event_id) where event_id is not null`.execute(db);
    },
  },

  // The public archive lists published announcements newest first. Without this index every listing sorts every
  // published announcement (local PostgreSQL, npm run bench:readers: 40 ms at 10,000 rows, 506 ms at 100,000); with it
  // the first page reads 20 index entries (5 ms and 2 ms). Searching by word still scans the bodies (docs/SIZING.md).
  '004_public_archive_order': {
    async up(db: Kysely<any>) {
      await sql`create index publications_published on publications (updated_at desc, announcement_id desc) where status = 'acked' and external_ref is not null`.execute(db);
    },
  },
};
