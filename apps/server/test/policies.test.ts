import { describe, expect, it } from 'vitest';
import { ruleContext } from '../src/application/announcements.js';
import type { Announcement, Issuer, Revision } from '../src/domain/types.js';
import { dkPolicy } from '../src/jurisdictions/dk.js';
import { isValidCvr, makeLei } from '../src/jurisdictions/identifiers.js';
import { ukPolicy } from '../src/jurisdictions/uk.js';
import { usPolicy } from '../src/jurisdictions/us.js';

const NOW = new Date('2026-11-03T12:00:00Z'); // Tuesday, GMT / EST

const issuer: Issuer = {
  id: 'i',
  name: 'Northwind Energy plc',
  profiles: {
    UK: { tidm: 'NWE', lei: makeLei('5299000NORTHWINDEN') },
    US: { cik: '0001234567', ccc: 'nw3n3rgy', ticker: 'NWEY', filerStatus: 'domestic' },
    DK: { cvr: '12345674', lei: makeLei('5299000NORTHWINDDK'), ticker: 'NWE', market: 'main' },
  },
};

describe('sample content', () => {
  const policies = [ukPolicy, usPolicy, dkPolicy];

  it('is offered by the policy, and every sample parses against its own category schema', () => {
    for (const policy of policies) {
      for (const category of policy.describe(NOW).categories) {
        if (!category.example) continue;
        const parsed = policy.parseMetadata(category.key, category.example.metadata);
        expect(parsed.success, `${policy.code}.${category.key}`).toBe(true);
      }
    }
  });

  it('gives every jurisdiction at least one sample, with dates relative to the clock it was asked at', () => {
    for (const policy of policies) {
      expect(policy.describe(NOW).categories.some((c) => c.example)).toBe(true);
    }
    const holding = (now: Date) => dkPolicy.describe(now).categories.find((c) => c.key === 'major_shareholding')!.example!.metadata;
    expect(holding(NOW)).not.toEqual(holding(new Date(NOW.getTime() + 86_400_000)));
  });

  it('lets a channel name what it calls sending, so the UI keeps no per-channel table', () => {
    expect(usPolicy.describe().channel.sendNoun).toBe('filing');
    expect(ukPolicy.describe().channel.sendNoun).toBeUndefined();
  });
});

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

