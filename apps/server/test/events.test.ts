import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AdvisoryAgent } from '../src/application/agents.js';
import { EVENT } from '../src/domain/events.js';
import type { Consumer } from '../src/ports/index.js';
import { pruneOutbox } from '../src/runtime.js';
import { FakeClock, fx, makeEnv, publishAnnouncement, silent, type Env } from './helpers.js';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const probe = (seen: string[], over: Partial<Consumer> = {}): Consumer => ({
  id: 'probe',
  handles: [EVENT.published],
  async handle(e) {
    seen.push(e.aggregateId);
  },
  ...over,
});

describe('event outbox and reactor', () => {
  it('commits the published event with the publication and delivers it once to each interested consumer', async () => {
    const seen: string[] = [];
    env = await makeEnv({ consumers: [probe(seen)] });
    const id = await publishAnnouncement(env);
    await env.rt.reactor.drain();

    expect(seen).toEqual([id]);
    const rows = await env.rt.store.read.events.forAggregate(id);
    expect(rows.filter((r) => r.consumer === 'probe')).toMatchObject([{ status: 'done', attempts: 1, event: { type: EVENT.published, issuerId: 'northwind' } }]);
    // A consumer that did not ask for an event type gets no delivery for it.
    expect(rows.some((r) => r.consumer === 'probe' && r.event.type === EVENT.submitted)).toBe(false);
  });

  it('retries a failing consumer with backoff and parks the delivery as dead after the last attempt', async () => {
    let calls = 0;
    const flaky = probe([], {
      id: 'flaky',
      async handle() {
        calls++;
        throw new Error('downstream is down');
      },
    });
    const clock = new FakeClock(new Date('2026-11-03T10:00:00Z'));
    env = await makeEnv({ clock, consumers: [flaky], env: { REACTOR_MAX_ATTEMPTS: '3' } });
    const id = await publishAnnouncement(env);
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await env.rt.reactor.drain();
    }
    expect(calls).toBe(3);
    const row = (await env.rt.store.read.events.forAggregate(id)).find((r) => r.consumer === 'flaky')!;
    expect(row).toMatchObject({ status: 'dead', attempts: 3, lastError: 'downstream is down' });
    expect((await env.rt.store.stats(clock.now().toISOString())).events.deadDeliveries).toBe(1);
  });

  it('lets another worker take over an abandoned lease and refuses the stale holder', async () => {
    const seen: string[] = [];
    const clock = new FakeClock(new Date('2026-11-03T10:00:00Z'));
    env = await makeEnv({ clock, consumers: [probe(seen)] });
    const id = await publishAnnouncement(env, fx.ukGeneral());
    // Simulate a worker that claimed a delivery and died: a fresh event for the probe.
    await env.rt.store.tx((tx) => env!.rt.events.emit(tx, { type: EVENT.published, issuerId: 'northwind', aggregateId: id, payload: {} }));
    const [lost] = await env.rt.store.read.events.claim(['probe'], clock.now().toISOString(), 1000, 'worker-a', 5);
    expect(lost).toBeDefined();

    clock.advance(5000);
    await env.rt.reactor.drain();
    expect(seen).toHaveLength(2); // the first publication, then the taken-over delivery
    expect(await env.rt.store.read.events.complete(lost!.id, 'worker-a', clock.now().toISOString())).toBe(false);
  });

  it('tells a slow consumer to stop when the reactor stops waiting, and retries it later', async () => {
    let aborted = false;
    const slow = probe([], {
      id: 'slow',
      async handle(_e, ctx) {
        await new Promise<void>((resolve) => ctx?.signal.addEventListener('abort', () => resolve()));
        aborted = true;
        throw new Error('stopped');
      },
    });
    env = await makeEnv({ consumers: [slow], env: { LEASE_MS: '200' } });
    const id = await publishAnnouncement(env);
    await env.rt.reactor.tick();
    expect(aborted).toBe(true);
    const row = (await env.rt.store.read.events.forAggregate(id)).find((r) => r.consumer === 'slow')!;
    expect(row.lastError).toBe('consumer timed out'); // recorded as a failed attempt, not left in flight
    expect(row.status).not.toBe('in_flight');
    expect(row.attempts).toBeGreaterThanOrEqual(1);
  });

  it('parks a delivery as dead when it keeps outliving its lease instead of retrying it forever', async () => {
    const seen: string[] = [];
    const clock = new FakeClock(new Date('2026-11-03T10:00:00Z'));
    env = await makeEnv({ clock, consumers: [probe(seen)], env: { REACTOR_MAX_ATTEMPTS: '2' } });
    const id = await publishAnnouncement(env);
    const delivered = seen.length;
    // A fresh event whose handler crashes the process: claimed, never completed, lease expires, claimed again.
    await env.rt.store.tx((tx) => env!.rt.events.emit(tx, { type: EVENT.published, issuerId: 'northwind', aggregateId: id, payload: {} }));
    for (let i = 0; i < 3; i++) {
      await env.rt.store.read.events.claim(['probe'], clock.now().toISOString(), 1000, `crashed-${i}`, 5);
      clock.advance(5000);
    }
    await env.rt.reactor.tick();
    expect(seen).toHaveLength(delivered); // the handler is not run again
    const row = (await env.rt.store.read.events.forAggregate(id)).find((r) => r.consumer === 'probe' && r.status === 'dead')!;
    expect(row).toBeDefined();
    expect(row.lastError).toContain('gave up');
  });

  it('prunes delivered events after the retention window and keeps dead and waiting ones for a person', async () => {
    const clock = new FakeClock(new Date('2026-11-03T10:00:00Z'));
    const broken = probe([], { id: 'broken', async handle() { throw new Error('always'); } });
    env = await makeEnv({ clock, consumers: [probe([]), broken], env: { REACTOR_MAX_ATTEMPTS: '1' } });
    const id = await publishAnnouncement(env);
    clock.advance(30 * 86_400_000);
    // Delivered recently: inside the retention window, so it stays whatever else is removed.
    const young = await publishAnnouncement(env);
    // A fresh event nobody has handled yet must survive, however old the rest is.
    await env.rt.store.tx((tx) => env!.rt.events.emit(tx, { type: EVENT.published, issuerId: 'northwind', aggregateId: id, payload: {} }));
    const before = await env.rt.db.selectFrom('event_deliveries').select('status').execute();
    expect(before.some((r) => r.status === 'done')).toBe(true);

    const removed = await pruneOutbox(env.rt.store, clock, 14, silent);
    expect(removed).toBeGreaterThan(0);
    const after = await env.rt.db.selectFrom('event_deliveries').select('status').execute();
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.status === 'dead' || r.status === 'pending' || r.status === 'done')).toBe(true);
    expect((await env.rt.store.read.events.forAggregate(young)).some((r) => r.status === 'done')).toBe(true);
    expect((await env.rt.store.read.events.forAggregate(id)).some((r) => r.status === 'done')).toBe(false);
    // The dead delivery's event is still there to be read.
    expect((await env.rt.store.read.events.forAggregate(id)).some((r) => r.consumer === 'broken' && r.status === 'dead')).toBe(true);
    expect(await pruneOutbox(env.rt.store, clock, 14, silent)).toBe(0); // nothing more to remove
  });

  it('runs only the consumers a process is told to run', async () => {
    const seen: string[] = [];
    env = await makeEnv({ consumers: [probe(seen)], env: { REACTOR_CONSUMERS: 'notifier' } });
    await publishAnnouncement(env);
    expect(seen).toEqual([]);
    const pending = (await env.rt.store.stats(new Date().toISOString())).events.pendingDeliveries;
    expect(pending).toBeGreaterThan(0); // written for the probe, waiting for a process that runs it
  });
});

