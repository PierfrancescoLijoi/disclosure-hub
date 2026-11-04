import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookChannel } from '../src/adapters/channels/index.js';
import { isPrivateAddress } from '../src/adapters/channels/url-guard.js';
import { buildAtom } from '../src/application/readers/feed.js';
import { signToken, verifyToken, webhookSecret } from '../src/application/readers/tokens.js';
import { parseWebhookUrl } from '../src/application/readers/webhook-url.js';
import { ChannelError, ChannelRegistry, type NotificationChannel, type OutboundMessage, type PublicItem } from '../src/ports/index.js';
import { FakeClock, fx, makeEnv, publishAnnouncement, type Env } from './helpers.js';

let env: Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

class FakeEmail implements NotificationChannel {
  readonly kind = 'email' as const;
  readonly name = 'fake';
  sent: OutboundMessage[] = [];
  failures: ('transient' | 'permanent')[] = [];
  async send(msg: OutboundMessage) {
    const fail = this.failures.shift();
    if (fail) throw new ChannelError(fail, `simulated ${fail} failure`);
    this.sent.push(msg);
  }
  to(address: string) {
    return this.sent.filter((m) => m.to === address);
  }
}

const tokenIn = (m: OutboundMessage) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text)![1]!);

async function start(over: Parameters<typeof makeEnv>[0] = {}) {
  const email = new FakeEmail();
  env = await makeEnv({ channels: new ChannelRegistry().register(email), ...over });
  return { email, e: env, readers: env.rt.subscriptions };
}

/** Follows and confirms through the same two steps a reader goes through. */
async function follow(email: FakeEmail, readers: Env['rt']['subscriptions'], address: string, filters: { issuerId?: string; jurisdiction?: string; category?: string } = {}) {
  await readers.follow({ kind: 'email', target: address, ...filters });
  const confirmation = email.to(address.toLowerCase()).at(-1)!;
  await readers.confirm(tokenIn(confirmation));
}

