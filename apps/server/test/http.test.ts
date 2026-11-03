import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { fx, makeEnv, type Env } from './helpers.js';

let env: Env;
let app: FastifyInstance;
beforeEach(async () => {
  env = await makeEnv();
  app = await buildApp(env.rt);
});
afterEach(async () => {
  await app.close();
  await env.close();
});

type Persona = 'alice' | 'bob' | 'carol' | 'dan' | 'erin' | 'frank';
async function call(as: Persona | undefined, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { ...(as ? { 'x-user-id': as } : {}), ...headers } });
  return { status: res.statusCode, body: res.json() as any };
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean) {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('REST end to end', () => {
  it('takes a UK announcement from draft to published', async () => {
    const created = await call('alice', 'POST', '/api/announcements', fx.ukGeneral());
    expect(created.status).toBe(201);
    const id = created.body.announcement.id as string;
    expect(created.body.actions).toEqual(['edit', 'validate', 'withdraw']);

    expect((await call('alice', 'POST', `/api/announcements/${id}/validate`, {})).body).toMatchObject({ ok: true, status: 'validated' });
    expect((await call('alice', 'POST', `/api/announcements/${id}/submit`, {})).body).toMatchObject({ ok: true, status: 'in_review' });
    expect((await call('bob', 'POST', `/api/announcements/${id}/approve`, { comment: 'Looks right' })).body).toMatchObject({ status: 'approved', complete: true });

    const pub = await call('erin', 'POST', `/api/announcements/${id}/publish`, {});
    expect(pub.status).toBe(202);
    const done = await until(() => call('erin', 'GET', `/api/announcements/${id}`), (r) => r.body.announcement.status === 'published');
    expect(done.body.publication).toMatchObject({ status: 'acked' });
    expect(done.body.publication.externalRef).toMatch(/^\d{4}[A-Z]$/);
    expect(done.body.actions).toEqual([]);

    const audit = await call('alice', 'GET', `/api/announcements/${id}/audit`);
    expect(audit.body.chain).toEqual({ ok: true });
    expect(audit.body.events.at(-1)).toMatchObject({ type: 'published', actorId: 'system' });
  });

  it('takes a US earnings 8-K from draft to published', async () => {
    const id = (await call('alice', 'POST', '/api/announcements', fx.usEarnings())).body.announcement.id as string;
    await call('alice', 'POST', `/api/announcements/${id}/validate`, {});
    await call('alice', 'POST', `/api/announcements/${id}/submit`, {});
    for (const who of ['bob', 'carol', 'dan'] as const) await call(who, 'POST', `/api/announcements/${id}/approve`, {});
    expect((await call('erin', 'POST', `/api/announcements/${id}/publish`, {})).status).toBe(202);
    const done = await until(() => call('erin', 'GET', `/api/announcements/${id}`), (r) => r.body.announcement.status === 'published');
    expect(done.body.publication.externalRef).toMatch(/^0001234567-\d{2}-\d{6}$/);
    expect(done.body.revision.metadata.items).toEqual(['2.02']);
  });

  it('maps failures to clear status codes', async () => {
    expect((await call(undefined, 'GET', '/api/announcements')).status).toBe(401);
    expect((await call('nobody' as Persona, 'GET', '/api/announcements')).status).toBe(401);
    expect((await call('alice', 'POST', '/api/announcements', { jurisdiction: 'UK' })).status).toBe(400);
    expect((await call('erin', 'POST', '/api/announcements', fx.ukGeneral())).body.error.code).toBe('MISSING_ROLE');

    const id = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    expect((await call('alice', 'POST', `/api/announcements/${id}/submit`, {})).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('frank', 'GET', `/api/announcements/${id}`)).status).toBe(404);
    expect((await call('alice', 'GET', '/api/announcements/missing')).status).toBe(404);

    await call('alice', 'POST', `/api/announcements/${id}/validate`, {});
    await call('alice', 'POST', `/api/announcements/${id}/submit`, {});
    expect((await call('erin', 'POST', `/api/announcements/${id}/approve`, {})).status).toBe(403);
  });

  it('refuses to submit a draft that failed validation', async () => {
    const bad = fx.usEarnings();
    bad.metadata = { ...bad.metadata, exhibit99_1: false };
    const id = (await call('alice', 'POST', '/api/announcements', bad)).body.announcement.id as string;
    expect((await call('alice', 'POST', `/api/announcements/${id}/validate`, {})).body.ok).toBe(false);
    expect((await call('alice', 'POST', `/api/announcements/${id}/submit`, {})).status).toBe(409);
  });

  it('returns 422 with the report when re-validation at submit finds a new problem', async () => {
    const id = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    await call('alice', 'POST', `/api/announcements/${id}/validate`, {});
    await env.rt.db.updateTable('issuers').set({ profiles: JSON.stringify({ UK: { tidm: 'NWE' } }) }).where('id', '=', 'northwind').execute();
    const submit = await call('alice', 'POST', `/api/announcements/${id}/submit`, {});
    expect(submit.status).toBe(422);
    expect(submit.body.report.issues.map((i: any) => i.code)).toContain('ISSUER_PROFILE_INCOMPLETE');
    expect(submit.body.view.announcement.status).toBe('draft');
  });

  it('supports Idempotency-Key on create', async () => {
    const h = { 'idempotency-key': 'abc-123' };
    const first = await call('alice', 'POST', '/api/announcements', fx.ukGeneral(), h);
    const second = await call('alice', 'POST', '/api/announcements', fx.ukGeneral(), h);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.announcement.id).toBe(first.body.announcement.id);
  });

  it('describes jurisdictions so a UI can build forms from the schemas', async () => {
    const res = await call(undefined, 'GET', '/api/config');
    expect(res.status).toBe(200);
    expect(res.body.jurisdictions.map((j: any) => j.code)).toEqual(['UK', 'US']);
    const uk = res.body.jurisdictions[0];
    expect(uk.channel.id).toBe('rns');
    const inside = uk.categories.find((c: any) => c.key === 'inside_information');
    expect(inside.jsonSchema.properties.personResponsible.properties.name.type).toBe('string');
    expect(res.body.ai).toEqual({ provider: 'mock-heuristic-v1' });
    expect((await call(undefined, 'GET', '/api/users')).body.users.length).toBeGreaterThan(3);
  });

  it('exposes the advisory pre-check and the mock-wire controls', async () => {
    const id = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    const pre = await call('alice', 'POST', `/api/announcements/${id}/precheck`, {});
    expect(pre.status).toBe(200);
    expect(pre.body.report.humanReviewRequired).toBe(true);
    expect((await call('alice', 'GET', `/api/announcements/${id}/precheck`)).body.result.provider).toBe('mock-heuristic-v1');

    expect((await call('alice', 'PUT', '/api/dev/gateways/rns', { mode: 'transient', failuresRemaining: 2 })).status).toBe(200);
    expect((await call('alice', 'GET', '/api/dev/gateways')).body.rns).toMatchObject({ mode: 'transient' });
  });

  it('answers health and readiness probes', async () => {
    expect((await call(undefined, 'GET', '/healthz')).body).toEqual({ ok: true });
    expect((await call(undefined, 'GET', '/readyz')).body).toMatchObject({ ok: true, role: 'all' });
  });
});

