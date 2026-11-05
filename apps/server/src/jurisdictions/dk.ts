import { z } from 'zod';
import { addBusinessDays, addDays, civilOf, daysBetween, zonedToUtc } from '../domain/calendar.js';
import { definePolicy, type Deadline, type Rule, type RuleContext } from '../domain/policy.js';
import { DK_HOLIDAYS } from './calendars.js';
import { isValidCvr, isValidLei } from './identifiers.js';
import {
  endOfDay,
  error,
  insideInfoRules,
  insideInfoSchema,
  pdmrDeadline,
  pdmrRules,
  pdmrSchema,
  resultsDeadline,
  resultsRules,
  resultsSchema,
  text,
  warning,
  type PdmrMeta,
} from './mar.js';

/**
 * Denmark model: EU MAR applies directly (Art. 17 inside information, Art. 19 managers' transactions, Art. 5 buy-backs),
 * the Transparency Directive sets the reporting periods and the major-shareholding notifications, and the Danish
 * Companies Act sets the notice of general meetings. Issuers on Nasdaq Copenhagen release company announcements
 * through the exchange and the Danish OAM (Finanstilsynet) stores them. The MAR text is the same one the UK uses
 * (mar.ts); what is Danish here is the language rule, the notification threshold, the CVR number, the calendar, the
 * channel, the market segment (main market or First North) and the three categories the UK and US policies do not have.
 * Simplified for the exercise: thresholds, notice periods, hours and wording are assumptions to confirm with Danish
 * counsel before use, not legal advice.
 */

const TZ = 'Europe/Copenhagen';
const REGIME = 'EU MAR';
const PREFIX = 'EU_MAR';

/** Illustrative: managers' transactions below this value in a year need not be notified (EUR 20,000 and its DKK peg). */
const PDMR_THRESHOLD: Record<string, number> = { EUR: 20_000, DKK: 149_200 };

/** Danish flagging thresholds in per cent of voting rights or share capital (Capital Markets Act). */
// Written with a % sign: a bare integer-like value would be listed before 33.33 by any consumer that keys an object by it.
const HOLDING_THRESHOLDS = ['5%', '10%', '15%', '20%', '25%', '33.33%', '50%', '66.67%', '90%'] as const;
/** The holder tells the issuer within 4 trading days; the issuer publishes within 3 trading days of being told (TD Art. 12). */
const HOLDER_NOTIFY_DAYS = 4;
const ISSUER_PUBLISH_DAYS = 3;
/** MAR Art. 5(4) with Delegated Regulation (EU) 2016/1052 Art. 2(3): end of the seventh daily market session. */
const BUYBACK_REPORT_SESSIONS = 7;
/** Companies Act: notice of a general meeting of a listed company, no earlier than 5 weeks before it. */
const NOTICE_MAX_DAYS = 35;
const NOTICE_MIN_DAYS = { annual: 21, extraordinary: 14 } as const;

const date = (title: string) => z.iso.date().meta({ title });

/** Company announcements are published in Danish or English. */
const language = z.enum(['da', 'en']).meta({ title: 'Language of the announcement' });
type Language = z.infer<typeof language>;

const insideInfo = insideInfoSchema.extend({ language });
const pdmr = pdmrSchema.extend({ language });
const results = resultsSchema.extend({ language });

const majorShareholding = z.object({
  language,
  holder: z.object({ name: text('Name'), type: z.enum(['natural_person', 'legal_entity']).meta({ title: 'Type' }) }).meta({ title: 'Shareholder' }),
  threshold: z.enum(HOLDING_THRESHOLDS).meta({ title: 'Threshold crossed (%)' }),
  direction: z.enum(['up', 'down']).meta({ title: 'Direction of the crossing' }),
  basis: z.enum(['voting_rights', 'share_capital']).meta({ title: 'Measured against' }),
  holdingKind: z.enum(['shares', 'financial_instruments', 'both']).meta({ title: 'Holding consists of' }),
  holdingPercent: z.number().min(0).max(100).meta({ title: 'Holding after the crossing (%)' }),
  crossedOn: date('Date the threshold was crossed'),
  notifiedOn: date('Date the issuer was notified'),
});
type HoldingMeta = z.infer<typeof majorShareholding>;

