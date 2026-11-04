import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const prod = { DEMO: '0', DATABASE_URL: 'postgres://u@h/db', QUEUE_URL: 'pg', AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp/', OIDC_AUDIENCE: 'api' };
const KEY = 'k'.repeat(32);

describe('reader and event settings', () => {
  it('needs the token key wherever readers are served or notified, but not in the publication worker', () => {
    expect(() => loadConfig({ ...prod, ROLE: 'api' })).toThrow(/READER_TOKEN_KEY/);
    expect(() => loadConfig({ ...prod, ROLE: 'events' })).toThrow(/READER_TOKEN_KEY/);
    expect(loadConfig({ ...prod, ROLE: 'worker' }).ROLE).toBe('worker');
    expect(loadConfig({ ...prod, ROLE: 'api', READER_TOKEN_KEY: KEY }).ROLE).toBe('api');
    expect(loadConfig({ ...prod, ROLE: 'api', EMAIL_TRANSPORT: 'off', WEBHOOKS: '0' }).ROLE).toBe('api'); // readers switched off
    expect(() => loadConfig({ ...prod, ROLE: 'api', READER_TOKEN_KEY: 'short' })).toThrow();
  });

  it('refuses transports without their address and private webhooks outside the demo', () => {
    expect(() => loadConfig({ ...prod, READER_TOKEN_KEY: KEY, EMAIL_TRANSPORT: 'acs' })).toThrow(/ACS_ENDPOINT/);
    expect(() => loadConfig({ ...prod, READER_TOKEN_KEY: KEY, EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_URL/);
    expect(() => loadConfig({ ...prod, READER_TOKEN_KEY: KEY, WEBHOOK_ALLOW_PRIVATE: '1' })).toThrow(/demo/);
    expect(loadConfig({ DEMO: '1', WEBHOOK_ALLOW_PRIVATE: '1' }).WEBHOOK_ALLOW_PRIVATE).toBe(true);
  });

  it('lets a process run only the consumers it names', () => {
    const c = loadConfig({ ...prod, ROLE: 'events', READER_TOKEN_KEY: KEY, REACTOR_CONSUMERS: 'notifier, agent:precheck' });
    expect(c.REACTOR_CONSUMERS.split(',').map((s) => s.trim())).toEqual(['notifier', 'agent:precheck']);
  });
});
