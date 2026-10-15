import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_SECURITY_POLICY } from '../../src/securityHeaders.js';
import { makeApp, type TestApp } from '../routes/helpers.js';

describe('security headers and static caching', () => {
  let t: TestApp;
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chartmate-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'theme-init.js'), 'void 0');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), '[core]');
    t = await makeApp({ webDist: dir });
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = (url: string) => t.app.inject({ method: 'GET', url });

  const expectPageHeaders = (h: Record<string, unknown>) => {
    expect(h['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
  };

  it('the CSP allows only same-origin resources, no inline code, no framing', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("style-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-/);
  });

  it('pages and static files carry the security headers; index.html is never cached', async () => {
    for (const url of ['/', '/index.html', '/baskets/x']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expectPageHeaders(r.headers);
      expect(r.headers['cache-control'], url).toBe('no-cache');
    }
    const theme = await get('/theme-init.js');
    expectPageHeaders(theme.headers);
    expect(theme.headers['cache-control']).toBe('no-cache');
  });

  it('hashed assets are cached for a year as immutable', async () => {
    const r = await get('/assets/index-abc123.js');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expectPageHeaders(r.headers);
  });

  it('a missing asset or file-like path is a 404, not the SPA page', async () => {
    for (const url of ['/assets/index-old.js', '/assets/x', '/missing.png', '/foo/bar.css']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain('<title>app</title>');
      expect(r.headers['cache-control'], url).toBe('no-cache');
      expectPageHeaders(r.headers);
    }
  });

  it('dotfiles are never served', async () => {
    for (const url of ['/.env', '/.git/config', '/assets/../.env']) {
      const r = await get(url);
      expect(r.statusCode, url).not.toBe(200);
      expect(r.body, url).not.toContain('SECRET');
      expect(r.body, url).not.toContain('[core]');
    }
  });

  it('API responses get nosniff, no-referrer and no-store, but no page policy', async () => {
    for (const url of ['/api/health', '/api/nope']) {
      const r = await get(url);
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
      expect(r.headers['referrer-policy'], url).toBe('no-referrer');
      expect(r.headers['content-security-policy'], url).toBeUndefined();
      expect(r.headers['cache-control'], url).toBe('no-store'); // market data and user data are never cached
    }
  });
});
