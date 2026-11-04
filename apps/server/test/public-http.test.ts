import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { ChannelRegistry, type NotificationChannel, type OutboundMessage } from '../src/ports/index.js';
import { makeEnv, publishAnnouncement, type Env } from './helpers.js';

let env: Env | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  await env?.close();
  env = app = undefined;
});

const sent: OutboundMessage[] = [];
const email: NotificationChannel = {
  kind: 'email',
  name: 'fake',
  async send(m) {
    sent.push(m);
  },
};

async function start(over: Parameters<typeof makeEnv>[0] = {}) {
  sent.length = 0;
  env = await makeEnv({ channels: new ChannelRegistry().register(email), ...over });
  app = await buildApp(env.rt);
  return { e: env, a: app };
}
const tokenIn = (m: OutboundMessage) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text)![1]!);

describe('public routes: reading', () => {
  it('serves the feed as Atom with validators, and answers 304 to a repeat', async () => {
    const { e, a } = await start();
    await publishAnnouncement(e);
    const first = await a.inject({ url: '/api/public/feed.atom?jurisdiction=UK' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/atom+xml');
    expect(first.headers['cache-control']).toBe('public, max-age=60');
    expect(first.body).toContain('<entry>');
    expect(first.body).toContain('/api/public/feed.atom?jurisdiction=UK');

    const again = await a.inject({ url: '/api/public/feed.atom?jurisdiction=UK', headers: { 'if-none-match': first.headers.etag as string } });
    expect(again.statusCode).toBe(304);
    expect((await a.inject({ url: '/api/public/feed.atom?jurisdiction=US' })).body).not.toContain('<entry>');
  });

  it('exposes the archive filters, the companies and what this deployment can do', async () => {
    const { e, a } = await start();
    await publishAnnouncement(e);
    const item = (await a.inject({ url: '/api/public/announcements?category=general&from=2000-01-01&q=northwind' })).json().items[0];
    expect(item).toMatchObject({ issuerId: 'northwind', category: 'general' });
    expect(typeof item.excerpt).toBe('string');
    expect(JSON.stringify(item)).not.toMatch(/createdBy|approv|body/i); // nothing about people or the full text

    const shared = await a.inject({ url: '/api/public/announcements' });
    expect(shared.headers['cache-control']).toBe('public, max-age=30'); // a CDN may absorb a crowd
    expect((await a.inject({ method: 'POST', url: '/api/public/subscriptions', payload: { kind: 'email', target: 'nope' } })).headers['cache-control']).toBeUndefined();
    expect((await a.inject({ url: '/api/public/issuers' })).json().items).toEqual([{ id: 'northwind', name: 'Northwind Energy plc' }]);
    expect((await a.inject({ url: '/api/public/options' })).json()).toEqual({ email: true, webhook: false, feed: true, mailbox: false });
    expect((await a.inject({ url: '/api/public/announcements?from=yesterday' })).statusCode).toBe(400);
  });
});

describe('public routes: following', () => {
  it('walks a reader from the form to the confirmation, the news and the one-click exit', async () => {
    const { e, a } = await start();
    const asked = await a.inject({ method: 'POST', url: '/api/public/subscriptions', payload: { kind: 'email', target: 'reader@example.com', issuer: 'northwind' } });
    expect(asked.statusCode).toBe(202);
    expect(sent).toHaveLength(1);

    expect((await a.inject({ method: 'POST', url: '/api/public/subscriptions/confirm', payload: { token: tokenIn(sent[0]!) } })).json()).toMatchObject({ kind: 'email', filters: { issuerId: 'northwind' }, issuerName: 'Northwind Energy plc' });
    expect((await a.inject({ method: 'POST', url: '/api/public/subscriptions/confirm', payload: { token: 'garbage-garbage' } })).statusCode).toBe(400);

    await publishAnnouncement(e);
    const news = sent.find((m) => m.subject.startsWith('Northwind Energy plc:'))!;
    expect(news.unsubscribeUrl).toMatch(/\/api\/public\/subscriptions\/unsubscribe\?token=/);

    // A mail client posts a form body to the List-Unsubscribe URL (RFC 8058).
    const path = news.unsubscribeUrl.replace(/^https?:\/\/[^/]+/, '');
    const left = await a.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(left.statusCode).toBe(200);
    expect(left.json()).toEqual({ ok: true });
    const row = await e.rt.db.selectFrom('subscriptions').select('status').executeTakeFirstOrThrow();
    expect(row.status).toBe('unsubscribed');
  });

  it('rejects bad input, unknown companies and channels this deployment lacks', async () => {
    const { a } = await start();
    const post = (payload: object) => a.inject({ method: 'POST', url: '/api/public/subscriptions', payload });
    expect((await post({ kind: 'email', target: 'nope' })).statusCode).toBe(400);
    expect((await post({ kind: 'email', target: 'a@example.com', issuer: 'ghost' })).statusCode).toBe(404);
    expect((await post({ kind: 'webhook', target: 'https://hooks.example.com/x' })).statusCode).toBe(501);
    expect((await post({ kind: 'sms', target: '123' })).statusCode).toBe(400);
  });

  it('limits the form per client', async () => {
    const { a } = await start();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await a.inject({ method: 'POST', url: '/api/public/subscriptions', payload: { kind: 'email', target: `r${i}@example.com` } })).statusCode);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429, 429]);
  });

  it('keys the limit on the address the proxy saw, not on one the client wrote into X-Forwarded-For', async () => {
    const { a } = await start({ env: { TRUST_PROXY: '1' } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await a.inject({ method: 'POST', url: '/api/public/subscriptions', headers: { 'x-forwarded-for': `10.9.8.${i}, 203.0.113.9` }, payload: { kind: 'email', target: `s${i}@example.com` } });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([202, 202, 202, 202, 202, 429, 429]);
  });

  it('answers only through the edge when an edge id is set, except for the platform probes', async () => {
    const { a } = await start({ env: { EDGE_ID: 'edge-guid-1234' } });
    expect((await a.inject({ method: 'GET', url: '/api/public/options' })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/public/options', headers: { 'x-azure-fdid': 'wrong' } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/public/options', headers: { 'x-azure-fdid': 'EDGE-GUID-1234' } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('shows the demo mailbox to someone who is not signed in, since that is who follows', async () => {
    env = await makeEnv({ env: { EMAIL_TRANSPORT: 'log' } });
    app = await buildApp(env.rt);
    await app.inject({ method: 'POST', url: '/api/public/subscriptions', payload: { kind: 'email', target: 'demo@example.com' } });
    const box = await app.inject({ url: '/api/dev/mailbox' });
    expect(box.statusCode).toBe(200);
    expect(box.json().messages[0]).toMatchObject({ to: 'demo@example.com', subject: expect.stringContaining('Confirm') });
  });

  it('keeps the demo mailbox out of a normal deployment', async () => {
    const { a } = await start();
    expect((await a.inject({ url: '/api/dev/mailbox' })).statusCode).toBe(404);
  });
});
