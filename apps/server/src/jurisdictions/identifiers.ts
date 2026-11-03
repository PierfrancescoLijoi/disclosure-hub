/** Identifier checksums shared by policies and mock gateways. */

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** ISO 17442 LEI: mod-97-10 over the letters-as-numbers string must equal 1. */
export function isValidLei(lei: string): boolean {
  if (!LEI_RE.test(lei)) return false;
  let rem = 0;
  for (const ch of lei) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem === 1;
}

/** Appends the two ISO 7064 check digits to an 18-character base (used for seed data and tests). */
export function makeLei(base18: string): string {
  let rem = 0;
  for (const ch of `${base18}00`) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return `${base18}${String(98 - rem).padStart(2, '0')}`;
}

/** ISO 6166 ISIN: letters expand to two digits, then Luhn over the digit string. */
export function isValidIsin(isin: string): boolean {
  if (!ISIN_RE.test(isin)) return false;
  const digits = [...isin].map((c) => (c >= 'A' ? String(c.charCodeAt(0) - 55) : c)).join('');
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const isValidTidm = (s: string) => /^[A-Z0-9]{2,5}$/.test(s);
export const isValidCik = (s: string) => /^\d{10}$/.test(s);
/** EDGAR CIK Confirmation Code: 8 characters. */
export const isValidCcc = (s: string) => /^[A-Za-z0-9@#$*]{8}$/.test(s);
