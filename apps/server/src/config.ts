import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

export const ConfigSchema = z
  .object({
    /** api: HTTP only. worker: publication queue consumer + sweeper. events: the event reactor only (pick consumers with REACTOR_CONSUMERS). all: everything in one process (local mode). */
    ROLE: z.enum(['api', 'worker', 'events', 'all']).default('all'),
    HOST: z.string().default('0.0.0.0'),
    PORT: int(3000),
    /** `sqlite:./data/hub.db`, `sqlite::memory:` or `postgres://...` */
    DATABASE_URL: z.string().default('sqlite:./data/hub.db'),
    /** `inproc`, `pg` (LISTEN/NOTIFY on the database, no extra service) or `redis://...` */
    QUEUE_URL: z.string().default('inproc'),
    AUTO_MIGRATE: flag(true),
    /** `demo`: seeded personas via the x-user-id header (needs DEMO=1). `oidc`: verify bearer tokens from a real identity provider. */
    AUTH_MODE: z.enum(['demo', 'oidc']).default('demo'),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_AUDIENCE: z.string().min(1).optional(),
    /** Only when the signing keys are reachable at another address than the issuer's metadata says. */
    OIDC_JWKS_URI: z.string().url().optional(),
    OIDC_ROLES_CLAIM: z.string().default('roles'),
    OIDC_ISSUER_CLAIM: z.string().default('issuer_id'),
    /** The company every user acts for when the token carries no company claim (one-company deployments). */
    OIDC_DEFAULT_ISSUER: z.string().min(1).optional(),
    /** What the browser app needs to start the sign-in (public values). */
    OIDC_AUTHORITY: z.string().url().optional(),
    OIDC_SPA_CLIENT_ID: z.string().min(1).optional(),
    OIDC_SPA_SCOPE: z.string().default('openid profile'),
    /** `password`: credentials in DATABASE_URL. `azure-managed-identity`: an Entra token is the password. */
    DATABASE_AUTH: z.enum(['password', 'azure-managed-identity']).default('password'),
    /** JSON array of companies to create or update at migration time: [{ id, name, profiles }]. */
    SEED_ISSUERS_JSON: z.string().optional(),
    /** Seeded personas, dev endpoints for the mock gateways, persona picker in the UI. */
    DEMO: flag(true),
    /** Hold releases while the channel is closed instead of sending at any hour. */
    ENFORCE_WINDOWS: flag(false),
    AI_PROVIDER: z.enum(['off', 'mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL: z.string().default('claude-sonnet-5-5'),
    MAX_ATTEMPTS: int(5),
    RETRY_BASE_MS: int(2000),
    RETRY_MAX_MS: int(60_000),
    LEASE_MS: int(60_000),
    SWEEP_INTERVAL_MS: int(5000),
    /** Requests per actor per minute; 0 switches the limit off (load tests). */
    RATE_LIMIT_PER_MIN: int(600),
    /** AI pre-check calls per actor per minute: each one can cost money with a real provider. */
    PRECHECK_RATE_LIMIT_PER_MIN: int(20),
    /** Seconds-level poll of the event outbox by consumers (reader notifications, agents). */
    REACTOR_POLL_MS: int(1000),
    REACTOR_MAX_ATTEMPTS: int(8),
    /** Comma list of consumer ids this process runs (for example `notifier` or `agent:precheck`); empty runs all. */
    REACTOR_CONSUMERS: z.string().default(''),
    /** Comma list of agents that run by themselves on events. Unset: the pre-check when AI_PROVIDER=mock (free), none otherwise (a real provider costs money per submit). */
    AGENTS: z.string().optional(),
    /** Public address of the site; links in notifications and the feed point here. */
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Derives confirmation, unsubscribe and webhook-signing secrets. At least 32 characters; required unless DEMO=1. */
    READER_TOKEN_KEY: z.string().min(32).optional(),
    /** `off`: no email. `log`: demo mailbox in memory and logs. `smtp`: SMTP_URL (Mailpit locally). `acs`: Azure Communication Services Email with the managed identity. */
    EMAIL_TRANSPORT: z.enum(['off', 'log', 'smtp', 'acs']).optional(),
    EMAIL_FROM: z.string().default('announcements@localhost'),
    SMTP_URL: z.string().optional(),
    ACS_ENDPOINT: z.string().url().optional(),
    /** Reader webhooks; off removes the option from the public form. */
    WEBHOOKS: flag(true),
    /** Allow webhooks to private addresses and plain http (local demo only; never in production). */
    WEBHOOK_ALLOW_PRIVATE: flag(false),
    /** Reverse proxies in front of the API (Front Door, ingress): how many X-Forwarded-For hops to trust for the client address. */
    TRUST_PROXY: int(0),
    /** Azure Front Door id: when set, requests that do not carry it in X-Azure-FDID (the edge adds it) are refused, so the WAF and cache cannot be skipped by calling the app directly. Probes are exempt. */
    EDGE_ID: z.string().min(8).optional(),
    WORKER_CONCURRENCY: int(4),
    GATEWAY_CONCURRENCY: int(2),
    WEB_DIST: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const postgres = /^postgres(ql)?:\/\//.test(c.DATABASE_URL);
    if (c.QUEUE_URL === 'pg' && !postgres) {
      ctx.addIssue({ code: 'custom', path: ['QUEUE_URL'], message: 'QUEUE_URL=pg needs a PostgreSQL DATABASE_URL' });
    }
    if (c.DATABASE_AUTH === 'azure-managed-identity' && !postgres) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_AUTH'], message: 'azure-managed-identity needs a PostgreSQL DATABASE_URL' });
    }
    if (c.AUTH_MODE === 'oidc') {
      for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE'] as const) {
        if (!c[key]) ctx.addIssue({ code: 'custom', path: [key], message: `AUTH_MODE=oidc needs ${key}` });
      }
    }
    if (c.QUEUE_URL === 'inproc' && c.ROLE !== 'all') {
      ctx.addIssue({ code: 'custom', path: ['QUEUE_URL'], message: 'The in-process queue only works with ROLE=all; use pg or redis:// for split roles' });
    }
    const email = c.EMAIL_TRANSPORT ?? (c.DEMO ? 'log' : 'off');
    if (email === 'smtp' && !c.SMTP_URL) ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'EMAIL_TRANSPORT=smtp needs SMTP_URL' });
    if (email === 'acs' && !c.ACS_ENDPOINT) ctx.addIssue({ code: 'custom', path: ['ACS_ENDPOINT'], message: 'EMAIL_TRANSPORT=acs needs ACS_ENDPOINT' });
    if (!c.DEMO && c.ROLE !== 'worker' && !c.READER_TOKEN_KEY && (email !== 'off' || c.WEBHOOKS)) {
      ctx.addIssue({ code: 'custom', path: ['READER_TOKEN_KEY'], message: 'Reader subscriptions need READER_TOKEN_KEY (32+ characters) unless DEMO=1; set EMAIL_TRANSPORT=off and WEBHOOKS=0 to switch them off' });
    }
    if (c.WEBHOOK_ALLOW_PRIVATE && !c.DEMO) {
      ctx.addIssue({ code: 'custom', path: ['WEBHOOK_ALLOW_PRIVATE'], message: 'WEBHOOK_ALLOW_PRIVATE is for the local demo only' });
    }
    if (c.AI_PROVIDER === 'anthropic' && !c.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY' });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
