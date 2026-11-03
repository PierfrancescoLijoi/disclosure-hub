/**
 * Shared by the command-line scripts (demo, bench). They talk to the REST API like any client:
 * with the demo persona header against `npm start`, or with a real bearer token when AUTH=oidc
 * (the local Keycloak realm; a password grant is only enabled there for the `hub-cli` client).
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OIDC = process.env.AUTH === 'oidc';
const TOKEN_URL = process.env.TOKEN_URL ?? 'http://localhost:8081/realms/hub/protocol/openid-connect/token';
const PASSWORD = process.env.PERSONA_PASSWORD ?? 'hub-dev-only';

const tokens = new Map<string, { pending: Promise<string>; expiresAt: number }>();

async function fetchToken(username: string): Promise<{ value: string; ttlMs: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'hub-cli', username, password: PASSWORD }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Sign-in as ${username} failed: ${data.error_description ?? res.status}`);
  return { value: data.access_token, ttlMs: (data.expires_in ?? 60) * 1000 };
}

/** One sign-in per user at a time: concurrent callers share the same request and the same token. */
function bearer(username: string): Promise<string> {
  const cached = tokens.get(username);
  if (cached && cached.expiresAt > Date.now() + 15_000) return cached.pending;
  const entry = { pending: undefined as unknown as Promise<string>, expiresAt: Number.MAX_SAFE_INTEGER };
  entry.pending = fetchToken(username).then(
    (t) => {
      entry.expiresAt = Date.now() + t.ttlMs;
      return t.value;
    },
    (err) => {
      tokens.delete(username);
      throw err;
    },
  );
  tokens.set(username, entry);
  return entry.pending;
}

export async function call(as: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(OIDC ? { authorization: `Bearer ${await bearer(as)}` } : { 'x-user-id': as }),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} as ${as}: ${res.status} ${data?.error?.code} ${data?.error?.message}`);
  return data;
}
