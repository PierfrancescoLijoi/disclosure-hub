/** Sample content for the "Fill with example content" button: the policy owns it, so the UI keeps no list of jurisdictions. */
import type { CategoryExample } from '../domain/policy.js';
import { CONTACT, ex } from './example-helpers.js';

export const dkExamples = {
  general: (now) => ex(now, () => ({
    headline: 'Indkaldelse til ordinær generalforsamling',
    body: `Bestyrelsen i Northwind Energy plc indkalder til ordinær generalforsamling den 12. december 2026. Indkaldelsen og fuldmagtsblanketten er tilgængelige på selskabets hjemmeside.${CONTACT}`,
    metadata: { language: 'da' },
  })),
  inside_information: (now) => ex(now, ({ minutesAgo }) => ({
    headline: 'Upgrade of full-year guidance',
    body: `Northwind Energy plc raises its full-year guidance: revenue and adjusted EBITDA are ahead of the Board's expectations.${CONTACT}`,
    metadata: { language: 'en', informationBecameKnownAt: minutesAgo(10), personResponsible: { name: 'Bob Chen', title: 'Company Secretary' } },
  })),
  pdmr_dealing: (now) => ex(now, ({ day }) => ({
    headline: 'Managers transactions',
    body: `Northwind Energy plc was notified that Dan Okafor, Chief Financial Officer, purchased shares in the Company.${CONTACT}`,
    metadata: {
      language: 'en', pdmrName: 'Dan Okafor', position: 'Chief Financial Officer', instrument: 'Ordinary shares', isin: 'DK0010244425',
      transactionType: 'acquisition', price: 120, currency: 'DKK', volume: 2000, transactionDate: day(1), venue: 'XCSE', notifiedAt: day(1),
    },
  })),
  major_shareholding: (now) => ex(now, ({ day }) => ({
    headline: 'Major shareholder announcement',
    body: `Northwind Energy plc was notified that Fjord Capital A/S has passed the 5% threshold of voting rights in the Company.${CONTACT}`,
    metadata: {
      language: 'en', holder: { name: 'Fjord Capital A/S', type: 'legal_entity' }, threshold: '5%', direction: 'up', basis: 'voting_rights',
      holdingKind: 'shares', holdingPercent: 5.4, crossedOn: day(2), notifiedOn: day(1),
    },
  })),
  share_buyback: (now) => ex(now, ({ day }) => ({
    headline: 'Share buyback programme: transactions in week 45',
    body: `Northwind Energy plc has bought own shares under the programme announced on 2 February 2026, as set out below.${CONTACT}`,
    metadata: {
      language: 'en', programme: 'Share buyback 2026', periodFrom: day(4), periodTo: day(1), sharesBought: 12000, averagePrice: 118.4,
      currency: 'DKK', cumulativeShares: 96000, authorisedMaximum: 500000,
    },
  })),
  general_meeting: (now) => ex(now, ({ inDays }) => ({
    headline: 'Notice of annual general meeting',
    body: `The Board of Directors of Northwind Energy plc convenes the annual general meeting. The notice, the agenda and the proxy form are available on the Company's website.${CONTACT}`,
    metadata: { language: 'en', meetingType: 'annual', meetingDate: inDays(28), venue: 'Copenhagen, Bella Center' },
  })),
} satisfies Record<string, (now: Date) => CategoryExample>;
