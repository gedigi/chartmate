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
    expect(setCookie).toMatch(/^chartmate_session=v1\.\d+\./);
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
    expect((await t.app.inject({ method: 'GET', url: barsUrl, headers: { cookie: 'chartmate_session=1' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: barsUrl, headers: { cookie: cookie.replace(/.$/, 'x') } })).statusCode).toBe(401);

    const out = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/^chartmate_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('marks the cookie Secure behind an https proxy (trustProxy on)', async () => {
    t = await makeApp({ password: 'hunter2', trustProxy: true });
    const ok = await t.app.inject({
      method: 'POST', url: '/api/login', payload: { password: 'hunter2' }, headers: { 'x-forwarded-proto': 'https' },
    });
    expect(ok.statusCode).toBe(204);
    expect(String(ok.headers['set-cookie'])).toMatch(/Secure/);
  });

  it('ignores X-Forwarded-Proto when trustProxy is off', async () => {
    t = await makeApp({ password: 'hunter2', trustProxy: false });
    const ok = await t.app.inject({
      method: 'POST', url: '/api/login', payload: { password: 'hunter2' }, headers: { 'x-forwarded-proto': 'https' },
    });
    expect(String(ok.headers['set-cookie'])).not.toMatch(/Secure/);
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
    dir = mkdtempSync(join(tmpdir(), 'chartmate-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Chartmate</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    t = await makeApp({ webDist: dir, password: 'hunter2' });

    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Chartmate</title>');

    const asset = await t.app.inject({ method: 'GET', url: '/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');

    const deep = await t.app.inject({ method: 'GET', url: '/baskets/abc' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    expect(deep.body).toContain('<title>Chartmate</title>');

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

async function loginCookie(t: TestApp, headers: Record<string, string> = {}): Promise<string> {
  const ok = await t.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' }, headers });
  expect(ok.statusCode).toBe(204);
  return cookieHeader(ok.headers['set-cookie']);
}

describe('auth guard: encoded-path bypass regression', () => {
  let t: TestApp | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('percent-encoded /api paths are guarded and cannot write', async () => {
    t = await makeApp({ password: 'hunter2' });
    const cookie = await loginCookie(t);
    await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ['stock:AAPL'], headers: { cookie } });

    for (const url of ['/%61pi/watchlist', '/ap%69/watchlist', '/%61%70%69/watchlist', '/ap%69/baskets']) {
      const g = await t.app.inject({ method: 'GET', url });
      expect(g.statusCode, url).toBe(401);
      expect(g.json(), url).toMatchObject({ code: 'unauthorized' });
    }
    const put = await t.app.inject({ method: 'PUT', url: '/%61pi/watchlist', payload: ['crypto:BTC'] });
    expect(put.statusCode).toBe(401);
    const post = await t.app.inject({ method: 'POST', url: '/ap%69/baskets', payload: { name: 'x', versions: [] } });
    expect(post.statusCode).toBe(401);

    const wl = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie } });
    expect(wl.json()).toEqual([{ type: 'symbol', id: 'stock:AAPL' }]);
    expect((await t.app.inject({ method: 'GET', url: '/api/baskets', headers: { cookie } })).json()).toEqual([]);
  });

  it('HEAD and OPTIONS on guarded routes are 401', async () => {
    t = await makeApp({ password: 'hunter2' });
    expect((await t.app.inject({ method: 'HEAD', url: '/api/watchlist' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'OPTIONS', url: '/api/watchlist' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'HEAD', url: '/%61pi/watchlist' })).statusCode).toBe(401);
  });

  it('encoded path to a public route routes to it and stays public', async () => {
    t = await makeApp({ password: 'hunter2' });
    const r = await t.app.inject({ method: 'GET', url: '/api/heal%74h' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('undecodable paths fail closed', async () => {
    t = await makeApp({ password: 'hunter2' });
    expect((await t.app.inject({ method: 'GET', url: '/api/watch%E0list' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/%E0pi/watchlist' })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/foo%E0' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('/%61pi/x is a JSON 404 (open) or 401 (auth), never index.html; SPA paths still served', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chartmate-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Chartmate</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');

    t = await makeApp({ webDist: dir });
    const open404 = await t.app.inject({ method: 'GET', url: '/%61pi/x' });
    expect(open404.statusCode).toBe(404);
    expect(open404.json()).toMatchObject({ code: 'not_found' });
    const dbl = await t.app.inject({ method: 'GET', url: '//api/x' });
    expect(dbl.statusCode).toBeGreaterThanOrEqual(400);
    expect(dbl.headers['content-type']).toMatch(/application\/json/);
    await t.close();

    t = await makeApp({ webDist: dir, password: 'hunter2' });
    const guarded = await t.app.inject({ method: 'GET', url: '/%61pi/x' });
    expect(guarded.statusCode).toBe(401);
    for (const url of ['/', '/baskets/abc', '/chart/stock:AAPL']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toContain('<title>Chartmate</title>');
    }
    expect((await t.app.inject({ method: 'GET', url: '/app.js' })).body).toBe('console.log(1)');
    expect((await t.app.inject({ method: 'GET', url: '/%61pp.js' })).statusCode).toBe(200);
  });
});

describe('login rate limiting', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  const login = (t: TestApp, password: string, ip = '10.0.0.1') =>
    t.app.inject({ method: 'POST', url: '/api/login', payload: { password }, remoteAddress: ip });

  it('allows 10 failures per IP per 15 min, then 429 until the window passes', async () => {
    let now = Date.UTC(2026, 9, 11);
    t = await makeApp({ password: 'hunter2' }, { now: () => now });
    for (let i = 0; i < 10; i++) expect((await login(t, 'wrong')).statusCode).toBe(401);
    const limited = await login(t, 'hunter2');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    // Other IPs are unaffected.
    expect((await login(t, 'hunter2', '10.0.0.2')).statusCode).toBe(204);
    now += 15 * 60_000;
    expect((await login(t, 'hunter2')).statusCode).toBe(204);
  });

  it('a successful login resets the IP counter', async () => {
    const now = Date.UTC(2026, 9, 11);
    t = await makeApp({ password: 'hunter2' }, { now: () => now });
    for (let i = 0; i < 9; i++) await login(t, 'wrong');
    expect((await login(t, 'hunter2')).statusCode).toBe(204);
    for (let i = 0; i < 9; i++) expect((await login(t, 'wrong')).statusCode).toBe(401);
    expect((await login(t, 'hunter2')).statusCode).toBe(204);
  });

  it('caps failures globally at 100 per 15 min', async () => {
    let now = Date.UTC(2026, 9, 11);
    t = await makeApp({ password: 'hunter2' }, { now: () => now });
    for (let i = 0; i < 100; i++) expect((await login(t, 'wrong', `10.1.${Math.floor(i / 5)}.${i % 5}`)).statusCode).toBe(401);
    const r = await login(t, 'hunter2', '192.168.1.1');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: 'rate_limited' });
    now += 15 * 60_000;
    expect((await login(t, 'hunter2', '192.168.1.1')).statusCode).toBe(204);
  });
});

describe('session expiry and logout', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('rejects cookies older than 30 days', async () => {
    let now = Date.UTC(2026, 9, 11);
    t = await makeApp({ password: 'hunter2' }, { now: () => now });
    const cookie = await loginCookie(t);
    now += 29 * DAY;
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie } })).statusCode).toBe(200);
    now += 2 * DAY; // 31 days after issue
    const r = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie } });
    expect(r.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json())
      .toEqual({ authRequired: true, authenticated: false });
  });

  it('rejects validly signed cookies with a malformed value', async () => {
    t = await makeApp({ password: 'hunter2' });
    for (const value of ['1', 'v1.', 'v1.abc', 'v2.123', `v1.${Date.now()}x`]) {
      const signed = t.app.signCookie(value);
      const r = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie: `chartmate_session=${encodeURIComponent(signed)}` } });
      expect(r.statusCode, value).toBe(401);
    }
    const good = t.app.signCookie(`v1.${Date.now()}`);
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie: `chartmate_session=${encodeURIComponent(good)}` } })).statusCode).toBe(200);
  });

  it('logout is public and always clears the cookie', async () => {
    t = await makeApp({ password: 'hunter2' });
    for (const headers of [{}, { cookie: 'chartmate_session=garbage' }]) {
      const r = await t.app.inject({ method: 'POST', url: '/api/logout', headers });
      expect(r.statusCode).toBe(204);
      expect(String(r.headers['set-cookie'])).toMatch(/^chartmate_session=;/);
    }
  });

  it('accepts the pre-rename altv_session cookie and replaces it on the next login/logout', async () => {
    t = await makeApp({ password: 'hunter2' });
    const legacy = `altv_session=${encodeURIComponent(t.app.signCookie(`v1.${Date.now()}`))}`;
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie: legacy } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: legacy } })).json())
      .toEqual({ authRequired: true, authenticated: true });
    // Unsigned legacy cookies are rejected like any other.
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: { cookie: 'altv_session=v1.1' } })).statusCode).toBe(401);

    const login = await t.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' }, headers: { cookie: legacy } });
    const set = ([] as string[]).concat(login.headers['set-cookie'] as string | string[]);
    expect(set.some((c) => /^chartmate_session=v1\./.test(c))).toBe(true);
    expect(set.some((c) => /^altv_session=;/.test(c))).toBe(true);

    const out = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: legacy } });
    const cleared = ([] as string[]).concat(out.headers['set-cookie'] as string | string[]);
    expect(cleared.some((c) => /^chartmate_session=;/.test(c))).toBe(true);
    expect(cleared.some((c) => /^altv_session=;/.test(c))).toBe(true);
  });
});
