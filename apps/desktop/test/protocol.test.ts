import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { API_BODY_LIMIT, createAppProtocolHandler, type InjectFn, type InjectRequest } from '../src/lib/protocol.js';
import { CONTENT_SECURITY_POLICY } from '../src/lib/securityHeaders.js';

const ORIGIN = 'app://chartmate';

let root: string;
let webRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'chartmate-proto-'));
  webRoot = join(root, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Chartmate</title>');
  writeFileSync(join(webRoot, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(webRoot, 'assets', 'index-abc.css'), 'body{}');
  writeFileSync(join(webRoot, 'theme-init.js'), '1');
  writeFileSync(join(webRoot, 'icon.svg'), '<svg/>');
  writeFileSync(join(webRoot, 'font.woff2'), 'x');
  writeFileSync(join(webRoot, 'data.weird'), 'x');
  // A file next to (not inside) the web root: must never be served.
  writeFileSync(join(root, 'secret.txt'), 'top secret');
  mkdirSync(join(root, 'web-evil'), { recursive: true });
  writeFileSync(join(root, 'web-evil', 'x.txt'), 'sibling prefix');
});

function fakeInject(): { inject: InjectFn; calls: InjectRequest[] } {
  const calls: InjectRequest[] = [];
  const inject: InjectFn = async (req) => {
    calls.push(req);
    if (req.url.startsWith('/api/health')) {
      return { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '11' }, rawPayload: Buffer.from('{"ok":true}') };
    }
    if (req.url.startsWith('/api/empty')) return { statusCode: 204, headers: {}, rawPayload: Buffer.alloc(0) };
    if (req.url.startsWith('/api/cookie')) {
      return { statusCode: 200, headers: { 'set-cookie': ['a=1', 'b=2'], connection: 'keep-alive', 'transfer-encoding': 'chunked' }, rawPayload: Buffer.from('x') };
    }
    return { statusCode: 404, headers: { 'content-type': 'application/json' }, rawPayload: Buffer.from('{"code":"not_found"}') };
  };
  return { inject, calls };
}

function handler(inject = fakeInject().inject) {
  return createAppProtocolHandler({ inject, webRoot, host: 'chartmate' });
}

const get = (h: ReturnType<typeof handler>, path: string, init?: RequestInit) => h(new Request(`${ORIGIN}${path}`, init));

