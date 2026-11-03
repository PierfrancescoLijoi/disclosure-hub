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
    US: { cik: '0001234567', ccc: 'nw3n3rgy', ticker: 'NWEY', filerStatus: 'domestic' },
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

  it('counts the PDMR deadline from the transaction, not from when the issuer was told', () => {
    const slow = pdmr({ transactionDate: '2026-11-02', notifiedAt: '2026-11-05' }); // Mon transaction: due Thu 5 Nov
    const t = ukPolicy.timing(context(ukPolicy, 'pdmr_dealing', slow));
    expect(t.deadline?.at?.toISOString()).toBe('2026-11-05T23:59:00.000Z');
    expect(t.deadline?.basis).toContain('transaction');
    expect(ukPolicy.validate(input('pdmr_dealing', slow))).toEqual([]);
  });

  it('warns when the PDMR told the issuer later than three business days after the transaction', () => {
    const issues = ukPolicy.validate(input('pdmr_dealing', pdmr({ transactionDate: '2026-10-26', notifiedAt: '2026-10-30' })));
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['UK_MAR_PDMR_LATE_NOTIFICATION', 'warning'], ['DEADLINE_PASSED', 'warning']]);
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
  const due = (over: Record<string, unknown>) => k8({ items: ['1.01'], ...over });

  it('computes the 8-K due date as four business days with the 17:30 ET cut-off', () => {
    expect(usPolicy.timing(context(usPolicy, 'form_8k', due({}))).deadline?.at?.toISOString()).toBe('2026-11-06T22:30:00.000Z');
    // Veterans Day (Wed 11 Nov) is a federal holiday: Fri 6 Nov + 4 business days is Fri 13 Nov.
    expect(usPolicy.timing(context(usPolicy, 'form_8k', due({ eventDate: '2026-11-06' }))).deadline?.at?.toISOString()).toBe('2026-11-13T22:30:00.000Z');
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

  it('treats a Reg FD disclosure learned before the open as due 24 hours later, not at the next day open', () => {
    // Monday 08:00 ET: today's 09:30 open is the next commencement of trading, so the 24 hours (Tuesday 08:00 ET) are the later limit.
    const early = k8({ eventDate: '2026-11-02', items: ['7.01'], regFd: { selectiveDisclosure: 'unintentional', learnedAt: '2026-11-02T13:00:00Z' } });
    expect(usPolicy.timing(context(usPolicy, 'form_8k', early)).deadline?.at?.toISOString()).toBe('2026-11-03T13:00:00.000Z');
  });

  it('sets no Form 8-K deadline when only voluntary Items 7.01 and 8.01 are reported', () => {
    for (const items of [['8.01'], ['7.01'], ['7.01', '8.01']]) {
      const t = usPolicy.timing(context(usPolicy, 'form_8k', k8({ items, regFd: { selectiveDisclosure: 'none' } })));
      expect(t.deadline).toMatchObject({ at: null });
      expect(t.deadline?.basis).toContain('voluntary');
    }
    // Any mandatory item restores the four-business-day clock.
    expect(usPolicy.timing(context(usPolicy, 'form_8k', k8({ items: ['8.01', '1.01'] }))).deadline?.at?.toISOString()).toBe('2026-11-06T22:30:00.000Z');
  });

  it('starts the Item 1.05 clock at the materiality determination, not at the incident', () => {
    const cyber = k8({ eventDate: '2026-10-26', items: ['1.05'], cyber: { materialityDeterminedAt: '2026-11-02T15:00:00Z' } });
    const t = usPolicy.timing(context(usPolicy, 'form_8k', cyber));
    expect(t.deadline?.at?.toISOString()).toBe('2026-11-06T22:30:00.000Z'); // 4 business days after Mon 2 Nov, not after 26 Oct
    expect(t.deadline?.basis).toContain('materiality');
    expect(errors(usPolicy.validate(input('form_8k', cyber)))).toEqual([]);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['1.05'] }))))).toEqual(['US_8K_1_05_DETAILS']);
    expect(errors(usPolicy.validate(input('form_8k', k8({ items: ['1.05'], cyber: { materialityDeterminedAt: '2026-11-04T09:00:00Z' } }))))).toEqual(['FUTURE_TIMESTAMP']);
  });

  it('accepts Item 5.07 votes and keeps the standard clock', () => {
    const vote = k8({ items: ['5.07'] });
    expect(errors(usPolicy.validate(input('form_8k', vote)))).toEqual([]);
    expect(usPolicy.timing(context(usPolicy, 'form_8k', vote)).deadline?.at?.toISOString()).toBe('2026-11-06T22:30:00.000Z');
  });

  describe('filer status', () => {
    const withStatus = (filerStatus?: string): Issuer => ({
      ...issuer,
      profiles: { ...issuer.profiles, US: { cik: '0001234567', ccc: 'nw3n3rgy', ticker: 'NWEY', ...(filerStatus ? { filerStatus } : {}) } },
    });
    const k6 = { reportDate: '2026-11-02', basis: 'home_country_law', signatory };

    it('requires the issuer profile to say whether the issuer is a domestic or foreign private issuer', () => {
      expect(codes(usPolicy.validate(input('form_8k', k8(), { issuer: withStatus() })))).toContain('ISSUER_PROFILE_INCOMPLETE');
    });

    it('stops a foreign private issuer from filing a Form 8-K and a domestic filer from filing a Form 6-K', () => {
      expect(errors(usPolicy.validate(input('form_8k', k8(), { issuer: withStatus('foreign_private') })))).toEqual(['US_FILER_STATUS']);
      expect(errors(usPolicy.validate(input('form_6k', k6, { issuer: withStatus('domestic') })))).toEqual(['US_FILER_STATUS']);
    });

    it('lets a foreign private issuer furnish a Form 6-K with no fixed deadline', () => {
      const fpi = withStatus('foreign_private');
      expect(errors(usPolicy.validate(input('form_6k', k6, { issuer: fpi })))).toEqual([]);
      const t = usPolicy.timing(context(usPolicy, 'form_6k', k6));
      expect(t.deadline).toMatchObject({ at: null });
      const out = usPolicy.render({ ...context(usPolicy, 'form_6k', k6), issuer: fpi });
      expect(out.attributes).toMatchObject({ formType: '6-K', items: [] });
      expect(out.content).toContain('FORM 6-K');
      expect(usPolicy.approvalRequirement(context(usPolicy, 'form_6k', k6))).toEqual({ min: 2, mustInclude: ['legal'] });
    });
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
    const issues = usPolicy.validate(input('form_8k', due({ eventDate: '2026-10-20' })));
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
