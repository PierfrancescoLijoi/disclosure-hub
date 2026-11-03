/** One-click sample content so a reviewer can walk the flow without typing. */
interface Example {
  headline: string;
  body: string;
  metadata: Record<string, unknown>;
}

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const CONTACT = '\n\nEnquiries: Investor Relations, ir@northwind.example, +44 20 7946 0000.';

export const EXAMPLES: Record<string, () => Example> = {
  'UK.general': () => ({
    headline: 'Notice of Annual General Meeting',
    body: `Northwind Energy plc announces that its Annual General Meeting will be held on 12 December 2026 at the Company's registered office. The Notice of AGM and the proxy form have been posted to shareholders and are available on the Company website.${CONTACT}`,
    metadata: {},
  }),
  'UK.inside_information': () => ({
    headline: 'Trading update and upgrade to full-year guidance',
    body: `Northwind Energy plc today provides a trading update for the ten months to 31 October 2026. Revenue and adjusted EBITDA are ahead of the Board's expectations and full-year guidance is raised accordingly.${CONTACT}`,
    metadata: { informationBecameKnownAt: minutesAgo(10), personResponsible: { name: 'Bob Chen', title: 'Company Secretary' } },
  }),
  'UK.pdmr_dealing': () => ({
    headline: 'Director/PDMR Shareholding',
    body: `Northwind Energy plc was notified that Dan Okafor, Chief Financial Officer, purchased ordinary shares of 1p each in the Company.${CONTACT}`,
    metadata: {
      pdmrName: 'Dan Okafor', position: 'Chief Financial Officer', instrument: 'Ordinary shares of 1p each', isin: 'GB0007980591',
      transactionType: 'acquisition', price: 4.21, currency: 'GBP', volume: 5000, transactionDate: day(1), venue: 'XLON', notifiedAt: day(1),
    },
  }),
  'UK.results': () => ({
    headline: 'Half-year results for the six months ended 30 June 2026',
    body: `Northwind Energy plc announces its unaudited results for the six months ended 30 June 2026. Revenue grew 8% and the interim dividend is maintained.${CONTACT}`,
    metadata: { periodType: 'interim', periodEnd: '2026-06-30' },
  }),
  'US.form_8k': () => ({
    headline: 'Northwind Energy reports third quarter 2026 results',
    body: `Northwind Energy plc (NWEY) today reported results for the third quarter ended 30 September 2026, with revenue up 8% year on year and operating margin of 14%.${CONTACT}`,
    metadata: { eventDate: day(1), items: ['2.02'], exhibit99_1: true, signatory: { name: 'Carol Diaz', title: 'General Counsel' } },
  }),
};
