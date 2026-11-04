import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createTransport } from 'nodemailer';
import { ChannelError, type Logger, type NotificationChannel, type OutboundMessage } from '../../ports/index.js';
import { guardedLookup, isPrivateAddress } from './url-guard.js';

const SEND_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAILBOX_SIZE = 200;

/** Writes the message to the log and keeps the last few in memory: the demo mailbox, no mail server needed. */
export class LogChannel implements NotificationChannel {
  readonly kind = 'email' as const;
  readonly name = 'log';
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly log: Logger) {}
  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
    if (this.sent.length > MAILBOX_SIZE) this.sent.shift();
    this.log.info({ to: msg.to, subject: msg.subject }, 'email (log transport)');
  }
}

/** SMTP: Mailpit locally, an SMTP relay or any provider elsewhere. */
export class SmtpChannel implements NotificationChannel {
  readonly kind = 'email' as const;
  readonly name = 'smtp';
  private readonly transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport({ url, connectionTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS });
  }
  async send(msg: OutboundMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      // A 5xx reply about the recipient will not improve on retry; connection trouble and 4xx will.
      throw new ChannelError(code !== undefined && code >= 500 ? 'permanent' : 'transient', (err as Error).message);
    }
  }
}

let azureCredential: { getToken(scope: string): Promise<{ token: string } | null> } | undefined;
async function entraToken(scope: string): Promise<string> {
  if (!azureCredential) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    azureCredential = new DefaultAzureCredential();
  }
  const t = await azureCredential.getToken(scope);
  if (!t) throw new Error('Could not get an Entra token');
  return t.token;
}

/** Azure Communication Services Email over REST with the app's managed identity: no key, no SMTP password. */
export class AcsEmailChannel implements NotificationChannel {
  readonly kind = 'email' as const;
  readonly name = 'acs';
  constructor(
    private readonly endpoint: string,
    private readonly from: string,
    private readonly token: () => Promise<string> = () => entraToken('https://communication.azure.com/.default'),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(msg: OutboundMessage): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint.replace(/\/$/, '')}/emails:send?api-version=2023-03-31`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.token()}` },
        body: JSON.stringify({
          senderAddress: this.from,
          recipients: { to: [{ address: msg.to }] },
          content: { subject: msg.subject, plainText: msg.text },
          headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ChannelError('transient', (err as Error).message);
    }
    if (res.ok) return; // 202: ACS accepts the message and delivers asynchronously
    const retryable = res.status === 429 || res.status >= 500;
    throw new ChannelError(retryable ? 'transient' : 'permanent', `ACS Email answered ${res.status}`);
  }
}

/** Signed HTTPS POST to a reader's endpoint. The address is validated at connect time (no private networks). */
export class WebhookChannel implements NotificationChannel {
  readonly kind = 'webhook' as const;
  readonly name = 'webhook';
  constructor(private readonly allowPrivate: boolean) {}

  send(msg: OutboundMessage): Promise<void> {
    const url = new URL(msg.to);
    // Node skips the DNS lookup for an IP literal, so the guarded lookup never sees it.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (!this.allowPrivate && isIP(literal) && isPrivateAddress(literal)) {
      return Promise.reject(new ChannelError('permanent', `refusing to connect to a private address (${literal})`));
    }
    const body = JSON.stringify({ ...msg.data, unsubscribeUrl: msg.unsubscribeUrl });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', msg.signingSecret ?? '').update(`${timestamp}.${body}`).digest('hex');
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method: 'POST',
          timeout: SEND_TIMEOUT_MS,
          lookup: guardedLookup(this.allowPrivate) as never,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'disclosure-hub-webhook/1',
            'x-hub-timestamp': timestamp,
            'x-hub-signature': `sha256=${signature}`,
          },
        },
        (res) => {
          let seen = 0;
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > MAX_RESPONSE_BYTES) req.destroy(); // never read an unbounded answer
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve();
            const retryable = status === 429 || status >= 500;
            reject(new ChannelError(retryable ? 'transient' : 'permanent', `endpoint answered ${status}`)); // redirects are not followed
          });
        },
      );
      // The socket timeout is an idle timeout: a server dripping one byte at a time never trips it, so there is a wall-clock limit too.
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), TOTAL_TIMEOUT_MS);
      req.on('close', () => clearTimeout(deadline));
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err) => reject(new ChannelError(/private address/.test(err.message) ? 'permanent' : 'transient', err.message)));
      req.end(body);
    });
  }
}
