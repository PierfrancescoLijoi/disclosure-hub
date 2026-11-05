import { z } from 'zod';
import { addBusinessDays, civilOf, nextBusinessDay, zonedToUtc, type CivilDate } from '../domain/calendar.js';
import { definePolicy, type Deadline, type Rule, type RuleContext } from '../domain/policy.js';
import type { Issue } from '../domain/types.js';
import { NYSE_HOLIDAYS, US_FEDERAL_HOLIDAYS } from './calendars.js';
import { isValidCcc, isValidCik } from './identifiers.js';

/**
 * US model: Form 8-K for domestic filers (4 business days; Item 1.05 counts from the
 * materiality determination; Items 7.01 and 8.01 are voluntary and carry no deadline), Form 6-K
 * for foreign private issuers, and Regulation FD (simultaneous public disclosure when intentional,
 * prompt public disclosure when unintentional), all filed through EDGAR. Simplified for the exercise; hours and cut-offs
 * are assumptions, not legal advice.
 */

const TZ = 'America/New_York';
const EDGAR_CUTOFF = '17:30';
const FILING_DAYS = 4;
const REG_FD_PROMPT_HOURS = 24;
const ITEMS = ['1.01', '1.05', '2.02', '5.02', '5.07', '7.01', '8.01'] as const;
const ITEM_TITLES: Record<(typeof ITEMS)[number], string> = {
  '1.01': 'Entry into a Material Definitive Agreement',
  '1.05': 'Material Cybersecurity Incidents',
  '2.02': 'Results of Operations and Financial Condition',
  '5.02': 'Departure/Election of Directors or Certain Officers; Compensatory Arrangements',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
};
const FURNISHED = new Set(['2.02', '7.01']);
/** Items a company may file voluntarily: no Form 8-K deadline attaches to them. */
const VOLUNTARY = new Set(['7.01', '8.01']);

const text = (title: string) => z.string().trim().min(1).meta({ title });

const form8k = z.object({
  eventDate: z.iso.date().meta({ title: 'Date of earliest event reported' }),
  items: z.array(z.enum(ITEMS)).min(1).meta({ title: '8-K items' }),
  exhibit99_1: z.boolean().optional().meta({ title: 'Attach announcement text as Exhibit 99.1' }),
  signatory: z.object({ name: text('Name'), title: text('Title') }).meta({ title: 'Signatory' }),
  regFd: z
    .object({
      selectiveDisclosure: z.enum(['none', 'intentional', 'unintentional']).meta({ title: 'Selective disclosure' }),
      learnedAt: z.iso.datetime({ offset: true }).optional().meta({ title: 'Senior official learned of it at' }),
      publicDisclosureSimultaneous: z.boolean().optional().meta({ title: 'Public disclosure is simultaneous' }),
    })
    .optional()
    .meta({ title: 'Regulation FD (Item 7.01)' }),
  cyber: z
    .object({ materialityDeterminedAt: z.iso.datetime({ offset: true }).meta({ title: 'Incident determined to be material at' }) })
    .optional()
    .meta({ title: 'Cybersecurity incident (Item 1.05)' }),
  officerChange: z
    .object({
      person: text('Person'),
      position: text('Position'),
      nature: z.enum(['appointment', 'departure', 'compensation']).meta({ title: 'Nature' }),
    })
    .optional()
    .meta({ title: 'Officer or director change (Item 5.02)' }),
});
type Meta8k = z.infer<typeof form8k>;

const form6k = z.object({
  reportDate: z.iso.date().meta({ title: 'Report date' }),
  basis: z.enum(['home_country_law', 'exchange_rule', 'security_holders']).meta({ title: 'Why it is furnished' }),
  exhibit99_1: z.boolean().optional().meta({ title: 'Attach announcement text as Exhibit 99.1' }),
  signatory: z.object({ name: text('Name'), title: text('Title') }).meta({ title: 'Signatory' }),
});
type Meta6k = z.infer<typeof form6k>;

const error = (code: string, message: string, path?: string): Issue => ({ code, severity: 'error', message, path });

/** A missing status is reported once, by the issuer profile check, so only a wrong one is flagged here. */
const filerRule =
  (required: 'domestic' | 'foreign_private', form: string, other: string) =>
  ({ issuer }: RuleContext): Issue[] => {
    const status = issuer.profiles.US?.filerStatus;
    if (!status || status === required) return [];
    const who = status === 'domestic' ? 'a domestic filer' : 'a foreign private issuer';
    return [error('US_FILER_STATUS', `${issuer.name} is ${who}: it files Form ${other}, not Form ${form}`, 'issuer')];
  };

