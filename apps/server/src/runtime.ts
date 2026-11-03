import type { Kysely } from 'kysely';
import { BullMqQueue } from './adapters/queue/bullmq.js';
import { InProcessQueue } from './adapters/queue/in-process.js';
import { PgNotifyQueue } from './adapters/queue/pg-notify.js';
import { connect, migrateToLatest, type Connection } from './adapters/db/connect.js';
import { createStore } from './adapters/db/kysely-store.js';
import type { DB } from './adapters/db/schema.js';
import { MockEdgarGateway, MockRnsGateway } from './adapters/gateways/mock.js';
import { createPreCheckProvider } from './adapters/ai/index.js';
import { AnnouncementService } from './application/announcements.js';
import { PreCheckService } from './application/precheck.js';
import { PublicationRunner } from './application/publication-runner.js';
import type { Config } from './config.js';
import type { PolicyRegistry } from './domain/policy.js';
import { defaultPolicies } from './jurisdictions/index.js';
import { GatewayRegistry, type Clock, type JobQueue, type Logger, type Store } from './ports/index.js';
import { seedDemo, seedIssuers } from './seed.js';

export interface Runtime {
  config: Config;
  db: Kysely<DB>;
  store: Store;
  policies: PolicyRegistry;
  queue: JobQueue;
  announcements: AnnouncementService;
  runner: PublicationRunner;
  /** Undefined when AI_PROVIDER=off: the rest of the system never needs it. */
  preCheck: PreCheckService | undefined;
  log: Logger;
  /** Starts the consumer and sweeper according to ROLE. */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeOverrides {
  clock?: Clock;
  log?: Logger;
  policies?: PolicyRegistry;
  gateways?: GatewayRegistry;
  queue?: JobQueue;
  connection?: Connection;
  random?: () => number;
}

const systemClock: Clock = { now: () => new Date() };

const write = (level: string) => (obj: object | string, msg?: string) => {
  const fields = typeof obj === 'string' ? { msg: obj } : { msg, ...describeErrors(obj) };
  console.log(JSON.stringify({ level, time: new Date().toISOString(), ...fields }));
};
const describeErrors = (o: object) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Error ? v.message : v]));

export const consoleLogger: Logger = { info: write('info'), warn: write('warn'), error: write('error') };

export async function createRuntime(config: Config, o: RuntimeOverrides = {}): Promise<Runtime> {
  const log = o.log ?? consoleLogger;
  const clock = o.clock ?? systemClock;
  const connection = o.connection ?? connect(config.DATABASE_URL, config.DATABASE_AUTH);
  const { db } = connection;
  if (config.AUTO_MIGRATE && config.ROLE !== 'worker') {
    await migrateToLatest(db);
    if (config.DEMO) await seedDemo(db);
    if (config.SEED_ISSUERS_JSON) await seedIssuers(db, config.SEED_ISSUERS_JSON);
  }

  const store = createStore(db);
  const policies = o.policies ?? defaultPolicies();
  const gateways = o.gateways ?? new GatewayRegistry().register(new MockRnsGateway(db, clock)).register(new MockEdgarGateway(db, clock));
  const queue =
    o.queue ??
    (config.QUEUE_URL === 'inproc'
      ? new InProcessQueue(config.WORKER_CONCURRENCY, (err, id) => log.error({ err, publicationId: id }, 'job crashed'))
      : config.QUEUE_URL === 'pg'
        ? new PgNotifyQueue(connection.pool!, {
            concurrency: config.WORKER_CONCURRENCY,
            onError: (err, id) => log.error({ err, publicationId: id }, 'queue error'),
          })
        : new BullMqQueue(config.QUEUE_URL, {
            concurrency: config.WORKER_CONCURRENCY,
            onError: (err, id) => log.error({ err, publicationId: id }, 'job crashed'),
          }));

  const runner = new PublicationRunner({
    store,
    policies,
    gateways,
    clock,
    queue,
    log,
    random: o.random,
    config: {
      leaseMs: config.LEASE_MS,
      retryBaseMs: config.RETRY_BASE_MS,
      retryMaxMs: config.RETRY_MAX_MS,
      gatewayConcurrency: config.GATEWAY_CONCURRENCY,
      enforceWindows: config.ENFORCE_WINDOWS,
    },
  });
  const announcements = new AnnouncementService({ store, policies, clock, queue, maxAttempts: config.MAX_ATTEMPTS, log });
  const provider = createPreCheckProvider(config);
  const preCheck = provider && new PreCheckService({ store, policies, clock, provider, log });

  let sweeper: NodeJS.Timeout | undefined;
  return {
    config,
    db,
    store,
    policies,
    queue,
    announcements,
    runner,
    preCheck,
    log,
    async start() {
      if (config.ROLE === 'api') return;
      await queue.start(async (id) => {
        await runner.run(id);
      });
      const sweep = () => runner.sweep().catch((err) => log.error({ err }, 'sweep failed'));
      await sweep();
      sweeper = setInterval(sweep, config.SWEEP_INTERVAL_MS);
      sweeper.unref();
    },
    async close() {
      if (sweeper) clearInterval(sweeper);
      await queue.close();
      await store.close();
    },
  };
}