const shareBuyback = z.object({
  language,
  programme: text('Programme'),
  periodFrom: date('First trading day in the report'),
  periodTo: date('Last trading day in the report'),
  sharesBought: z.number().int().positive().meta({ title: 'Shares bought in the period' }),
  averagePrice: z.number().positive().meta({ title: 'Average price' }),
  currency: z.string().length(3).meta({ title: 'Currency (ISO 4217)' }),
  cumulativeShares: z.number().int().positive().meta({ title: 'Shares bought under the programme so far' }),
  authorisedMaximum: z.number().int().positive().meta({ title: 'Maximum under the authorisation (shares)' }),
});
type BuybackMeta = z.infer<typeof shareBuyback>;

const generalMeeting = z.object({
  language,
  meetingType: z.enum(['annual', 'extraordinary']).meta({ title: 'Type of meeting' }),
  meetingDate: date('Date of the meeting'),
  venue: text('Venue'),
});
type MeetingMeta = z.infer<typeof generalMeeting>;

// ------------------------------------------------------------------ rules

/** The Transparency Directive notifications apply on a regulated market, not on First North. */
const regulatedMarketOnly =
  (what: string): Rule =>
  ({ issuer }) =>
    issuer.profiles.DK?.market === 'first_north'
      ? [error('DK_REGULATED_MARKET_ONLY', `${what} applies to issuers on a regulated market; ${issuer.name} is on First North`, 'issuer')]
      : [];

const thresholdRule: Rule<PdmrMeta> = ({ meta }) => {
  const limit = PDMR_THRESHOLD[meta.currency];
  const value = meta.price * meta.volume;
  return limit !== undefined && value < limit
    ? [warning(`${PREFIX}_PDMR_BELOW_THRESHOLD`, `The transaction is worth ${value} ${meta.currency}, under the ${limit} ${meta.currency} notification threshold; confirm the year's total before publishing`, 'metadata.volume')]
    : [];
};

const holdingRules: Rule<HoldingMeta>[] = [
  regulatedMarketOnly('A major-shareholder announcement'),
  ({ meta }) => {
    const limit = Number.parseFloat(meta.threshold);
    const consistent = meta.direction === 'up' ? meta.holdingPercent >= limit : meta.holdingPercent < limit;
    return consistent
      ? []
      : [error('DK_TD_HOLDING_VS_THRESHOLD', `A holding of ${meta.holdingPercent}% is not ${meta.direction === 'up' ? 'at or above' : 'below'} the ${meta.threshold} threshold it is said to have crossed ${meta.direction}wards`, 'metadata.holdingPercent')];
  },
  ({ meta, now }) => {
    const today = civilOf(now, TZ);
    return [
      ...(meta.crossedOn > today ? [error('DK_TD_DATE_IN_FUTURE', 'The crossing cannot be in the future', 'metadata.crossedOn')] : []),
      ...(meta.notifiedOn > today ? [error('DK_TD_DATE_IN_FUTURE', 'The notification cannot be in the future', 'metadata.notifiedOn')] : []),
      ...(meta.notifiedOn < meta.crossedOn ? [error('DK_TD_DATES', 'The issuer was notified before the threshold was crossed', 'metadata.notifiedOn')] : []),
    ];
  },
  ({ meta }) =>
    meta.notifiedOn > addBusinessDays(meta.crossedOn, HOLDER_NOTIFY_DAYS, DK_HOLIDAYS)
      ? [warning('DK_TD_LATE_HOLDER_NOTIFICATION', `The shareholder told the issuer more than ${HOLDER_NOTIFY_DAYS} trading days after the crossing (Transparency Directive Art. 12(2)); record the reason`, 'metadata.notifiedOn')]
      : [],
];

