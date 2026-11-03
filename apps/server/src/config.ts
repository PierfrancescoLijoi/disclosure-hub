import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

export const ConfigSchema = z
  .object({
    /** api: HTTP only. worker: queue consumer + sweeper. all: both in one process (local mode). */
    ROLE: z.enum(['api', 'worker', 'all']).default('all'),
    HOST: z.string().default('0.0.0.0'),
    PORT: int(3000),
    /** `sqlite:./data/hub.db`, `sqlite::memory:` or `postgres://...` */
    DATABASE_URL: z.string().default('sqlite:./data/hub.db'),
    /** `inproc` or `redis://...` */
    QUEUE_URL: z.string().default('inproc'),
    AUTO_MIGRATE: flag(true),
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
    WORKER_CONCURRENCY: int(4),
    GATEWAY_CONCURRENCY: int(2),
    WEB_DIST: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.QUEUE_URL === 'inproc' && c.ROLE !== 'all') {
      ctx.addIssue({ code: 'custom', path: ['QUEUE_URL'], message: 'The in-process queue only works with ROLE=all; use redis:// for split roles' });
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
