import { createHash } from 'node:crypto';
import type { PublicItem } from '../../ports/index.js';

const XML_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
// Control characters other than tab, newline and carriage return are not allowed in XML 1.0 even escaped: one in a headline would break the whole feed.
const escapeXml = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]!);

export interface AtomFeed {
  xml: string;
  etag: string;
  lastModified: string;
}

/** Atom 1.0 for readers and feed readers. Only what the public page already shows: no people, no metadata. */
export function buildAtom(opts: { title: string; selfUrl: string; baseUrl: string; items: PublicItem[] }): AtomFeed {
  const updated = opts.items[0]?.publishedAt ?? '1970-01-01T00:00:00.000Z';
  const entries = opts.items.map((i) => {
    const link = `${opts.baseUrl}/public/announcements/${i.id}`;
    return [
      '  <entry>',
      `    <id>urn:disclosure-hub:announcement:${escapeXml(i.id)}</id>`,
      `    <title>${escapeXml(i.headline)}</title>`,
      `    <updated>${escapeXml(i.publishedAt)}</updated>`,
      `    <link rel="alternate" href="${escapeXml(link)}"/>`,
      `    <author><name>${escapeXml(i.issuerName)}</name></author>`,
      `    <category term="${escapeXml(i.jurisdiction)}"/>`,
      `    <category term="${escapeXml(i.category)}"/>`,
      `    <summary>${escapeXml(i.excerpt)}</summary>`,
      '  </entry>',
    ].join('\n');
  });
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(opts.selfUrl)}</id>`,
    `  <title>${escapeXml(opts.title)}</title>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    `  <link rel="self" href="${escapeXml(opts.selfUrl)}"/>`,
    ...entries,
    '</feed>',
  ].join('\n');
  return { xml, etag: `"${createHash('sha256').update(xml).digest('hex').slice(0, 32)}"`, lastModified: new Date(updated).toUTCString() };
}