const buybackRules: Rule<BuybackMeta>[] = [
  ({ meta, now }) => [
    ...(meta.periodFrom > meta.periodTo ? [error('DK_BUYBACK_PERIOD', 'The report starts after it ends', 'metadata.periodFrom')] : []),
    ...(meta.periodTo > civilOf(now, TZ) ? [error('DK_BUYBACK_PERIOD', 'The report period ends in the future', 'metadata.periodTo')] : []),
  ],
  ({ meta }) =>
    meta.cumulativeShares < meta.sharesBought
      ? [error('DK_BUYBACK_CUMULATIVE', 'The programme total cannot be smaller than the shares bought in the period', 'metadata.cumulativeShares')]
      : [],
  ({ meta }) =>
    meta.cumulativeShares > meta.authorisedMaximum
      ? [error('DK_BUYBACK_ABOVE_AUTHORISATION', 'The programme total is above the maximum the shareholders authorised', 'metadata.cumulativeShares')]
      : [],
];

const meetingRules: Rule<MeetingMeta>[] = [
  ({ meta, now }) => {
    const today = civilOf(now, TZ);
    if (meta.meetingDate <= today) return [error('DK_MEETING_IN_PAST', 'The meeting date has passed', 'metadata.meetingDate')];
    const lead = daysBetween(today, meta.meetingDate);
    const min = NOTICE_MIN_DAYS[meta.meetingType];
    if (lead < min) {
      return [error('DK_MEETING_NOTICE_TOO_SHORT', `Notice must go out at least ${min} days before the meeting; ${lead} are left (Companies Act). Move the meeting`, 'metadata.meetingDate')];
    }
    return lead > NOTICE_MAX_DAYS
      ? [warning('DK_MEETING_NOTICE_TOO_EARLY', `Notice may go out at most ${NOTICE_MAX_DAYS} days before the meeting; wait until ${addDays(meta.meetingDate, -NOTICE_MAX_DAYS)}`, 'metadata.meetingDate')]
      : [];
  },
];

// ------------------------------------------------------------------ deadlines

const holdingDeadline = ({ meta }: RuleContext<HoldingMeta>): Deadline => ({
  at: endOfDay(addBusinessDays(meta.notifiedOn, ISSUER_PUBLISH_DAYS, DK_HOLIDAYS), TZ),
  basis: `Issuer publishes within ${ISSUER_PUBLISH_DAYS} trading days of the notification (Transparency Directive Art. 12(6))`,
});

/** Each transaction is reported within 7 sessions of its own execution, so the first day of the report sets the limit. */
const buybackDeadline = ({ meta }: RuleContext<BuybackMeta>): Deadline => ({
  at: endOfDay(addBusinessDays(meta.periodFrom, BUYBACK_REPORT_SESSIONS, DK_HOLIDAYS), TZ),
  basis: `End of the ${BUYBACK_REPORT_SESSIONS}th market session after the first transaction in the report (MAR Art. 5(4), Delegated Regulation 2016/1052 Art. 2(3))`,
});

const meetingDeadline = ({ meta }: RuleContext<MeetingMeta>): Deadline => {
  const min = NOTICE_MIN_DAYS[meta.meetingType];
  return { at: zonedToUtc(addDays(meta.meetingDate, -min), '23:59', TZ), basis: `Notice at least ${min} days before the meeting (Companies Act)` };
};

// ------------------------------------------------------------------ wording

interface Wording {
  inside: string;
  responsible: (name: string, title: string) => string;
  holding: (m: HoldingMeta) => string[];
  buyback: (m: BuybackMeta) => string[];
  meeting: (m: MeetingMeta) => string[];
}

const pct = (n: number) => `${n}%`;

