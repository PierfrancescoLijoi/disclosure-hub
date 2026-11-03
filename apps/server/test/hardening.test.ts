import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { defaultPolicies } from '../src/jurisdictions/index.js';
import { GatewayRegistry, type PublishGateway } from '../src/ports/index.js';
import { fx, makeEnv, type Env } from './helpers.js';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const code = async (p: Promise<unknown>) => p.then(() => undefined, (e: { code?: string; status?: number }) => `${e.status} ${e.code}`);

describe('approval is bound to what the approver reviewed', () => {
  it('refuses an approval for a revision that has since been replaced', async () => {
    env = await makeEnv();
    const { alice, bob, carol } = env.actors;
    const { id } = await env.svc.create(alice, fx.usOther());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);

    // Bob opens revision 1; meanwhile changes are requested and revision 2 is resubmitted.
    await env.svc.requestChanges(carol, id, 'Add the buy-back size');
    await env.svc.saveRevision(alice, id, { ...fx.usOther(), body: `${fx.usOther().body} Buy-back size: 10m shares.` });
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    expect((await env.svc.get(alice, id)).announcement.currentRevision).toBe(2);

    expect(await code(env.svc.approve(bob, id, '', 1))).toBe('409 STALE_REVISION');
    expect(await env.svc.approve(bob, id, '', 2)).toMatchObject({ complete: false });
  });
});

describe('a gateway that never answers', () => {
  it('times out as a transient failure and frees the channel instead of hanging the worker', async () => {
    let calls = 0;
    const hanging: PublishGateway = {
      channel: 'rns',
      find: async () => null,
      submit: () => {
        calls++;
        return new Promise(() => undefined);
      },
    };
    env = await makeEnv({
      policies: defaultPolicies(),
      gateways: new GatewayRegistry().register(hanging),
      env: { LEASE_MS: '200', MAX_ATTEMPTS: '2' },
    });
    const { alice, bob, erin } = env.actors;
    const { id } = await env.svc.create(alice, fx.ukGeneral());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    await env.svc.approve(bob, id);
    await env.svc.publish(erin, id);
    await env.settle();

    const view = await env.svc.get(erin, id);
    expect(calls).toBe(2);
    expect(view.announcement).toMatchObject({ status: 'failed' });
    expect(view.announcement.failureReason).toContain('GATEWAY_TIMEOUT');
    expect(view.publication?.status).toBe('exhausted');
  });
});

describe('operational limits', () => {
  it('limits requests per actor, not per address', async () => {
    env = await makeEnv({ env: { RATE_LIMIT_PER_MIN: '5' } });
    const app = await buildApp(env.rt);
    try {
      const get = (as: string) => app.inject({ method: 'GET', url: '/api/me', headers: { 'x-user-id': as } });
      for (let i = 0; i < 5; i++) expect((await get('alice')).statusCode).toBe(200);
      const limited = await get('alice');
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect((await get('bob')).statusCode).toBe(200); // another actor behind the same address is unaffected
    } finally {
      await app.close();
    }
  });

  it('limits the AI pre-check more tightly than the rest of the API', async () => {
    env = await makeEnv({ env: { PRECHECK_RATE_LIMIT_PER_MIN: '2' } });
    const app = await buildApp(env.rt);
    try {
      const { id } = await env.svc.create(env.actors.alice, fx.ukGeneral());
      const run = () => app.inject({ method: 'POST', url: `/api/announcements/${id}/precheck`, headers: { 'x-user-id': 'alice' } });
      expect((await run()).statusCode).toBe(200);
      expect((await run()).statusCode).toBe(200);
      expect((await run()).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('exposes queue and workflow gauges in Prometheus text', async () => {
    env = await makeEnv({ manualQueue: true });
    const { alice, bob, erin } = env.actors;
    const { id } = await env.svc.create(alice, fx.ukGeneral());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    await env.svc.approve(bob, id);
    await env.svc.publish(erin, id); // manual queue: the publication stays waiting
    const app = await buildApp(env.rt);
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('hub_publications{status="pending"} 1');
      expect(res.body).toContain('hub_announcements{status="publishing"} 1');
      expect(res.body).toMatch(/hub_oldest_waiting_publication_seconds \d/);
    } finally {
      await app.close();
    }
  });

  it('creates the partial indexes the sweeper relies on', async () => {
    env = await makeEnv();
    const rows = process.env.TEST_PG_URL
      ? (await sql<{ name: string }>`select indexname as name from pg_indexes where tablename = 'publications'`.execute(env.rt.db)).rows
      : (await sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = 'publications'`.execute(env.rt.db)).rows;
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['publications_waiting', 'publications_leased']));
  });

  it('refuses to replay a concurrent create whose content differs from the winner', async () => {
    env = await makeEnv();
    const { alice } = env.actors;
    const a = fx.ukGeneral();
    const b = { ...fx.ukGeneral(), headline: 'A different notice entirely' };
    const results = await Promise.allSettled([env.svc.create(alice, a, 'key-1'), env.svc.create(alice, b, 'key-1')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
