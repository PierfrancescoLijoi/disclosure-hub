import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { fx, makeEnv, type Env } from './helpers.js';

const ISSUER = 'https://idp.example.test/hub/v2.0';
const AUDIENCE = 'api://disclosure-hub';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let signing: PrivateKey;
let otherKey: PrivateKey;
let jwksServer: Server;
let jwksUri: string;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signing = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', r));
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/keys`;
});
afterAll(() => new Promise<void>((r) => jwksServer.close(() => r())));

interface Claims {
  sub?: string;
  name?: string;
  roles?: string[];
  issuer_id?: string;
  iss?: string;
  aud?: string;
  expiresIn?: string;
  key?: PrivateKey;
}

const token = (c: Claims) =>
  new SignJWT({ name: c.name ?? c.sub, roles: c.roles ?? [], ...(c.issuer_id && { issuer_id: c.issuer_id }) })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(c.sub ?? 'u-1')
    .setIssuer(c.iss ?? ISSUER)
    .setAudience(c.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(c.expiresIn ?? '5m')
    .sign(c.key ?? signing);

let env: Env | undefined;
let app: FastifyInstance | undefined;

async function start(extra: Record<string, string | undefined> = {}) {
  env = await makeEnv({
    env: { AUTH_MODE: 'oidc', OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: jwksUri, OIDC_DEFAULT_ISSUER: 'northwind', ...extra },
  });
  app = await buildApp(env.rt);
  return app;
}

afterEach(async () => {
  await app?.close();
  await env?.close();
  app = env = undefined;
});

const call = async (method: 'GET' | 'POST', url: string, bearer?: string, payload?: unknown) => {
  const res = await app!.inject({
    method,
    url,
    payload: payload as object,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  return { status: res.statusCode, body: res.json() as any };
};

describe('OIDC bearer authentication', () => {
  it('takes a UK announcement from draft to published with real identities and their roles', async () => {
    await start();
    const alice = await token({ sub: 'oid-alice', name: 'Alice Morgan', roles: ['author'] });
    const bob = await token({ sub: 'oid-bob', name: 'Bob Chen', roles: ['company_secretary'] });
    const erin = await token({ sub: 'oid-erin', name: 'Erin Walsh', roles: ['publisher'] });

    const created = await call('POST', '/api/announcements', alice, fx.ukGeneral());
    expect(created.status).toBe(201);
    const id = created.body.announcement.id;
    expect((await call('POST', `/api/announcements/${id}/validate`, alice)).status).toBe(200);
    expect((await call('POST', `/api/announcements/${id}/submit`, alice)).status).toBe(200);

    // Roles come from the token: the author cannot approve, the company secretary can.
    expect((await call('POST', `/api/announcements/${id}/approve`, alice)).status).toBe(403);
    expect((await call('POST', `/api/announcements/${id}/approve`, bob)).body).toMatchObject({ complete: true });
    expect((await call('POST', `/api/announcements/${id}/publish`, bob)).status).toBe(403);
    expect((await call('POST', `/api/announcements/${id}/publish`, erin)).status).toBe(202);
    await env!.settle();

    const view = await call('GET', `/api/announcements/${id}`, erin);
    expect(view.body.announcement.status).toBe('published');
    const audit = await call('GET', `/api/announcements/${id}/audit`, erin);
    expect(audit.body.events.map((e: { actorId: string }) => e.actorId)).toContain('oid-bob');
    expect(audit.body.chain).toEqual({ ok: true });
  });

  it('refuses requests without a usable token', async () => {
    await start();
    const good = { sub: 'u', roles: ['author'] };
    const cases: [string, string | undefined][] = [
      ['no token', undefined],
      ['garbage', 'not-a-jwt'],
      ['wrong audience', await token({ ...good, aud: 'api://someone-else' })],
      ['wrong issuer', await token({ ...good, iss: 'https://evil.example.test/' })],
      ['expired', await token({ ...good, expiresIn: '-10m' })],
      ['signed by another key', await token({ ...good, key: otherKey })],
    ];
    for (const [label, bearer] of cases) {
      expect((await call('GET', '/api/me', bearer)).status, label).toBe(401);
    }
  });

  it('does not accept the demo persona header in OIDC mode', async () => {
    await start({ DEMO: '1' });
    const res = await app!.inject({ method: 'GET', url: '/api/me', headers: { 'x-user-id': 'alice' } });
    expect(res.statusCode).toBe(401);
    expect((await app!.inject({ method: 'GET', url: '/%61pi/me', headers: { 'x-user-id': 'alice' } })).statusCode).toBe(401);
  });

  it('refuses an account with no application role or no company, with a reason', async () => {
    await start();
    expect((await call('GET', '/api/me', await token({ sub: 'u', roles: ['unrelated'] }))).body.error.code).toBe('NO_ROLE');
    expect((await call('GET', '/api/me', await token({ sub: 'u', roles: ['author'], issuer_id: 'ghost' }))).body.error.code).toBe('UNKNOWN_COMPANY');
    await app!.close();
    await env!.close();
    await start({ OIDC_DEFAULT_ISSUER: undefined });
    expect((await call('GET', '/api/me', await token({ sub: 'u', roles: ['author'] }))).body.error.code).toBe('NO_COMPANY');
  });

  it('keeps one company away from another, with the company taken from the token', async () => {
    await start();
    const alice = await token({ sub: 'oid-alice', roles: ['author'] });
    const frank = await token({ sub: 'oid-frank', roles: ['author'], issuer_id: 'contoso' });
    const { body } = await call('POST', '/api/announcements', alice, fx.ukGeneral());
    const id = body.announcement.id;

    expect((await call('GET', `/api/announcements/${id}`, frank)).status).toBe(404);
    expect((await call('GET', '/api/announcements', frank)).body.items).toEqual([]);
    const names = (await call('GET', '/api/users', frank)).body.users.map((u: { id: string }) => u.id);
    expect(names).toContain('oid-frank');
    expect(names).not.toContain('oid-alice');
  });

  it('exposes only public sign-in settings and no persona list', async () => {
    await start({ OIDC_SPA_CLIENT_ID: 'spa-client', OIDC_AUTHORITY: 'https://login.example.test/hub/v2.0' });
    const cfg = (await app!.inject({ method: 'GET', url: '/api/config' })).json();
    expect(cfg.auth).toEqual({ mode: 'oidc', authority: 'https://login.example.test/hub/v2.0', clientId: 'spa-client', scope: 'openid profile' });
    expect((await app!.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
  });

  it('answers 503, not 401, when the identity provider cannot be reached', async () => {
    await start({ OIDC_JWKS_URI: 'http://127.0.0.1:9/keys' });
    const res = await call('GET', '/api/me', await token({ sub: 'u', roles: ['author'] }));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('configuration guards', () => {
  it('needs an issuer and an audience for OIDC', () => {
    expect(() => loadConfig({ AUTH_MODE: 'oidc' })).toThrow(/OIDC_ISSUER/);
  });
  it('needs PostgreSQL for the database-backed queue and for managed identity', () => {
    expect(() => loadConfig({ QUEUE_URL: 'pg', ROLE: 'api' })).toThrow(/PostgreSQL/);
    expect(() => loadConfig({ DATABASE_AUTH: 'azure-managed-identity' })).toThrow(/PostgreSQL/);
    expect(loadConfig({ QUEUE_URL: 'pg', ROLE: 'api', DATABASE_URL: 'postgres://u@h/db' }).QUEUE_URL).toBe('pg');
  });
});
