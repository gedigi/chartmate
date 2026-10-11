import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

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
});