describe('AI switched off', () => {
  it('hides the feature and keeps everything else', async () => {
    await app.close();
    await env.close();
    env = await makeEnv({ env: { AI_PROVIDER: 'off' } });
    app = await buildApp(env.rt);
    expect((await call(undefined, 'GET', '/api/config')).body.ai).toBeNull();
    const id = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    expect((await call('alice', 'POST', `/api/announcements/${id}/precheck`, {})).body.error.code).toBe('AI_DISABLED');
    expect((await call('alice', 'POST', `/api/announcements/${id}/validate`, {})).status).toBe(200);
  });
});

describe('identity boundary', () => {
  it('does not let an encoded path skip authentication', async () => {
    for (const url of ['/%61pi/dev/gateways', '/api/dev/gateways']) {
      expect((await call(undefined, 'GET', url)).status, url).toBe(401);
    }
  });

  it('rejects a malformed list cursor with 400 instead of failing in the query', async () => {
    expect((await call('alice', 'GET', '/api/announcements?cursor=bm9waXBl')).status).toBe(400);
    expect((await call('alice', 'GET', '/api/announcements?cursor=%3Cscript%3E')).status).toBe(400);
  });
});

describe('persona auth is demo-only', () => {
  it('authenticates nobody when DEMO is off, even with a seeded user id', async () => {
    expect((await call('alice', 'GET', '/api/me')).status).toBe(200); // the user exists and works in demo mode
    await app.close();
    app = await buildApp({ ...env.rt, config: { ...env.rt.config, DEMO: false } }); // same database, demo off
    expect((await call('alice', 'GET', '/api/me')).status).toBe(401);
  });
});
