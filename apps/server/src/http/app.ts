import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { chaosKey, type Chaos } from '../adapters/gateways/mock.js';
import { createAuthenticator } from '../auth/oidc.js';
import { DomainError, unauthorized } from '../domain/errors.js';
import { STATUSES, type Actor } from '../domain/types.js';
import type { Runtime } from '../runtime.js';
import { registerPublicRoutes } from './public.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

const draft = z.object({
  headline: z.string().max(500),
  body: z.string().max(200_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const createBody = draft.extend({ jurisdiction: z.string().min(1), category: z.string().min(1) });
const saveBody = draft.extend({ expectedVersion: z.number().int().optional() });
const commentBody = z.object({ comment: z.string().max(2000).default(''), revision: z.number().int().positive().optional() });
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  jurisdiction: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((c) => Buffer.from(c, 'base64url').toString().split('|').length === 2, 'malformed cursor')
    .optional(),
});
const chaosBody = z.object({
  mode: z.enum(['ok', 'transient', 'permanent', 'ack_lost']),
  failuresRemaining: z.number().int().min(0).max(20).optional(),
  latencyMs: z.number().int().min(0).max(10_000).optional(),
});
const idParam = z.object({ id: z.string().min(1) });
const recentQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(rt: Runtime): Promise<FastifyInstance> {
  // trustProxy: behind Front Door or an ingress the client address is in X-Forwarded-For, and the rate limit keys on it.
  // The hop numbers the socket peer 0, so N trusted proxies are hops 0..N-1: trusting hop N would let a client pick its own address.
  // The request serializer drops the query string: unsubscribe and confirm links carry a token there.
  const logger = {
    level: rt.config.DEMO ? 'warn' : 'info',
    serializers: { req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: req.method, url: req.url.split('?')[0], hostname: req.hostname, remoteAddress: req.ip }) },
  };
  const app = Fastify({ logger, bodyLimit: 1_000_000, trustProxy: rt.config.TRUST_PROXY > 0 ? (_address: string, hop: number) => hop < rt.config.TRUST_PROXY : false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Invalid request', details: err.issues } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
  });

  // Identity. AUTH_MODE=oidc verifies a bearer token from a real identity provider (Entra ID,
  // Keycloak, ...). AUTH_MODE=demo lets the x-user-id header pick a seeded persona and only works
  // with DEMO=1. Everything below this hook only ever sees an Actor.
  const oidcMode = rt.config.AUTH_MODE === 'oidc';
  const personaMode = !oidcMode && rt.config.DEMO;
  const authenticate = oidcMode
    ? createAuthenticator(
        {
          issuer: rt.config.OIDC_ISSUER!,
          audience: rt.config.OIDC_AUDIENCE!,
          jwksUri: rt.config.OIDC_JWKS_URI,
          rolesClaim: rt.config.OIDC_ROLES_CLAIM,
          issuerClaim: rt.config.OIDC_ISSUER_CLAIM,
          defaultIssuer: rt.config.OIDC_DEFAULT_ISSUER,
        },
        async (id) => (await rt.store.read.issuers.get(id)) !== null,
      )
    : undefined;
  const seenIdentity = new Map<string, string>(); // actor id -> fingerprint last written to the users table

  // Behind Front Door the app is only reachable through the edge: a direct call would skip its WAF rate rule and cache.
  if (rt.config.EDGE_ID) {
    const edgeId = rt.config.EDGE_ID;
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path === '/healthz' || path === '/readyz') return; // the platform's own probes
      const given = req.headers['x-azure-fdid'];
      if (typeof given !== 'string' || given.toLowerCase() !== edgeId.toLowerCase()) {
        return reply.status(403).send({ error: { code: 'EDGE_ONLY', message: 'Not reachable directly' } });
      }
    });
  }

  // Decided on the matched route, not the raw URL: '/%61pi/...' reaches the same handler.
  app.addHook('preHandler', async (req) => {
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/')) return;
    // Public reading of published announcements and the sign-in configuration need no identity.
    if (route === '/api/config' || route.startsWith('/api/public/') || route === '/api/dev/mailbox' || (route === '/api/users' && personaMode)) return;

    if (authenticate) {
      const header = req.headers.authorization;
      const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!token) throw unauthorized('Missing bearer token');
      const actor = await authenticate(token);
      const fingerprint = JSON.stringify([actor.name, actor.issuerId, actor.roles]);
      if (seenIdentity.get(actor.id) !== fingerprint) {
        await rt.store.read.users.upsert(actor);
        seenIdentity.set(actor.id, fingerprint);
      }
      req.actor = actor;
      return;
    }

    // Persona headers are a demo mechanism; without DEMO nothing authenticates here.
    if (!personaMode) throw unauthorized('No identity provider configured');
    const id = req.headers['x-user-id'];
    const actor = typeof id === 'string' ? await rt.store.read.users.get(id) : null;
    if (!actor) throw unauthorized();
    req.actor = actor;
  });

  if (rt.config.RATE_LIMIT_PER_MIN > 0) {
    // Registered after the identity hook, so the key is the authenticated actor. Floods of
    // unauthenticated requests are the edge's job (nginx limit_req in the Compose stack).
    await app.register(rateLimit, {
      max: rt.config.RATE_LIMIT_PER_MIN,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (req) => req.actor?.id ?? req.ip,
      errorResponseBuilder: (_req, ctx) =>
        Object.assign(new Error(`Too many requests; retry in ${Math.ceil(ctx.ttl / 1000)} s`), { statusCode: 429 }),
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  // Prometheus text format, hand-written: three gauges and one age are not worth a dependency.
  // Operational endpoint: keep it off the public edge (the nginx config only forwards /api).
  app.get('/metrics', async (_req, reply) => {
    const s = await rt.store.stats(new Date().toISOString());
    const lines: string[] = [];
    const gauge = (name: string, help: string, samples: [string, number][]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, v] of samples) lines.push(`${name}${labels} ${v}`);
    };
    gauge('hub_publications', 'Publications by status', Object.entries(s.publicationsByStatus).map(([k, v]) => [`{status="${k}"}`, v]));
    gauge('hub_announcements', 'Announcements by status', Object.entries(s.announcementsByStatus).map(([k, v]) => [`{status="${k}"}`, v]));
    gauge('hub_oldest_waiting_publication_seconds', 'Age of the oldest publication waiting for a worker', [['', s.oldestWaitingSeconds]]);
    gauge('hub_oldest_pending_delivery_seconds', 'Age of the oldest domain-event delivery waiting for a consumer (outbox lag)', [['', s.events.oldestPendingSeconds]]);
    gauge('hub_pending_deliveries', 'Domain-event deliveries waiting for a consumer', [['', s.events.pendingDeliveries]]);
    gauge('hub_dead_deliveries', 'Domain-event deliveries that exhausted their attempts and need a person', [['', s.events.deadDeliveries]]);
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
  app.get('/readyz', async () => {
    await rt.store.read.settings.get('ping');
    return { ok: true, role: rt.config.ROLE };
  });

  app.get('/api/config', async () => ({
    role: rt.config.ROLE,
    demo: rt.config.DEMO,
    queue: rt.config.QUEUE_URL === 'inproc' ? 'in-process' : rt.config.QUEUE_URL === 'pg' ? 'postgres' : 'redis',
    auth: oidcMode
      ? {
          mode: 'oidc' as const,
          authority: rt.config.OIDC_AUTHORITY ?? rt.config.OIDC_ISSUER,
          clientId: rt.config.OIDC_SPA_CLIENT_ID ?? null,
          scope: rt.config.OIDC_SPA_SCOPE,
        }
      : { mode: 'demo' as const },
    database: rt.config.DATABASE_URL.startsWith('postgres') ? 'postgres' : 'sqlite',
    enforceWindows: rt.config.ENFORCE_WINDOWS,
    ai: rt.preCheck ? { provider: rt.preCheck.providerName } : null,
    jurisdictions: rt.policies.list().map((p) => p.describe()),
  }));

  // Demo: every persona, for the picker. OIDC: only people of the caller's own company, for names on screen.
  app.get('/api/users', async (req) => {
    if (personaMode) return { users: await rt.store.read.users.list() };
    const users = await rt.store.read.users.listByIssuer(req.actor.issuerId);
    return { users: users.map((u) => ({ id: u.id, name: u.name, issuerId: u.issuerId, roles: u.roles })) };
  });

  // Public: published announcements only, no people, no approvals, no jurisdiction metadata.
  registerPublicRoutes(app, rt);

  app.get('/api/activity', async (req) => ({ events: await rt.announcements.activity(req.actor, recentQuery.parse(req.query).limit) }));
  app.get('/api/publications', async (req) => ({ items: await rt.announcements.publications(req.actor, recentQuery.parse(req.query).limit) }));

  app.get('/api/me', async (req) => ({ actor: req.actor, issuer: await rt.store.read.issuers.get(req.actor.issuerId) }));

  // ------------------------------------------------------------ announcements
  app.post('/api/announcements', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    const { id, replay } = await rt.announcements.create(req.actor, createBody.parse(req.body), typeof key === 'string' ? key : undefined);
    return reply.status(replay ? 200 : 201).send(await rt.announcements.get(req.actor, id));
  });

  app.get('/api/announcements', async (req) => {
    const { items, nextCursor } = await rt.announcements.list(req.actor, listQuery.parse(req.query));
    return { items, nextCursor };
  });

  app.get('/api/announcements/:id', async (req) => rt.announcements.get(req.actor, idParam.parse(req.params).id));

  app.put('/api/announcements/:id/revision', async (req) => {
    const { id } = idParam.parse(req.params);
    const result = await rt.announcements.saveRevision(req.actor, id, saveBody.parse(req.body));
    return { ...result, view: await rt.announcements.get(req.actor, id) };
  });

  app.get('/api/announcements/:id/revisions', async (req) => ({
    revisions: await rt.announcements.revisions(req.actor, idParam.parse(req.params).id),
  }));

  app.post('/api/announcements/:id/validate', async (req) => {
    const { id } = idParam.parse(req.params);
    const result = await rt.announcements.validate(req.actor, id);
    return { ...result, view: await rt.announcements.get(req.actor, id) };
  });

  app.post('/api/announcements/:id/submit', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const result = await rt.announcements.submit(req.actor, id);
    return reply.status(result.ok ? 200 : 422).send({ ...result, view: await rt.announcements.get(req.actor, id) });
  });

  app.post('/api/announcements/:id/approve', async (req) => {
    const { id } = idParam.parse(req.params);
    const { comment, revision } = commentBody.parse(req.body ?? {});
    const result = await rt.announcements.approve(req.actor, id, comment, revision);
    return { ...result, view: await rt.announcements.get(req.actor, id) };
  });

  app.post('/api/announcements/:id/request-changes', async (req) => {
    const { id } = idParam.parse(req.params);
    const result = await rt.announcements.requestChanges(req.actor, id, commentBody.parse(req.body ?? {}).comment);
    return { ...result, view: await rt.announcements.get(req.actor, id) };
  });

  app.post('/api/announcements/:id/publish', async (req, reply) =>
    reply.status(202).send(await rt.announcements.publish(req.actor, idParam.parse(req.params).id)),
  );

  app.post('/api/announcements/:id/retry', async (req, reply) =>
    reply.status(202).send(await rt.announcements.retry(req.actor, idParam.parse(req.params).id)),
  );

  app.post('/api/announcements/:id/reopen', async (req) => {
    const { id } = idParam.parse(req.params);
    await rt.announcements.reopen(req.actor, id, commentBody.parse(req.body ?? {}).comment);
    return rt.announcements.get(req.actor, id);
  });

  app.post('/api/announcements/:id/withdraw', async (req) => {
    const { id } = idParam.parse(req.params);
    await rt.announcements.withdraw(req.actor, id, commentBody.parse(req.body ?? {}).comment);
    return rt.announcements.get(req.actor, id);
  });

  app.get('/api/announcements/:id/preview', async (req) => rt.announcements.preview(req.actor, idParam.parse(req.params).id));

  app.get('/api/announcements/:id/audit', async (req) => rt.announcements.auditTrail(req.actor, idParam.parse(req.params).id));

  // ---------------------------------------------------------------- AI (advisory)
  const aiOrDisabled = () => {
    if (!rt.preCheck) throw new DomainError(404, 'AI_DISABLED', 'The AI pre-check is switched off');
    return rt.preCheck;
  };
  app.post(
    '/api/announcements/:id/precheck',
    { config: { rateLimit: { max: rt.config.PRECHECK_RATE_LIMIT_PER_MIN || 1_000_000, timeWindow: '1 minute' } } },
    async (req) => aiOrDisabled().run(req.actor, idParam.parse(req.params).id),
  );
  app.get('/api/announcements/:id/precheck', async (req) => ({
    result: await aiOrDisabled().latest(req.actor, idParam.parse(req.params).id),
  }));

  // ------------------------------------------------- demo controls for the mock wires
  if (rt.config.DEMO) {
    app.get('/api/dev/gateways', async () => {
      const out: Record<string, Chaos> = {};
      for (const p of rt.policies.list()) {
        const raw = await rt.store.read.settings.get(chaosKey(p.channel.id));
        out[p.channel.id] = raw ? (JSON.parse(raw) as Chaos) : { mode: 'ok' };
      }
      return out;
    });
    app.put('/api/dev/gateways/:channel', async (req) => {
      const { channel } = z.object({ channel: z.string() }).parse(req.params);
      const body = chaosBody.parse(req.body);
      await rt.store.read.settings.set(chaosKey(channel), JSON.stringify(body));
      return body;
    });
    app.post('/api/dev/sweep', async () => ({ requeued: await rt.runner.sweep() }));
  }

  await serveWeb(app, rt);
  return app;
}

async function serveWeb(app: FastifyInstance, rt: Runtime): Promise<void> {
  const root = resolve(rt.config.WEB_DIST ?? resolve(here, '../../../web/dist'));
  if (!existsSync(resolve(root, 'index.html'))) return;
  await app.register(fastifyStatic, { root, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
}
