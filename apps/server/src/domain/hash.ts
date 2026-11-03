import { createHash } from 'node:crypto';
import type { AuditEvent } from './types.js';

export const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

/** JSON with sorted keys so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contentHash(input: {
  jurisdiction: string;
  category: string;
  headline: string;
  body: string;
  metadata: Record<string, unknown>;
}): string {
  return sha256Hex(canonicalJson(input));
}

export const GENESIS_HASH = '0'.repeat(64);

export function auditHash(
  prevHash: string,
  event: { announcementId: string; seq: number; type: string; actorId: string; at: string; data: unknown },
): string {
  return sha256Hex(`${prevHash}|${canonicalJson(event)}`);
}

/** Recomputes the whole chain; reports the first event whose link or content does not match. */
export function verifyAuditChain(events: AuditEvent[]): { ok: true } | { ok: false; brokenAtSeq: number } {
  let prev = GENESIS_HASH;
  for (const [i, e] of events.entries()) {
    const { announcementId, seq, type, actorId, at, data } = e;
    const expected = auditHash(prev, { announcementId, seq, type, actorId, at, data });
    if (e.seq !== i + 1 || e.prevHash !== prev || e.hash !== expected) return { ok: false, brokenAtSeq: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}
