import { describe, expect, it } from 'vitest';
import { attention, countBy, missingRequired } from '../src/work';

const row = (status: string, extra: Record<string, unknown> = {}) => ({ status, changesRequested: false, createdBy: 'alice', ...extra });
const alice = { id: 'alice', roles: ['author'] };
const bob = { id: 'bob', roles: ['company_secretary'] };
const erin = { id: 'erin', roles: ['publisher'] };

describe('attention', () => {
  it('points an author at their draft and at returned work', () => {
    expect(attention(row('draft'), alice)).toBe('Finish and validate');
    expect(attention(row('draft', { changesRequested: true }), alice)).toBe('Address the review comments');
    expect(attention(row('validated'), alice)).toBe('Submit for review');
  });

  it('asks an approver only about other people’s submissions', () => {
    expect(attention(row('in_review'), bob)).toBe('Review and decide');
    expect(attention(row('in_review', { createdBy: 'bob' }), bob)).toBeNull();
  });

  it('asks a publisher for approved and failed items', () => {
    expect(attention(row('approved'), erin)).toBe('Publish');
    expect(attention(row('failed'), erin)).toMatch(/retry/);
    expect(attention(row('published'), erin)).toBeNull();
  });

  it('stays quiet for roles that cannot act', () => {
    expect(attention(row('draft'), erin)).toBeNull();
    expect(attention(row('approved'), bob)).toBeNull();
  });
});

describe('countBy', () => {
  it('tallies by key', () => {
    expect(countBy([{ s: 'a' }, { s: 'b' }, { s: 'a' }], (r) => r.s)).toEqual({ a: 2, b: 1 });
  });
});

describe('missingRequired', () => {
  const schema = {
    required: ['eventDate', 'signatory'],
    properties: {
      eventDate: { title: 'Event date', type: 'string' },
      signatory: { title: 'Signatory', type: 'object', required: ['name'], properties: { name: { title: 'Name', type: 'string' } } },
    },
  };

  it('lists empty required fields, including nested ones', () => {
    expect(missingRequired(schema, {})).toEqual(['Event date', 'Signatory']);
    expect(missingRequired(schema, { eventDate: '2026-11-01', signatory: {} })).toEqual(['Signatory → Name']);
  });

  it('is satisfied when everything is present', () => {
    expect(missingRequired(schema, { eventDate: '2026-11-01', signatory: { name: 'Carol' } })).toEqual([]);
  });
});
