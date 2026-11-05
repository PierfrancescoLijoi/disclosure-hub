import { z } from 'zod';
import { definePolicy } from '../domain/policy.js';
import { UK_BANK_HOLIDAYS } from './calendars.js';
import { isValidLei, isValidTidm } from './identifiers.js';
import { insideInfoRules, insideInfoSchema, pdmrDeadline, pdmrRules, pdmrSchema, resultsDeadline, resultsRules, resultsSchema } from './mar.js';

/**
 * UK main-market model: UK MAR Art. 17 (inside information), Art. 19 (PDMR dealings),
 * DTR 4 (results), released through a Regulatory Information Service (RNS).
 * The MAR and results building blocks are shared with Denmark (mar.ts).
 * Simplified for the exercise; thresholds and hours are assumptions, not legal advice.
 */

const TZ = 'Europe/London';

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
      schema: insideInfoSchema,
      rules: insideInfoRules('UK_MAR'),
      approval: { min: 2, mustInclude: ['company_secretary'] },
      deadline: () => ({ at: null, basis: 'As soon as possible (UK MAR Art. 17(1))' }),
      releaseOutsideWindow: true,
    },
    pdmr_dealing: {
      label: 'PDMR dealing notification (UK MAR Art. 19)',
      schema: pdmrSchema,
      rules: pdmrRules('UK_MAR', UK_BANK_HOLIDAYS),
      approval: { min: 1, mustInclude: ['company_secretary'] },
      deadline: pdmrDeadline('UK MAR', UK_BANK_HOLIDAYS, TZ),
    },
    results: {
      label: 'Annual or interim results (DTR 4)',
      schema: resultsSchema,
      rules: resultsRules(TZ),
      approval: { min: 2, mustInclude: ['cfo'] },
      deadline: resultsDeadline(TZ, { final: 'Annual report within 4 months of year end (DTR 4.1)', interim: 'Half-year report within 3 months of period end (DTR 4.2)' }),
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
