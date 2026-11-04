/**
 * Local measurements of the three places the database could become the bottleneck: the public archive search,
 * the event outbox, and the reader fan-out. No HTTP, no sign-in: the runtime is built directly, so the numbers
 * are the database and the code, not the network.
 *
 *   DATABASE_URL=postgres://hub:hub@localhost:5432/hub npm run bench:readers -w apps/server
 *   SIZES=10000,100000 FOLLOWERS=10000 SEND_MS=20 EVENTS=5000 npm run bench:readers -w apps/server
 *
 * It DROPS and recreates the public schema (PostgreSQL), so point it at a scratch database. A laptop with a
 * container database is not Azure: these figures show the shape (what grows with what), docs/SIZING.md says so.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { loadConfig } from './config.js';
import { connect } from './adapters/db/connect.js';
import { createRuntime, consoleLogger } from './runtime.js';
import { ChannelRegistry, type NotificationChannel, type OutboundMessage } from './ports/index.js';
import { EVENT } from './domain/events.js';

const URL = process.env.DATABASE_URL ?? 'sqlite::memory:';
const SIZES = (process.env.SIZES ?? '10000,100000').split(',').map(Number);
const FOLLOWERS = Number(process.env.FOLLOWERS ?? 10_000);
const SEND_MS = Number(process.env.SEND_MS ?? 20);
const EVENTS = Number(process.env.EVENTS ?? 5000);
const BATCH = 1000;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const quiet = { info() {}, warn() {}, error: consoleLogger.error };
const iso = (ms: number) => new Date(ms).toISOString();

async function fresh() {
  const connection = connect(URL);
  if (connection.dialect === 'postgres') {
    await sql`drop schema public cascade`.execute(connection.db);
    await sql`create schema public`.execute(connection.db);
  }
  return connection;
}

class SlowChannel implements NotificationChannel {
  readonly kind = 'email' as const;
  readonly name = 'bench';
  sent = 0;
  async send(_m: OutboundMessage) {
    await new Promise((r) => setTimeout(r, SEND_MS));
    this.sent++;
  }
}

async function main() {
  const connection = await fresh();
  const channel = new SlowChannel();
  const config = loadConfig({ DATABASE_URL: URL, QUEUE_URL: 'inproc', DEMO: '1', ROLE: 'all', SWEEP_INTERVAL_MS: '600000', REACTOR_POLL_MS: '600000', NOTIFY_CHUNK: '1000' });
  const rt = await createRuntime(config, { connection, log: quiet, channels: new ChannelRegistry().register(channel) });
  const db = rt.db;
  console.log(`database             ${connection.dialect}`);

  // ------------------------------------------------------------ 1. public archive: latency against archive size
  let seeded = 0;
  const WORDS = ['dividend', 'acquisition', 'director', 'results', 'placing', 'trading', 'update', 'notice', 'holding', 'buyback'];
  for (const size of SIZES) {
    while (seeded < size) {
      const n = Math.min(BATCH, size - seeded);
      const rows = Array.from({ length: n }, (_, k) => {
        const i = seeded + k;
        const id = `bench-${i}`;
        const at = iso(Date.UTC(2024, 0, 1) + i * 60_000);
        const word = WORDS[i % WORDS.length]!;
        return {
          a: { id, issuer_id: 'northwind', jurisdiction: i % 5 === 0 ? 'US' : 'UK', category: 'general', status: 'published', current_revision: 1, version: 1, created_by: 'alice', created_at: at, updated_at: at, idempotency_key: null, approval_requirement: null, failure_reason: null },
          r: { announcement_id: id, number: 1, headline: `Northwind ${word} notice ${i}`, body: `The Board of Northwind Energy plc announces a ${word} matter number ${i}. `.repeat(8), metadata: '{}', content_hash: 'h', author_id: 'alice', created_at: at },
          p: { id: `bp-${i}`, announcement_id: id, issuer_id: 'northwind', revision: 1, idempotency_key: `bk-${i}`, status: 'acked', attempts: 1, max_attempts: 5, next_attempt_at: at, lease_until: null, lease_token: null, last_error: null, external_ref: `ref-${i}`, ack: '{}', created_at: at, updated_at: at },
        };
      });
      await db.insertInto('announcements').values(rows.map((r) => r.a)).execute();
      await db.insertInto('revisions').values(rows.map((r) => r.r)).execute();
      await db.insertInto('publications').values(rows.map((r) => r.p)).execute();
      seeded += n;
    }
    if (connection.dialect === 'postgres') await sql`analyze`.execute(db);
    const cases: [string, () => Promise<unknown>][] = [
      ['latest 20, no filter', () => rt.store.read.announcements.publicFeed({ limit: 20 })],
      ['latest 20, one jurisdiction', () => rt.store.read.announcements.publicFeed({ limit: 20, jurisdiction: 'US' })],
      ['one common word', () => rt.store.read.announcements.publicFeed({ limit: 20, q: 'northwind' })],
      ['one rare word', () => rt.store.read.announcements.publicFeed({ limit: 20, q: `matter number ${size - 3}` })],
      ['word that matches nothing', () => rt.store.read.announcements.publicFeed({ limit: 20, q: 'zzzqqq' })],
    ];
    console.log(`\npublic archive: ${size} published announcements`);
    for (const [name, run] of cases) {
      const ms: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        await run();
        ms.push(performance.now() - t0);
      }
      console.log(`  ${name.padEnd(30)} p50 ${pct(ms, 0.5).toFixed(0).padStart(6)} ms   p95 ${pct(ms, 0.95).toFixed(0).padStart(6)} ms`);
    }
  }

  // ------------------------------------------------------------ 2. event outbox: claim and complete throughput
  const consumers = ['bench-a'];
  const at0 = iso(Date.now());
  for (let done = 0; done < EVENTS; done += BATCH) {
    const n = Math.min(BATCH, EVENTS - done);
    const events = Array.from({ length: n }, () => ({ id: randomUUID(), type: 'bench.event', issuerId: 'northwind', aggregateId: 'bench-0', payload: {}, at: at0 }));
    for (const e of events) await rt.store.tx((tx) => tx.events.insert(e, consumers, at0));
  }
  for (const claimers of [1, 4]) {
    // put them back to pending between runs
    await db.updateTable('event_deliveries').set({ status: 'pending', lease_token: null, lease_until: null }).execute();
    const t0 = performance.now();
    let total = 0;
    await Promise.all(
      Array.from({ length: claimers }, async () => {
        const token = randomUUID();
        for (;;) {
          const batch = await rt.store.read.events.claim(consumers, iso(Date.now()), 60_000, token, 50);
          if (batch.length === 0) return;
          for (const d of batch) await rt.store.read.events.complete(d.id, token, iso(Date.now()));
          total += batch.length;
        }
      }),
    );
    const s = (performance.now() - t0) / 1000;
    console.log(`\noutbox: ${claimers} claimer(s), ${total} deliveries claimed and completed in ${s.toFixed(1)} s  ->  ${(total / s).toFixed(0)} per second`);
  }
  const t1 = performance.now();
  const pruned = await rt.store.read.events.prune(iso(Date.now() + 86_400_000), BATCH);
  console.log(`outbox prune: one pass removed ${pruned.deliveries} deliveries and ${pruned.events} events in ${(performance.now() - t1).toFixed(0)} ms`);

  // ------------------------------------------------------------ 3. reader fan-out: followers told per second
  for (let done = 0; done < FOLLOWERS; done += BATCH) {
    const n = Math.min(BATCH, FOLLOWERS - done);
    await db
      .insertInto('subscriptions')
      .values(Array.from({ length: n }, (_, k) => ({ id: `sub-${String(done + k).padStart(8, '0')}`, kind: 'email', target: `reader${done + k}@example.com`, issuer_id: null, jurisdiction: null, category: null, status: 'active', created_at: at0, confirmed_at: at0 })))
      .execute();
  }
  const target = 'bench-0';
  await rt.store.tx((tx) => rt.events.emit(tx, { type: EVENT.published, issuerId: 'northwind', aggregateId: target, payload: {} }));
  const t2 = performance.now();
  let passes = 0;
  for (;;) {
    const n = await rt.reactor.drain(1);
    passes++;
    if (n === 0 && channel.sent >= FOLLOWERS) break;
    if (n === 0) {
      console.log(`fan-out stalled at ${channel.sent} of ${FOLLOWERS}`);
      break;
    }
  }
  const s2 = (performance.now() - t2) / 1000;
  const continuations = await db.selectFrom('domain_events').select(sql<number>`count(*)`.as('n')).where('type', '=', EVENT.notifyContinue).executeTakeFirst();
  console.log(`\nfan-out: ${channel.sent} followers told in ${s2.toFixed(1)} s (${passes} reactor passes, ${Number(continuations?.n ?? 0)} continuations)  ->  ${(channel.sent / s2).toFixed(0)} per second`);
  console.log(`         send time ${SEND_MS} ms each, 10 sends at a time: ceiling ${(10 / (SEND_MS / 1000)).toFixed(0)} per second for one consumer process`);

  await rt.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
