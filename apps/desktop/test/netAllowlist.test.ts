import { describe, expect, it, vi } from 'vitest';
import {
  BlockedRequestError, createGuardedFetch, installFetchAllowlist, isAllowedUrl, providerHosts, YAHOO_HOSTS,
} from '../src/lib/netAllowlist.js';

const HOSTS = new Set(['query1.finance.yahoo.com', 'data-api.binance.vision']);

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes[url];
    if (!r) return new Response('nope', { status: 599 });
    return r();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });

describe('isAllowedUrl', () => {
  it('allows https to listed hosts on the default port', () => {
    expect(isAllowedUrl('https://query1.finance.yahoo.com/v8/finance/chart/AAPL', HOSTS)).toBe(true);
    expect(isAllowedUrl('https://data-api.binance.vision:443/api/v3/klines', HOSTS)).toBe(true);
  });
  it.each([
    'http://query1.finance.yahoo.com/x', // not https
    'https://evil.com/x',
    'https://query1.finance.yahoo.com.evil.com/x', // suffix trick
    'https://evilquery1.finance.yahoo.com/x',
    'https://query1.finance.yahoo.com:8443/x', // non-default port
    'https://user:pw@query1.finance.yahoo.com/x', // credentials
    'ws://query1.finance.yahoo.com/x',
    'file:///etc/passwd',
    'data:text/plain,hi',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'not a url',
  ])('blocks %s', (url) => {
    expect(isAllowedUrl(url, HOSTS)).toBe(false);
  });
  it('is case-insensitive on the host (URL parsing lowercases it)', () => {
    expect(isAllowedUrl('https://QUERY1.finance.YAHOO.com/x', HOSTS)).toBe(true);
  });
});