describe('app:// protocol handler — static files', () => {
  it('serves index.html at / with html MIME, CSP and no-cache', async () => {
    const res = await get(handler(), '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>Chartmate</title>');
  });

  it.each([
    ['/assets/index-abc.js', 'text/javascript; charset=utf-8'],
    ['/assets/index-abc.css', 'text/css; charset=utf-8'],
    ['/theme-init.js', 'text/javascript; charset=utf-8'],
    ['/icon.svg', 'image/svg+xml'],
    ['/font.woff2', 'font/woff2'],
    ['/data.weird', 'application/octet-stream'],
  ])('serves %s as %s', async (path, mime) => {
    const res = await get(handler(), path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(mime);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('marks hashed assets immutable', async () => {
    const res = await get(handler(), '/assets/index-abc.js');
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
  });

  it('falls back to index.html for HTML navigations to client routes (SPA)', async () => {
    for (const p of ['/baskets', '/baskets/123', '/chart?x=1']) {
      const res = await get(handler(), p, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('does not fall back for non-navigation requests (fetch of a missing path)', async () => {
    const res = await get(handler(), '/baskets', { headers: { accept: '*/*' } });
    expect(res.status).toBe(404);
  });

  it('404s missing files that look like files (no SPA fallback for /assets/x.js)', async () => {
    const res = await get(handler(), '/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('HEAD returns headers without a body', async () => {
    const res = await get(handler(), '/assets/index-abc.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('rejects non-GET/HEAD for static paths with 405', async () => {
    const res = await get(handler(), '/', { method: 'POST', body: 'x' });
    expect(res.status).toBe(405);
  });

  it('rejects other hosts', async () => {
    const res = await handler()(new Request('app://evil/index.html'));
    expect(res.status).toBe(404);
  });

  it('serves security headers on every response', async () => {
    const res = await get(handler(), '/');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
  });
});

describe('app:// protocol handler — path traversal', () => {
  // Raw URLs as a compromised renderer could send them; URL parsing normalizes plain `..`, so the handler must
  // also cope with encoded dots/slashes/backslashes, NUL bytes and sibling-prefix tricks.
  it.each([
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/%2E%2E%2F%2E%2E%2Fsecret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets%5c..%5c..%5csecret.txt',
    '/%252e%252e%252fsecret.txt',
    '/index.html%00.js',
    '/%00',
    '/..%2fweb-evil%2fx.txt',
    '/%2fetc%2fpasswd',
    '/%E0%A4%A',
  ])('%s → 404 without leaking files', async (path) => {
    const res = await get(handler(), path);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('top secret');
    expect(body).not.toContain('sibling prefix');
    expect(body).not.toContain('root:');
  });

  it('app://chartmate/../../etc/passwd as given to the handler → 404', async () => {
    const res = await handler()(new Request('app://chartmate/../../etc/passwd'));
    expect(res.status).toBe(404);
  });
});

describe('app:// protocol handler — /api routing through fastify.inject', () => {
  it('routes GET /api/health with query to inject and returns its response', async () => {
    const { inject, calls } = fakeInject();
    const res = await get(handler(inject), '/api/health?x=1&y=%20');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('/api/health?x=1&y=%20');
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('forwards method, headers and body (PUT)', async () => {
    const { inject, calls } = fakeInject();
    const body = JSON.stringify({ a: 1 });
    await get(handler(inject), '/api/layouts/default', { method: 'PUT', body, headers: { 'content-type': 'application/json', 'x-test': 'yes' } });
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['x-test']).toBe('yes');
    expect(Buffer.from(calls[0]!.payload!).toString()).toBe(body);
  });

  it('treats api-looking variants as API (never the SPA)', async () => {
    const { inject, calls } = fakeInject();
    for (const p of ['/api', '/API/x', '/api;x/y', '/%61pi/health']) {
      const res = await get(handler(inject), p);
      expect(res.headers.get('content-type'), p).not.toMatch(/text\/html/);
    }
    expect(calls).toHaveLength(4);
  });

  it('returns 204 with a null body', async () => {
    const res = await get(handler(), '/api/empty', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('keeps multiple set-cookie values and drops hop-by-hop headers', async () => {
    const res = await get(handler(), '/api/cookie');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
  });

  it('rejects bodies over the 1 MB limit with 413 without calling inject (declared length)', async () => {
    const { inject, calls } = fakeInject();
    const big = 'x'.repeat(API_BODY_LIMIT + 1);
    const res = await get(handler(inject), '/api/layouts/default', { method: 'PUT', body: big, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('rejects streamed bodies over the limit (no content-length) with 413', async () => {
    const { inject, calls } = fakeInject();
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent > API_BODY_LIMIT + chunk.length) { ctrl.close(); return; }
        sent += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    const req = new Request(`${ORIGIN}/api/layouts/default`, { method: 'PUT', body: stream, duplex: 'half' } as RequestInit);
    const res = await handler(inject)(req);
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
    expect(sent).toBeLessThanOrEqual(API_BODY_LIMIT + 2 * chunk.length);
  });

  it('accepts a body of exactly the limit', async () => {
    const { inject, calls } = fakeInject();
    const res = await get(handler(inject), '/api/x', { method: 'PUT', body: 'x'.repeat(API_BODY_LIMIT) });
    expect(res.status).toBe(404); // from the fake
    expect(calls[0]!.payload!.length).toBe(API_BODY_LIMIT);
  });

  it('maps inject failures to a 500 JSON error without leaking details', async () => {
    const inject: InjectFn = vi.fn(async () => { throw new Error('secret internal detail'); });
    const res = await get(handler(inject), '/api/health');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret internal detail');
  });
});
