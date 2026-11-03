import { z } from 'zod';
import { addBusinessDays, civilOf, zonedToUtc, type CivilDate } from '../domain/calendar.js';
import { definePolicy, type Rule } from '../domain/policy.js';
import type { Issue } from '../domain/types.js';
import { UK_BANK_HOLIDAYS } from './calendars.js';
import { isValidIsin, isValidLei, isValidTidm } from './identifiers.js';

/**
 * UK main-market model: UK MAR Art. 17 (inside information), Art. 19 (PDMR dealings),
 * DTR 4 (results), released through a Regulatory Information Service (RNS).
 * Simplified for the exercise; thresholds and hours are assumptions, not legal advice.
 */

const TZ = 'Europe/London';
const ASAP_WARN_MINUTES = 60;
const MIN_DELAY_JUSTIFICATION = 30;
const PDMR_BUSINESS_DAYS = 3;

const text = (title: string) => z.string().trim().min(1).meta({ title });
const date = (title: string) => z.iso.date().meta({ title });
const datetime = (title: string) => z.iso.datetime({ offset: true }).meta({ title });
const person = z.object({ name: text('Name'), title: text('Position') });

const error = (code: string, message: string, path?: string): Issue => ({ code, severity: 'error', message, path });
const warning = (code: string, message: string, path?: string): Issue => ({ code, severity: 'warning', message, path });

const insideInfo = z.object({
  informationBecameKnownAt: datetime('Inside information became known at'),
  personResponsible: person.meta({ title: 'Person responsible for release' }),
  delayedDisclosure: z
    .object({ decidedAt: datetime('Delay decided at'), justification: text('Justification for delay') })
    .optional()
    .meta({ title: 'Delayed disclosure (Art. 17(4))' }),
});

const pdmr = z.object({
  pdmrName: text('PDMR name'),
  position: text('Position'),
  closelyAssociated: z.boolean().optional().meta({ title: 'Closely associated person' }),
  instrument: text('Instrument description'),
  isin: text('ISIN'),
  transactionType: z.enum(['acquisition', 'disposal', 'other']).meta({ title: 'Transaction type' }),
  price: z.number().positive().meta({ title: 'Price' }),
  currency: z.string().length(3).meta({ title: 'Currency (ISO 4217)' }),
  volume: z.number().int().positive().meta({ title: 'Volume' }),
  transactionDate: date('Transaction date'),
  venue: text('Trading venue'),
  notifiedAt: date('Date issuer was notified'),
});

const results = z.object({
  periodType: z.enum(['final', 'interim']).meta({ title: 'Period type' }),
  periodEnd: date('Period end'),
});

