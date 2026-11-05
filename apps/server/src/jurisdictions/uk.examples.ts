/** Sample content for the "Fill with example content" button: the policy owns it, so the UI keeps no list of jurisdictions. */
import type { CategoryExample } from '../domain/policy.js';
import { CONTACT, ex } from './example-helpers.js';

export const ukExamples = {
  general: (now) => ex(now, () => ({
    headline: 'Notice of Annual General Meeting',
    body: `Northwind Energy plc announces that its Annual General Meeting will be held on 12 December 2026 at the Company's registered office. The Notice of AGM and the proxy form have been posted to shareholders and are available on the Company website.${CONTACT}`,
    metadata: {},
  })),
  inside_information: (now) => ex(now, ({ minutesAgo }) => ({
    headline: 'Trading update and upgrade to full-year guidance',
    body: `Northwind Energy plc today provides a trading update for the ten months to 31 October 2026. Revenue and adjusted EBITDA are ahead of the Board's expectations and full-year guidance is raised accordingly.${CONTACT}`,
    metadata: { informationBecameKnownAt: minutesAgo(10), personResponsible: { name: 'Bob Chen', title: 'Company Secretary' } },
  })),
  pdmr_dealing: (now) => ex(now, ({ day }) => ({
    headline: 'Director/PDMR Shareholding',
    body: `Northwind Energy plc was notified that Dan Okafor, Chief Financial Officer, purchased ordinary shares of 1p each in the Company.${CONTACT}`,
    metadata: {
      pdmrName: 'Dan Okafor', position: 'Chief Financial Officer', instrument: 'Ordinary shares of 1p each', isin: 'GB0007980591',
      transactionType: 'acquisition', price: 4.21, currency: 'GBP', volume: 5000, transactionDate: day(1), venue: 'XLON', notifiedAt: day(1),
    },
  })),
  results: (now) => ex(now, () => ({
    headline: 'Half-year results for the six months ended 30 June 2026',
    body: `Northwind Energy plc announces its unaudited results for the six months ended 30 June 2026. Revenue grew 8% and the interim dividend is maintained.${CONTACT}`,
    metadata: { periodType: 'interim', periodEnd: '2026-06-30' },
  })),
} satisfies Record<string, (now: Date) => CategoryExample>;