describe('following announcements by email', () => {
  it('tells a confirmed reader once when something is published, with a link and a way out', async () => {
    const { email, e, readers } = await start();
    await follow(email, readers, 'Reader@Example.com');
    const confirmation = email.to('reader@example.com')[0]!;
    expect(confirmation.subject).toMatch(/Confirm/);
    expect(confirmation.unsubscribeUrl).toContain('/api/public/subscriptions/unsubscribe?token=');

    const id = await publishAnnouncement(e);
    const news = email.to('reader@example.com').filter((m) => m.subject.startsWith('Northwind Energy plc:'));
    expect(news).toHaveLength(1);
    expect(news[0]!.text).toContain(`/public/announcements/${id}`);
    expect(news[0]!.text).toContain('/public/unsubscribe?token=');

    // A redelivery of the same event does not tell the reader twice.
    const event = (await e.rt.store.read.events.forAggregate(id)).find((r) => r.consumer === 'notifier' && r.event.type === 'announcement.published')!.event;
    await e.rt.consumers.get('notifier')!.handle(event);
    expect(email.to('reader@example.com').filter((m) => m.subject.startsWith('Northwind'))).toHaveLength(1);
  });

  it('sends nothing before the address is confirmed', async () => {
    const { email, e, readers } = await start();
    await readers.follow({ kind: 'email', target: 'unconfirmed@example.com' });
    await publishAnnouncement(e);
    expect(email.to('unconfirmed@example.com')).toHaveLength(1); // only the confirmation request
  });

  it('delivers by the filters the reader chose', async () => {
    const { email, e, readers } = await start();
    await follow(email, readers, 'all@example.com');
    await follow(email, readers, 'northwind@example.com', { issuerId: 'northwind' });
    await follow(email, readers, 'contoso@example.com', { issuerId: 'contoso' });
    await follow(email, readers, 'inside@example.com', { jurisdiction: 'UK', category: 'inside_information' });
    await follow(email, readers, 'us@example.com', { jurisdiction: 'US' });

    await publishAnnouncement(e, fx.ukGeneral());
    const news = (a: string) => email.to(a).filter((m) => !m.subject.startsWith('Confirm')).length;
    expect([news('all@example.com'), news('northwind@example.com'), news('contoso@example.com'), news('inside@example.com'), news('us@example.com')]).toEqual([1, 1, 0, 0, 0]);
  });

  it('stops for good when the reader unsubscribes, and erases the address', async () => {
    const { email, e, readers } = await start();
    await follow(email, readers, 'leaver@example.com');
    const unsubscribeUrl = email.to('leaver@example.com')[0]!.unsubscribeUrl;
    const token = decodeURIComponent(new URL(unsubscribeUrl).searchParams.get('token')!);
    await readers.unsubscribe(token);
    await readers.unsubscribe(token); // leaving twice is fine

    await publishAnnouncement(e);
    expect(email.to('leaver@example.com')).toHaveLength(1);
    const row = await e.rt.db.selectFrom('subscriptions').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('unsubscribed');
    expect(row.target).toMatch(/^erased:[0-9a-f]{16}$/);
  });

  it('rejects forged, swapped and expired links', async () => {
    const clock = new FakeClock(new Date('2026-11-03T10:00:00Z'));
    const { email, readers } = await start({ clock });
    await readers.follow({ kind: 'email', target: 'a@example.com' });
    const confirm = tokenIn(email.to('a@example.com')[0]!);
    await expect(readers.confirm(`${confirm}x`)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    await expect(readers.unsubscribe(confirm)).rejects.toMatchObject({ code: 'INVALID_TOKEN' }); // a confirm link is not an unsubscribe link
    clock.advance(49 * 3_600_000);
    await expect(readers.confirm(confirm)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('answers the same whether or not an address is known or over its limit, and caps abuse per address', async () => {
    const { email, e, readers } = await start();
    for (let i = 0; i < 12; i++) await expect(readers.follow({ kind: 'email', target: 'busy@example.com' })).resolves.toBeUndefined();
    expect(email.to('busy@example.com')).toHaveLength(10);
    const rows = await e.rt.db.selectFrom('subscriptions').select('id').execute();
    expect(rows).toHaveLength(10);
  });

  it('tells a large audience in chunks, each handled by its own delivery, so nobody is told twice or left out', async () => {
    const { email, e, readers } = await start({ env: { NOTIFY_CHUNK: '2' } });
    const people = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}@example.com`);
    for (const p of people) await follow(email, readers, p);
    await publishAnnouncement(e);
    for (const p of people) expect(email.to(p).filter((m) => m.subject.startsWith('Northwind Energy plc:')), p).toHaveLength(1);
    const continuations = await e.rt.db.selectFrom('domain_events').select('id').where('type', '=', 'reader.notify.continue').execute();
    expect(continuations).toHaveLength(2); // 5 followers in chunks of 2, 2 and 1: a continuation after each full chunk
    const open = await e.rt.db.selectFrom('event_deliveries').select('status').where('consumer', '=', 'notifier').execute();
    expect(open.every((r) => r.status === 'done')).toBe(true);
  });

  it('keeps going past a follower that keeps failing: the next chunk is queued once, however often the first is retried', async () => {
    const { email, e, readers } = await start({ env: { NOTIFY_CHUNK: '2' } });
    const people = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}@example.com`);
    for (const p of people) await follow(email, readers, p);
    const before = email.sent.length;
    email.failures.push('transient'); // one send in the first chunk fails once and is retried
    await publishAnnouncement(e);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await e.rt.reactor.drain();
    }
    const recipients = email.sent.slice(before).map((m) => m.to).sort();
    expect(recipients).toEqual(people); // everybody once, including those behind the follower that failed
    const continuations = await e.rt.db.selectFrom('domain_events').select('id').where('type', '=', 'reader.notify.continue').execute();
    expect(continuations).toHaveLength(2); // retries of the first chunk did not queue it again
  });

  it('accepts a bare address only, so a display name or separator cannot add recipients or dodge the cap', async () => {
    const { email, readers } = await start();
    for (const target of ['Foo<victim@example.com>', 'x,victim@example.com', 'a;b@example.com', '"x"@example.com', 'victim@example.com, other@example.com']) {
      await expect(readers.follow({ kind: 'email', target }), target).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    }
    expect(email.sent).toHaveLength(0);
  });

  it('lets an address subscribe again once unconfirmed requests have expired, and purges them', async () => {
    const clock = new FakeClock(new Date('2026-11-03T10:00:00Z'));
    const { email, e, readers } = await start({ clock });
    for (let i = 0; i < 12; i++) await readers.follow({ kind: 'email', target: 'victim@example.com' });
    expect(email.to('victim@example.com')).toHaveLength(10); // an attacker filled the quota with pending requests
    clock.advance(49 * 3_600_000);
    await readers.follow({ kind: 'email', target: 'victim@example.com' });
    expect(email.to('victim@example.com')).toHaveLength(11); // the owner is not locked out
    expect(await e.rt.db.selectFrom('subscriptions').select('id').execute()).toHaveLength(1); // the expired rows are gone
  });

  it('clears stored error text when a reader leaves, since a transport error can quote the address', async () => {
    const { email, e, readers } = await start();
    await follow(email, readers, 'leaver@example.com');
    email.failures = ['permanent'];
    await publishAnnouncement(e);
    const sub = await e.rt.db.selectFrom('subscriptions').select('id').executeTakeFirstOrThrow();
    const before = await e.rt.db.selectFrom('notifications').select('last_error').where('subscription_id', '=', sub.id).executeTakeFirstOrThrow();
    expect(before.last_error).toContain('simulated permanent failure');
    await readers.unsubscribe(decodeURIComponent(/token=([^&]+)/.exec(readers.unsubscribeUrl(sub.id))![1]!));
    const after = await e.rt.db.selectFrom('notifications').select('last_error').where('subscription_id', '=', sub.id).executeTakeFirstOrThrow();
    expect(after.last_error).toBeNull();
  });

  it('validates what is followed', async () => {
    const { readers } = await start();
    await expect(readers.follow({ kind: 'email', target: 'not-an-address' })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(readers.follow({ kind: 'email', target: 'a@example.com', issuerId: 'nobody' })).rejects.toMatchObject({ status: 404 });
    await expect(readers.follow({ kind: 'email', target: 'a@example.com', jurisdiction: 'UK', category: 'bogus' })).rejects.toMatchObject({ code: 'UNKNOWN_CATEGORY' });
    await expect(readers.follow({ kind: 'email', target: 'a@example.com', category: 'general' })).rejects.toMatchObject({ code: 'CATEGORY_NEEDS_JURISDICTION' });
    await expect(readers.follow({ kind: 'webhook', target: 'https://hooks.example.com/x' })).rejects.toMatchObject({ status: 501 }); // no webhook channel here
  });

  it('retries a transient failure without telling the others twice, and records a permanent one', async () => {
    const { email, e, readers } = await start();
    await follow(email, readers, 'ok@example.com');
    await follow(email, readers, 'flaky@example.com');
    await follow(email, readers, 'gone@example.com');
    const before = email.sent.length;
    email.failures.push('transient', 'permanent'); // first two sends of the news: one retried later, one dropped

    await publishAnnouncement(e);
    await new Promise((r) => setTimeout(r, 20)); // backoff is a few milliseconds in tests
    await e.rt.reactor.drain();
    const news = email.sent.slice(before);
    const recipients = news.map((m) => m.to).sort();
    expect(new Set(recipients).size).toBe(recipients.length); // nobody twice
    expect(recipients).toHaveLength(2);
    const failed = await e.rt.db.selectFrom('notifications').selectAll().where('status', '=', 'failed').execute();
    expect(failed).toHaveLength(1);
    expect(failed[0]!.last_error).toContain('permanent');
  });
});

describe('tokens', () => {
  const key = 'k'.repeat(40);
  it('binds a token to its purpose, subscription and expiry', () => {
    const t = signToken(key, 'confirm', 'sub-1', 2000);
    expect(verifyToken(key, 'confirm', t, 1000)).toBe('sub-1');
    expect(verifyToken(key, 'confirm', t, 3000)).toBeNull();
    expect(verifyToken(key, 'unsubscribe', t, 1000)).toBeNull();
    expect(verifyToken('x'.repeat(40), 'confirm', t, 1000)).toBeNull();
    expect(verifyToken(key, 'unsubscribe', signToken(key, 'unsubscribe', 'sub-1'), Date.now() * 2)).toBe('sub-1'); // never expires
  });
});

describe('webhooks', () => {
  async function receiver(status = 200) {
    const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ headers: req.headers, body });
        res.statusCode = status;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, close: () => new Promise((r) => server.close(r)) };
  }
  const msg = (to: string): OutboundMessage => ({ to, subject: 's', text: 't', data: { type: 'announcement.published' }, unsubscribeUrl: 'https://x/u', signingSecret: 's3cret' });

  it('posts a body the receiver can verify with the secret it was given', async () => {
    const r = await receiver();
    await new WebhookChannel(true).send(msg(r.url));
    const { headers, body } = r.hits[0]!;
    const expected = createHmac('sha256', 's3cret').update(`${headers['x-hub-timestamp']}.${body}`).digest('hex');
    expect(headers['x-hub-signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(body)).toMatchObject({ type: 'announcement.published', unsubscribeUrl: 'https://x/u' });
    await r.close();
  });

  it('treats a 4xx as permanent and a 5xx as transient', async () => {
    const gone = await receiver(410);
    await expect(new WebhookChannel(true).send(msg(gone.url))).rejects.toMatchObject({ kind: 'permanent' });
    await gone.close();
    const down = await receiver(503);
    await expect(new WebhookChannel(true).send(msg(down.url))).rejects.toMatchObject({ kind: 'transient' });
    await down.close();
  });

  it('refuses to call private addresses unless the demo allows it', async () => {
    const r = await receiver();
    await expect(new WebhookChannel(false).send(msg(r.url))).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('private address') });
    expect(r.hits).toHaveLength(0);
    await r.close();
    for (const to of ['http://169.254.169.254/latest/meta-data', 'http://[::1]:9/x', 'http://2130706433/x', 'http://localhost:9/x']) {
      await expect(new WebhookChannel(false).send(msg(to)), to).rejects.toMatchObject({ kind: 'permanent' });
    }
  });

  it('hands the receiver its signing secret in the confirmation, and tells an anonymous caller nothing about why it failed', async () => {
    const calls: OutboundMessage[] = [];
    let failWith: ChannelError | undefined;
    const hook: NotificationChannel = {
      kind: 'webhook',
      name: 'fake-webhook',
      async send(m) {
        if (failWith) throw failWith;
        calls.push(m);
      },
    };
    env = await makeEnv({ channels: new ChannelRegistry().register(hook) });
    const readers = env.rt.subscriptions;
    await readers.follow({ kind: 'webhook', target: 'https://hooks.example.com/in' });
    const sub = await env.rt.db.selectFrom('subscriptions').select('id').executeTakeFirstOrThrow();
    expect(calls[0]!.data.signingSecret).toBe(webhookSecret(env.rt.config.READER_TOKEN_KEY ?? 'demo-reader-token-key-not-for-production-use', sub.id));
    expect(calls[0]!.signingSecret).toBe(calls[0]!.data.signingSecret);

    failWith = new ChannelError('permanent', 'refusing to connect to a private address (10.0.0.5)');
    const refused = await readers.follow({ kind: 'webhook', target: 'https://db.internal/x' }).catch((err: Error) => err);
    expect(refused).toMatchObject({ code: 'WEBHOOK_UNREACHABLE' });
    expect((refused as Error).message).not.toMatch(/10\.0\.0\.5|private/);
  });

  it('classifies addresses and validates webhook URLs', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '172.20.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fec0::1', '168.63.129.16']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(parseWebhookUrl('https://hooks.example.com/x', false)).not.toBeNull();
    expect(parseWebhookUrl('http://hooks.example.com/x', false)).toBeNull();
    expect(parseWebhookUrl('http://localhost:9/x', true)).not.toBeNull();
    expect(parseWebhookUrl('https://user:pw@hooks.example.com/x', false)).toBeNull();
    expect(parseWebhookUrl('ftp://hooks.example.com/x', true)).toBeNull();
  });
});

