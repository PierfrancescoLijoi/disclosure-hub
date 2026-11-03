import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB } from './adapters/db/schema.js';
import { makeLei } from './jurisdictions/identifiers.js';

/** Demo tenants and personas. Idempotent: safe to run on every start. */
export const DEMO_USERS = [
  { id: 'alice', issuer_id: 'northwind', name: 'Alice Morgan (IR, author)', roles: ['author'] },
  { id: 'bob', issuer_id: 'northwind', name: 'Bob Chen (Company Secretary)', roles: ['company_secretary'] },
  { id: 'carol', issuer_id: 'northwind', name: 'Carol Diaz (General Counsel)', roles: ['legal'] },
  { id: 'dan', issuer_id: 'northwind', name: 'Dan Okafor (CFO)', roles: ['cfo'] },
  { id: 'erin', issuer_id: 'northwind', name: 'Erin Walsh (Head of IR, publisher)', roles: ['publisher'] },
  { id: 'frank', issuer_id: 'contoso', name: 'Frank Reyes (Contoso, author + publisher)', roles: ['author', 'publisher'] },
] as const;

export async function seedDemo(db: Kysely<DB>): Promise<void> {
  const issuers = [
    {
      id: 'northwind',
      name: 'Northwind Energy plc',
      profiles: {
        UK: { tidm: 'NWE', lei: makeLei('5299000NORTHWINDEN') },
        US: { cik: '0001234567', ccc: 'nw3n3rgy', ticker: 'NWEY' },
      },
    },
    {
      id: 'contoso',
      name: 'Contoso Biologics Inc.',
      profiles: { US: { cik: '0007654321', ccc: 'c0nt0s0#', ticker: 'CNTS' } },
    },
  ];
  for (const i of issuers) {
    await db
      .insertInto('issuers')
      .values({ id: i.id, name: i.name, profiles: JSON.stringify(i.profiles) })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
  for (const u of DEMO_USERS) {
    await db
      .insertInto('users')
      .values({ id: u.id, issuer_id: u.issuer_id, name: u.name, roles: JSON.stringify(u.roles) })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
}

const SeedIssuers = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1), profiles: z.record(z.string(), z.record(z.string(), z.string())) }),
);

/** Creates or updates the companies a deployment serves, from SEED_ISSUERS_JSON. Idempotent. */
export async function seedIssuers(db: Kysely<DB>, json: string): Promise<number> {
  const issuers = SeedIssuers.parse(JSON.parse(json));
  for (const i of issuers) {
    await db
      .insertInto('issuers')
      .values({ id: i.id, name: i.name, profiles: JSON.stringify(i.profiles) })
      .onConflict((oc) => oc.column('id').doUpdateSet({ name: i.name, profiles: JSON.stringify(i.profiles) }))
      .execute();
  }
  return issuers.length;
}