const note = z.object({ note: z.string() });
const agent = (id: string, triggers: string[], run: AdvisoryAgent['run'], over: Partial<AdvisoryAgent> = {}): AdvisoryAgent => ({
  id,
  version: '1',
  triggers,
  output: note,
  run,
  ...over,
});

const reportsBy = async (e: Env, id: string, agentId: string) => {
  const a = (await e.rt.store.read.announcements.get('northwind', id))!;
  return (await e.rt.store.read.aiReports.forRevision(id, a.currentRevision)).filter((r) => r.agent === agentId);
};

async function submitted(e: Env): Promise<string> {
  const { id } = await e.svc.create(e.actors.alice, fx.ukGeneral());
  await e.svc.validate(e.actors.alice, id);
  await e.svc.submit(e.actors.alice, id);
  await e.rt.reactor.drain();
  return id;
}

describe('advisory agents', () => {
  it('runs the pre-check on its own when an announcement is submitted, so reviewers find it ready', async () => {
    env = await makeEnv();
    const id = await submitted(env);
    const latest = await env.rt.preCheck!.latest(env.actors.bob, id);
    expect(latest).toMatchObject({ provider: 'mock-heuristic-v1', revision: 1 });
    expect((await reportsBy(env, id, 'precheck'))[0]!.eventId).not.toBeNull();
    const audit = await env.rt.store.read.audit.list(id);
    expect(audit.some((e) => e.type === 'agent_report' && e.actorId === 'agent:precheck')).toBe(true);
  });

  it('does not run the pre-check by itself when AGENTS says none', async () => {
    env = await makeEnv({ env: { AGENTS: '' } });
    const id = await submitted(env);
    expect(await env.rt.preCheck!.latest(env.actors.bob, id)).toBeNull();
  });

  it('adds a second agent with no change to the workflow, and lets it build on the first one report', async () => {
    const first = agent('a', [EVENT.submitted], async () => ({ note: 'from a' }));
    const second = agent('b', [EVENT.agentReport], async (ctx) => ({ note: `saw ${ctx.reports.map((r) => r.agent).join(',')}` }));
    env = await makeEnv({ agents: [first, second], env: { AGENTS: '' } });
    const id = await submitted(env);

    expect((await reportsBy(env, id, 'a')).map((r) => r.report)).toEqual([{ note: 'from a' }]);
    expect((await reportsBy(env, id, 'b')).map((r) => r.report)).toEqual([{ note: 'saw a' }]);
  });

  it('writes one report per event even when the event is delivered twice', async () => {
    let runs = 0;
    const once = agent('once', [EVENT.submitted], async () => ({ note: String(++runs) }));
    env = await makeEnv({ agents: [once], env: { AGENTS: '' } });
    const id = await submitted(env);
    const consumer = env.rt.consumers.get('agent:once')!;
    const event = (await env.rt.store.read.events.forAggregate(id)).find((r) => r.consumer === 'agent:once')!.event;
    await consumer.handle(event);
    expect(await reportsBy(env, id, 'once')).toHaveLength(1);
    expect(runs).toBe(1);
  });

  it('stops agents that keep triggering each other', async () => {
    const both = [EVENT.submitted, EVENT.agentReport];
    env = await makeEnv({ agents: [agent('ping', both, async () => ({ note: 'ping' })), agent('pong', both, async () => ({ note: 'pong' }))], env: { AGENTS: '' } });
    const id = await submitted(env);
    const total = (await reportsBy(env, id, 'ping')).length + (await reportsBy(env, id, 'pong')).length;
    expect(total).toBeGreaterThan(2);
    expect(total).toBeLessThan(40);
  });

  it('discards output that does not match the schema, keeps a record, and does not retry', async () => {
    let runs = 0;
    const bad = agent('bad', [EVENT.submitted], async () => ((runs++, { wrong: true })));
    env = await makeEnv({ agents: [bad], env: { AGENTS: '' } });
    const id = await submitted(env);
    expect(await reportsBy(env, id, 'bad')).toHaveLength(0);
    expect(runs).toBe(1);
    expect((await env.rt.store.read.audit.list(id)).some((e) => e.type === 'agent_output_rejected')).toBe(true);
  });

  it('never blocks the workflow when an agent keeps failing', async () => {
    const down = agent('down', [EVENT.submitted], async () => {
      throw new Error('model unavailable');
    });
    env = await makeEnv({ agents: [down], env: { AGENTS: '' } });
    const id = await submitted(env);
    await env.svc.approve(env.actors.bob, id);
    await env.svc.publish(env.actors.erin, id);
    await env.settle();
    expect((await env.svc.get(env.actors.erin, id)).announcement.status).toBe('published');
  });

  it('gives an agent a copy of the announcement, not a way to change it', async () => {
    const meddler = agent('meddler', [EVENT.submitted], async (ctx) => {
      ctx.view.headline = 'tampered';
      ctx.view.metadata.x = 1;
      return { note: 'done' };
    });
    env = await makeEnv({ agents: [meddler], env: { AGENTS: '' } });
    const id = await submitted(env);
    const rev = (await env.rt.store.read.revisions.get(id, 1))!;
    expect(rev.headline).toBe('Notice of Annual General Meeting');
    expect(rev.metadata).toEqual({});
  });
});
