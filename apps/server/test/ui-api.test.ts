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
async function call(as: Persona | undefined, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: as ? { 'x-user-id': as } : {} });
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

async function draftToReview(as: Persona, input: object) {
  const id = (await call(as, 'POST', '/api/announcements', input)).body.announcement.id as string;
  await call(as, 'POST', `/api/announcements/${id}/validate`, {});
  await call(as, 'POST', `/api/announcements/${id}/submit`, {});
  return id;
}
async function publishUk() {
  const id = await draftToReview('alice', fx.ukGeneral());
  await call('bob', 'POST', `/api/announcements/${id}/approve`, {});
  await call('erin', 'POST', `/api/announcements/${id}/publish`, {});
  await until(() => call('erin', 'GET', `/api/announcements/${id}`), (r) => r.body.announcement.status === 'published');
  return id;
}

describe('public feed', () => {
  it('needs no sign-in and shows nothing that is not published', async () => {
    await call('alice', 'POST', '/api/announcements', fx.ukGeneral()); // draft
    await draftToReview('alice', fx.ukGeneral()); // in review

    const feed = await call(undefined, 'GET', '/api/public/announcements');
    expect(feed.status).toBe(200);
    expect(feed.body.items).toEqual([]);
  });

  it('lists a published announcement without internal fields and serves its text', async () => {
    const id = await publishUk();

    const feed = await call(undefined, 'GET', '/api/public/announcements');
    expect(feed.body.items).toHaveLength(1);
    const item = feed.body.items[0];
    expect(item).toMatchObject({ id, jurisdiction: 'UK', issuerName: 'Northwind Energy plc', channelName: expect.any(String) });
    expect(item.receipt).toMatch(/^\d{4}[A-Z]$/);
    expect(item.publishedAt).toEqual(expect.any(String));
    // Nothing that identifies people or internal state.
    expect(JSON.stringify(item)).not.toMatch(/createdBy|authorId|approval|audit|metadata|idempotency|status/);

    const detail = await call(undefined, 'GET', `/api/public/announcements/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail.body)).not.toMatch(/createdBy|authorId|approval|audit|metadata|idempotency/);
  });

  it('answers 404 for a draft, whatever the id', async () => {
    const draftId = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    expect((await call(undefined, 'GET', `/api/public/announcements/${draftId}`)).status).toBe(404);
    expect((await call(undefined, 'GET', '/api/public/announcements/nope')).status).toBe(404);
  });

  it('filters by jurisdiction and text and pages', async () => {
    await publishUk();
    const us = await draftToReview('alice', fx.usEarnings());
    for (const who of ['bob', 'carol', 'dan'] as const) await call(who, 'POST', `/api/announcements/${us}/approve`, {});
    await call('erin', 'POST', `/api/announcements/${us}/publish`, {});
    await until(() => call('erin', 'GET', `/api/announcements/${us}`), (r) => r.body.announcement.status === 'published');

    expect((await call(undefined, 'GET', '/api/public/announcements')).body.items).toHaveLength(2);
    expect((await call(undefined, 'GET', '/api/public/announcements?jurisdiction=US')).body.items.map((i: any) => i.id)).toEqual([us]);
    expect((await call(undefined, 'GET', '/api/public/announcements?q=zzz-no-match')).body.items).toEqual([]);

    const page = await call(undefined, 'GET', '/api/public/announcements?limit=1');
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    const next = await call(undefined, 'GET', `/api/public/announcements?limit=1&cursor=${page.body.nextCursor}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
  });

  it('rejects a malformed cursor', async () => {
    expect((await call(undefined, 'GET', '/api/public/announcements?cursor=!!!')).status).toBe(400);
  });
});

describe('workspace feeds', () => {
  it('lists recent activity for the caller own company only, newest first, with headlines', async () => {
    const id = await draftToReview('alice', fx.ukGeneral());
    const mine = await call('bob', 'GET', '/api/activity?limit=10');
    expect(mine.status).toBe(200);
    expect(mine.body.events.map((e: any) => e.type)).toEqual(['submitted', 'validated', 'created']);
    expect(mine.body.events[0]).toMatchObject({ announcementId: id, headline: expect.any(String) });

    const other = await call('frank', 'GET', '/api/activity?limit=10');
    expect(other.body.events).toEqual([]);
    expect((await call(undefined, 'GET', '/api/activity')).status).toBe(401);
  });

  it('lists publication jobs of the own company with the headline', async () => {
    const id = await publishUk();
    const mine = await call('erin', 'GET', '/api/publications');
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ announcementId: id, status: 'acked', headline: expect.any(String), jurisdiction: 'UK' });
    expect((await call('frank', 'GET', '/api/publications')).body.items).toEqual([]);
  });

  it('previews the publication format and keeps tenants apart', async () => {
    const id = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    const pv = await call('alice', 'GET', `/api/announcements/${id}/preview`);
    expect(pv.status).toBe(200);
    expect(pv.body.payload).toMatchObject({ channel: 'rns', headline: expect.any(String), content: expect.any(String) });
    expect((await call('frank', 'GET', `/api/announcements/${id}/preview`)).status).toBe(404);
  });

  it('flags a draft that came back with requested changes', async () => {
    const id = await draftToReview('alice', fx.ukGeneral());
    await call('bob', 'POST', `/api/announcements/${id}/request-changes`, { comment: 'Please cite the source' });
    const list = await call('alice', 'GET', '/api/announcements');
    expect(list.body.items.find((i: any) => i.id === id)).toMatchObject({ status: 'draft', changesRequested: true });
    const fresh = (await call('alice', 'POST', '/api/announcements', fx.ukGeneral())).body.announcement.id as string;
    const again = await call('alice', 'GET', '/api/announcements');
    expect(again.body.items.find((i: any) => i.id === fresh).changesRequested).toBe(false);
  });
});
