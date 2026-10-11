import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DAY, makeApp, type TestApp } from './helpers.js';

function cookieHeader(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return raw.split(';')[0]!;
}

describe('auth', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('everything is open without a password', async () => {
    t = await makeApp();
    const s = await t.app.inject({ method: 'GET', url: '/api/session' });
    expect(s.json()).toEqual({ authRequired: false, authenticated: true });
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).statusCode).toBe(200);
  });

  it('password-protects the API with a signed session cookie', async () => {
    t = await makeApp({ password: 'hunter2' });
    const to = Date.now();
    const barsUrl = `/api/bars?symbol=crypto:BTC&tf=1h&session=eth&from=${to - DAY}&to=${to}`;

    const denied = await t.app.inject({ method: 'GET', url: barsUrl });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: 'unauthorized' });

    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/session' })).json()).toEqual({ authRequired: true, authenticated: false });

    const wrong = await t.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'unauthorized' });
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await t.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
    expect(ok.statusCode).toBe(204);
    const setCookie = String(ok.headers['set-cookie']);
    expect(setCookie).toMatch(/^altv_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    expect(setCookie).not.toMatch(/Secure/);
    const cookie = cookieHeader(ok.headers['set-cookie']);

    const allowed = await t.app.inject({ method: 'GET', url: barsUrl, headers: { cookie } });
    expect(allowed.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json())
      .toEqual({ authRequired: true, authenticated: true });

    // Tampered / unsigned cookies are rejected.
    expect((await t.app.inject({ method: 'GET', url: barsUrl, headers: { cookie: 'altv_session=1' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: barsUrl, headers: { cookie: cookie.replace(/.$/, 'x') } })).statusCode).toBe(401);

    const out = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/^altv_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('marks the cookie Secure behind an https proxy', async () => {
    t = await makeApp({ password: 'hunter2' });
    const ok = await t.app.inject({
      method: 'POST', url: '/api/login', payload: { password: 'hunter2' }, headers: { 'x-forwarded-proto': 'https' },
    });
    expect(ok.statusCode).toBe(204);
    expect(String(ok.headers['set-cookie'])).toMatch(/Secure/);
  });

  it('rejects malformed login bodies', async () => {
    t = await makeApp({ password: 'hunter2' });
    const r = await t.app.inject({ method: 'POST', url: '/api/login', payload: { pw: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invalid_request' });
  });
});

describe('SPA static serving', () => {
  let t: TestApp | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('serves files, falls back to index.html for non-api paths, JSON 404 for /api', async () => {
    dir = mkdtempSync(join(tmpdir(), 'altv-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>altv</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    t = await makeApp({ webDist: dir, password: 'hunter2' });

    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>altv</title>');

    const asset = await t.app.inject({ method: 'GET', url: '/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');

    const deep = await t.app.inject({ method: 'GET', url: '/baskets/abc' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    expect(deep.body).toContain('<title>altv</title>');

    // With auth on, unknown /api paths are guarded like the rest of the API.
    const guarded = await t.app.inject({ method: 'GET', url: '/api/x' });
    expect(guarded.statusCode).toBe(401);
    await t.close();

    t = await makeApp({ webDist: dir });
    const api = await t.app.inject({ method: 'GET', url: '/api/x' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/application\/json/);
    expect(api.json()).toMatchObject({ code: 'not_found' });

    const post = await t.app.inject({ method: 'POST', url: '/somewhere' });
    expect(post.statusCode).toBe(404);
  });
});
