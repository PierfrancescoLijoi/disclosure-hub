import { describe, expect, it } from 'vitest';
import { ruleContext } from '../src/application/announcements.js';
import type { Announcement, Issuer, Revision } from '../src/domain/types.js';
import { makeLei } from '../src/jurisdictions/identifiers.js';
import { ukPolicy } from '../src/jurisdictions/uk.js';
import { usPolicy } from '../src/jurisdictions/us.js';

const NOW = new Date('2026-11-03T12:00:00Z'); // Tuesday, GMT / EST

const issuer: Issuer = {
  id: 'i',
  name: 'Northwind Energy plc',
  profiles: {
    UK: { tidm: 'NWE', lei: makeLei('5299000NORTHWINDEN') },
    US: { cik: '0001234567', ccc: 'nw3n3rgy', ticker: 'NWEY' },
  },
};

const BODY = 'A sufficiently detailed announcement for shareholders. Enquiries: ir@northwind.example';

const input = (category: string, metadata: unknown, over: { headline?: string; body?: string; issuer?: Issuer; now?: Date } = {}) => ({
  announcementId: 'a1',
  category,
  issuer: over.issuer ?? issuer,
  headline: over.headline ?? 'Headline',
  body: over.body ?? BODY,
  metadata,
  now: over.now ?? NOW,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const errors = (issues: { code: string; severity: string }[]) => issues.filter((i) => i.severity === 'error').map((i) => i.code);

function context(policy: typeof ukPolicy, category: string, metadata: Record<string, unknown>, now = NOW) {
  const a = { id: 'a1', jurisdiction: policy.code, category } as Announcement;
  const rev = { headline: 'Headline', body: BODY, metadata } as Revision;
  return ruleContext(policy, a, rev, issuer, now)!;
}

describe('shared rules', () => {
  it('requires headline and body, caps headline length and rejects draft placeholders', () => {
    expect(codes(ukPolicy.validate(input('general', {}, { headline: ' ', body: '' })))).toEqual(['HEADLINE_REQUIRED', 'BODY_REQUIRED']);
    expect(codes(ukPolicy.validate(input('general', {}, { headline: 'x'.repeat(151) })))).toContain('HEADLINE_TOO_LONG');
    expect(codes(ukPolicy.validate(input('general', {}, { body: 'Revenue of [●] million, TBC' })))).toContain('PLACEHOLDER_LEFT');
    expect(ukPolicy.validate(input('general', {}))).toEqual([]);
  });

  it('checks the issuer has the identifiers the channel needs', () => {
    const badLei: Issuer = { ...issuer, profiles: { UK: { tidm: 'NWE', lei: 'NOTALEI' } } };
    expect(codes(ukPolicy.validate(input('general', {}, { issuer: badLei })))).toContain('ISSUER_PROFILE_INCOMPLETE');
    const noUs: Issuer = { ...issuer, profiles: { UK: issuer.profiles.UK! } };
    expect(codes(usPolicy.validate(input('form_8k', { eventDate: '2026-11-02', items: ['8.01'], signatory: { name: 'a', title: 'b' } }, { issuer: noUs })))).toContain('ISSUER_PROFILE_INCOMPLETE');
  });

  it('reports schema errors with a path instead of crashing', () => {
    const issues = ukPolicy.validate(input('inside_information', {}));
    expect(issues.every((i) => i.code === 'SCHEMA_INVALID')).toBe(true);
    expect(issues.map((i) => i.path)).toContain('metadata.personResponsible');
  });

  it('refuses an unknown category', () => {
    expect(() => ukPolicy.validate(input('nope', {}))).toThrow(/no category/);
  });
});

describe('UK policy', () => {
  const person = { name: 'Bob Chen', title: 'Company Secretary' };

  it('warns when inside information has been known a while without a recorded delay', () => {
    const stale = { informationBecameKnownAt: '2026-11-03T08:00:00Z', personResponsible: person };
    expect(codes(ukPolicy.validate(input('inside_information', stale)))).toEqual(['UK_MAR_ASAP']);
    const fresh = { informationBecameKnownAt: '2026-11-03T11:30:00Z', personResponsible: person };
    expect(ukPolicy.validate(input('inside_information', fresh))).toEqual([]);
  });

  it('demands a real justification for a delayed disclosure and rejects future timestamps', () => {
    const delayed = (justification: string) => ({
      informationBecameKnownAt: '2026-11-03T08:00:00Z',
      personResponsible: person,
      delayedDisclosure: { decidedAt: '2026-11-03T08:10:00Z', justification },
    });
    expect(errors(ukPolicy.validate(input('inside_information', delayed('later'))))).toEqual(['UK_MAR_DELAY_JUSTIFICATION']);
    expect(errors(ukPolicy.validate(input('inside_information', delayed('Negotiations ongoing; disclosure would prejudice the issuer and confidentiality is ensured'))))).toEqual([]);
    const future = { informationBecameKnownAt: '2026-11-04T08:00:00Z', personResponsible: person };
    expect(errors(ukPolicy.validate(input('inside_information', future)))).toContain('FUTURE_TIMESTAMP');
  });

  const pdmr = (over: Record<string, unknown> = {}) => ({
    pdmrName: 'Dan Okafor',
    position: 'CFO',
    instrument: 'Ordinary shares',
    isin: 'GB0007980591',
    transactionType: 'acquisition',
    price: 4.2,
    currency: 'GBP',
    volume: 10,
    transactionDate: '2026-11-03',
    venue: 'XLON',
    notifiedAt: '2026-11-03',
    ...over,
  });

  it('computes the PDMR deadline as three business days and warns once it has passed', () => {
    expect(ukPolicy.timing(context(ukPolicy, 'pdmr_dealing', pdmr())).deadline?.at?.toISOString()).toBe('2026-11-06T23:59:00.000Z');
    expect(ukPolicy.validate(input('pdmr_dealing', pdmr()))).toEqual([]);
    const late = pdmr({ transactionDate: '2026-10-28', notifiedAt: '2026-10-28' });
    expect(codes(ukPolicy.validate(input('pdmr_dealing', late)))).toEqual(['DEADLINE_PASSED']);
  });

  it('validates ISIN and date order for PDMR dealings', () => {
    expect(errors(ukPolicy.validate(input('pdmr_dealing', pdmr({ isin: 'GB0007980590' }))))).toEqual(['INVALID_ISIN']);
    expect(errors(ukPolicy.validate(input('pdmr_dealing', pdmr({ transactionDate: '2026-11-03', notifiedAt: '2026-11-02' }))))).toEqual(['UK_MAR_PDMR_DATES']);
  });

  it('derives the results deadline from the period type', () => {
    const final = ukPolicy.timing(context(ukPolicy, 'results', { periodType: 'final', periodEnd: '2026-06-30' }));
    expect(final.deadline?.at?.toISOString()).toBe('2026-10-30T23:59:00.000Z');
    expect(final.overdue).toBe(true);
    const interim = ukPolicy.timing(context(ukPolicy, 'results', { periodType: 'interim', periodEnd: '2026-06-30' }));
    expect(interim.deadline?.at?.toISOString()).toBe('2026-09-30T22:59:00.000Z'); // BST: 23:59 London is 22:59Z
  });

  it('sets approval requirements per category', () => {
    const req = (c: string, m: Record<string, unknown> = {}) => ukPolicy.approvalRequirement(context(ukPolicy, c, m));
    expect(req('inside_information', { informationBecameKnownAt: '2026-11-03T11:30:00Z', personResponsible: person })).toEqual({ min: 2, mustInclude: ['company_secretary'] });
    expect(req('pdmr_dealing', pdmr())).toEqual({ min: 1, mustInclude: ['company_secretary'] });
    expect(req('results', { periodType: 'final', periodEnd: '2026-06-30' })).toEqual({ min: 2, mustInclude: ['cfo'] });
    expect(req('general')).toEqual({ min: 1, mustInclude: [] });
  });

  it('adds the MAR statement, the responsible person and the LEI when rendering inside information', () => {
    const ctx = context(ukPolicy, 'inside_information', { informationBecameKnownAt: '2026-11-03T11:30:00Z', personResponsible: { name: 'Bob Chen', title: 'Company Secretary' } });
    const out = ukPolicy.render(ctx);
    expect(out.channel).toBe('rns');
    expect(out.content).toContain('contains inside information');
    expect(out.content).toContain('Bob Chen, Company Secretary');
    expect(out.content).toContain(`LEI: ${issuer.profiles.UK!.lei}`);
    expect(out.attributes).toMatchObject({ tidm: 'NWE', insideInformation: 'true' });
    const plain = ukPolicy.render(context(ukPolicy, 'general', {}));
    expect(plain.content).not.toContain('inside information');
  });

  it('reports the RNS window and its next opening', () => {
    const closed = ukPolicy.timing(context(ukPolicy, 'general', {}, new Date('2026-11-03T06:30:00Z')));
    expect(closed.window.open).toBe(false);
    expect(closed.window.nextOpenAt?.toISOString()).toBe('2026-11-03T07:00:00.000Z');
    expect(ukPolicy.timing(context(ukPolicy, 'general', {})).window.open).toBe(true);
  });
});

describe('US policy', () => {
  const signatory = { name: 'Carol Diaz', title: 'General Counsel' };
  const k8 = (over: Record<string, unknown> = {}) => ({ eventDate: '2026-11-02', items: ['8.01'], signatory, ...over });

  it('computes the 8-K due date as four business days with the 17:30 ET cut-off', () => {
    expect(usPolicy.timing(context(usPolicy, 'form_8k', k8())).deadline?.at?.toISOString()).toBe('2026-11-06T22:30:00.000Z');
    // Veterans Day (Wed 11 Nov) is a federal holiday: Fri 6 Nov + 4 business days is Fri 13 Nov.
    expect(usPolicy.timing(context(usPolicy, 'form_8k', k8({ eventDate: '2026-11-06' }))).deadline?.at?.toISOString()).toBe('2026-11-13T22:30:00.000Z');
  });

  it('tightens the deadline to the Reg FD prompt limit after an unintentional selective disclosure', () => {
    const midweek = k8({ eventDate: '2026-11-03', items: ['7.01'], regFd: { selectiveDisclosure: 'unintentional', learnedAt: '2026-11-03T21:00:00Z' } });
    const t = usPolicy.timing(context(usPolicy, 'form_8k', midweek));
    expect(t.deadline?.at?.toISOString()).toBe('2026-11-04T21:00:00.000Z'); // 24 hours later
    expect(t.deadline?.basis).toContain('Regulation FD');

    // Learned Friday 16:00 ET: later of 24h (Saturday) and next NYSE open (Monday 09:30 ET).
    const friday = k8({ eventDate: '2026-11-06', items: ['7.01'], regFd: { selectiveDisclosure: 'unintentional', learnedAt: '2026-11-06T21:00:00Z' } });
    expect(usPolicy.timing(context(usPolicy, 'form_8k', friday)).deadline?.at?.toISOString()).toBe('2026-11-09T14:30:00.000Z');
  });

  it('enforces item-specific requirements', () => {
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['2.02'] }))))).toEqual(['US_8K_2_02_EXHIBIT']);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['2.02'], exhibit99_1: true }))))).toEqual([]);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['7.01'] }))))).toEqual(['US_8K_7_01_REGFD']);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['7.01'], regFd: { selectiveDisclosure: 'unintentional' } }))))).toEqual(['US_REG_FD_LEARNED_AT']);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['5.02'] }))))).toEqual(['US_8K_5_02_DETAILS']);
    expect(errors(usPolicy.validate(input('form_8k', k8({ eventDate: '2026-11-04' }))))).toEqual(['US_8K_EVENT_IN_FUTURE']);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: [] }))))).toEqual(['SCHEMA_INVALID']);
  });

  it('warns about a late 8-K without blocking it', () => {
    const issues = usPolicy.validate(input('form_8k', k8({ eventDate: '2026-10-20' })));
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['DEADLINE_PASSED', 'warning']]);
  });

  it('asks legal and the CFO for earnings and legal alone for other items', () => {
    const req = (items: string[]) => usPolicy.approvalRequirement(context(usPolicy, 'form_8k', k8({ items })));
    expect(req(['2.02'])).toEqual({ min: 2, mustInclude: ['legal', 'cfo'] });
    expect(req(['8.01'])).toEqual({ min: 2, mustInclude: ['legal'] });
  });

  it('renders the 8-K with the furnished notice and Exhibit 99.1', () => {
    const out = usPolicy.render(context(usPolicy, 'form_8k', k8({ items: ['2.02'], exhibit99_1: true })));
    expect(out.channel).toBe('edgar');
    expect(out.content).toContain('Item 2.02. Results of Operations and Financial Condition');
    expect(out.content).toContain('shall not be deemed "filed"');
    expect(out.content).toContain('Item 9.01');
    expect(out.attachments).toEqual([{ type: 'EX-99.1', name: 'ex99-1.htm', content: BODY }]);
    expect(out.attributes).toMatchObject({ cik: '0001234567', formType: '8-K', items: ['2.02'] });
    expect(usPolicy.render(context(usPolicy, 'form_8k', k8())).attachments).toEqual([]);
  });

  it('closes EDGAR on weekends and opens it at 06:00 ET on the next business day', () => {
    const saturday = usPolicy.timing(context(usPolicy, 'form_8k', k8(), new Date('2026-11-07T15:00:00Z')));
    expect(saturday.window.open).toBe(false);
    expect(saturday.window.nextOpenAt?.toISOString()).toBe('2026-11-09T11:00:00.000Z');
  });
});
