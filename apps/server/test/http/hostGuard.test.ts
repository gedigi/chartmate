import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostnameOf, isAllowedHostname, parseAllowedHosts } from '../../src/hostGuard.js';
import { makeApp, type TestApp } from '../routes/helpers.js';

describe('hostnameOf', () => {
  it('strips the port, lowercases and keeps IPv6 brackets', () => {
    expect(hostnameOf('localhost:8787')).toBe('localhost');
    expect(hostnameOf('LocalHost')).toBe('localhost');
    expect(hostnameOf('127.0.0.1:80')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:8787')).toBe('[::1]');
    expect(hostnameOf('[::1]')).toBe('[::1]');
    expect(hostnameOf('chartmate.example.com.')).toBe('chartmate.example.com');
  });

  it('returns null for anything that is not a plain host[:port]', () => {
    for (const h of ['', ' ', 'localhost:', 'localhost:abc', 'a b', 'user@localhost', 'localhost/x', '[::1', '::1', 'http://localhost']) {
      expect(hostnameOf(h), h).toBeNull();
    }
  });
});

describe('parseAllowedHosts', () => {
  it('accepts names, IPv4 and bracketed IPv6, comma separated, normalized', () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts(' ')).toEqual([]);
    expect(parseAllowedHosts('Chartmate.Example.com, 192.168.1.10 ,[fd00::1],,nas.local.')).toEqual([
      'chartmate.example.com', '192.168.1.10', '[fd00::1]', 'nas.local',
    ]);
  });

  it('rejects ports, schemes, paths, wildcards and other junk', () => {
    for (const v of ['example.com:8787', 'https://example.com', 'example.com/x', '*', '*.example.com', 'a b', 'fd00::1', '-bad.com']) {
      expect(() => parseAllowedHosts(v), v).toThrow(/CHARTMATE_ALLOWED_HOSTS/);
    }
  });
});

describe('isAllowedHostname', () => {
  it('always allows the loopback names, plus the configured ones', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]']) expect(isAllowedHostname(h, [])).toBe(true);
    expect(isAllowedHostname('evil.example', [])).toBe(false);
    expect(isAllowedHostname('127.0.0.2', [])).toBe(false);
    expect(isAllowedHostname('nas.local', ['nas.local'])).toBe(true);
    expect(isAllowedHostname('sub.nas.local', ['nas.local'])).toBe(false);
  });
});

