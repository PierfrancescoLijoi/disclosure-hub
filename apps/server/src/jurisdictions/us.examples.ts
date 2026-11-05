/** Sample content for the "Fill with example content" button: the policy owns it, so the UI keeps no list of jurisdictions. */
import type { CategoryExample } from '../domain/policy.js';
import { CONTACT, ex } from './example-helpers.js';

export const usExamples = {
  form_8k: (now) => ex(now, ({ day }) => ({
    headline: 'Northwind Energy reports third quarter 2026 results',
    body: `Northwind Energy plc (NWEY) today reported results for the third quarter ended 30 September 2026, with revenue up 8% year on year and operating margin of 14%.${CONTACT}`,
    metadata: { eventDate: day(1), items: ['2.02'], exhibit99_1: true, signatory: { name: 'Carol Diaz', title: 'General Counsel' } },
  })),
} satisfies Record<string, (now: Date) => CategoryExample>;