const WORDING: Record<Language, Wording> = {
  en: {
    inside: 'This announcement contains inside information as defined in Article 7 of Regulation (EU) No 596/2014 on market abuse.',
    responsible: (name, title) => `The person responsible for arranging the release of this announcement on behalf of the Company was ${name}, ${title}.`,
    holding: (m) => [
      'Major shareholder announcement (Transparency Directive Art. 9)',
      `Shareholder: ${m.holder.name} (${m.holder.type === 'legal_entity' ? 'legal entity' : 'natural person'})`,
      `Crossed ${m.direction === 'up' ? 'above' : 'below'} the ${m.threshold} threshold of ${m.basis === 'voting_rights' ? 'voting rights' : 'share capital'}`,
      `Holding after the crossing: ${pct(m.holdingPercent)} (${m.holdingKind.replace('_', ' ')})`,
      `Date of the crossing: ${m.crossedOn}`,
      `Notified to the Company on: ${m.notifiedOn}`,
    ],
    buyback: (m) => [
      `Share buyback programme: ${m.programme}`,
      `Period: ${m.periodFrom} to ${m.periodTo}`,
      `Shares bought: ${m.sharesBought} at an average price of ${m.averagePrice} ${m.currency}`,
      `Total under the programme: ${m.cumulativeShares} of a maximum of ${m.authorisedMaximum} shares`,
    ],
    meeting: (m) => [
      m.meetingType === 'annual' ? 'Notice of annual general meeting' : 'Notice of extraordinary general meeting',
      `Date of the meeting: ${m.meetingDate}`,
      `Venue: ${m.venue}`,
    ],
  },
  da: {
    inside: 'Denne meddelelse indeholder insiderinformation som defineret i artikel 7 i forordning (EU) nr. 596/2014 om markedsmisbrug.',
    responsible: (name, title) => `Den person, der er ansvarlig for offentliggørelsen på selskabets vegne, er ${name}, ${title}.`,
    holding: (m) => [
      'Større aktionærmeddelelse (gennemsigtighedsdirektivets artikel 9)',
      `Aktionær: ${m.holder.name} (${m.holder.type === 'legal_entity' ? 'juridisk person' : 'fysisk person'})`,
      `Har ${m.direction === 'up' ? 'overskredet' : 'underskredet'} grænsen på ${m.threshold.replace('%', ' %')} af ${m.basis === 'voting_rights' ? 'stemmerettighederne' : 'aktiekapitalen'}`,
      `Beholdning efter ændringen: ${m.holdingPercent} % (${{ shares: 'aktier', financial_instruments: 'finansielle instrumenter', both: 'aktier og finansielle instrumenter' }[m.holdingKind]})`,
      `Dato for ændringen: ${m.crossedOn}`,
      `Meddelt selskabet den: ${m.notifiedOn}`,
    ],
    buyback: (m) => [
      `Aktietilbagekøbsprogram: ${m.programme}`,
      `Periode: ${m.periodFrom} til ${m.periodTo}`,
      `Købte aktier: ${m.sharesBought} til en gennemsnitskurs på ${m.averagePrice} ${m.currency}`,
      `I alt under programmet: ${m.cumulativeShares} af højst ${m.authorisedMaximum} aktier`,
    ],
    meeting: (m) => [
      m.meetingType === 'annual' ? 'Indkaldelse til ordinær generalforsamling' : 'Indkaldelse til ekstraordinær generalforsamling',
      `Dato for generalforsamlingen: ${m.meetingDate}`,
      `Sted: ${m.venue}`,
    ],
  },
};

/** The structured facts a category adds above the free text, in the language of the announcement. */
function facts(category: string, meta: Record<string, unknown>, words: Wording): string[] {
  switch (category) {
    case 'major_shareholding':
      return words.holding(meta as HoldingMeta);
    case 'share_buyback':
      return words.buyback(meta as BuybackMeta);
    case 'general_meeting':
      return words.meeting(meta as MeetingMeta);
    default:
      return [];
  }
}

// ------------------------------------------------------------------ policy

