import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Confirmation, unsubscribe and webhook-signing secrets are derived from one key and the
 * subscription id, so nothing secret is stored per reader and a token cannot be guessed.
 */
export type TokenPurpose = 'confirm' | 'unsubscribe';

const mac = (key: string, data: string) => createHmac('sha256', key).update(data).digest('base64url');

/** `expiresAt` in epoch milliseconds; 0 means the token never expires (unsubscribe links must keep working). */
export function signToken(key: string, purpose: TokenPurpose, subscriptionId: string, expiresAt = 0): string {
  return `${subscriptionId}.${expiresAt}.${mac(key, `${purpose}.${subscriptionId}.${expiresAt}`)}`;
}

/** The subscription id when the token is genuine and not expired, otherwise null. */
export function verifyToken(key: string, purpose: TokenPurpose, token: string, nowMs: number): string | null {
  const [id, exp, sig, ...rest] = token.split('.');
  if (!id || !exp || !sig || rest.length > 0 || !/^\d+$/.test(exp)) return null;
  const expected = Buffer.from(mac(key, `${purpose}.${id}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = Number(exp);
  return expiresAt !== 0 && expiresAt < nowMs ? null : id;
}

/** The key a webhook receiver verifies signatures with; delivered in the confirmation request body (`signingSecret`). */
export const webhookSecret = (key: string, subscriptionId: string): string =>
  createHmac('sha256', key).update(`webhook.${subscriptionId}`).digest('hex');