function addMonths(civil: CivilDate, months: number): CivilDate {
  const d = new Date(`${civil}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const endOfDay = (civil: CivilDate) => zonedToUtc(civil, '23:59', TZ);

const insideInfoRules: Rule<z.infer<typeof insideInfo>>[] = [
  ({ meta, now }) => {
    const out: Issue[] = [];
    const known = new Date(meta.informationBecameKnownAt);
    if (known > now) out.push(error('FUTURE_TIMESTAMP', 'Information cannot become known in the future', 'metadata.informationBecameKnownAt'));
    if (meta.delayedDisclosure) {
      if (meta.delayedDisclosure.justification.length < MIN_DELAY_JUSTIFICATION) {
        out.push(error('UK_MAR_DELAY_JUSTIFICATION', `A delay needs a recorded justification of at least ${MIN_DELAY_JUSTIFICATION} characters`, 'metadata.delayedDisclosure.justification'));
      }
    } else if (now.getTime() - known.getTime() > ASAP_WARN_MINUTES * 60_000) {
      out.push(warning('UK_MAR_ASAP', `Information known for over ${ASAP_WARN_MINUTES} minutes; MAR expects disclosure as soon as possible. If disclosure was delayed, record the delay.`, 'metadata.informationBecameKnownAt'));
    }
    return out;
  },
];

const pdmrRules: Rule<z.infer<typeof pdmr>>[] = [
  ({ meta }) => (isValidIsin(meta.isin) ? [] : [error('INVALID_ISIN', `"${meta.isin}" is not a valid ISIN`, 'metadata.isin')]),
  ({ meta }) =>
    meta.transactionDate > meta.notifiedAt
      ? [error('UK_MAR_PDMR_DATES', 'Transaction date is after the notification date', 'metadata.transactionDate')]
      : [],
  // Art. 19(1): the PDMR must tell the issuer within 3 business days of the transaction.
  ({ meta }) =>
    meta.notifiedAt > addBusinessDays(meta.transactionDate, PDMR_BUSINESS_DAYS, UK_BANK_HOLIDAYS)
      ? [warning('UK_MAR_PDMR_LATE_NOTIFICATION', `The PDMR told the issuer more than ${PDMR_BUSINESS_DAYS} business days after the transaction (Art. 19(1)); record the reason`, 'metadata.notifiedAt')]
      : [],
];

const resultsRules: Rule<z.infer<typeof results>>[] = [
  ({ meta, now }) =>
    meta.periodEnd > civilOf(now, TZ) ? [error('PERIOD_IN_FUTURE', 'Period end is in the future', 'metadata.periodEnd')] : [],
];

export const ukPolicy = definePolicy({
  code: 'UK',
  name: 'United Kingdom',
  timezone: TZ,
  channel: { id: 'rns', name: 'RNS (Regulatory Information Service)' },
  issuerProfile: z
    .object({
      tidm: z.string().refine(isValidTidm, 'TIDM must be 2-5 uppercase letters or digits'),
      lei: z.string().refine(isValidLei, 'LEI is not a valid ISO 17442 identifier'),
    })
    .catchall(z.string()),
  headlineMax: 150,
  calendar: UK_BANK_HOLIDAYS,
  window: { open: '07:00', close: '18:30' },
  categories: {
    inside_information: {
      label: 'Inside information (UK MAR Art. 17)',
      schema: insideInfo,
      rules: insideInfoRules,
      approval: { min: 2, mustInclude: ['company_secretary'] },
      deadline: () => ({ at: null, basis: 'As soon as possible (UK MAR Art. 17(1))' }),
      releaseOutsideWindow: true,
    },
    pdmr_dealing: {
      label: 'PDMR dealing notification (UK MAR Art. 19)',
      schema: pdmr,
      rules: pdmrRules,
      approval: { min: 1, mustInclude: ['company_secretary'] },
      deadline: ({ meta }) => ({
        at: endOfDay(addBusinessDays(meta.transactionDate, PDMR_BUSINESS_DAYS, UK_BANK_HOLIDAYS)),
        basis: 'Issuer must publish within 3 business days of the transaction (UK MAR Art. 19(3))',
      }),
    },
    results: {
      label: 'Annual or interim results (DTR 4)',
      schema: results,
      rules: resultsRules,
      approval: { min: 2, mustInclude: ['cfo'] },
      deadline: ({ meta }) => ({
        at: endOfDay(addMonths(meta.periodEnd, meta.periodType === 'final' ? 4 : 3)),
        basis: meta.periodType === 'final' ? 'Annual report within 4 months of year end (DTR 4.1)' : 'Half-year report within 3 months of period end (DTR 4.2)',
      }),
    },
    general: {
      label: 'Other regulatory announcement',
      schema: z.object({}),
      approval: { min: 1, mustInclude: [] },
    },
  },

  render({ issuer, headline, body, category, meta }) {
    const profile = issuer.profiles.UK ?? {};
    const inside = category === 'inside_information';
    const lines = [
      ...(inside
        ? [
            'This announcement contains inside information as stipulated under the UK version of Regulation (EU) No. 596/2014 which is part of English law by virtue of the European Union (Withdrawal) Act 2018, as amended.',
            '',
          ]
        : []),
      body.trim(),
      '',
      ...(inside ? [`The person responsible for arranging the release of this announcement on behalf of the Company was ${meta.personResponsible.name}, ${meta.personResponsible.title}.`, ''] : []),
      `LEI: ${profile.lei}`,
    ];
    return {
      channel: 'rns',
      headline,
      content: lines.join('\n'),
      attributes: {
        issuerName: issuer.name,
        tidm: profile.tidm ?? '',
        lei: profile.lei ?? '',
        category,
        insideInformation: String(inside),
      },
      attachments: [],
    };
  },

  postPublication({ category, meta }) {
    return [
      'Confirm the release reached the FCA National Storage Mechanism',
      'Publish on the issuer website and keep it there for at least 5 years (UK MAR Art. 17(1))',
      ...(category === 'inside_information' && meta.delayedDisclosure ? ['Notify the FCA of the delay and keep the delay record (UK MAR Art. 17(4))'] : []),
    ];
  },
});