describe('Host and Origin guard', () => {
  let t: TestApp | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const withWeb = async (overrides: Parameters<typeof makeApp>[0] = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'chartmate-host-'));
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    t = await makeApp({ webDist: dir, ...overrides });
    return t.app;
  };

  it('without a password, serves loopback hosts on any port', async () => {
    const app = await withWeb();
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:5173', 'localhost', '127.0.0.1']) {
      expect((await app.inject({ url: '/api/health', headers: { host } })).statusCode, host).toBe(200);
      expect((await app.inject({ url: '/', headers: { host } })).statusCode, host).toBe(200);
    }
  });

  it('an inject request without an explicit Host (the desktop app) passes', async () => {
    const app = await withWeb();
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    const put = await app.inject({ method: 'PUT', url: '/api/watchlist', payload: [] });
    expect(put.statusCode).toBeLessThan(300);
  });

  it('without a password, rejects any other Host before routes and static files (DNS rebinding)', async () => {
    const app = await withWeb();
    const api = await app.inject({ url: '/api/health', headers: { host: 'evil.example:8787' } });
    expect(api.statusCode).toBe(403);
    expect(api.json()).toEqual({ code: 'host_not_allowed', message: expect.stringContaining('CHARTMATE_ALLOWED_HOSTS') });
    for (const url of ['/', '/app.js', '/chart/stock:AAPL']) {
      const res = await app.inject({ url, headers: { host: 'evil.example' } });
      expect(res.statusCode, url).toBe(403);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.body).not.toContain('root');
    }
    const write = await app.inject({ method: 'PUT', url: '/api/watchlist', payload: [], headers: { host: 'evil.example' } });
    expect(write.statusCode).toBe(403);
    for (const host of ['localhost:abc', '127.0.0.2:8787', 'localhost.evil.example']) {
      expect((await app.inject({ url: '/api/health', headers: { host } })).statusCode, host).toBe(403);
    }
  });

  it('allows the hosts listed in CHARTMATE_ALLOWED_HOSTS', async () => {
    const app = await withWeb({ allowedHosts: ['nas.local', '192.168.1.10'] });
    expect((await app.inject({ url: '/api/health', headers: { host: 'nas.local:8787' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/', headers: { host: '192.168.1.10:8787' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });

  it('checks Origin on state-changing API requests when present', async () => {
    const app = await withWeb({ allowedHosts: ['nas.local'] });
    const put = (origin?: string) => app.inject({
      method: 'PUT', url: '/api/watchlist', payload: [],
      headers: { host: 'localhost:8787', ...(origin !== undefined ? { origin } : {}) },
    });
    expect((await put()).statusCode).toBeLessThan(300);
    expect((await put('http://localhost:5173')).statusCode).toBeLessThan(300); // Vite dev server
    expect((await put('https://nas.local')).statusCode).toBeLessThan(300);
    const bad = await put('https://evil.example');
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toMatchObject({ code: 'origin_not_allowed' });
    expect((await put('null')).statusCode).toBe(403);
    expect((await put('not a url')).statusCode).toBe(403);
    // GETs are not state-changing: a cross-origin GET is left to the browser's same-origin policy.
    const get = await app.inject({ url: '/api/health', headers: { host: 'localhost', origin: 'https://evil.example' } });
    expect(get.statusCode).toBe(200);
  });

  it('behind a trusted proxy, checks X-Forwarded-Host instead of the Host header', async () => {
    const app = await withWeb({ trustProxy: true, allowedHosts: ['chartmate.example.com'] });
    const fwd = (xfh: string) => app.inject({ url: '/api/health', headers: { host: '127.0.0.1:8787', 'x-forwarded-host': xfh } });
    expect((await fwd('chartmate.example.com')).statusCode).toBe(200);
    expect((await fwd('evil.example')).statusCode).toBe(403);
  });

  it('without a trusted proxy, ignores X-Forwarded-Host', async () => {
    const app = await withWeb();
    const res = await app.inject({ url: '/api/health', headers: { host: 'localhost', 'x-forwarded-host': 'evil.example' } });
    expect(res.statusCode).toBe(200);
  });

  it('with a password and no list, any Host is served (cookie auth protects the instance)', async () => {
    const app = await withWeb({ password: 'pw' });
    expect((await app.inject({ url: '/api/health', headers: { host: 'chartmate.example.com' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/watchlist', headers: { host: 'chartmate.example.com' } })).statusCode).toBe(401);
  });

  it('with a password and a list, the list is enforced too', async () => {
    const app = await withWeb({ password: 'pw', allowedHosts: ['chartmate.example.com'] });
    expect((await app.inject({ url: '/api/health', headers: { host: 'chartmate.example.com' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/health', headers: { host: 'other.example' } })).statusCode).toBe(403);
  });

  it('over a real socket, the Docker healthcheck address passes', async () => {
    const app = await withWeb();
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${addr}/api/health`);
    expect(res.status).toBe(200);
    // HTTP/1.0 allows a request without a Host header: no name, no service.
    const { port } = new URL(addr);
    const raw = await new Promise<string>((resolve, reject) => {
      let data = '';
      const s = connect(Number(port), '127.0.0.1', () => s.write('GET /api/health HTTP/1.0\r\n\r\n'));
      s.on('data', (d) => { data += d.toString(); });
      s.on('end', () => resolve(data));
      s.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 403/);
  });
});
