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
    expect(hostnameOf('chartmate_web:8787')).toBe('chartmate_web'); // Compose service names may contain _
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
    expect(parseAllowedHosts('chartmate_web,my_app.internal')).toEqual(['chartmate_web', 'my_app.internal']);
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
    // Only the canonical loopback spellings: 0.0.0.0, 127.1 and other 127/8 addresses are refused.
    for (const h of ['127.0.0.2', '0.0.0.0', '127.1', '[::ffff:127.0.0.1]', '[0:0:0:0:0:0:0:1]']) expect(isAllowedHostname(h, []), h).toBe(false);
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

  it('state-changing API requests need an Origin equal to the request origin (POST, PUT, DELETE)', async () => {
    const app = await withWeb({ allowedHosts: ['nas.local'] });
    const send = (method: 'POST' | 'PUT' | 'DELETE', host: string, origin?: string, extra: Record<string, string> = {}) => app.inject({
      method, url: method === 'PUT' ? '/api/watchlist' : method === 'POST' ? '/api/baskets' : '/api/baskets/nope',
      ...(method === 'PUT' ? { payload: [] } : method === 'POST' ? { payload: {} } : {}),
      headers: { host, ...(origin !== undefined ? { origin } : {}), ...extra },
    });
    const denied = async (res: Awaited<ReturnType<typeof send>>) => {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'origin_not_allowed' });
    };
    for (const m of ['POST', 'PUT', 'DELETE'] as const) {
      // No Origin (curl, the healthcheck): only the Host check applies.
      expect((await send(m, 'localhost:8787')).statusCode, m).not.toBe(403);
      // Same origin: scheme-default or explicit port matches the Host header.
      expect((await send(m, 'nas.local:8787', 'http://nas.local:8787')).statusCode, m).not.toBe(403);
      expect((await send(m, 'nas.local', 'http://nas.local')).statusCode, m).not.toBe(403);
      // Another allowed host or another port of the same host is a different origin.
      await denied(await send(m, 'localhost:8787', 'https://nas.local'));
      await denied(await send(m, 'nas.local:8787', 'http://nas.local:9999'));
      await denied(await send(m, 'nas.local', 'http://nas.local:8080'));
      await denied(await send(m, 'localhost:8787', 'https://evil.example'));
      await denied(await send(m, 'localhost:8787', 'null'));
      await denied(await send(m, 'localhost:8787', 'not a url'));
      // A browser-set Sec-Fetch-Site: same-origin (pages cannot forge it) is accepted.
      expect((await send(m, 'nas.local:8787', 'http://nas.local:1', { 'sec-fetch-site': 'same-origin' })).statusCode, m).not.toBe(403);
      await denied(await send(m, 'nas.local:8787', 'https://evil.example', { 'sec-fetch-site': 'cross-site' }));
    }
  });

  it('a loopback Origin on any port is accepted only for a loopback Host (the Vite dev proxy)', async () => {
    const app = await withWeb({ allowedHosts: ['nas.local'] });
    const put = (host: string, origin: string) => app.inject({ method: 'PUT', url: '/api/watchlist', payload: [], headers: { host, origin } });
    // pnpm dev: the page is on localhost:5173, Vite proxies to 8787 with changeOrigin (Host localhost:8787).
    expect((await put('localhost:8787', 'http://localhost:5173')).statusCode).toBeLessThan(300);
    expect((await put('127.0.0.1:8787', 'http://[::1]:5173')).statusCode).toBeLessThan(300);
    expect((await put('nas.local:8787', 'http://localhost:5173')).statusCode).toBe(403);
  });

  it('GETs are not checked for Origin (left to the same-origin policy)', async () => {
    const app = await withWeb();
    const get = await app.inject({ url: '/api/health', headers: { host: 'localhost', origin: 'https://evil.example' } });
    expect(get.statusCode).toBe(200);
  });

  it('checks Origin with a password too, with or without a host list', async () => {
    for (const allowedHosts of [[], ['chartmate.example.com']]) {
      const t2 = await makeApp({ password: 'pw', allowedHosts });
      try {
        const res = await t2.app.inject({
          method: 'POST', url: '/api/login', payload: { password: 'pw' },
          headers: { host: 'chartmate.example.com', origin: 'https://evil.example' },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'origin_not_allowed' });
        const ok = await t2.app.inject({
          method: 'POST', url: '/api/login', payload: { password: 'pw' },
          headers: { host: 'chartmate.example.com', origin: 'https://chartmate.example.com', 'x-forwarded-proto': 'https' },
        });
        expect(ok.statusCode).not.toBe(403);
      } finally {
        await t2.close();
      }
    }
  });

  it('an extra exact origin from the config (the desktop app://chartmate) is accepted', async () => {
    const app = await withWeb({ allowedOrigins: ['app://chartmate'] });
    const put = (origin: string) => app.inject({ method: 'PUT', url: '/api/watchlist', payload: [], headers: { origin } });
    expect((await put('app://chartmate')).statusCode).toBeLessThan(300);
    expect((await put('app://evil')).statusCode).toBe(403);
  });

  it('behind a trusted proxy, checks X-Forwarded-Host as well as the Host header', async () => {
    const app = await withWeb({ trustProxy: true, allowedHosts: ['chartmate.example.com'] });
    const fwd = (xfh: string) => app.inject({ url: '/api/health', headers: { host: '127.0.0.1:8787', 'x-forwarded-host': xfh } });
    expect((await fwd('chartmate.example.com')).statusCode).toBe(200);
    expect((await fwd('evil.example')).statusCode).toBe(403);
    expect((await fwd('chartmate.example.com, evil.example')).statusCode).toBe(403);
    expect((await fwd('evil.example, chartmate.example.com')).statusCode).toBe(403);
  });

  it.each([true, 1] as const)('with trustProxy %s, a forged X-Forwarded-Host cannot hide a foreign Host (rebinding)', async (trustProxy) => {
    const app = await withWeb({ trustProxy, allowedHosts: ['chartmate.example.com'] });
    const req = (host: string, xfh: string) => app.inject({ url: '/api/health', headers: { host, 'x-forwarded-host': xfh } });
    expect((await req('evil.example', 'localhost')).statusCode).toBe(403);
    expect((await req('evil.example:8787', 'chartmate.example.com')).statusCode).toBe(403);
    expect((await req('chartmate.example.com', 'chartmate.example.com')).statusCode).toBe(200);
    expect((await req('127.0.0.1:8787', 'chartmate.example.com')).statusCode).toBe(200);
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
