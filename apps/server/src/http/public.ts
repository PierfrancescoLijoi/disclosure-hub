import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildAtom } from '../application/readers/feed.js';
import type { Runtime } from '../runtime.js';

const cursor = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((c) => Buffer.from(c, 'base64url').toString().split('|').length === 2, 'malformed cursor');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const filters = {
  issuer: z.string().max(100).optional(),
  jurisdiction: z.string().max(10).optional(),
  category: z.string().max(60).optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
};
const feedQuery = z.object({ ...filters, limit: z.coerce.number().int().min(1).max(50).default(20), cursor: cursor.optional() });
const atomQuery = z.object({ ...filters, limit: z.coerce.number().int().min(1).max(100).default(50) });

const followBody = z.object({
  kind: z.enum(['email', 'webhook']),
  target: z.string().min(3).max(500),
  issuer: z.string().max(100).optional(),
  jurisdiction: z.string().max(10).optional(),
  category: z.string().max(60).optional(),
});
const tokenBody = z.object({ token: z.string().min(10).max(500) });

const toQuery = (q: z.infer<typeof feedQuery>) => ({ issuerId: q.issuer, jurisdiction: q.jurisdiction, category: q.category, from: q.from, to: q.to, q: q.q, limit: q.limit, cursor: q.cursor });

/**
 * What a stranger can do without signing in: read published announcements, follow a feed, and
 * subscribe by email or webhook. Nothing here returns people, approvals or unpublished text.
 */
export function registerPublicRoutes(app: FastifyInstance, rt: Runtime): void {
  const baseUrl = rt.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const emailOn = rt.subscriptions.hasChannel('email');
  const webhookOn = rt.subscriptions.hasChannel('webhook');

  // Published text does not change, so every public read may be shared for a moment: this is what lets a CDN
  // or the nginx cache in front absorb a crowd; the feed sets its own, longer lifetime.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' && req.url.startsWith('/api/public/') && reply.statusCode === 200 && !reply.hasHeader('cache-control')) reply.header('cache-control', 'public, max-age=30');
    return payload;
  });

  app.get('/api/public/announcements', async (req) => rt.announcements.publicFeed(toQuery(feedQuery.parse(req.query))));
  app.get('/api/public/announcements/:id', async (req) => rt.announcements.publicGet(z.object({ id: z.string().min(1) }).parse(req.params).id));
  app.get('/api/public/issuers', async () => ({ items: await rt.announcements.publicIssuers() }));
  app.get('/api/public/options', async () => ({ email: emailOn, webhook: webhookOn, feed: true, mailbox: Boolean(rt.mailbox) }));

  // Feed readers poll: a short shared cache and conditional requests keep that cheap, also at the edge.
  app.get('/api/public/feed.atom', async (req, reply) => {
    const q = atomQuery.parse(req.query);
    const { items } = await rt.announcements.publicFeed(toQuery({ ...q, cursor: undefined }));
    const query = new URLSearchParams(Object.entries(req.query as Record<string, string>).filter(([, v]) => typeof v === 'string' && v));
    const feed = buildAtom({
      title: 'Regulatory announcements',
      selfUrl: `${baseUrl}/api/public/feed.atom${query.size ? `?${query}` : ''}`,
      baseUrl,
      items,
    });
    reply.header('cache-control', 'public, max-age=60').header('etag', feed.etag).header('last-modified', feed.lastModified);
    if (req.headers['if-none-match'] === feed.etag) return reply.status(304).send();
    return reply.type('application/atom+xml; charset=utf-8').send(feed.xml);
  });

  // Anyone can type an address into this form, so it is limited per client and answers the same way every time.
  const hourly = { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } };
  app.post('/api/public/subscriptions', hourly, async (req, reply) => {
    const b = followBody.parse(req.body);
    await rt.subscriptions.follow({ kind: b.kind, target: b.target, issuerId: b.issuer, jurisdiction: b.jurisdiction, category: b.category });
    return reply.status(202).send({ ok: true, message: 'If the address is valid, a confirmation is on its way.' });
  });
  app.post('/api/public/subscriptions/confirm', async (req) => rt.subscriptions.confirm(tokenBody.parse(req.body).token));

  // RFC 8058 one-click unsubscribe posts a form body to the URL in the List-Unsubscribe header; the token is in the query.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.post('/api/public/subscriptions/unsubscribe', async (req) => {
    const fromQuery = z.object({ token: z.string().min(10).max(500) }).safeParse(req.query);
    const token = fromQuery.success ? fromQuery.data.token : tokenBody.parse(req.body).token;
    await rt.subscriptions.unsubscribe(token);
    return { ok: true };
  });

  // Demo only: the messages the log transport "sent", so the confirm link can be followed without a mail server.
  if (rt.config.DEMO && rt.mailbox) {
    const mailbox = rt.mailbox;
    app.get('/api/dev/mailbox', async () => ({ messages: [...mailbox.sent].reverse().map((m) => ({ to: m.to, subject: m.subject, text: m.text })) }));
  }
}