const rules8k: Rule<Meta8k>[] = [
  filerRule('domestic', '8-K', '6-K'),
  ({ meta, now }) => (meta.eventDate > civilOf(now, TZ) ? [error('US_8K_EVENT_IN_FUTURE', 'Event date is in the future', 'metadata.eventDate')] : []),
  ({ meta }) =>
    meta.items.includes('2.02') && !meta.exhibit99_1
      ? [error('US_8K_2_02_EXHIBIT', 'Item 2.02 requires the earnings release as Exhibit 99.1', 'metadata.exhibit99_1')]
      : [],
  ({ meta }) =>
    meta.items.includes('7.01') && !meta.regFd
      ? [error('US_8K_7_01_REGFD', 'Item 7.01 requires the Regulation FD details', 'metadata.regFd')]
      : [],
  ({ meta }) =>
    meta.regFd?.selectiveDisclosure === 'unintentional' && !meta.regFd.learnedAt
      ? [error('US_REG_FD_LEARNED_AT', 'Unintentional selective disclosure needs the time a senior official learned of it', 'metadata.regFd.learnedAt')]
      : [],
  ({ meta }) =>
    meta.regFd?.selectiveDisclosure === 'intentional' && meta.regFd.publicDisclosureSimultaneous !== true
      ? [error('US_REG_FD_SIMULTANEOUS', 'An intentional selective disclosure requires simultaneous public disclosure', 'metadata.regFd.publicDisclosureSimultaneous')]
      : [],
  ({ meta }) =>
    meta.items.includes('1.05') && !meta.cyber
      ? [error('US_8K_1_05_DETAILS', 'Item 1.05 requires the time the incident was determined to be material', 'metadata.cyber')]
      : [],
  ({ meta, now }) =>
    meta.cyber && new Date(meta.cyber.materialityDeterminedAt) > now
      ? [error('FUTURE_TIMESTAMP', 'The materiality determination cannot be in the future', 'metadata.cyber.materialityDeterminedAt')]
      : [],
  ({ meta }) =>
    meta.items.includes('5.02') && !meta.officerChange
      ? [error('US_8K_5_02_DETAILS', 'Item 5.02 requires the officer or director change details', 'metadata.officerChange')]
      : [],
];

const rules6k: Rule<Meta6k>[] = [filerRule('foreign_private', '6-K', '8-K')];

const filingDue = (civil: CivilDate, basis: string): Deadline => ({
  at: zonedToUtc(addBusinessDays(civil, FILING_DAYS, US_FEDERAL_HOLIDAYS), EDGAR_CUTOFF, TZ),
  basis: `${basis} (${EDGAR_CUTOFF} ET filing cut-off)`,
});

/** Earliest applicable limit: the 8-K clock of each mandatory item and, when it applies, the Reg FD "prompt" limit. */
function deadline8k({ meta }: { meta: Meta8k }): Deadline {
  const mandatory = meta.items.filter((i) => !VOLUNTARY.has(i));
  const limits: Deadline[] = [];
  if (mandatory.some((i) => i !== '1.05') || (mandatory.includes('1.05') && !meta.cyber)) {
    limits.push(filingDue(meta.eventDate, `Form 8-K: ${FILING_DAYS} business days after the event`));
  }
  if (meta.cyber && mandatory.includes('1.05')) {
    const determined = civilOf(new Date(meta.cyber.materialityDeterminedAt), TZ);
    limits.push(filingDue(determined, `Form 8-K Item 1.05: ${FILING_DAYS} business days after the materiality determination, not the incident`));
  }
  const learnedAt = meta.regFd?.selectiveDisclosure === 'unintentional' ? meta.regFd.learnedAt : undefined;
  if (learnedAt) {
    const learned = new Date(learnedAt);
    const nextOpen = zonedToUtc(nextBusinessDay(civilOf(learned, TZ), NYSE_HOLIDAYS), '09:30', TZ);
    limits.push({
      at: new Date(Math.max(learned.getTime() + REG_FD_PROMPT_HOURS * 3_600_000, nextOpen.getTime())),
      basis: "Regulation FD prompt disclosure: later of 24 hours or the next day's NYSE open (Rule 101(d))",
    });
  }
  if (limits.length === 0) {
    return { at: null, basis: 'Items 7.01 and 8.01 are voluntary: no Form 8-K deadline (Regulation FD timing still applies after an unintentional disclosure)' };
  }
  return limits.reduce((first, d) => (d.at! < first.at! ? d : first));
}