describe('createGuardedFetch', () => {
  it('passes allowed requests through', async () => {
    const { fn, calls } = fakeFetch({ 'https://query1.finance.yahoo.com/a': () => new Response('ok') });
    const f = createGuardedFetch(fn, HOSTS);
    const res = await f('https://query1.finance.yahoo.com/a');
    expect(await res.text()).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('rejects disallowed hosts before any I/O', async () => {
    const { fn, calls } = fakeFetch({});
    const onBlocked = vi.fn();
    const f = createGuardedFetch(fn, HOSTS, { onBlocked });
    await expect(f('https://evil.com/steal')).rejects.toBeInstanceOf(BlockedRequestError);
    await expect(f(new URL('http://query1.finance.yahoo.com/a'))).rejects.toBeInstanceOf(BlockedRequestError);
    await expect(f(new Request('https://evil.com/x'))).rejects.toBeInstanceOf(BlockedRequestError);
    expect(calls).toHaveLength(0);
    expect(onBlocked).toHaveBeenCalledWith('evil.com');
  });

  it('follows redirects itself and checks every hop', async () => {
    const { fn, calls } = fakeFetch({
      'https://query1.finance.yahoo.com/a': redirect(302, '/b'),
      'https://query1.finance.yahoo.com/b': redirect(301, 'https://data-api.binance.vision/c'),
      'https://data-api.binance.vision/c': () => new Response('final'),
    });
    const f = createGuardedFetch(fn, HOSTS);
    const res = await f('https://query1.finance.yahoo.com/a');
    expect(await res.text()).toBe('final');
    expect(calls.map((c) => c.url)).toEqual([
      'https://query1.finance.yahoo.com/a', 'https://query1.finance.yahoo.com/b', 'https://data-api.binance.vision/c',
    ]);
    for (const c of calls) expect(c.init?.redirect).toBe('manual');
  });

  it('blocks a redirect to a non-allowlisted host', async () => {
    const { fn, calls } = fakeFetch({ 'https://query1.finance.yahoo.com/a': redirect(302, 'https://evil.com/x') });
    const f = createGuardedFetch(fn, HOSTS);
    await expect(f('https://query1.finance.yahoo.com/a')).rejects.toBeInstanceOf(BlockedRequestError);
    expect(calls).toHaveLength(1);
  });

  it('blocks a redirect downgrade to http', async () => {
    const { fn } = fakeFetch({ 'https://query1.finance.yahoo.com/a': redirect(307, 'http://query1.finance.yahoo.com/a') });
    await expect(createGuardedFetch(fn, HOSTS)('https://query1.finance.yahoo.com/a')).rejects.toBeInstanceOf(BlockedRequestError);
  });

  it('caps redirect loops', async () => {
    const { fn } = fakeFetch({ 'https://query1.finance.yahoo.com/a': redirect(302, '/a') });
    await expect(createGuardedFetch(fn, HOSTS, { maxRedirects: 5 })('https://query1.finance.yahoo.com/a')).rejects.toThrow(/redirect/i);
  });

  it('leaves redirect: "manual" to the caller (each hop is then a fresh guarded call)', async () => {
    const { fn, calls } = fakeFetch({ 'https://query1.finance.yahoo.com/a': redirect(302, 'https://evil.com/') });
    const f = createGuardedFetch(fn, HOSTS);
    const res = await f('https://query1.finance.yahoo.com/a', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
    await expect(f(res.headers.get('location')!)).rejects.toBeInstanceOf(BlockedRequestError);
  });

  it('strips Authorization/Cookie/Proxy-Authorization on cross-origin redirects, keeps them same-origin', async () => {
    const { fn, calls } = fakeFetch({
      'https://query1.finance.yahoo.com/a': redirect(302, '/b'),
      'https://query1.finance.yahoo.com/b': redirect(302, 'https://data-api.binance.vision/c'),
      'https://data-api.binance.vision/c': () => new Response('ok'),
    });
    const headers = { authorization: 'Bearer t', cookie: 'a=1', 'proxy-authorization': 'Basic x', 'x-keep': '1' };
    await createGuardedFetch(fn, HOSTS)('https://query1.finance.yahoo.com/a', { headers });
    const h = (i: number) => new Headers(calls[i]!.init?.headers);
    expect(h(1).get('authorization')).toBe('Bearer t'); // same origin
    expect(h(1).get('cookie')).toBe('a=1');
    expect(h(2).get('authorization')).toBeNull(); // cross origin
    expect(h(2).get('cookie')).toBeNull();
    expect(h(2).get('proxy-authorization')).toBeNull();
    expect(h(2).get('x-keep')).toBe('1');
  });

  it('switches to GET without a body on 303', async () => {
    const { fn, calls } = fakeFetch({
      'https://query1.finance.yahoo.com/a': redirect(303, '/b'),
      'https://query1.finance.yahoo.com/b': () => new Response('ok'),
    });
    await createGuardedFetch(fn, HOSTS)('https://query1.finance.yahoo.com/a', { method: 'POST', body: 'x' });
    expect(calls[1]!.init?.method).toBe('GET');
    expect(calls[1]!.init?.body).toBeUndefined();
  });
});

describe('installFetchAllowlist', () => {
  it('replaces target.fetch and can be undone', async () => {
    const { fn } = fakeFetch({ 'https://query1.finance.yahoo.com/a': () => new Response('ok') });
    const target = { fetch: fn };
    const undo = installFetchAllowlist(target, HOSTS);
    expect(target.fetch).not.toBe(fn);
    await expect(target.fetch('https://evil.com/')).rejects.toBeInstanceOf(BlockedRequestError);
    expect(await (await target.fetch('https://query1.finance.yahoo.com/a')).text()).toBe('ok');
    undo();
    expect(target.fetch).toBe(fn);
  });

  it('uses the given base transport instead of the original fetch', async () => {
    const orig = fakeFetch({});
    const base = fakeFetch({ 'https://query1.finance.yahoo.com/a': () => new Response('via base') });
    const target = { fetch: orig.fn };
    installFetchAllowlist(target, HOSTS, { base: base.fn });
    expect(await (await target.fetch('https://query1.finance.yahoo.com/a')).text()).toBe('via base');
    expect(orig.calls).toHaveLength(0);
  });
});

describe('providerHosts', () => {
  it('fixture mode needs no network at all', () => {
    expect(providerHosts({ providers: 'fixture', cryptoProvider: 'binance', binanceBaseUrl: 'https://data-api.binance.vision' })).toEqual([]);
  });
  it('live + binance: Yahoo hosts plus the configured Binance host only', () => {
    const hosts = providerHosts({ providers: 'live', cryptoProvider: 'binance', binanceBaseUrl: 'https://api.binance.com' });
    expect(hosts).toEqual(expect.arrayContaining([...YAHOO_HOSTS, 'api.binance.com']));
    expect(hosts).not.toContain('data-api.binance.vision');
    expect(hosts).not.toContain('api.exchange.coinbase.com');
  });
  it('live + coinbase: Yahoo hosts plus Coinbase', () => {
    const hosts = providerHosts({ providers: 'live', cryptoProvider: 'coinbase', binanceBaseUrl: 'https://data-api.binance.vision' });
    expect(hosts).toEqual(expect.arrayContaining([...YAHOO_HOSTS, 'api.exchange.coinbase.com']));
    expect(hosts).not.toContain('data-api.binance.vision');
  });
  it('Yahoo hosts are exactly the ones yahoo-finance2 needs (API hosts, cookie/crumb and EU consent)', () => {
    expect([...YAHOO_HOSTS].sort()).toEqual([
      'consent.yahoo.com', 'finance.yahoo.com', 'guce.yahoo.com',
      'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
    ]);
  });
});
