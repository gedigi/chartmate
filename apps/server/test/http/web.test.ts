import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsp from 'node:fs/promises';
import { request } from 'node:http';
import { frameworkErrorHandler } from '../../src/app.js';
import { isApiPath, looksLikeApi } from '../../src/paths.js';
import { makeApp, type TestApp } from '../routes/helpers.js';

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, readFile: vi.fn(real.readFile) };
});

describe('isApiPath / looksLikeApi', () => {
  it('treats matrix-param and backslash variants of /api as API paths', () => {
    for (const u of ['/api', '/api/x', '/API/x', '/api;x/foo', '/api;/foo', '/\\api/foo', '/%5Capi/foo', '\\api\\x', '/%61pi;y/z', '//api/x']) {
      expect(isApiPath(u), u).toBe(true);
    }
    for (const u of ['/', '/apix', '/baskets/api', '/apis/x', '/chart/stock:AAPL', '/a;api/x']) {
      expect(isApiPath(u), u).toBe(false);
    }
    expect(looksLikeApi('/\\api/%E0')).toBe(true);
  });
});

describe('frameworkErrorHandler', () => {
  const run = (code: string, password: string | null = null, url = '/foo') => {
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      code(s: number) { sent.status = s; return reply; },
      send(b: unknown) { sent.body = b; return reply; },
    };
    const err = Object.assign(new Error('x'), { code, statusCode: 400 });
    frameworkErrorHandler(password)(err as never, { url } as never, reply as never);
    return sent;
  };
  it('maps FST_ERR_BAD_URL to Malformed URL and others to a generic Bad request', () => {
    expect(run('FST_ERR_BAD_URL')).toEqual({ status: 400, body: { code: 'invalid_request', message: 'Malformed URL' } });
    expect(run('FST_ERR_ASYNC_CONSTRAINT')).toEqual({ status: 400, body: { code: 'invalid_request', message: 'Bad request' } });
  });
  it('fails closed for API-looking URLs when auth is on', () => {
    expect(run('FST_ERR_BAD_URL', 'pw', '/api/%E0')).toEqual({ status: 401, body: { code: 'unauthorized', message: 'Login required' } });
  });
});

describe('SPA index.html serving', () => {
  let t: TestApp | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.mocked(fsp.readFile).mockClear();
  });

  it('reads index.html once at startup, not per request; re-reads when its mtime changes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'altv-web-'));
    const index = join(dir, 'index.html');
    writeFileSync(index, '<!doctype html><title>v1</title>');
    t = await makeApp({ webDist: dir });
    const reads = () => vi.mocked(fsp.readFile).mock.calls.filter(([p]) => String(p) === index).length;
    const before = reads();
    for (const url of ['/baskets/a', '/chart/x', '/foo/bar']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('v1');
    }
    expect(reads()).toBe(before);
    writeFileSync(index, '<!doctype html><title>v2</title>');
    const later = new Date(Date.now() + 10_000);
    utimesSync(index, later, later);
    expect((await t.app.inject({ method: 'GET', url: '/baskets/a' })).body).toContain('v2');
  });

  it('missing index.html: SPA routes get a JSON 404 web_not_built (no crash)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'altv-web-'));
    writeFileSync(join(dir, 'app.js'), 'x');
    t = await makeApp({ webDist: dir });
    const r = await t.app.inject({ method: 'GET', url: '/baskets/abc' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.json()).toMatchObject({ code: 'web_not_built' });
    expect((await t.app.inject({ method: 'GET', url: '/app.js' })).body).toBe('x');
    // appears later (built after start): served
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>late</title>');
    expect((await t.app.inject({ method: 'GET', url: '/baskets/abc' })).body).toContain('late');
  });

  // light-my-request normalizes `/\\api` as a WHATWG URL (host "api"), so raw paths go over a real socket.
  const rawGet = async (app: TestApp['app'], path: string) => {
    const port = (app.server.address() as { port: number } | null)?.port
      ?? Number(new URL(await app.listen({ port: 0, host: '127.0.0.1' })).port);
    return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
      });
      req.on('error', reject);
      req.end();
    });
  };

  it('/api;x/... and /\\api/... are JSON 404s (401 with auth), never index.html', async () => {
    dir = mkdtempSync(join(tmpdir(), 'altv-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>altv</title>');
    for (const password of [null, 'hunter2']) {
      t = await makeApp({ webDist: dir, password });
      for (const path of ['/api;x/watchlist', '/\\api/watchlist', '/%5Capi/watchlist', '/api;/x']) {
        const r = await rawGet(t.app, path);
        expect(r.status, path).toBe(password === null ? 404 : 401);
        expect(r.type, path).toMatch(/application\/json/);
        expect(r.body, path).not.toContain('<title>');
      }
      expect((await rawGet(t.app, '/baskets/x')).body).toContain('<title>altv</title>');
      await t.close();
      t = undefined;
    }
  });
});
