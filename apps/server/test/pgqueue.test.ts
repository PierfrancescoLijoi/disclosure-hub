import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaosKey } from '../src/adapters/gateways/mock.js';
import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { fx, makeEnv, silent, type Env } from './helpers.js';

/** The database-backed queue, exercised through the same service and runner. Needs TEST_PG_URL. */
const PG = process.env.TEST_PG_URL;

let env: Env;
let extra: Runtime | undefined;
beforeEach(async () => {
  if (!PG) return;
  env = await makeEnv({ env: { QUEUE_URL: 'pg', RETRY_BASE_MS: '50', RETRY_MAX_MS: '200', LEASE_MS: '400' } });
});
afterEach(async () => {
  await extra?.close();
  extra = undefined;
  if (PG) await env.close();
});

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const approved = async (input = fx.ukGeneral(), approvers = [env.actors.bob]) => {
  const { id } = await env.svc.create(env.actors.alice, input);
  await env.svc.validate(env.actors.alice, id);
  await env.svc.submit(env.actors.alice, id);
  for (const a of approvers) await env.svc.approve(a, id);
  return id;
};
const status = async (id: string) => (await env.svc.get(env.actors.erin, id)).announcement.status;
const receipts = (channel: string) => env.rt.db.selectFrom('ext_receipts').selectAll().where('channel', '=', channel).execute();

describe.skipIf(!PG)('PostgreSQL LISTEN/NOTIFY queue', () => {
  it('publishes without any other service', async () => {
    const id = await approved();
    await env.svc.publish(env.actors.erin, id);
    await until(() => status(id), (s) => s === 'published');
    expect(await receipts('rns')).toHaveLength(1);
  });

  it('retries with a delayed wake-up and still releases exactly once', async () => {
    await env.rt.store.read.settings.set(chaosKey('edgar'), JSON.stringify({ mode: 'transient', failuresRemaining: 2 }));
    const id = await approved(fx.usOther(), [env.actors.carol, env.actors.bob]);
    await env.svc.publish(env.actors.erin, id);
    await until(() => status(id), (s) => s === 'published');
    expect((await env.svc.get(env.actors.erin, id)).publication?.attempts).toBe(3);
    expect(await receipts('edgar')).toHaveLength(1);
  });

  it('shares work between two worker processes without double publishing', async () => {
    extra = await createRuntime(
      loadConfig({ ROLE: 'worker', DATABASE_URL: PG!, QUEUE_URL: 'pg', AUTO_MIGRATE: '0', DEMO: '0', RETRY_BASE_MS: '50', RETRY_MAX_MS: '200' }),
      { log: silent },
    );
    await extra.start();

    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await approved({ ...fx.ukGeneral(), headline: `Notice ${i}` }));
    await Promise.all(ids.map((id) => env.svc.publish(env.actors.erin, id)));
    await until(async () => Promise.all(ids.map(status)), (s) => s.every((x) => x === 'published'));

    expect(await receipts('rns')).toHaveLength(8);
    const refs = (await env.rt.db.selectFrom('publications').select('external_ref').execute()).map((r) => r.external_ref);
    expect(new Set(refs).size).toBe(8);
  });

  it('recovers the listener after its connection is killed', async () => {
    const id1 = await approved();
    await env.svc.publish(env.actors.erin, id1);
    await until(() => status(id1), (s) => s === 'published');

    // Terminate every other session on the database: the listener's connection included.
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database()`.execute(env.rt.db).catch(() => undefined);

    const id2 = await approved({ ...fx.ukGeneral(), headline: 'After the outage' });
    await env.svc.publish(env.actors.erin, id2);
    // A notification sent while the listener is down is lost by design; the sweeper (here driven by hand,
    // as the worker does on a timer) re-sends it until the listener is back.
    await until(
      async () => {
        await env.rt.runner.sweep();
        return status(id2);
      },
      (s) => s === 'published',
      15_000,
    );
    expect(await receipts('rns')).toHaveLength(2);
  });
});
