import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { DomainError, forbidden, unauthorized } from '../domain/errors.js';
import type { Actor, Role } from '../domain/types.js';

const KNOWN_ROLES: readonly Role[] = ['author', 'company_secretary', 'legal', 'cfo', 'publisher'];
const DISCOVERY_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_S = 30;

export interface OidcOptions {
  /** Expected `iss` of the access token. Entra: https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: string;
  /** Expected `aud`: the API's own client id or identifier URI. */
  audience: string;
  /** Skip discovery when the keys live elsewhere than the issuer's metadata says (Compose: internal hostname). */
  jwksUri?: string;
  /** Claim holding the app roles. Dotted paths work: `realm_access.roles`. */
  rolesClaim: string;
  /** Claim holding the company the user acts for; `defaultIssuer` is used when it is absent. */
  issuerClaim: string;
  defaultIssuer?: string;
  /** Tests inject a key set; production leaves it unset. */
  keys?: JWTVerifyGetKey;
}

export type Authenticator = (bearerToken: string) => Promise<Actor>;

/** Resolves the signing keys lazily and retries discovery after a failure instead of caching it. */
function remoteKeys(o: Pick<OidcOptions, 'issuer' | 'jwksUri'>): JWTVerifyGetKey {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const load = async (): Promise<JWTVerifyGetKey> => {
    let uri = o.jwksUri;
    if (!uri) {
      const url = `${o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${url}`);
      uri = ((await res.json()) as { jwks_uri?: string }).jwks_uri;
      if (!uri) throw new Error(`OIDC discovery document has no jwks_uri: ${url}`);
    }
    return createRemoteJWKSet(new URL(uri), { timeoutDuration: DISCOVERY_TIMEOUT_MS });
  };
  return async (header, token) => {
    keys ??= load().catch((err) => {
      keys = undefined;
      throw err;
    });
    return (await keys)(header, token);
  };
}

const pathGet = (payload: JWTPayload, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), payload);

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Turns a verified access token into an Actor. The token is the source of truth for identity and
 * roles; the database only needs to know the company. Anything missing is a refusal, not a default.
 */
export function createAuthenticator(o: OidcOptions, issuerExists: (id: string) => Promise<boolean>): Authenticator {
  const keys = o.keys ?? remoteKeys(o);
  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: o.issuer,
        audience: o.audience,
        algorithms: ['RS256', 'PS256', 'ES256'],
        clockTolerance: CLOCK_TOLERANCE_S,
      }));
    } catch (err) {
      const detail = (err as { code?: string }).code;
      // Discovery or network trouble is ours to fix, not the caller's: do not pretend it is a bad token.
      if (detail === undefined || detail === 'ERR_JWKS_TIMEOUT') throw new DomainError(503, 'AUTH_UNAVAILABLE', 'The identity provider could not be reached');
      throw unauthorized(`Invalid access token (${detail})`);
    }

    const id = text(payload.oid) ?? text(payload.sub);
    if (!id) throw unauthorized('Access token has no subject');

    const claimed = pathGet(payload, o.rolesClaim);
    const roles = (Array.isArray(claimed) ? claimed : []).filter((r): r is Role => KNOWN_ROLES.includes(r as Role));
    if (roles.length === 0) throw forbidden('NO_ROLE', 'No application role is assigned to this account');

    const issuerId = text(pathGet(payload, o.issuerClaim)) ?? o.defaultIssuer;
    if (!issuerId) throw forbidden('NO_COMPANY', 'This account is not linked to a company');
    if (!(await issuerExists(issuerId))) throw forbidden('UNKNOWN_COMPANY', 'The company this account belongs to is not set up');

    const name = text(payload.name) ?? text(payload.preferred_username) ?? text(payload.email) ?? id;
    return { id, name, issuerId, roles: [...new Set(roles)] };
  };
}
