import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setUnauthorizedHandler } from '../src/api/client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); setUnauthorizedHandler(null); });

describe('api client', () => {
  it('maps non-2xx JSON errors to ApiError with status and code', async () => {
    mockFetch(jsonResponse(400, { code: 'invalid_request', message: 'bad symbol' }));
    const err = await api.symbol('stock:???').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_request', message: 'bad symbol' });
  });

  it('maps non-JSON error bodies to ApiError with a generic code', async () => {
    mockFetch(new Response('Bad Gateway', { status: 502 }));
    const err = await api.quotes(['stock:AAPL']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'http_error' });
  });

  it('maps network failures to ApiError with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.session()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('layouts.get returns null on 404 and URL-encodes the key', async () => {
    const f = mockFetch(jsonResponse(404, { code: 'not_found', message: 'No layout' }));
    await expect(api.layouts.get('sym:stock:AAPL')).resolves.toBeNull();
    expect(f.mock.calls[0]![0]).toBe('/api/layouts/sym%3Astock%3AAAPL');
  });

  it('layouts.get treats a 200 with a null (or empty) body as "no layout", like a 404', async () => {
    mockFetch(jsonResponse(200, null), new Response('', { status: 200 }), jsonResponse(404, { code: 'not_found', message: 'x' }));
    await expect(api.layouts.get('default')).resolves.toBeNull();
    await expect(api.layouts.get('default')).resolves.toBeNull();
    await expect(api.layouts.get('default')).resolves.toBeNull();
  });

  it('layouts.get still throws on other errors', async () => {
    mockFetch(jsonResponse(500, { code: 'internal', message: 'boom' }));
    await expect(api.layouts.get('default')).rejects.toBeInstanceOf(ApiError);
  });

  it('builds the bars query string and passes the abort signal', async () => {
    const body = { symbol: 'crypto:BTC', tf: '1h', session: 'rth', bars: [], hasMoreBefore: false, stale: false, notices: [], markers: [] };
    const f = mockFetch(jsonResponse(200, body));
    const ctl = new AbortController();
    await expect(api.bars({ symbol: 'crypto:BTC', tf: '1h', session: 'rth', from: 1, to: 2 }, ctl.signal)).resolves.toEqual(body);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/bars?symbol=crypto%3ABTC&tf=1h&session=rth&from=1&to=2');
    expect(init?.signal).toBe(ctl.signal);
  });

  it('sends JSON bodies and resolves void on 204', async () => {
    const f = mockFetch(new Response(null, { status: 204 }));
    await expect(api.login('pw')).resolves.toBeUndefined();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/login');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ password: 'pw' });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('encodes symbol ids in path segments and joins list params', async () => {
    const f = mockFetch(jsonResponse(200, []), jsonResponse(200, {}), jsonResponse(200, []));
    await api.drawings.get('stock:BRK.B');
    await api.sparklines(['stock:AAPL', 'crypto:BTC']);
    await api.search('a b');
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      '/api/drawings/stock%3ABRK.B',
      '/api/sparklines?symbols=stock%3AAAPL%2Ccrypto%3ABTC',
      '/api/symbols/search?q=a+b',
    ]);
  });

  it('routes basket operations to the right endpoints', async () => {
    const basket = { id: 'b1', name: 'B', baseValue: 100, versions: [], createdAt: 0, updatedAt: 0 };
    const f = mockFetch(jsonResponse(200, basket), jsonResponse(200, basket), new Response(null, { status: 204 }));
    await api.baskets.appendVersion('b1', { effectiveFrom: '2024-01-02', weights: { 'stock:AAPL': 1 } });
    await api.baskets.update('b1', { name: 'B' });
    await api.baskets.remove('b1');
    expect(f.mock.calls.map((c) => [c[0], c[1]?.method])).toEqual([
      ['/api/baskets/b1/versions', 'POST'],
      ['/api/baskets/b1', 'PUT'],
      ['/api/baskets/b1', 'DELETE'],
    ]);
  });

  it('sends PUT requests with keepalive so beforeunload flushes survive the page unloading', async () => {
    const f = mockFetch(new Response(null, { status: 204 }), new Response(null, { status: 204 }), new Response(null, { status: 204 }));
    await api.layouts.put('default', { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] });
    await api.drawings.put('crypto:BTC', []);
    await api.watchlist.put([]);
    for (const [, init] of f.mock.calls) {
      expect(init?.method).toBe('PUT');
      expect(init?.keepalive).toBe(true);
    }
  });

  it('omits keepalive for PUT bodies over 16 KB', async () => {
    const f = mockFetch(new Response(null, { status: 204 }));
    const big = Array.from({ length: 400 }, (_, i) => ({ name: 'segment', points: [{ timestamp: i, value: i }], lock: false }));
    await api.drawings.put('crypto:BTC', big);
    expect(String(f.mock.calls[0]![1]?.body).length).toBeGreaterThan(16_000);
    expect(f.mock.calls[0]![1]?.keepalive).toBeUndefined();
  });

  it('keeps in-flight keepalive bodies within a 48 KB budget, freeing it when requests settle', async () => {
    const resolvers: Array<() => void> = [];
    const f = vi.fn<typeof fetch>().mockImplementation(() =>
      new Promise((r) => { resolvers.push(() => r(new Response(null, { status: 204 }))); }));
    vi.stubGlobal('fetch', f);
    // ~15 KB each: three fit in 48 KB, the fourth does not.
    const body = Array.from({ length: 210 }, (_, i) => ({ name: 'segment', points: [{ timestamp: i, value: i }], lock: false }));
    const puts = [0, 1, 2, 3].map((i) => api.drawings.put(`crypto:C${i}`, body));
    const size = String(f.mock.calls[0]![1]?.body).length;
    expect(size).toBeGreaterThan(12_000);
    expect(size).toBeLessThanOrEqual(16_000);
    expect(f.mock.calls.map((c) => c[1]?.keepalive)).toEqual([true, true, true, undefined]);
    for (const r of resolvers) r();
    await Promise.all(puts);
    const last = api.drawings.put('crypto:C9', body);
    resolvers.at(-1)!();
    await last;
    expect(f.mock.calls.at(-1)![1]?.keepalive).toBe(true);
  });

  it('watchlist.get accepts the legacy symbol id array and the entry array', async () => {
    const section = { type: 'section', id: '0b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f60', title: 'Tech', collapsed: true };
    mockFetch(jsonResponse(200, ['stock:AAPL', 'crypto:BTC']), jsonResponse(200, [section, { type: 'symbol', id: 'stock:AAPL' }]));
    expect(await api.watchlist.get()).toEqual([{ type: 'symbol', id: 'stock:AAPL' }, { type: 'symbol', id: 'crypto:BTC' }]);
    expect(await api.watchlist.get()).toEqual([section, { type: 'symbol', id: 'stock:AAPL' }]);
  });

  it('does not set keepalive on GET requests', async () => {
    const f = mockFetch(jsonResponse(200, []));
    await api.watchlist.get();
    expect(f.mock.calls[0]![1]?.keepalive).toBeUndefined();
  });

  it('calls the registered unauthorized handler when a request returns 401 unauthorized', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(jsonResponse(401, { code: 'unauthorized', message: 'Login required' }));
    await expect(api.watchlist.get()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not call the unauthorized handler for login/session requests or other errors', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    mockFetch(
      jsonResponse(401, { code: 'unauthorized', message: 'Wrong password' }),
      jsonResponse(401, { code: 'unauthorized', message: 'Login required' }),
      jsonResponse(403, { code: 'forbidden', message: 'nope' }),
    );
    await expect(api.login('bad')).rejects.toMatchObject({ status: 401 });
    await expect(api.session()).rejects.toMatchObject({ status: 401 });
    await expect(api.watchlist.get()).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