describe('public reading', () => {
  const item = (over: Partial<PublicItem> = {}): PublicItem => ({
    id: 'a1', issuerId: 'northwind', jurisdiction: 'UK', category: 'general', headline: 'Results <Q3> & more', excerpt: 'Short text', issuerName: 'Northwind Energy plc', receipt: 'RNS-1', filingDate: null, publishedAt: '2026-11-03T09:00:00.000Z', ...over,
  });

  it('builds an Atom feed that escapes markup and carries a stable validator', () => {
    const feed = buildAtom({ title: 'T', selfUrl: 'https://h/feed', baseUrl: 'https://h', items: [item()] });
    expect(feed.xml).toContain('<title>Results &lt;Q3&gt; &amp; more</title>');
    expect(feed.xml).toContain('<link rel="alternate" href="https://h/public/announcements/a1"/>');
    expect(feed.xml).toContain('<updated>2026-11-03T09:00:00.000Z</updated>');
    expect(buildAtom({ title: 'T', selfUrl: 'https://h/feed', baseUrl: 'https://h', items: [item()] }).etag).toBe(feed.etag);
    expect(buildAtom({ title: 'T', selfUrl: 'https://h/feed', baseUrl: 'https://h', items: [] }).xml).toContain('1970-01-01');
  });

  it('drops control characters that XML 1.0 forbids, so one headline cannot break the whole feed', () => {
    const feed = buildAtom({ title: 'T', selfUrl: 'https://h/feed', baseUrl: 'https://h', items: [item({ headline: 'Re\x01sults\x0b ok' })] });
    expect(feed.xml).toContain('<title>Results ok</title>');
    expect(feed.xml).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  it('filters the archive by company, category, date and any word of the text', async () => {
    env = await makeEnv({ clock: new FakeClock(new Date('2026-11-03T12:00:00Z')) });
    const e = env;
    const general = fx.ukGeneral();
    general.body = `${general.body}\nThe meeting will be held at the Harbour Hotel.`;
    await publishAnnouncement(e, general);
    await publishAnnouncement(e, fx.ukPdmr(), [e.actors.bob]);
    const ids = async (q: object) => (await e.svc.publicFeed({ limit: 20, ...q })).items.map((i) => i.category);

    expect(await ids({})).toHaveLength(2);
    const excerpt = (await e.svc.publicFeed({ limit: 20, category: 'general' })).items[0]!.excerpt;
    expect(excerpt).toBe(general.body.replace(/\s+/g, ' ').trim().slice(0, 300)); // words intact, whitespace folded
    expect(await ids({ category: 'pdmr_dealing' })).toEqual(['pdmr_dealing']);
    expect(await ids({ q: 'harbour hotel' })).toEqual(['general']); // a word from the body
    expect(await ids({ q: 'harbour spaceship' })).toEqual([]); // every word must match
    expect(await ids({ issuerId: 'contoso' })).toEqual([]);
    expect(await ids({ from: '2026-11-04' })).toEqual([]);
    expect(await ids({ from: '2026-11-03', to: '2026-11-03' })).toHaveLength(2);
    expect((await e.svc.publicIssuers()).map((i) => i.name)).toEqual(['Northwind Energy plc']);
  });
});
