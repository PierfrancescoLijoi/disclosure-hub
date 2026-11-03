import { z } from 'zod';
import { addBusinessDays, civilOf, nextBusinessDay, zonedToUtc } from '../domain/calendar.js';
import { definePolicy, type Deadline, type Rule } from '../domain/policy.js';
import type { Issue } from '../domain/types.js';
import { NYSE_HOLIDAYS, US_FEDERAL_HOLIDAYS } from './calendars.js';
import { isValidCcc, isValidCik } from './identifiers.js';

/**
 * US model: Form 8-K (4 business days after the event) and Regulation FD (prompt public
 * disclosure after an unintentional selective disclosure), filed through EDGAR.
 * Simplified for the exercise; hours and cut-offs are assumptions, not legal advice.
 */

const TZ = 'America/New_York';
const EDGAR_CUTOFF = '17:30';
const REG_FD_PROMPT_HOURS = 24;
const ITEMS = ['1.01', '2.02', '5.02', '7.01', '8.01'] as const;
const ITEM_TITLES: Record<(typeof ITEMS)[number], string> = {
  '1.01': 'Entry into a Material Definitive Agreement',
  '2.02': 'Results of Operations and Financial Condition',
  '5.02': 'Departure/Election of Directors or Certain Officers; Compensatory Arrangements',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
};
const FURNISHED = new Set(['2.02', '7.01']);

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
    })
    .optional()
    .meta({ title: 'Regulation FD (Item 7.01)' }),
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

const error = (code: string, message: string, path?: string): Issue => ({ code, severity: 'error', message, path });

const rules8k: Rule<Meta8k>[] = [
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
    meta.items.includes('5.02') && !meta.officerChange
      ? [error('US_8K_5_02_DETAILS', 'Item 5.02 requires the officer or director change details', 'metadata.officerChange')]
      : [],
];

/** Earliest of the 8-K due date and, when it applies, the Reg FD "prompt" limit. */
function deadline8k({ meta }: { meta: Meta8k }): Deadline {
  const due: Deadline = {
    at: zonedToUtc(addBusinessDays(meta.eventDate, 4, US_FEDERAL_HOLIDAYS), EDGAR_CUTOFF, TZ),
    basis: `Form 8-K: 4 business days after the event (${EDGAR_CUTOFF} ET filing cut-off)`,
  };
  const learnedAt = meta.regFd?.selectiveDisclosure === 'unintentional' ? meta.regFd.learnedAt : undefined;
  if (!learnedAt) return due;
  const learned = new Date(learnedAt);
  const nextOpen = zonedToUtc(nextBusinessDay(civilOf(learned, TZ), NYSE_HOLIDAYS), '09:30', TZ);
  const prompt = new Date(Math.max(learned.getTime() + REG_FD_PROMPT_HOURS * 3_600_000, nextOpen.getTime()));
  return prompt < due.at! ? { at: prompt, basis: 'Regulation FD prompt disclosure: later of 24 hours or next NYSE open (Rule 101(d))' } : due;
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
  },

  render({ issuer, headline, body, meta }) {
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

  postPublication({ meta }) {
    return [
      'Link the EDGAR filing from the investor relations site',
      ...(meta.items.includes('2.02') ? ['Hold the earnings call only after the 8-K is public (Regulation FD)'] : []),
    ];
  },
});
