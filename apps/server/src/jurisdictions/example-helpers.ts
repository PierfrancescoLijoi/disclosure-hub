import type { CategoryExample } from '../domain/policy.js';

/** Relative dates for sample content, computed from the clock the server runs on. */
export interface Rel {
  day(back: number): string;
  inDays(n: number): string;
  minutesAgo(m: number): string;
}

export const CONTACT = `

Enquiries: Investor Relations, ir@northwind.example, +44 20 7946 0000.`;

export const ex = (now: Date, build: (rel: Rel) => CategoryExample): CategoryExample =>
  build({
    day: (back) => new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10),
    inDays: (n) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10),
    minutesAgo: (m) => new Date(now.getTime() - m * 60_000).toISOString(),
  });