function context(policy: typeof ukPolicy, category: string, metadata: Record<string, unknown>, now = NOW, who: Issuer = issuer) {
  const a = { id: 'a1', jurisdiction: policy.code, category } as Announcement;
  const rev = { headline: 'Headline', body: BODY, metadata } as Revision;
  return ruleContext(policy, a, rev, who, now)!;
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

  it('clamps results deadlines to the last day of a shorter target month', () => {
    const final = ukPolicy.timing(context(ukPolicy, 'results', { periodType: 'final', periodEnd: '2026-10-31' }));
    expect(final.deadline?.at?.toISOString()).toBe('2027-02-28T23:59:00.000Z');

    const interim = ukPolicy.timing(context(ukPolicy, 'results', { periodType: 'interim', periodEnd: '2026-01-31' }));
    expect(interim.deadline?.at?.toISOString()).toBe('2026-04-30T22:59:00.000Z'); // BST: 23:59 London is 22:59Z

    const leapYear = ukPolicy.timing(context(ukPolicy, 'results', { periodType: 'final', periodEnd: '2023-10-31' }));
    expect(leapYear.deadline?.at?.toISOString()).toBe('2024-02-29T23:59:00.000Z');
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

  it("uses the next trading day's open for a Reg FD disclosure learned before today's open", () => {
    // Monday 08:00 ET: later of 24 hours (Tuesday 08:00) or the next day's NYSE open (Tuesday 09:30).
    const early = k8({ eventDate: '2026-11-02', items: ['7.01'], regFd: { selectiveDisclosure: 'unintentional', learnedAt: '2026-11-02T13:00:00Z' } });
    expect(usPolicy.timing(context(usPolicy, 'form_8k', early)).deadline?.at?.toISOString()).toBe('2026-11-03T14:30:00.000Z');
  });

  it('requires intentional selective disclosure to be public simultaneously', () => {
    const missingConfirmation = k8({ items: ['7.01'], regFd: { selectiveDisclosure: 'intentional' } });
    expect(errors(usPolicy.validate(input('form_8k', missingConfirmation)))).toEqual(['US_REG_FD_SIMULTANEOUS']);

    const confirmed = k8({ items: ['7.01'], regFd: { selectiveDisclosure: 'intentional', publicDisclosureSimultaneous: true } });
    expect(errors(usPolicy.validate(input('form_8k', confirmed)))).toEqual([]);
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

describe('Denmark policy (EU MAR, Nasdaq Copenhagen)', () => {
  const person = { name: 'Bob Chen', title: 'Company Secretary' };
  const dealing = (over: Record<string, unknown> = {}) => ({
    language: 'en',
    pdmrName: 'Dan Okafor',
    position: 'Chief Financial Officer',
    instrument: 'Ordinary shares',
    isin: 'DK0010244425',
    transactionType: 'acquisition',
    price: 100,
    currency: 'DKK',
    volume: 2000,
    transactionDate: '2026-11-03',
    venue: 'XCSE',
    notifiedAt: '2026-11-03',
    ...over,
  });

  it('checks a CVR number with the modulus 11 rule', () => {
    expect(isValidCvr('12345674')).toBe(true);
    expect(isValidCvr('12345675')).toBe(false);
    expect(isValidCvr('1234567')).toBe(false);
  });

  it('needs the language of the announcement, Danish or English, in every category', () => {
    const issues = dkPolicy.validate(input('general', {}));
    expect(issues.map((i) => [i.code, i.path])).toEqual([['SCHEMA_INVALID', 'metadata.language']]);
    expect(dkPolicy.validate(input('general', { language: 'da' }))).toEqual([]);
    expect(codes(dkPolicy.validate(input('general', { language: 'sv' })))).toEqual(['SCHEMA_INVALID']);
  });

  it('checks the issuer has a valid CVR number and LEI', () => {
    const badCvr: Issuer = { ...issuer, profiles: { DK: { cvr: '12345675', lei: makeLei('5299000NORTHWINDDK'), ticker: 'NWE', market: 'main' } } };
    expect(codes(dkPolicy.validate(input('general', { language: 'en' }, { issuer: badCvr })))).toContain('ISSUER_PROFILE_INCOMPLETE');
  });

  it('shares the MAR rules with the UK under its own codes', () => {
    const known = new Date(NOW.getTime() - 90 * 60_000).toISOString();
    const issues = dkPolicy.validate(input('inside_information', { language: 'en', informationBecameKnownAt: known, personResponsible: person }));
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['EU_MAR_ASAP', 'warning']]);
    const short = { language: 'en', informationBecameKnownAt: known, personResponsible: person, delayedDisclosure: { decidedAt: known, justification: 'too short' } };
    expect(errors(dkPolicy.validate(input('inside_information', short)))).toEqual(['EU_MAR_DELAY_JUSTIFICATION']);
  });

  it('counts the PDMR deadline in Danish business days: Ascension Day is not one', () => {
    const on = new Date('2026-05-13T12:00:00Z');
    const t = dkPolicy.timing(context(dkPolicy, 'pdmr_dealing', dealing({ transactionDate: '2026-05-13', notifiedAt: '2026-05-13' }), on));
    expect(t.deadline?.at?.toISOString()).toBe('2026-05-19T21:59:00.000Z'); // Thu 14 May is closed: due Tue 19 May, 23:59 in Copenhagen (CEST)
    const uk = ukPolicy.timing(context(ukPolicy, 'pdmr_dealing', { ...dealing(), isin: 'GB0007980591', currency: 'GBP', transactionDate: '2026-05-13', notifiedAt: '2026-05-13' }, on));
    expect(uk.deadline?.at?.toISOString()).toBe('2026-05-18T22:59:00.000Z'); // the same MAR rule, a different calendar: Mon 18 May
  });

  it('warns, without blocking, when a dealing is under the notification threshold', () => {
    const small = dkPolicy.validate(input('pdmr_dealing', dealing({ price: 10, volume: 100 })));
    expect(small.map((i) => [i.code, i.severity])).toEqual([['EU_MAR_PDMR_BELOW_THRESHOLD', 'warning']]);
    expect(dkPolicy.validate(input('pdmr_dealing', dealing()))).toEqual([]);
    expect(errors(dkPolicy.validate(input('pdmr_dealing', dealing({ isin: 'DK0010244420' }))))).toEqual(['INVALID_ISIN']);
  });

  it('renders the MAR statement in the language of the announcement and carries the CVR number', () => {
    const meta = { informationBecameKnownAt: '2026-11-03T11:30:00Z', personResponsible: person };
    const en = dkPolicy.render(context(dkPolicy, 'inside_information', { ...meta, language: 'en' }));
    expect(en.channel).toBe('cph');
    expect(en.content).toContain('contains inside information');
    expect(en.content).toContain('Bob Chen, Company Secretary');
    const da = dkPolicy.render(context(dkPolicy, 'inside_information', { ...meta, language: 'da' }));
    expect(da.content).toContain('insiderinformation');
    expect(da.attributes).toMatchObject({ cvr: '12345674', language: 'da', insideInformation: 'true' });
    expect(dkPolicy.render(context(dkPolicy, 'general', { language: 'da' })).content).not.toContain('insiderinformation');
  });

  it('asks for the Finanstilsynet notice only when disclosure was delayed', () => {
    const base = { language: 'en', informationBecameKnownAt: '2026-11-03T10:00:00Z', personResponsible: person };
    const plain = dkPolicy.postPublication(context(dkPolicy, 'inside_information', base));
    expect(plain.join(' ')).toContain('OAM');
    expect(plain.join(' ')).not.toContain('delay');
    const delayed = dkPolicy.postPublication(context(dkPolicy, 'inside_information', { ...base, delayedDisclosure: { decidedAt: '2026-11-03T10:00:00Z', justification: 'x'.repeat(40) } }));
    expect(delayed.join(' ')).toContain('delay');
  });

  it('reports the Copenhagen window and keeps inside information releasable outside it', () => {
    const closed = dkPolicy.timing(context(dkPolicy, 'general', { language: 'en' }, new Date('2026-11-03T04:30:00Z'))); // 05:30 Copenhagen
    expect(closed.window.open).toBe(false);
    expect(closed.window.nextOpenAt?.toISOString()).toBe('2026-11-03T06:00:00.000Z');
    const inside = dkPolicy.timing(context(dkPolicy, 'inside_information', { language: 'en', informationBecameKnownAt: '2026-11-03T03:00:00Z', personResponsible: person }, new Date('2026-11-03T04:30:00Z')));
    expect(inside.holdWhenClosed).toBe(false);
  });
});

describe('Denmark: market segment, major shareholders, buy-backs and general meetings', () => {
  const dk = (over: Record<string, string> = {}): Issuer => ({ ...issuer, profiles: { ...issuer.profiles, DK: { ...issuer.profiles.DK!, ...over } } });
  const firstNorth = dk({ market: 'first_north', certifiedAdviser: 'Carnegie A/S' });

  const holding = (over: Record<string, unknown> = {}) => ({
    language: 'en',
    holder: { name: 'Fjord Capital A/S', type: 'legal_entity' },
    threshold: '5%',
    direction: 'up',
    basis: 'voting_rights',
    holdingKind: 'shares',
    holdingPercent: 5.4,
    crossedOn: '2026-11-02',
    notifiedOn: '2026-11-03',
    ...over,
  });
  const buyback = (over: Record<string, unknown> = {}) => ({
    language: 'en',
    programme: 'Share buyback 2026',
    periodFrom: '2026-10-30',
    periodTo: '2026-11-02',
    sharesBought: 12000,
    averagePrice: 118.4,
    currency: 'DKK',
    cumulativeShares: 96000,
    authorisedMaximum: 500000,
    ...over,
  });
  const meeting = (over: Record<string, unknown> = {}) => ({ language: 'en', meetingType: 'annual', meetingDate: '2026-12-01', venue: 'Copenhagen', ...over });

  describe('market segment', () => {
    it('needs the issuer profile to say whether it is on the main market or First North', () => {
      const noMarket = dk();
      delete (noMarket.profiles.DK as Record<string, string>).market;
      const issues = dkPolicy.validate(input('general', { language: 'en' }, { issuer: noMarket }));
      expect(issues.map((i) => [i.code, i.path])).toEqual([['ISSUER_PROFILE_INCOMPLETE', 'issuer.market']]);
    });

    it('asks a First North issuer for its Certified Adviser', () => {
      const issues = dkPolicy.validate(input('general', { language: 'en' }, { issuer: dk({ market: 'first_north' }) }));
      expect(issues.map((i) => [i.code, i.path])).toEqual([['ISSUER_PROFILE_INCOMPLETE', 'issuer.certifiedAdviser']]);
      expect(dkPolicy.validate(input('general', { language: 'en' }, { issuer: firstNorth }))).toEqual([]);
    });

    it('keeps the MAR duties on First North but stops the regulated-market notifications', () => {
      const known = new Date(NOW.getTime() - 90 * 60_000).toISOString();
      const inside = { language: 'en', informationBecameKnownAt: known, personResponsible: { name: 'Bob Chen', title: 'Company Secretary' } };
      expect(dkPolicy.validate(input('inside_information', inside, { issuer: firstNorth })).map((i) => i.code)).toEqual(['EU_MAR_ASAP']);
      expect(errors(dkPolicy.validate(input('major_shareholding', holding(), { issuer: firstNorth })))).toEqual(['DK_REGULATED_MARKET_ONLY']);
    });

    it('adds the Certified Adviser to the post-publication duties on First North only', () => {
      const note = (who: Issuer) => dkPolicy.postPublication(context(dkPolicy, 'general', { language: 'en' }, NOW, who)).join(' ');
      expect(note(firstNorth)).toContain('Certified Adviser');
      expect(note(issuer)).not.toContain('Certified Adviser');
    });
  });

  describe('major shareholder announcement (Transparency Directive Art. 9)', () => {
    it('accepts a consistent crossing and dates', () => {
      expect(dkPolicy.validate(input('major_shareholding', holding()))).toEqual([]);
    });

    it('rejects a holding that contradicts the threshold and direction', () => {
      expect(errors(dkPolicy.validate(input('major_shareholding', holding({ holdingPercent: 4.6 }))))).toEqual(['DK_TD_HOLDING_VS_THRESHOLD']);
      expect(errors(dkPolicy.validate(input('major_shareholding', holding({ direction: 'down', holdingPercent: 5.2 }))))).toEqual(['DK_TD_HOLDING_VS_THRESHOLD']);
      expect(dkPolicy.validate(input('major_shareholding', holding({ direction: 'down', holdingPercent: 4.8 })))).toEqual([]);
    });

    it('rejects dates in the future or in the wrong order', () => {
      expect(errors(dkPolicy.validate(input('major_shareholding', holding({ crossedOn: '2026-11-04', notifiedOn: '2026-11-04' }))))).toEqual(['DK_TD_DATE_IN_FUTURE', 'DK_TD_DATE_IN_FUTURE']);
      expect(errors(dkPolicy.validate(input('major_shareholding', holding({ crossedOn: '2026-11-03', notifiedOn: '2026-11-02' }))))).toEqual(['DK_TD_DATES']);
    });

    it('warns when the shareholder told the issuer after four trading days', () => {
      const late = dkPolicy.validate(input('major_shareholding', holding({ crossedOn: '2026-10-26', notifiedOn: '2026-11-03' })));
      expect(late.map((i) => [i.code, i.severity])).toEqual([['DK_TD_LATE_HOLDER_NOTIFICATION', 'warning']]);
      expect(dkPolicy.validate(input('major_shareholding', holding({ crossedOn: '2026-10-30', notifiedOn: '2026-11-03' })))).toEqual([]);
    });

    it('gives the issuer three trading days from the notification', () => {
      const t = dkPolicy.timing(context(dkPolicy, 'major_shareholding', holding({ crossedOn: '2026-10-30', notifiedOn: '2026-11-02' })));
      expect(t.deadline?.at?.toISOString()).toBe('2026-11-05T22:59:00.000Z'); // Thu 5 Nov, 23:59 in Copenhagen
      expect(t.deadline?.basis).toContain('Art. 12(6)');
    });

    it('renders the crossing in Danish or English and asks for the filing with Finanstilsynet', () => {
      const da = dkPolicy.render(context(dkPolicy, 'major_shareholding', holding({ language: 'da' })));
      expect(da.content).toContain('Større aktionærmeddelelse');
      expect(da.content).toContain('overskredet grænsen på 5 % af stemmerettighederne');
      expect(da.attributes).toMatchObject({ category: 'major_shareholding', market: 'main', insideInformation: 'false' });
      const en = dkPolicy.render(context(dkPolicy, 'major_shareholding', holding()));
      expect(en.content).toContain('Crossed above the 5% threshold of voting rights');
      expect(dkPolicy.postPublication(context(dkPolicy, 'major_shareholding', holding())).join(' ')).toContain('Art. 12(6)');
    });

    it('asks for the company secretary alone', () => {
      expect(dkPolicy.approvalRequirement(context(dkPolicy, 'major_shareholding', holding()))).toEqual({ min: 1, mustInclude: ['company_secretary'] });
    });
  });

  describe('share buyback report (EU MAR Art. 5)', () => {
    it('accepts a coherent report', () => {
      expect(dkPolicy.validate(input('share_buyback', buyback()))).toEqual([]);
    });

    it('rejects a total below the period, a total above the authorisation and an impossible period', () => {
      expect(errors(dkPolicy.validate(input('share_buyback', buyback({ cumulativeShares: 5000 }))))).toEqual(['DK_BUYBACK_CUMULATIVE']);
      expect(errors(dkPolicy.validate(input('share_buyback', buyback({ cumulativeShares: 600000 }))))).toEqual(['DK_BUYBACK_ABOVE_AUTHORISATION']);
      expect(errors(dkPolicy.validate(input('share_buyback', buyback({ periodFrom: '2026-11-02', periodTo: '2026-10-30' }))))).toEqual(['DK_BUYBACK_PERIOD']);
      expect(errors(dkPolicy.validate(input('share_buyback', buyback({ periodTo: '2026-11-09' }))))).toEqual(['DK_BUYBACK_PERIOD']);
    });

    it('counts seven market sessions from the first transaction in the report, so a longer period is due sooner', () => {
      const long = dkPolicy.timing(context(dkPolicy, 'share_buyback', buyback()));
      expect(long.deadline?.at?.toISOString()).toBe('2026-11-10T22:59:00.000Z'); // Fri 30 Oct + 7 sessions = Tue 10 Nov
      const week = dkPolicy.timing(context(dkPolicy, 'share_buyback', buyback({ periodFrom: '2026-11-02' })));
      expect(week.deadline?.at?.toISOString()).toBe('2026-11-11T22:59:00.000Z');
    });

    it('skips Danish closing days when it counts the sessions', () => {
      const t = dkPolicy.timing(context(dkPolicy, 'share_buyback', buyback({ periodFrom: '2026-05-11', periodTo: '2026-05-12' }), new Date('2026-05-13T10:00:00Z')));
      expect(t.deadline?.at?.toISOString()).toBe('2026-05-21T21:59:00.000Z'); // 12, 13, 15 (14 May is closed), 18, 19, 20, 21
    });

    it('renders the figures in the language of the announcement and asks for the transaction report', () => {
      const da = dkPolicy.render(context(dkPolicy, 'share_buyback', buyback({ language: 'da' })));
      expect(da.content).toContain('Aktietilbagekøbsprogram: Share buyback 2026');
      expect(da.content).toContain('I alt under programmet: 96000 af højst 500000 aktier');
      expect(dkPolicy.postPublication(context(dkPolicy, 'share_buyback', buyback())).join(' ')).toContain('Art. 5(3)');
      expect(dkPolicy.approvalRequirement(context(dkPolicy, 'share_buyback', buyback()))).toEqual({ min: 1, mustInclude: ['cfo'] });
    });
  });

  describe('notice of general meeting (Companies Act)', () => {
    it('accepts a notice 21 days to 5 weeks ahead', () => {
      expect(dkPolicy.validate(input('general_meeting', meeting({ meetingDate: '2026-11-24' })))).toEqual([]);
      expect(dkPolicy.validate(input('general_meeting', meeting({ meetingDate: '2026-12-08' })))).toEqual([]);
    });

    it('blocks a notice that is too short for the type of meeting', () => {
      expect(errors(dkPolicy.validate(input('general_meeting', meeting({ meetingDate: '2026-11-23' }))))).toEqual(['DK_MEETING_NOTICE_TOO_SHORT']);
      expect(dkPolicy.validate(input('general_meeting', meeting({ meetingType: 'extraordinary', meetingDate: '2026-11-17' })))).toEqual([]);
      expect(errors(dkPolicy.validate(input('general_meeting', meeting({ meetingType: 'extraordinary', meetingDate: '2026-11-16' }))))).toEqual(['DK_MEETING_NOTICE_TOO_SHORT']);
    });

    it('warns, without blocking, when the notice is sent more than five weeks ahead, and rejects a past meeting', () => {
      const early = dkPolicy.validate(input('general_meeting', meeting({ meetingDate: '2026-12-15' })));
      expect(early.map((i) => [i.code, i.severity])).toEqual([['DK_MEETING_NOTICE_TOO_EARLY', 'warning']]);
      expect(early[0]!.message).toContain('2026-11-10');
      expect(errors(dkPolicy.validate(input('general_meeting', meeting({ meetingDate: '2026-11-03' }))))).toEqual(['DK_MEETING_IN_PAST']);
    });

    it('works backwards from the meeting: the deadline is the last day the notice can go out', () => {
      const annual = dkPolicy.timing(context(dkPolicy, 'general_meeting', meeting({ meetingDate: '2026-12-15' })));
      expect(annual.deadline?.at?.toISOString()).toBe('2026-11-24T22:59:00.000Z');
      const extra = dkPolicy.timing(context(dkPolicy, 'general_meeting', meeting({ meetingType: 'extraordinary', meetingDate: '2026-12-15' })));
      expect(extra.deadline?.at?.toISOString()).toBe('2026-12-01T22:59:00.000Z');
    });

    it('renders the notice and needs two approvers including the company secretary', () => {
      const da = dkPolicy.render(context(dkPolicy, 'general_meeting', meeting({ language: 'da' })));
      expect(da.content).toContain('Indkaldelse til ordinær generalforsamling');
      expect(da.content).toContain('Sted: Copenhagen');
      expect(dkPolicy.approvalRequirement(context(dkPolicy, 'general_meeting', meeting()))).toEqual({ min: 2, mustInclude: ['company_secretary'] });
    });
  });
});
