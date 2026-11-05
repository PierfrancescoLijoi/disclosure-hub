/**
 * Walks one announcement per jurisdiction from draft to published against a running server,
 * through the public REST API only, and prints the final state of each.
 *   npm run demo                      (server on http://localhost:3000)
 *   BASE_URL=http://host:3000 npm run demo
 */
import { call } from './cli-auth.js';



const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const CONTACT = 'Enquiries: Investor Relations, ir@northwind.example.';

const flows = [
  {
    title: 'UK  RNS  inside information (UK MAR Art. 17)',
    draft: {
      jurisdiction: 'UK',
      category: 'inside_information',
      headline: 'Trading update and upgrade to full-year guidance',
      body: `Northwind Energy plc provides a trading update: revenue and adjusted EBITDA are ahead of the Board's expectations and guidance is raised.\n${CONTACT}`,
      metadata: {
        informationBecameKnownAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        personResponsible: { name: 'Bob Chen', title: 'Company Secretary' },
      },
    },
    approvers: ['bob', 'carol'],
  },
  {
    title: 'US  EDGAR  Form 8-K Item 2.02 (earnings)',
    draft: {
      jurisdiction: 'US',
      category: 'form_8k',
      headline: 'Northwind Energy reports third quarter 2026 results',
      body: `Northwind Energy plc (NWEY) reported third quarter revenue up 8% year on year.\n${CONTACT}`,
      metadata: { eventDate: day(1), items: ['2.02'], exhibit99_1: true, signatory: { name: 'Carol Diaz', title: 'General Counsel' } },
    },
    approvers: ['bob', 'carol', 'dan'],
  },
  {
    title: 'DK  Nasdaq Copenhagen  inside information (EU MAR Art. 17), in Danish',
    draft: {
      jurisdiction: 'DK',
      category: 'inside_information',
      headline: 'Opjustering af forventningerne til regnskabsåret 2026',
      body: `Northwind Energy plc opjusterer forventningerne til året: omsætning og justeret EBITDA ligger over bestyrelsens forventninger.
${CONTACT}`,
      metadata: {
        language: 'da',
        informationBecameKnownAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        personResponsible: { name: 'Bob Chen', title: 'Company Secretary' },
      },
    },
    approvers: ['bob', 'carol'],
  },
];

async function waitPublished(id: string) {
  for (let i = 0; i < 120; i++) {
    const v = await call('erin', 'GET', `/announcements/${id}`);
    if (['published', 'failed'].includes(v.announcement.status)) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for publication');
}

for (const flow of flows) {
  console.log(`\n== ${flow.title}`);
  const created = await call('alice', 'POST', '/announcements', flow.draft);
  const id = created.announcement.id as string;
  console.log(`alice   created draft ${id.slice(0, 8)}`);

  const v = await call('alice', 'POST', `/announcements/${id}/validate`);
  console.log(`alice   validated: ok=${v.ok} warnings=${v.report.issues.length}`);
  const s = await call('alice', 'POST', `/announcements/${id}/submit`);
  const req = s.view.announcement.approvalRequirement;
  console.log(`alice   submitted; policy needs ${req.min} approvers incl. [${req.mustInclude.join(', ')}]`);

  for (const who of flow.approvers) {
    const a = await call(who, 'POST', `/announcements/${id}/approve`, { comment: 'Approved' });
    console.log(`${who.padEnd(7)} approved -> ${a.status}${a.complete ? ' (requirement met)' : ''}`);
  }

  await call('erin', 'POST', `/announcements/${id}/publish`);
  console.log('erin    requested publication; worker is sending...');
  const done = await waitPublished(id);
  const audit = await call('alice', 'GET', `/announcements/${id}/audit`);
  console.log(`result  status=${done.announcement.status} ack=${done.publication?.externalRef} filingDate=${done.publication?.ack?.filingDate ?? '-'}`);
  console.log(`audit   ${audit.events.length} events, hash chain ${audit.chain.ok ? 'verified' : 'BROKEN'}: ${audit.events.map((e: any) => e.type).join(' > ')}`);
  if (done.announcement.status !== 'published') process.exitCode = 1;
}
console.log(process.exitCode ? '\nDemo finished with failures.' : '\nAll three jurisdictions published.');
