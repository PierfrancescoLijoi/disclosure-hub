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
import { agentConsumer, preCheckAgent, type AdvisoryAgent } from './application/agents.js';
import { PreCheckService } from './application/precheck.js';
import { EventBus, Reactor } from './application/reactor.js';
import { AcsEmailChannel, LogChannel, SmtpChannel, WebhookChannel } from './adapters/channels/index.js';
import { notifierConsumer } from './application/readers/notifier.js';
import { SubscriptionService } from './application/readers/subscriptions.js';
import { PublicationRunner } from './application/publication-runner.js';
import type { Config } from './config.js';
import type { PolicyRegistry } from './domain/policy.js';
import { defaultPolicies } from './jurisdictions/index.js';
import { ChannelRegistry, ConsumerRegistry, GatewayRegistry, type Clock, type Consumer, type JobQueue, type Logger, type Store } from './ports/index.js';
import { seedDemo, seedIssuers } from './seed.js';

export interface Runtime {
  config: Config;
  db: Kysely<DB>;
  store: Store;
  policies: PolicyRegistry;
  queue: JobQueue;
  announcements: AnnouncementService;
  runner: PublicationRunner;
  events: EventBus;
  reactor: Reactor;
  /** Every consumer of domain events: reader notifications, agents, and anything a module adds. */
  consumers: ConsumerRegistry;
  subscriptions: SubscriptionService;
  /** The demo mailbox: only with EMAIL_TRANSPORT=log. */
  mailbox: LogChannel | undefined;
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
  /** Extra event consumers, registered beside the built-in ones. */
  consumers?: Consumer[];
  /** Extra advisory agents; they run on their triggers like the built-in ones. */
  agents?: AdvisoryAgent[];
  /** Replaces the configured reader channels (tests). */
  channels?: ChannelRegistry;
}

const systemClock: Clock = { now: () => new Date() };
const OUTBOX_REPORT_MS = 60_000;

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
  if (config.AUTO_MIGRATE && config.ROLE !== 'worker' && config.ROLE !== 'events') {
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

  const consumers = new ConsumerRegistry();
  const events = new EventBus(consumers, clock);
  const runner = new PublicationRunner({
    events,
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
  const announcements = new AnnouncementService({ store, policies, clock, queue, maxAttempts: config.MAX_ATTEMPTS, log, events });
  const provider = createPreCheckProvider(config);
  const preCheck = provider && new PreCheckService({ store, policies, clock, provider, log });

  // Readers: channels by configuration, one subscription service, one notifier consumer.
  const emailTransport = config.EMAIL_TRANSPORT ?? (config.DEMO ? 'log' : 'off');
  const channels = o.channels ?? new ChannelRegistry();
  let mailbox: LogChannel | undefined;
  if (!o.channels) {
    if (emailTransport === 'log') channels.register((mailbox = new LogChannel(log)));
    if (emailTransport === 'smtp') channels.register(new SmtpChannel(config.SMTP_URL!, config.EMAIL_FROM));
    if (emailTransport === 'acs') channels.register(new AcsEmailChannel(config.ACS_ENDPOINT!, config.EMAIL_FROM));
    if (config.WEBHOOKS) channels.register(new WebhookChannel(config.WEBHOOK_ALLOW_PRIVATE));
  }
  const tokenKey = config.READER_TOKEN_KEY ?? 'demo-reader-token-key-not-for-production-use';
  const baseUrl = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const subscriptions = new SubscriptionService({ store, policies, channels, clock, log, config: { baseUrl, tokenKey, allowPrivateWebhooks: config.WEBHOOK_ALLOW_PRIVATE } });
  consumers.register(notifierConsumer({ store, channels, subscriptions, clock, log, baseUrl, tokenKey }));

  // Agents are consumers with guardrails: the pre-check is the first, anything passed in is the next.
  const autorun = (config.AGENTS ?? (config.AI_PROVIDER === 'mock' ? 'precheck' : '')).split(',').map((s) => s.trim()).filter(Boolean);
  const agents = [...(provider && autorun.includes('precheck') ? [preCheckAgent(provider)] : []), ...(o.agents ?? [])];
  for (const agent of agents) consumers.register(agentConsumer(agent, policies, { store, events, clock, log }));
  for (const c of o.consumers ?? []) consumers.register(c);

  const only = config.REACTOR_CONSUMERS.split(',').map((s) => s.trim()).filter(Boolean);
  const reactor = new Reactor({
    store,
    consumers,
    clock,
    log,
    random: o.random,
    config: {
      leaseMs: config.LEASE_MS,
      maxAttempts: config.REACTOR_MAX_ATTEMPTS,
      retryBaseMs: config.RETRY_BASE_MS,
      retryMaxMs: config.RETRY_MAX_MS,
      batch: config.WORKER_CONCURRENCY,
      only: only.length ? only : undefined,
    },
  });

  let sweeper: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  let outboxReport: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  return {
    config,
    db,
    store,
    policies,
    queue,
    announcements,
    runner,
    events,
    reactor,
    consumers,
    subscriptions,
    mailbox,
    preCheck,
    log,
    async start() {
      // Two independent jobs, so each scales on its own signal: publishing (queue depth) and events (outbox lag).
      if (config.ROLE === 'worker' || config.ROLE === 'all') {
        await queue.start(async (id) => {
          await runner.run(id);
        });
        const sweep = () => runner.sweep().catch((err) => log.error({ err }, 'sweep failed'));
        await sweep();
        sweeper = setInterval(sweep, config.SWEEP_INTERVAL_MS);
        sweeper.unref();
      }
      if (config.ROLE === 'events' || config.ROLE === 'all') {
        // One pass at a time: a slow consumer must not make the ticks pile up and exceed WORKER_CONCURRENCY.
        const poll = () => {
          if (draining) return;
          draining = reactor.drain().then(
            () => undefined,
            (err) => log.error({ err }, 'reactor pass failed'),
          ).finally(() => {
            draining = undefined;
          });
        };
        poller = setInterval(poll, config.REACTOR_POLL_MS); // not unref'd: an events process has nothing else to keep it alive
        // The same numbers as /metrics, as a log line: Azure alerts on it from Log Analytics, no Prometheus scraper needed.
        const report = () =>
          store.stats(clock.now().toISOString()).then(
            (s) => log.info(s.events, 'outbox'),
            (err) => log.error({ err }, 'outbox stats failed'),
          );
        outboxReport = setInterval(report, OUTBOX_REPORT_MS);
        outboxReport.unref();
      }
    },
    async close() {
      if (sweeper) clearInterval(sweeper);
      if (poller) clearInterval(poller);
      if (outboxReport) clearInterval(outboxReport);
      await draining; // let a pass in flight finish before the database goes away
      await queue.close();
      await store.close();
    },
  };
}