function render6k(issuerName: string, profile: Record<string, string>, headline: string, body: string, meta: Meta6k) {
  const exhibit = meta.exhibit99_1 === true;
  const content = [
    'UNITED STATES SECURITIES AND EXCHANGE COMMISSION',
    'FORM 6-K - REPORT OF FOREIGN PRIVATE ISSUER PURSUANT TO RULE 13a-16 OR 15d-16',
    `For the month of ${meta.reportDate.slice(0, 7)}`,
    `${issuerName} (CIK ${profile.cik}, ${profile.ticker})`,
    '',
    exhibit ? 'See Exhibit 99.1 attached hereto.' : body.trim(),
    ...(exhibit ? ['', 'Exhibit 99.1 Press release'] : []),
    '',
    `SIGNATURE: ${meta.signatory.name}, ${meta.signatory.title}`,
  ].join('\n');
  return {
    channel: 'edgar',
    headline,
    content,
    attributes: { issuerName, cik: profile.cik ?? '', ccc: profile.ccc ?? '', formType: '6-K', items: [], periodOfReport: meta.reportDate },
    attachments: exhibit ? [{ type: 'EX-99.1', name: 'ex99-1.htm', content: body.trim() }] : [],
  };
}

export const usPolicy = definePolicy({
  code: 'US',
  name: 'United States',
  timezone: TZ,
  channel: { id: 'edgar', name: 'SEC EDGAR' },
  issuerProfile: z
    .object({
      cik: z.string().refine(isValidCik, 'CIK must be 10 digits'),
      ccc: z.string().refine(isValidCcc, 'CCC must be 8 characters'),
      ticker: z.string().min(1, 'Ticker is required'),
      filerStatus: z.enum(['domestic', 'foreign_private'], { error: 'Filer status must be domestic or foreign_private' }),
    })
    .catchall(z.string()),
  headlineMax: 200,
  calendar: US_FEDERAL_HOLIDAYS,
  window: { open: '06:00', close: '22:00' },
  categories: {
    form_8k: {
      label: 'Form 8-K current report',
      schema: form8k,
      rules: rules8k,
      approval: ({ meta }) => ({ min: 2, mustInclude: meta.items.includes('2.02') ? ['legal', 'cfo'] : ['legal'] }),
      deadline: deadline8k,
    },
    form_6k: {
      label: 'Form 6-K report (foreign private issuers)',
      schema: form6k,
      rules: rules6k,
      approval: { min: 2, mustInclude: ['legal'] },
      deadline: () => ({ at: null, basis: 'Promptly after the information is made public at home (Form 6-K General Instruction B)' }),
    },
  },

  render({ issuer, headline, body, category, meta }) {
    if (category === 'form_6k') return render6k(issuer.name, issuer.profiles.US ?? {}, headline, body, meta as Meta6k);
    const profile = issuer.profiles.US ?? {};
    const items = [...(meta.items as (typeof ITEMS)[number][])].sort();
    const exhibit = meta.exhibit99_1 === true;
    const itemBlocks = items.map((code) =>
      [
        `Item ${code}. ${ITEM_TITLES[code]}`,
        exhibit ? 'See Exhibit 99.1 attached hereto.' : body.trim(),
        ...(FURNISHED.has(code)
          ? [`The information in this Item ${code} is being furnished and shall not be deemed "filed" for purposes of Section 18 of the Securities Exchange Act of 1934.`]
          : []),
      ].join('\n'),
    );
    const content = [
      'UNITED STATES SECURITIES AND EXCHANGE COMMISSION',
      'FORM 8-K - CURRENT REPORT',
      `Date of Report (Date of earliest event reported): ${meta.eventDate}`,
      `${issuer.name} (CIK ${profile.cik}, ${profile.ticker})`,
      '',
      ...itemBlocks,
      ...(exhibit ? ['', 'Item 9.01 Financial Statements and Exhibits', '(d) Exhibits: 99.1 Press release'] : []),
      '',
      `SIGNATURE: ${meta.signatory.name}, ${meta.signatory.title}`,
    ].join('\n');
    return {
      channel: 'edgar',
      headline,
      content,
      attributes: {
        issuerName: issuer.name,
        cik: profile.cik ?? '',
        ccc: profile.ccc ?? '',
        formType: '8-K',
        items,
        periodOfReport: meta.eventDate,
      },
      attachments: exhibit ? [{ type: 'EX-99.1', name: 'ex99-1.htm', content: body.trim() }] : [],
    };
  },

  postPublication({ category, meta }) {
    if (category === 'form_6k') return ['Link the EDGAR filing from the investor relations site'];
    return [
      'Link the EDGAR filing from the investor relations site',
      ...(meta.items.includes('2.02') ? ['Hold the earnings call only after the 8-K is public (Regulation FD)'] : []),
    ];
  },
});
