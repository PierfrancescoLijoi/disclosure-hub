import { z } from 'zod';
import { addBusinessDays, civilOf, zonedToUtc, type Calendar, type CivilDate } from '../domain/calendar.js';
import type { Deadline, Rule } from '../domain/policy.js';
import type { Issue } from '../domain/types.js';
import { isValidIsin } from './identifiers.js';

/**
 * The Market Abuse Regulation (inside information Art. 17, managers' transactions Art. 19) and the periodic
 * reporting duty are the same text in the UK (retained law) and in the EU (Denmark). They are written once here;
 * a policy plugs in its own calendar, time zone, issue-code prefix and wording. What really differs between
 * regimes (language, thresholds, identifiers, channel) stays in the policy file.
 * Simplified for the exercise; thresholds and hours are assumptions, not legal advice.
 */

export const ASAP_WARN_MINUTES = 60;
export const MIN_DELAY_JUSTIFICATION = 30;
export const PDMR_BUSINESS_DAYS = 3;

export const text = (title: string) => z.string().trim().min(1).meta({ title });
const date = (title: string) => z.iso.date().meta({ title });
const datetime = (title: string) => z.iso.datetime({ offset: true }).meta({ title });
const person = z.object({ name: text('Name'), title: text('Position') });

export const error = (code: string, message: string, path?: string): Issue => ({ code, severity: 'error', message, path });
export const warning = (code: string, message: string, path?: string): Issue => ({ code, severity: 'warning', message, path });

// ------------------------------------------------------------------ inside information (Art. 17)

export const insideInfoSchema = z.object({
  informationBecameKnownAt: datetime('Inside information became known at'),
  personResponsible: person.meta({ title: 'Person responsible for release' }),
  delayedDisclosure: z
    .object({ decidedAt: datetime('Delay decided at'), justification: text('Justification for delay') })
    .optional()
    .meta({ title: 'Delayed disclosure (Art. 17(4))' }),
});
export type InsideInfoMeta = z.infer<typeof insideInfoSchema>;

/** `prefix` keeps the issue codes of each regime apart (UK_MAR, EU_MAR). */
export const insideInfoRules = (prefix: string): Rule<InsideInfoMeta>[] => [
  ({ meta, now }) => {
    const out: Issue[] = [];
    const known = new Date(meta.informationBecameKnownAt);
    if (known > now) out.push(error('FUTURE_TIMESTAMP', 'Information cannot become known in the future', 'metadata.informationBecameKnownAt'));
    if (meta.delayedDisclosure) {
      if (meta.delayedDisclosure.justification.length < MIN_DELAY_JUSTIFICATION) {
        out.push(error(`${prefix}_DELAY_JUSTIFICATION`, `A delay needs a recorded justification of at least ${MIN_DELAY_JUSTIFICATION} characters`, 'metadata.delayedDisclosure.justification'));
      }
    } else if (now.getTime() - known.getTime() > ASAP_WARN_MINUTES * 60_000) {
      out.push(warning(`${prefix}_ASAP`, `Information known for over ${ASAP_WARN_MINUTES} minutes; MAR expects disclosure as soon as possible. If disclosure was delayed, record the delay.`, 'metadata.informationBecameKnownAt'));
    }
    return out;
  },
];

// ------------------------------------------------------------------ managers' transactions (Art. 19)

export const pdmrSchema = z.object({
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
export type PdmrMeta = z.infer<typeof pdmrSchema>;

export const pdmrRules = (prefix: string, calendar: Calendar): Rule<PdmrMeta>[] => [
  ({ meta }) => (isValidIsin(meta.isin) ? [] : [error('INVALID_ISIN', `"${meta.isin}" is not a valid ISIN`, 'metadata.isin')]),
  ({ meta }) =>
    meta.transactionDate > meta.notifiedAt
      ? [error(`${prefix}_PDMR_DATES`, 'Transaction date is after the notification date', 'metadata.transactionDate')]
      : [],
  // Art. 19(1): the PDMR must tell the issuer within 3 business days of the transaction.
  ({ meta }) =>
    meta.notifiedAt > addBusinessDays(meta.transactionDate, PDMR_BUSINESS_DAYS, calendar)
      ? [warning(`${prefix}_PDMR_LATE_NOTIFICATION`, `The PDMR told the issuer more than ${PDMR_BUSINESS_DAYS} business days after the transaction (Art. 19(1)); record the reason`, 'metadata.notifiedAt')]
      : [],
];

export const endOfDay = (civil: CivilDate, tz: string) => zonedToUtc(civil, '23:59', tz);

/** Art. 19(3): the issuer publishes within 3 business days of the transaction (not of being told). */
export const pdmrDeadline =
  (regime: string, calendar: Calendar, tz: string) =>
  ({ meta }: { meta: PdmrMeta }): Deadline => ({
    at: endOfDay(addBusinessDays(meta.transactionDate, PDMR_BUSINESS_DAYS, calendar), tz),
    basis: `Issuer must publish within ${PDMR_BUSINESS_DAYS} business days of the transaction (${regime} Art. 19(3))`,
  });

// ------------------------------------------------------------------ periodic results

export const resultsSchema = z.object({
  periodType: z.enum(['final', 'interim']).meta({ title: 'Period type' }),
  periodEnd: date('Period end'),
});
export type ResultsMeta = z.infer<typeof resultsSchema>;

export const resultsRules = (tz: string): Rule<ResultsMeta>[] => [
  ({ meta, now }) =>
    meta.periodEnd > civilOf(now, tz) ? [error('PERIOD_IN_FUTURE', 'Period end is in the future', 'metadata.periodEnd')] : [],
];

function addMonths(civil: CivilDate, months: number): CivilDate {
  const [year, month, day] = civil.split('-').map(Number) as [number, number, number];
  const targetStart = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = targetStart.getUTCFullYear();
  const targetMonth = targetStart.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

/** Annual report within 4 months of year end, half-year report within 3 months of period end. */
export const resultsDeadline =
  (tz: string, basis: { final: string; interim: string }) =>
  ({ meta }: { meta: ResultsMeta }): Deadline => ({
    at: endOfDay(addMonths(meta.periodEnd, meta.periodType === 'final' ? 4 : 3), tz),
    basis: meta.periodType === 'final' ? basis.final : basis.interim,
  });
