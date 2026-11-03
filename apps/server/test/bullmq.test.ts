import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaosKey } from '../src/adapters/gateways/mock.js';
import { loadConfig } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { fx, makeEnv, silent, type Env } from './helpers.js';

/**
 * Redis/BullMQ adapter, exercised through the same service and runner. Needs TEST_REDIS_URL;
 * the two-worker test also needs TEST_PG_URL so both processes see one database.
 */
const REDIS = process.env.TEST_REDIS_URL;
const PG = process.env.TEST_PG_URL;

let env: Env;
let extra: Runtime | undefined;
beforeEach(async () => {
  const r = new Redis(REDIS!);
  await r.flushdb();
  r.disconnect();
  env = await makeEnv({ env: { QUEUE_URL: REDIS!, RETRY_BASE_MS: '50', RETRY_MAX_MS: '200' } });
});
afterEach(async () => {
  await extra?.close();
  extra = undefined;
  await env.close();
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

describe.skipIf(!REDIS)('BullMQ queue', () => {
  it('publishes through Redis', async () => {
    const id = await approved();
    await env.svc.publish(env.actors.erin, id);
    await until(() => status(id), (s) => s === 'published');
    expect(await receipts('rns')).toHaveLength(1);
  });

  it('retries with a delayed job and still releases exactly once', async () => {
    await env.rt.store.read.settings.set(chaosKey('edgar'), JSON.stringify({ mode: 'transient', failuresRemaining: 2 }));
    const id = await approved(fx.usOther(), [env.actors.carol, env.actors.bob]);
    await env.svc.publish(env.actors.erin, id);
    await until(() => status(id), (s) => s === 'published');
    expect((await env.svc.get(env.actors.erin, id)).publication?.attempts).toBe(3);
    expect(await receipts('edgar')).toHaveLength(1);
  });

  it.skipIf(!PG)('shares work between two worker processes without double publishing', async () => {
    extra = await createRuntime(
      loadConfig({ ROLE: 'worker', DATABASE_URL: PG!, QUEUE_URL: REDIS!, AUTO_MIGRATE: '0', DEMO: '0', RETRY_BASE_MS: '50', RETRY_MAX_MS: '200' }),
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
});
