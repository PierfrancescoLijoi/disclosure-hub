import { describe, expect, it } from 'vitest';
import { addBusinessDays, windowStatus, zonedToUtc, civilOf } from '../src/domain/calendar.js';
import { canonicalJson, contentHash } from '../src/domain/hash.js';
import { assertCapability, availableActions, requirementSatisfied } from '../src/domain/permissions.js';
import { nextStatus, TRANSITIONS, type TransitionEvent } from '../src/domain/state-machine.js';
import { STATUSES, type Actor, type Approval } from '../src/domain/types.js';
import { UK_BANK_HOLIDAYS, US_FEDERAL_HOLIDAYS } from '../src/jurisdictions/calendars.js';
import { isValidCcc, isValidCik, isValidIsin, isValidLei, makeLei } from '../src/jurisdictions/identifiers.js';

const actor = (roles: Actor['roles']): Actor => ({ id: 'u', name: 'U', issuerId: 'i', roles });

describe('state machine', () => {
  it('walks the happy path draft to published', () => {
    const path: [TransitionEvent, string][] = [
      ['validation_passed', 'validated'],
      ['submit', 'in_review'],
      ['approvals_complete', 'approved'],
      ['publish', 'publishing'],
      ['published', 'published'],
    ];
    let s: string = 'draft';
    for (const [event, expected] of path) {
      s = nextStatus(s as never, event);
      expect(s).toBe(expected);
    }
  });

  it('rejects every move not in the table', () => {
    for (const status of STATUSES) {
      for (const [event, t] of Object.entries(TRANSITIONS)) {
        const legal = (t.from as readonly string[]).includes(status);
        const attempt = () => nextStatus(status, event as TransitionEvent);
        if (legal) expect(attempt()).toBe(t.to);
        else expect(attempt).toThrowError(/Cannot/);
      }
    }
  });

  it('has no way out of published or withdrawn', () => {
    for (const terminal of ['published', 'withdrawn'] as const) {
      for (const event of Object.keys(TRANSITIONS) as TransitionEvent[]) {
        expect(() => nextStatus(terminal, event)).toThrow();
      }
    }
  });
});

describe('permissions', () => {
  it('maps status and role to the buttons a user may press', () => {
    expect(availableActions('draft', actor(['author']))).toEqual(['edit', 'validate', 'withdraw']);
    expect(availableActions('in_review', actor(['legal']))).toEqual(['approve', 'request_changes']);
    expect(availableActions('approved', actor(['publisher']))).toEqual(['publish', 'reopen']);
    expect(availableActions('published', actor(['author', 'publisher', 'legal']))).toEqual([]);
  });

  it('refuses a missing capability', () => {
    expect(() => assertCapability(actor(['author']), 'publisher')).toThrow(/needs one of/);
  });

  const approval = (approverId: string, roles: Approval['roles'], voided = false): Approval => ({
    id: approverId,
    announcementId: 'a',
    revision: 1,
    contentHash: 'h',
    approverId,
    roles,
    decision: 'approve',
    comment: '',
    at: 'now',
    voidedAt: voided ? 'x' : null,
  });

  it('needs a distinct approver per required role', () => {
    const req = { min: 2, mustInclude: ['legal', 'cfo'] as Approval['roles'] };
    expect(requirementSatisfied(req, [approval('a', ['legal', 'cfo']), approval('b', ['company_secretary'])])).toBe(false);
    expect(requirementSatisfied(req, [approval('a', ['legal']), approval('b', ['cfo'])])).toBe(true);
  });

  it('ignores voided approvals and needs min approvers', () => {
    expect(requirementSatisfied({ min: 2, mustInclude: [] }, [approval('a', ['legal']), approval('b', ['cfo'], true)])).toBe(false);
    expect(requirementSatisfied({ min: 1, mustInclude: [] }, [approval('a', ['legal'])])).toBe(true);
  });
});

describe('calendar', () => {
  it('skips weekends and holidays when adding business days', () => {
    // Tuesday 2026-11-03 + 4 business days is Monday 2026-11-09.
    expect(addBusinessDays('2026-11-03', 4, US_FEDERAL_HOLIDAYS)).toBe('2026-11-09');
    // Friday 2026-11-06 + 1 skips the weekend and Veterans Day (Wed 11 Nov) for +3.
    expect(addBusinessDays('2026-11-06', 3, US_FEDERAL_HOLIDAYS)).toBe('2026-11-12');
    // 2026-12-24 + 1 skips Christmas Day and the Boxing Day substitute (Mon 28 Dec) in the UK.
    expect(addBusinessDays('2026-12-24', 1, UK_BANK_HOLIDAYS)).toBe('2026-12-29');
  });

  it('converts wall clock to UTC across daylight saving', () => {
    expect(zonedToUtc('2026-07-01', '09:30', 'America/New_York').toISOString()).toBe('2026-07-01T13:30:00.000Z');
    expect(zonedToUtc('2026-12-01', '09:30', 'America/New_York').toISOString()).toBe('2026-12-01T14:30:00.000Z');
    expect(civilOf(new Date('2026-07-01T23:30:00Z'), 'Europe/London')).toBe('2026-07-02');
  });

  it('reports the next opening of a window', () => {
    const w = { open: '07:00', close: '18:30' };
    const open = windowStatus(new Date('2026-11-03T12:00:00Z'), 'Europe/London', w, UK_BANK_HOLIDAYS);
    expect(open).toEqual({ open: true, nextOpenAt: null });
    const evening = windowStatus(new Date('2026-11-03T19:00:00Z'), 'Europe/London', w, UK_BANK_HOLIDAYS);
    expect(evening.open).toBe(false);
    expect(evening.nextOpenAt?.toISOString()).toBe('2026-11-04T07:00:00.000Z');
    const saturday = windowStatus(new Date('2026-11-07T10:00:00Z'), 'Europe/London', w, UK_BANK_HOLIDAYS);
    expect(saturday.nextOpenAt?.toISOString()).toBe('2026-11-09T07:00:00.000Z');
  });
});

describe('hashing', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    const base = { jurisdiction: 'UK', category: 'general', headline: 'h', body: 'b' };
    expect(contentHash({ ...base, metadata: { x: 1, y: 2 } })).toBe(contentHash({ ...base, metadata: { y: 2, x: 1 } }));
    expect(contentHash({ ...base, metadata: {} })).not.toBe(contentHash({ ...base, body: 'c', metadata: {} }));
  });
});

describe('identifiers', () => {
  it('validates LEI checksums', () => {
    const lei = makeLei('529900TESTNORTHWIN');
    expect(isValidLei(lei)).toBe(true);
    expect(isValidLei(lei.slice(0, 19) + (lei.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(isValidLei('short')).toBe(false);
  });

  it('validates ISIN checksums', () => {
    expect(isValidIsin('US0378331005')).toBe(true);
    expect(isValidIsin('GB0007980591')).toBe(true);
    expect(isValidIsin('US0378331006')).toBe(false);
  });

  it('validates CIK and CCC shapes', () => {
    expect(isValidCik('0001234567')).toBe(true);
    expect(isValidCik('123')).toBe(false);
    expect(isValidCcc('abcd1234')).toBe(true);
    expect(isValidCcc('short')).toBe(false);
  });
});
