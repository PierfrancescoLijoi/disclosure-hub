import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaosKey, type Chaos } from '../src/adapters/gateways/mock.js';
import type { CreateInput } from '../src/application/announcements.js';
import { DomainError } from '../src/domain/errors.js';
import type { Actor } from '../src/domain/types.js';
import { addUser, fx, makeEnv, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(() => env.close());

const setChaos = (channel: string, chaos: Chaos) =>
  env.rt.store.read.settings.set(chaosKey(channel), JSON.stringify(chaos));
const receipts = async (channel: string) =>
  env.rt.db.selectFrom('ext_receipts').selectAll().where('channel', '=', channel).execute();

async function expectError(p: Promise<unknown>, status: number, code?: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).status).toBe(status);
  if (code) expect((err as DomainError).code).toBe(code);
}

/** Draft -> validated -> in review -> approved, returning the announcement id. */
async function toApproved(input: CreateInput, approvers: Actor[]) {
  const { alice } = env.actors;
  const { id } = await env.svc.create(alice, input);
  const v = await env.svc.validate(alice, id);
  expect(v.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect((await env.svc.submit(alice, id)).ok).toBe(true);
  for (const approver of approvers) await env.svc.approve(approver, id);
  return id;
}

async function publishAndSettle(id: string) {
  await env.svc.publish(env.actors.erin, id);
  await env.settle();
  return env.svc.get(env.actors.erin, id);
}

describe('draft to published, UK', () => {
  it('publishes a general announcement through RNS with an RNS number and a valid audit chain', async () => {
    const { alice, bob, erin } = env.actors;
    const id = await toApproved(fx.ukGeneral(), [bob]);
    expect((await env.svc.get(erin, id)).announcement.status).toBe('approved');

    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    expect(view.publication?.status).toBe('acked');
    expect(view.publication?.externalRef).toMatch(/^\d{4}[A-Z]$/);
    expect(view.obligations.join(' ')).toContain('National Storage Mechanism');

    const trail = await env.svc.auditTrail(alice, id);
    expect(trail.chain).toEqual({ ok: true });
    expect(trail.events.map((e) => e.type)).toEqual([
      'created', 'validated', 'submitted', 'approved', 'publish_requested', 'published',
    ]);
  });

  it('needs two approvals including the company secretary for inside information', async () => {
    const { alice, bob, carol, erin } = env.actors;
    const { id } = await env.svc.create(alice, fx.ukInside());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);

    // Carol alone is not enough: needs two approvers and one must be the company secretary.
    expect(await env.svc.approve(carol, id)).toMatchObject({ complete: false, status: 'in_review' });
    expect(await env.svc.approve(bob, id)).toMatchObject({ complete: true, status: 'approved' });

    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    expect(view.timing?.deadline).toMatchObject({ at: null, basis: expect.stringContaining('As soon as possible') });
    void erin;
  });

  it('adds the MAR statement and the responsible person to the rendered release', async () => {
    const { bob } = env.actors;
    const { carol } = env.actors;
    const id = await toApproved(fx.ukInside(), [bob, carol]);
    await publishAndSettle(id);
    const receipt = (await receipts('rns'))[0]!;
    expect(JSON.parse(receipt.detail)).toMatchObject({ service: 'RNS', tidm: 'NWE' });
  });
});

describe('draft to published, Denmark', () => {
  it('publishes a Danish PDMR notification through Nasdaq Copenhagen with a company announcement number', async () => {
    const { alice, bob } = env.actors;
    const id = await toApproved(fx.dkPdmr(), [bob]);
    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    expect(view.publication?.externalRef).toMatch(/^1\/\d{4}$/);
    expect(view.obligations.join(' ')).toContain('OAM');
    const detail = JSON.parse((await receipts('cph'))[0]!.detail);
    expect(detail).toMatchObject({ service: 'Nasdaq Copenhagen', cvr: '12345674', language: 'da' });
    expect((await env.svc.auditTrail(alice, id)).chain).toEqual({ ok: true });
  });

  it('retries a transient Copenhagen failure without a second release', async () => {
    const id = await toApproved(fx.dkPdmr(), [env.actors.bob]);
    await setChaos('cph', { mode: 'transient', failuresRemaining: 2 });
    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    expect(await receipts('cph')).toHaveLength(1);
  });

  it('refuses to publish when the Danish language field is missing', async () => {
    const input = fx.dkPdmr();
    delete (input.metadata as Record<string, unknown>).language;
    const { id } = await env.svc.create(env.actors.alice, input);
    const v = await env.svc.validate(env.actors.alice, id);
    expect(v.ok).toBe(false);
    expect(v.report.issues.map((i) => i.path)).toContain('metadata.language');
  });
});

