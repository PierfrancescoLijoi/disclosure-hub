/** Civil dates ("YYYY-MM-DD") keep business-day maths free of timezone drift. */
export type CivilDate = string;

export interface Calendar {
  holidays: ReadonlySet<CivilDate>;
}

/** Local opening hours on business days, "HH:MM" in the policy timezone. */
export interface OpeningWindow {
  open: string;
  close: string;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsOf(date: Date, tz: string): Parts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function civilOf(date: Date, tz: string): CivilDate {
  const p = partsOf(date, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function minutesOfDay(date: Date, tz: string): number {
  const p = partsOf(date, tz);
  return p.h * 60 + p.mi;
}

/** Instant at which the wall clock in `tz` reads civil date + HH:MM. */
export function zonedToUtc(civil: CivilDate, hhmm: string, tz: string): Date {
  const [y, mo, d] = civil.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const p = partsOf(new Date(t), tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - t;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

const weekday = (civil: CivilDate): number => new Date(`${civil}T00:00:00Z`).getUTCDay();

export function isBusinessDay(civil: CivilDate, cal: Calendar): boolean {
  const wd = weekday(civil);
  return wd !== 0 && wd !== 6 && !cal.holidays.has(civil);
}

function shift(civil: CivilDate, days: number): CivilDate {
  const d = new Date(`${civil}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addBusinessDays(civil: CivilDate, n: number, cal: Calendar): CivilDate {
  let cur = civil;
  let left = n;
  while (left > 0) {
    cur = shift(cur, 1);
    if (isBusinessDay(cur, cal)) left--;
  }
  return cur;
}

export function nextBusinessDay(civil: CivilDate, cal: Calendar): CivilDate {
  return addBusinessDays(civil, 1, cal);
}

export interface WindowStatus {
  open: boolean;
  /** Next instant the window opens; null when already open. */
  nextOpenAt: Date | null;
}

export function windowStatus(now: Date, tz: string, window: OpeningWindow, cal: Calendar): WindowStatus {
  const today = civilOf(now, tz);
  const mins = minutesOfDay(now, tz);
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const businessToday = isBusinessDay(today, cal);
  if (businessToday && mins >= toMin(window.open) && mins < toMin(window.close)) {
    return { open: true, nextOpenAt: null };
  }
  const openDay = businessToday && mins < toMin(window.open) ? today : nextBusinessDay(today, cal);
  return { open: false, nextOpenAt: zonedToUtc(openDay, window.open, tz) };
}
