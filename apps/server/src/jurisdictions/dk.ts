import { z } from 'zod';
import { definePolicy, type Rule } from '../domain/policy.js';
import { DK_HOLIDAYS } from './calendars.js';
import { isValidCvr, isValidLei } from './identifiers.js';
import {
  insideInfoRules,
  insideInfoSchema,
  pdmrDeadline,
  pdmrRules,
  pdmrSchema,
  resultsDeadline,
  resultsRules,
  resultsSchema,
  warning,
  type PdmrMeta,
} from './mar.js';

/**
 * Denmark model: EU MAR applies directly (Art. 17 inside information, Art. 19 managers' transactions) and the
 * Transparency Directive sets the reporting periods; issuers on Nasdaq Copenhagen release company announcements
 * through the exchange, and the Danish OAM (Finanstilsynet) stores them. The MAR text is the same one the UK
 * uses (mar.ts); what is Danish here is the language rule, the notification threshold, the CVR number, the
 * calendar and the channel. Simplified for the exercise; thresholds, hours and wording are assumptions, not legal advice.
 */

const TZ = 'Europe/Copenhagen';
const REGIME = 'EU MAR';
const PREFIX = 'EU_MAR';

/** Illustrative: managers' transactions below this value in a year need not be notified (EUR 20,000 and its DKK peg). */
const PDMR_THRESHOLD: Record<string, number> = { EUR: 20_000, DKK: 149_200 };

/** Company announcements are published in Danish or English. */
const language = z.enum(['da', 'en']).meta({ title: 'Language of the announcement' });
type Language = z.infer<typeof language>;

const insideInfo = insideInfoSchema.extend({ language });
const pdmr = pdmrSchema.extend({ language });
const results = resultsSchema.extend({ language });

const thresholdRule: Rule<PdmrMeta> = ({ meta }) => {
  const limit = PDMR_THRESHOLD[meta.currency];
  const value = meta.price * meta.volume;
  return limit !== undefined && value < limit
    ? [warning(`${PREFIX}_PDMR_BELOW_THRESHOLD`, `The transaction is worth ${value} ${meta.currency}, under the ${limit} ${meta.currency} notification threshold; confirm the year's total before publishing`, 'metadata.volume')]
    : [];
};

const WORDING: Record<Language, { inside: string; responsible: (name: string, title: string) => string }> = {
  en: {
    inside: 'This announcement contains inside information as defined in Article 7 of Regulation (EU) No 596/2014 on market abuse.',
    responsible: (name, title) => `The person responsible for arranging the release of this announcement on behalf of the Company was ${name}, ${title}.`,
  },
  da: {
    inside: 'Denne meddelelse indeholder insiderinformation som defineret i artikel 7 i forordning (EU) nr. 596/2014 om markedsmisbrug.',
    responsible: (name, title) => `Den person, der er ansvarlig for offentliggørelsen på selskabets vegne, er ${name}, ${title}.`,
  },
};

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
    })
    .catchall(z.string()),
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
    const lines = [
      ...(inside ? [words.inside, ''] : []),
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
        category,
        insideInformation: String(inside),
        language: meta.language,
      },
      attachments: [],
    };
  },

  postPublication({ category, meta }) {
    return [
      'Confirm the announcement is stored in the Danish OAM (Finanstilsynet)',
      'Publish on the issuer website and keep it there for at least 5 years (EU MAR Art. 17(1))',
      ...(category === 'inside_information' && meta.delayedDisclosure ? ['Notify Finanstilsynet that disclosure was delayed and keep the delay record (EU MAR Art. 17(4))'] : []),
    ];
  },
});