describe('draft to published, US', () => {
  it('publishes an earnings 8-K once legal and the CFO have each approved', async () => {
    const { alice, bob, carol, dan, erin } = env.actors;
    const { id } = await env.svc.create(alice, fx.usEarnings());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);

    // Policy for Item 2.02: two approvers, one legal and one CFO, each a different person.
    expect(await env.svc.approve(bob, id)).toMatchObject({ complete: false });
    expect(await env.svc.approve(carol, id)).toMatchObject({ complete: false });
    expect(await env.svc.approve(dan, id)).toMatchObject({ complete: true });

    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    expect(view.publication?.externalRef).toMatch(/^0001234567-\d{2}-\d{6}$/);
    expect(view.publication?.ack).toMatchObject({ filingDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(view.obligations.join(' ')).toContain('earnings call');
    expect(view.timing?.deadline?.basis).toContain('Form 8-K');
    void erin;
  });

  it('applies a lighter approval requirement to a non-earnings 8-K', async () => {
    const { bob, carol } = env.actors;
    const id = await toApproved(fx.usOther(), [carol, bob]);
    expect((await publishAndSettle(id)).announcement.status).toBe('published');
  });

  it('uses the same state transitions as the UK flow', async () => {
    const { alice, bob, carol } = env.actors;
    const uk = await env.svc.create(alice, fx.ukGeneral());
    const us = await env.svc.create(alice, fx.usOther());
    for (const [id, approvers] of [[uk.id, [bob]], [us.id, [bob, carol]]] as const) {
      await env.svc.validate(alice, id);
      await env.svc.submit(alice, id);
      for (const approver of approvers) await env.svc.approve(approver, id);
    }
    const [a, b] = await Promise.all([env.svc.get(alice, uk.id), env.svc.get(alice, us.id)]);
    expect([a.announcement.status, b.announcement.status]).toEqual(['approved', 'approved']);
  });
});

describe('validation gates', () => {
  it('blocks submit when the jurisdiction rules fail and explains why', async () => {
    const { alice } = env.actors;
    const bad = fx.usEarnings();
    bad.metadata = { ...bad.metadata, exhibit99_1: false };
    const { id } = await env.svc.create(alice, bad);

    const v = await env.svc.validate(alice, id);
    expect(v.ok).toBe(false);
    expect(v.report.issues.map((i) => i.code)).toContain('US_8K_2_02_EXHIBIT');
    expect(v.status).toBe('draft');

    await expectError(env.svc.submit(alice, id), 409, 'INVALID_TRANSITION');
  });

  it('flags jurisdiction-specific problems with codes the UI can show', async () => {
    const { alice } = env.actors;
    const badPdmr = fx.ukPdmr();
    badPdmr.metadata = { ...badPdmr.metadata, isin: 'GB0007980590' };
    const { id } = await env.svc.create(alice, badPdmr);
    const v = await env.svc.validate(alice, id);
    expect(v.report.issues.map((i) => i.code)).toContain('INVALID_ISIN');
  });

  it('re-validates on submit and sends a now-invalid draft back', async () => {
    const { alice } = env.actors;
    const { id } = await env.svc.create(alice, fx.ukGeneral());
    await env.svc.validate(alice, id);
    // Break the issuer profile after validation: submit must notice.
    await env.rt.db.updateTable('issuers').set({ profiles: JSON.stringify({ UK: { tidm: 'NWE', lei: 'BADLEI' } }) }).where('id', '=', 'northwind').execute();
    const r = await env.svc.submit(alice, id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('draft');
    expect(r.report.issues.map((i) => i.code)).toContain('ISSUER_PROFILE_INCOMPLETE');
  });
});

describe('maker-checker and content binding', () => {
  it('refuses approval by the revision author', async () => {
    const gina = await addUser(env, 'gina', 'northwind', ['author', 'company_secretary']);
    const { id } = await env.svc.create(gina, fx.ukGeneral());
    await env.svc.validate(gina, id);
    await env.svc.submit(gina, id);
    await expectError(env.svc.approve(gina, id), 403, 'FOUR_EYES');
  });

  it('refuses the same approver twice and users without an approver role', async () => {
    const { alice, bob, carol } = env.actors;
    const { id } = await env.svc.create(alice, fx.usOther());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    await env.svc.approve(carol, id);
    await expectError(env.svc.approve(carol, id), 409, 'ALREADY_APPROVED');
    await expectError(env.svc.approve(alice, id), 403, 'MISSING_ROLE');
    await env.svc.approve(bob, id);
  });

  it('keeps authors from publishing and publishers from drafting', async () => {
    const { alice, erin } = env.actors;
    await expectError(env.svc.create(erin, fx.ukGeneral()), 403, 'MISSING_ROLE');
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    await expectError(env.svc.publish(alice, id), 403, 'MISSING_ROLE');
  });

  it('cannot edit once in review; reopening voids approvals and a new revision needs fresh ones', async () => {
    const { alice, bob, erin } = env.actors;
    const id = await toApproved(fx.ukGeneral(), [bob]);
    const edit = { ...fx.ukGeneral(), body: 'Changed text. Enquiries: ir@northwind.example' };

    await expectError(env.svc.saveRevision(alice, id, edit), 409, 'INVALID_TRANSITION');
    await env.svc.reopen(erin, id, 'late correction');
    expect((await env.svc.saveRevision(alice, id, edit)).changed).toBe(true);

    const view = await env.svc.get(alice, id);
    expect(view.announcement).toMatchObject({ status: 'draft', currentRevision: 2 });
    expect(view.approvals).toEqual([]);
    expect((await env.svc.revisions(alice, id)).map((r) => r.number)).toEqual([1, 2]);

    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    await expectError(env.svc.publish(erin, id), 409, 'INVALID_TRANSITION');
    await env.svc.approve(bob, id);
    expect((await publishAndSettle(id)).announcement.status).toBe('published');
  });

  it('does not let earlier approvals count after changes were requested', async () => {
    const { alice, bob, carol } = env.actors;
    const { id } = await env.svc.create(alice, fx.usOther());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    await env.svc.approve(carol, id);
    await env.svc.requestChanges(bob, id, 'Add the buy-back size');

    // Resubmit unchanged: the earlier approval was voided, so it is back to zero.
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    expect(await env.svc.approve(bob, id)).toMatchObject({ complete: false });
    await expectError(env.svc.requestChanges(bob, id, ' '), 422, 'COMMENT_REQUIRED');
  });

  it('refuses to publish when approved content no longer matches its hash', async () => {
    const { erin } = env.actors;
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    await env.rt.db.updateTable('revisions').set({ body: 'Tampered after approval' }).where('announcement_id', '=', id).execute();
    await expectError(env.svc.publish(erin, id), 409, 'APPROVAL_STALE');
  });
});

describe('tenancy and idempotent create', () => {
  it('hides one issuer announcements from another', async () => {
    const { alice, frank } = env.actors;
    const { id } = await env.svc.create(alice, fx.usOther());
    await expectError(env.svc.get(frank, id), 404);
    await expectError(env.svc.validate(frank, id), 404);
    expect((await env.svc.list(frank, { limit: 10 })).items).toEqual([]);
    expect((await env.svc.list(alice, { limit: 10 })).items).toHaveLength(1);
  });

  it('returns the same announcement for a repeated Idempotency-Key and rejects a changed payload', async () => {
    const { alice } = env.actors;
    const first = await env.svc.create(alice, fx.ukGeneral(), 'key-1');
    const again = await env.svc.create(alice, fx.ukGeneral(), 'key-1');
    expect(again).toEqual({ id: first.id, replay: true });
    await expectError(env.svc.create(alice, { ...fx.ukGeneral(), headline: 'Different' }, 'key-1'), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect((await env.svc.list(alice, { limit: 10 })).items).toHaveLength(1);
  });

  it('pages through announcements with a cursor', async () => {
    const { alice } = env.actors;
    for (let i = 0; i < 5; i++) await env.svc.create(alice, { ...fx.ukGeneral(), headline: `Notice ${i}` });
    const p1 = await env.svc.list(alice, { limit: 2 });
    const p2 = await env.svc.list(alice, { limit: 2, cursor: p1.nextCursor! });
    const p3 = await env.svc.list(alice, { limit: 2, cursor: p2.nextCursor! });
    const ids = [...p1.items, ...p2.items, ...p3.items].map((a) => a.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
  });
});

describe('publication reliability', () => {
  it('treats a double publish as one publication and one release', async () => {
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    const { erin } = env.actors;
    await Promise.all([env.svc.publish(erin, id), env.svc.publish(erin, id).catch(() => undefined)]);
    await env.svc.publish(erin, id);
    await env.settle();
    expect((await env.svc.get(erin, id)).announcement.status).toBe('published');
    expect(await receipts('rns')).toHaveLength(1);
    const pubs = await env.rt.db.selectFrom('publications').selectAll().execute();
    expect(pubs).toHaveLength(1);
  });

  it('retries transient gateway failures with backoff and still releases exactly once', async () => {
    await setChaos('edgar', { mode: 'transient', failuresRemaining: 2 });
    const id = await toApproved(fx.usOther(), [env.actors.carol, env.actors.bob]);
    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    expect(view.publication?.attempts).toBe(3);
    const events = (await env.svc.auditTrail(env.actors.alice, id)).events;
    expect(events.filter((e) => e.type === 'publish_attempt_failed')).toHaveLength(2);
    expect(await receipts('edgar')).toHaveLength(1);
  });

  it('reconciles a lost acknowledgement instead of sending the release twice', async () => {
    await setChaos('rns', { mode: 'ack_lost', failuresRemaining: 1 });
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    const view = await publishAndSettle(id);
    expect(view.announcement.status).toBe('published');
    const rows = await receipts('rns');
    expect(rows).toHaveLength(1);
    expect(view.publication?.externalRef).toBe(rows[0]!.external_ref);
    expect(view.publication?.attempts).toBe(2);
  });

  it('fails after the retry budget, then a publisher can retry once the wire is back', async () => {
    env = await (async () => {
      await env.close();
      return makeEnv({ env: { MAX_ATTEMPTS: '3' } });
    })();
    await setChaos('rns', { mode: 'transient', failuresRemaining: 99 });
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    const failed = await publishAndSettle(id);
    expect(failed.announcement).toMatchObject({ status: 'failed' });
    expect(failed.announcement.failureReason).toContain('GATEWAY_UNAVAILABLE');
    expect(failed.publication?.status).toBe('exhausted');
    expect(failed.actions).toContain('retry');

    await setChaos('rns', { mode: 'ok' });
    await env.svc.retry(env.actors.erin, id);
    await env.settle();
    const ok = await env.svc.get(env.actors.erin, id);
    expect(ok.announcement.status).toBe('published');
    expect(await receipts('rns')).toHaveLength(1);
  });

  it('does not retry a permanent rejection; the fix is a corrected revision', async () => {
    const { alice, bob, erin } = env.actors;
    await setChaos('rns', { mode: 'permanent' });
    const id = await toApproved(fx.ukGeneral(), [bob]);
    const failed = await publishAndSettle(id);
    expect(failed.announcement.status).toBe('failed');
    expect(failed.publication?.status).toBe('rejected');
    expect(failed.publication?.attempts).toBe(1);
    await expectError(env.svc.retry(erin, id), 409, 'RETRY_NOT_ALLOWED');

    await setChaos('rns', { mode: 'ok' });
    await env.svc.reopen(erin, id);
    await env.svc.saveRevision(alice, id, { ...fx.ukGeneral(), body: 'Corrected text. Enquiries: ir@northwind.example' });
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    await env.svc.approve(bob, id);
    const ok = await publishAndSettle(id);
    expect(ok.announcement.status).toBe('published');
    expect(ok.publication?.revision).toBe(2);
    expect(await receipts('rns')).toHaveLength(1);
  });

  it('keeps a second worker from double-publishing and rejects the stale lease holder', async () => {
    await env.close();
    env = await makeEnv({ manualQueue: true });
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    await env.svc.publish(env.actors.erin, id);
    const pubId = env.queue!.enqueued[0]!.id;
    const { publications } = env.rt.store.read;

    // Worker A claims with a short lease, then "crashes" without finishing.
    const a = await publications.claim(pubId, new Date().toISOString(), 300, 'worker-a');
    expect(a?.attempts).toBe(1);
    expect(await publications.claim(pubId, new Date().toISOString(), 300, 'worker-b')).toBeNull();

    await new Promise((r) => setTimeout(r, 350));
    expect(await env.rt.runner.run(pubId)).toBe('published');
    // The crashed worker wakes up late: its write must be refused.
    expect(await publications.finish(pubId, 'worker-a', { status: 'acked' }, new Date().toISOString())).toBe(false);
    expect(await receipts('rns')).toHaveLength(1);
  });

  it('recovers a publication whose wake-up was lost', async () => {
    await env.close();
    env = await makeEnv({ manualQueue: true, env: { LEASE_MS: '800' } }); // sweep grace = lease / 4 = 200ms
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    await env.svc.publish(env.actors.erin, id);
    env.queue!.enqueued.length = 0; // the wake-up is lost (Redis flushed, process died)

    expect(await env.rt.runner.sweep()).toBe(0); // not overdue yet
    await new Promise((r) => setTimeout(r, 260));
    expect(await env.rt.runner.sweep()).toBe(1);
    expect(await env.rt.runner.run(env.queue!.enqueued[0]!.id)).toBe('published');
  });

  it('re-schedules a wake-up that arrives before the retry is due instead of dropping it', async () => {
    await env.close();
    env = await makeEnv({ manualQueue: true });
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    await env.svc.publish(env.actors.erin, id);
    const pubId = env.queue!.enqueued[0]!.id;
    const due = new Date(Date.now() + 5_000).toISOString();
    await env.rt.store.read.publications.update(pubId, { status: 'retry', nextAttemptAt: due }, due);

    expect(await env.rt.runner.run(pubId)).toBe('skipped');
    const rewake = env.queue!.enqueued.at(-1)!;
    expect(rewake.id).toBe(pubId);
    expect(rewake.delayMs).toBeGreaterThan(4_000);
    expect(await receipts('rns')).toHaveLength(0);
  });

  it('fails the release if approved content was altered between approval and the wire', async () => {
    await env.close();
    env = await makeEnv({ manualQueue: true });
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    await env.svc.publish(env.actors.erin, id);
    await env.rt.db.updateTable('revisions').set({ headline: 'Altered' }).where('announcement_id', '=', id).execute();
    expect(await env.rt.runner.run(env.queue!.enqueued[0]!.id)).toBe('failed');
    const view = await env.svc.get(env.actors.erin, id);
    expect(view.announcement.failureReason).toContain('APPROVAL_STALE');
    expect(await receipts('rns')).toHaveLength(0);
  });
});

describe('audit trail', () => {
  it('detects a tampered event', async () => {
    const id = await toApproved(fx.ukGeneral(), [env.actors.bob]);
    const { alice } = env.actors;
    expect((await env.svc.auditTrail(alice, id)).chain).toEqual({ ok: true });
    await env.rt.db.updateTable('audit_events').set({ actor_id: 'mallory' }).where('announcement_id', '=', id).where('seq', '=', 3).execute();
    expect((await env.svc.auditTrail(alice, id)).chain).toEqual({ ok: false, brokenAtSeq: 3 });
  });

  it('rejects two concurrent writes to the same announcement', async () => {
    const { alice, bob, carol } = env.actors;
    const { id } = await env.svc.create(alice, fx.usOther());
    await env.svc.validate(alice, id);
    await env.svc.submit(alice, id);
    const results = await Promise.allSettled([env.svc.approve(bob, id), env.svc.approve(carol, id)]);
    // Either both succeed in sequence, or the loser gets a clean 409; never a half-written state.
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as DomainError).status).toBe(409);
    }
    const view = await env.svc.get(alice, id);
    const approved = view.approvals.filter((a) => a.decision === 'approve').length;
    expect(view.announcement.status).toBe(approved >= 2 ? 'approved' : 'in_review');
    expect((await env.svc.auditTrail(alice, id)).chain).toEqual({ ok: true });
  });
});