export const dkPolicy = definePolicy({
  code: 'DK',
  name: 'Denmark (EU)',
  timezone: TZ,
  channel: { id: 'cph', name: 'Nasdaq Copenhagen (company announcements)' },
  issuerProfile: z
    .object({
      cvr: z.string().refine(isValidCvr, 'CVR must be 8 digits with a valid check digit'),
      lei: z.string().refine(isValidLei, 'LEI is not a valid ISO 17442 identifier'),
      ticker: z.string().min(1, 'Ticker is required'),
      market: z.enum(['main', 'first_north'], { error: 'Market must be main or first_north' }),
    })
    .catchall(z.string())
    .refine((p) => p.market !== 'first_north' || !!p.certifiedAdviser?.trim(), { message: 'A First North issuer needs a Certified Adviser', path: ['certifiedAdviser'] }),
  headlineMax: 150,
  calendar: DK_HOLIDAYS,
  window: { open: '07:00', close: '22:00' },
  categories: {
    inside_information: {
      label: 'Inside information (EU MAR Art. 17)',
      schema: insideInfo,
      rules: insideInfoRules(PREFIX),
      approval: { min: 2, mustInclude: ['company_secretary'] },
      deadline: () => ({ at: null, basis: 'As soon as possible (EU MAR Art. 17(1))' }),
      releaseOutsideWindow: true,
    },
    pdmr_dealing: {
      label: "Managers' transaction (EU MAR Art. 19)",
      schema: pdmr,
      rules: [...pdmrRules(PREFIX, DK_HOLIDAYS), thresholdRule],
      approval: { min: 1, mustInclude: ['company_secretary'] },
      deadline: pdmrDeadline(REGIME, DK_HOLIDAYS, TZ),
    },
    results: {
      label: 'Annual or interim report (Transparency Directive)',
      schema: results,
      rules: resultsRules(TZ),
      approval: { min: 2, mustInclude: ['cfo'] },
      deadline: resultsDeadline(TZ, {
        final: 'Annual financial report within 4 months of year end (Transparency Directive Art. 4)',
        interim: 'Half-year report within 3 months of period end (Transparency Directive Art. 5)',
      }),
    },
    major_shareholding: {
      label: 'Major shareholder announcement (Transparency Directive Art. 9)',
      schema: majorShareholding,
      rules: holdingRules,
      approval: { min: 1, mustInclude: ['company_secretary'] },
      deadline: holdingDeadline,
    },
    share_buyback: {
      label: 'Share buyback report (EU MAR Art. 5)',
      schema: shareBuyback,
      rules: buybackRules,
      approval: { min: 1, mustInclude: ['cfo'] },
      deadline: buybackDeadline,
    },
    general_meeting: {
      label: 'Notice of general meeting (Companies Act)',
      schema: generalMeeting,
      rules: meetingRules,
      approval: { min: 2, mustInclude: ['company_secretary'] },
      deadline: meetingDeadline,
    },
    general: {
      label: 'Other company announcement',
      schema: z.object({ language }),
      approval: { min: 1, mustInclude: [] },
    },
  },

  render({ issuer, headline, body, category, meta }) {
    const profile = issuer.profiles.DK ?? {};
    const words = WORDING[meta.language as Language];
    const inside = category === 'inside_information';
    const structured = facts(category, meta, words);
    const lines = [
      ...(inside ? [words.inside, ''] : []),
      ...(structured.length ? [...structured, ''] : []),
      body.trim(),
      '',
      ...(inside ? [words.responsible(meta.personResponsible.name, meta.personResponsible.title), ''] : []),
      `LEI: ${profile.lei}`,
    ];
    return {
      channel: 'cph',
      headline,
      content: lines.join('\n'),
      attributes: {
        issuerName: issuer.name,
        cvr: profile.cvr ?? '',
        lei: profile.lei ?? '',
        ticker: profile.ticker ?? '',
        market: profile.market ?? '',
        category,
        insideInformation: String(inside),
        language: meta.language,
      },
      attachments: [],
    };
  },

  postPublication({ category, meta, issuer }) {
    const common = [
      'Confirm the announcement is stored in the Danish OAM (Finanstilsynet)',
      'Publish on the issuer website and keep it there for at least 5 years (EU MAR Art. 17(1))',
      ...(issuer.profiles.DK?.market === 'first_north' ? ['Send a copy to the Certified Adviser (First North rules)'] : []),
    ];
    switch (category) {
      case 'inside_information':
        return [...common, ...(meta.delayedDisclosure ? ['Notify Finanstilsynet that disclosure was delayed and keep the delay record (EU MAR Art. 17(4))'] : [])];
      case 'major_shareholding':
        return [...common, 'File the notification with Finanstilsynet at the same time (Transparency Directive Art. 12(6))', 'Update the total number of shares and voting rights on the website'];
      case 'share_buyback':
        return [...common, 'Report the individual transactions to Finanstilsynet (MAR Art. 5(3))', 'Keep the transaction records for the authority'];
      case 'general_meeting':
        return [...common, 'Publish the full meeting documents and the agenda on the website (Companies Act)'];
      default:
        return common;
    }
  },
});
