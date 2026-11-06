import { afterEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/domain/hash.js';
import { fx, makeEnv, type Env } from './helpers.js';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

// A person approving and an advisory agent reporting write to the same announcement's audit chain at the same
// moment. Neither may fail because the other got there first: the chain stays linear and unbroken.
// With one writer at a time (SQLite) this passes trivially; on PostgreSQL (TEST_PG_URL) it is a real race.
describe('audit chain under concurrent writers', () => {
  it('records every concurrent entry once, in a single unbroken chain', async () => {
    env = await makeEnv();
    const { alice } = env.actors;
    const { id } = await env.svc.create(alice, fx.ukGeneral());
    const before = (await env.rt.store.read.audit.list(id)).length;

    const writers = 8;
    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        env!.rt.store.tx((tx) =>
          tx.audit.append(
            { announcementId: id, issuerId: alice.issuerId, type: 'agent_report', actorId: `agent:test-${i}`, data: { n: i } },
            new Date().toISOString(),
          ),
        ),
      ),
    );

    const events = await env.rt.store.read.audit.list(id);
    expect(events).toHaveLength(before + writers);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: before + writers }, (_, i) => i + 1));
    expect(verifyAuditChain(events)).toEqual({ ok: true });
  });
});
