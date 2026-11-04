import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { makeEnv } from './helpers.js';

describe('web bundle served by the API', () => {
  it('serves files, falls back to index.html for screens, and keeps the /api 404 as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>hub</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const env = await makeEnv({ env: { WEB_DIST: dir } });
    const app = await buildApp(env.rt);
    try {
      const asset = await app.inject({ method: 'GET', url: '/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe('console.log(1)');

      const screen = await app.inject({ method: 'GET', url: '/announcements/123' });
      expect(screen.statusCode).toBe(200);
      expect(screen.body).toContain('<title>hub</title>');

      const missing = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('NOT_FOUND');
    } finally {
      await app.close();
      await env.close();
    }
  });
});
