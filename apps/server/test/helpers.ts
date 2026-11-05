import { sql } from 'kysely';
import { connect } from '../src/adapters/db/connect.js';
import { InProcessQueue } from '../src/adapters/queue/in-process.js';
import { AnnouncementService, type CreateInput } from '../src/application/announcements.js';
import { loadConfig } from '../src/config.js';
import { civilOf } from '../src/domain/calendar.js';
import type { PolicyRegistry } from '../src/domain/policy.js';
import type { Actor } from '../src/domain/types.js';
import type { AdvisoryAgent } from '../src/application/agents.js';
import type { ChannelRegistry, Consumer, GatewayRegistry, JobQueue, Clock, Logger } from '../src/ports/index.js';
import { createRuntime, type Runtime } from '../src/runtime.js';

/** TEST_LOG=1 prints what the runtime logs, for debugging a flaky run. */
export const silent: Logger = process.env.TEST_LOG
  ? { info: (o, m) => console.log('info', m ?? o), warn: (o, m) => console.log('warn', m, o), error: (o, m) => console.log('error', m, o) }
  : { info() {}, warn() {}, error() {} };

export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(iso: string) {
    this.t = new Date(iso);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** Records wake-ups and never runs them: tests then call runner.run() themselves. */
export class RecordingQueue implements JobQueue {
  enqueued: { id: string; delayMs?: number }[] = [];
  async enqueue(id: string, opts?: { delayMs?: number }) {
    this.enqueued.push({ id, delayMs: opts?.delayMs });
  }
  async start() {}
  async close() {}
}

export interface Env {
  rt: Runtime;
  svc: AnnouncementService;
  actors: Record<'alice' | 'bob' | 'carol' | 'dan' | 'erin' | 'frank', Actor>;
  queue: RecordingQueue | undefined;
  /** Waits for in-process jobs (including delayed retries) to finish. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface EnvOptions {
  env?: Record<string, string>;
  clock?: Clock;
  manualQueue?: boolean;
  policies?: PolicyRegistry;
  gateways?: GatewayRegistry;
  consumers?: Consumer[];
  agents?: AdvisoryAgent[];
  channels?: ChannelRegistry;
}

/**
 * Same suite, two databases: set TEST_PG_URL to run every integration test on PostgreSQL
 * instead of in-memory SQLite. Nothing in the tests depends on the dialect.
 */
export async function makeEnv(o: EnvOptions = {}): Promise<Env> {
  const url = process.env.TEST_PG_URL ?? 'sqlite::memory:';
  const connection = connect(url);
  if (connection.dialect === 'postgres') {
    await sql`drop schema public cascade`.execute(connection.db);
    await sql`create schema public`.execute(connection.db);
  }
  const config = loadConfig({
    DATABASE_URL: url,
    QUEUE_URL: 'inproc',
    DEMO: '1',
    RETRY_BASE_MS: '1',
    RETRY_MAX_MS: '4',
    SWEEP_INTERVAL_MS: '600000',
    REACTOR_POLL_MS: '600000',
    ...o.env,
  });
  const queue = o.manualQueue ? new RecordingQueue() : undefined;
  const rt = await createRuntime(config, {
    clock: o.clock,
    log: silent,
    random: () => 0.5,
    connection,
    queue,
    policies: o.policies,
    gateways: o.gateways,
    consumers: o.consumers,
    agents: o.agents,
    channels: o.channels,
  });
  await rt.start();
  const load = async (id: string) => (await rt.store.read.users.get(id))!;
  return {
    rt,
    svc: rt.announcements,
    actors: { alice: await load('alice'), bob: await load('bob'), carol: await load('carol'), dan: await load('dan'), erin: await load('erin'), frank: await load('frank') },
    queue,
    settle: async () => {
      if (rt.queue instanceof InProcessQueue) await rt.queue.drain();
    },
    close: () => rt.close(),
  };
}

export async function addUser(env: Env, id: string, issuerId: string, roles: Actor['roles']): Promise<Actor> {
  await env.rt.db
    .insertInto('users')
    .values({ id, issuer_id: issuerId, name: id, roles: JSON.stringify(roles) })
    .execute();
  return (await env.rt.store.read.users.get(id))!;
}

// ------------------------------------------------------------------ fixtures

const todayUk = () => civilOf(new Date(), 'Europe/London');
const todayNy = () => civilOf(new Date(), 'America/New_York');
const todayCph = () => civilOf(new Date(), 'Europe/Copenhagen');
const cphInDays = (n: number) => civilOf(new Date(Date.now() + n * 86_400_000), 'Europe/Copenhagen');
const CONTACT = 'Enquiries: Investor Relations, ir@northwind.example, +44 20 7946 0000.';
const LONG = 'The Board of Northwind Energy plc announces an update for shareholders and the wider market. '.repeat(3);

export const fx = {
  ukGeneral: (): CreateInput => ({
    jurisdiction: 'UK',
    category: 'general',
    headline: 'Notice of Annual General Meeting',
    body: `${LONG}\n${CONTACT}`,
    metadata: {},
  }),
  ukInside: (): CreateInput => ({
    jurisdiction: 'UK',
    category: 'inside_information',
    headline: 'Trading update',
    body: `${LONG}\n${CONTACT}`,
    metadata: {
      informationBecameKnownAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      personResponsible: { name: 'Bob Chen', title: 'Company Secretary' },
    },
  }),
  ukPdmr: (): CreateInput => ({
    jurisdiction: 'UK',
    category: 'pdmr_dealing',
    headline: 'Director/PDMR Shareholding',
    body: `Notification of a transaction by a person discharging managerial responsibilities.\n${CONTACT}`,
    metadata: {
      pdmrName: 'Dan Okafor',
      position: 'Chief Financial Officer',
      instrument: 'Ordinary shares of 1p each',
      isin: 'GB0007980591',
      transactionType: 'acquisition',
      price: 4.21,
      currency: 'GBP',
      volume: 1000,
      transactionDate: todayUk(),
      venue: 'XLON',
      notifiedAt: todayUk(),
    },
  }),
  dkInside: (): CreateInput => ({
    jurisdiction: 'DK',
    category: 'inside_information',
    headline: 'Trading update',
    body: `${LONG}\n${CONTACT}`,
    metadata: {
      language: 'en',
      informationBecameKnownAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      personResponsible: { name: 'Bob Chen', title: 'Company Secretary' },
    },
  }),
  dkPdmr: (): CreateInput => ({
    jurisdiction: 'DK',
    category: 'pdmr_dealing',
    headline: 'Managers transactions',
    body: `Notification of a transaction by a person discharging managerial responsibilities.\n${CONTACT}`,
    metadata: {
      language: 'da',
      pdmrName: 'Dan Okafor',
      position: 'Chief Financial Officer',
      instrument: 'Ordinary shares',
      isin: 'DK0010244425',
      transactionType: 'acquisition',
      price: 120,
      currency: 'DKK',
      volume: 2000,
      transactionDate: todayCph(),
      venue: 'XCSE',
      notifiedAt: todayCph(),
    },
  }),
  dkHolding: (): CreateInput => ({
    jurisdiction: 'DK',
    category: 'major_shareholding',
    headline: 'Major shareholder announcement',
    body: `Northwind Energy plc was notified of a change in a major holding.
${CONTACT}`,
    metadata: {
      language: 'da',
      holder: { name: 'Fjord Capital A/S', type: 'legal_entity' },
      threshold: '5%',
      direction: 'up',
      basis: 'voting_rights',
      holdingKind: 'shares',
      holdingPercent: 5.4,
      crossedOn: todayCph(),
      notifiedOn: todayCph(),
    },
  }),
  dkBuyback: (): CreateInput => ({
    jurisdiction: 'DK',
    category: 'share_buyback',
    headline: 'Share buyback: transactions',
    body: `Transactions under the share buyback programme.
${CONTACT}`,
    metadata: {
      language: 'en',
      programme: 'Share buyback 2026',
      periodFrom: todayCph(),
      periodTo: todayCph(),
      sharesBought: 1000,
      averagePrice: 118.4,
      currency: 'DKK',
      cumulativeShares: 5000,
      authorisedMaximum: 500000,
    },
  }),
  dkMeeting: (): CreateInput => ({
    jurisdiction: 'DK',
    category: 'general_meeting',
    headline: 'Notice of annual general meeting',
    body: `The Board convenes the annual general meeting.
${CONTACT}`,
    metadata: { language: 'en', meetingType: 'annual', meetingDate: cphInDays(28), venue: 'Copenhagen' },
  }),
  usEarnings: (): CreateInput => ({
    jurisdiction: 'US',
    category: 'form_8k',
    headline: 'Northwind Energy reports third quarter results',
    body: `Northwind Energy reports third quarter results with revenue growth.\n${CONTACT}`,
    metadata: {
      eventDate: todayNy(),
      items: ['2.02'],
      exhibit99_1: true,
      signatory: { name: 'Carol Diaz', title: 'General Counsel' },
    },
  }),
  usOther: (): CreateInput => ({
    jurisdiction: 'US',
    category: 'form_8k',
    headline: 'Northwind Energy announces share repurchase programme',
    body: `${LONG}\n${CONTACT}`,
    metadata: { eventDate: todayNy(), items: ['8.01'], signatory: { name: 'Carol Diaz', title: 'General Counsel' } },
  }),
};

export const withBody = (i: CreateInput, body: string): CreateInput => ({ ...i, body });

/** Draft to published through the real workflow, with the wire and the event consumers settled. */
export async function publishAnnouncement(e: Env, input: CreateInput = fx.ukGeneral(), approvers: Actor[] = [e.actors.bob]): Promise<string> {
  const { id } = await e.svc.create(e.actors.alice, input);
  await e.svc.validate(e.actors.alice, id);
  await e.svc.submit(e.actors.alice, id);
  for (const a of approvers) await e.svc.approve(a, id);
  await e.svc.publish(e.actors.erin, id);
  await e.settle();
  await e.rt.reactor.drain();
  return id;
}
