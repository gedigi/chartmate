import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BarsResponse, LatestResponse, Quote, SymbolInfo } from '@altv/shared';
import { ProviderError } from '../../src/errors.js';
import { basketBody, DAY, makeApp, type TestApp } from './helpers.js';

const HOUR = 3_600_000;

describe('market routes', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const get = (url: string) => t.app.inject({ method: 'GET', url });

  it('GET /api/health', async () => {
    const r = await get('/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('GET /api/bars returns RTH stock bars', async () => {
    const to = Date.now();
    const from = to - 10 * DAY;
    const r = await get(`/api/bars?symbol=stock:AAPL&tf=1h&session=rth&from=${from}&to=${to}`);
    expect(r.statusCode).toBe(200);
    const body = r.json<BarsResponse>();
    expect(body).toMatchObject({ symbol: 'stock:AAPL', tf: '1h', session: 'rth', markers: [], notices: [] });
    expect(typeof body.stale).toBe('boolean');
    expect(typeof body.hasMoreBefore).toBe('boolean');
    expect(body.bars.length).toBeGreaterThan(0);
    expect(body.bars.every((b) => b.session === 'regular')).toBe(true);
    expect(body.bars.every((b) => b.ts >= from && b.ts < to)).toBe(true);
  });

  it('GET /api/bars validates input', async () => {
    const to = Date.now();
    const from = to - DAY;
    const bad = [
      `/api/bars?symbol=stock:AAPL&tf=bad&session=rth&from=${from}&to=${to}`,
      `/api/bars?symbol=stock:AAPL&tf=1h&session=rth&from=${to}&to=${from}`,
      `/api/bars?symbol=stock:AAPL&tf=1h&session=xyz&from=${from}&to=${to}`,
      `/api/bars?symbol=stock:AAPL&tf=1h&session=rth&from=abc&to=${to}`,
      `/api/bars?symbol=stock:AAPL&tf=1h&session=rth&from=${from}`,
      `/api/bars?symbol=bogus&tf=1h&session=rth&from=${from}&to=${to}`,
      // span > 4000 bars
      `/api/bars?symbol=stock:AAPL&tf=1m&session=rth&from=${to - 4001 * 60_000}&to=${to}`,
    ];
    for (const url of bad) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(400);
      expect(r.json(), url).toMatchObject({ code: 'invalid_request', message: expect.any(String) });
    }
  });

  it('GET /api/bars accepts exactly 4000 bars of span', async () => {
    const to = Date.now();
    const r = await get(`/api/bars?symbol=crypto:BTC&tf=1h&session=eth&from=${to - 4000 * HOUR}&to=${to}`);
    expect(r.statusCode).toBe(200);
  });

  it('GET /api/bars unknown symbol → 404 not_found', async () => {
    const to = Date.now();
    const r = await get(`/api/bars?symbol=stock:NOPE&tf=1h&session=rth&from=${to - DAY}&to=${to}`);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'not_found' });
  });

  it('GET /api/bars and /api/latest for a basket', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody() });
    expect(created.statusCode).toBe(201);
    const id = `basket:${created.json<{ id: string }>().id}`;
    const to = Date.now();
    const r = await get(`/api/bars?symbol=${id}&tf=1D&session=rth&from=${to - 30 * DAY}&to=${to}`);
    expect(r.statusCode).toBe(200);
    const body = r.json<BarsResponse>();
    expect(body.symbol).toBe(id);
    expect(Array.isArray(body.markers)).toBe(true);
    expect(body.bars.length).toBeGreaterThan(0);

    const l = await get(`/api/latest?symbol=${id}&tf=1D&session=rth`);
    expect(l.statusCode).toBe(200);
    expect(l.json<LatestResponse>()).toMatchObject({ stale: false });
    expect(l.json<LatestResponse>().bar).not.toBeNull();
  });

  it('GET /api/latest for a stock', async () => {
    const r = await get('/api/latest?symbol=crypto:BTC&tf=5m&session=eth');
    expect(r.statusCode).toBe(200);
    const body = r.json<LatestResponse>();
    expect(body.stale).toBe(false);
    expect(body.bar).toMatchObject({ ts: expect.any(Number), close: expect.any(Number) });
    const s = await get('/api/latest?symbol=stock:AAPL&tf=1D&session=rth');
    expect(s.statusCode).toBe(200);
    expect(s.json<LatestResponse>()).toHaveProperty('bar');
    const bad = await get('/api/latest?symbol=stock:AAPL&tf=7m&session=rth');
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/symbols/search matches stocks and baskets', async () => {
    const r = await get('/api/symbols/search?q=aap');
    expect(r.statusCode).toBe(200);
    expect(r.json<SymbolInfo[]>().map((s) => s.id)).toContain('stock:AAPL');

    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody('My Mega Basket') });
    const id = created.json<{ id: string }>().id;
    const b = await get('/api/symbols/search?q=%20mega%20');
    expect(b.statusCode).toBe(200);
    expect(b.json<SymbolInfo[]>()[0]).toEqual({
      id: `basket:${id}`, assetClass: 'basket', ticker: 'My Mega Basket', name: 'My Mega Basket', pricePrecision: 2,
    });

    expect((await get('/api/symbols/search?q=')).statusCode).toBe(400);
    expect((await get('/api/symbols/search?q=%20%20')).statusCode).toBe(400);
    expect((await get(`/api/symbols/search?q=${'x'.repeat(41)}`)).statusCode).toBe(400);
  });

  it('GET /api/symbols/:id for stock and basket', async () => {
    const r = await get('/api/symbols/stock:AAPL');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL' });
    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody('Info') });
    const id = created.json<{ id: string }>().id;
    const b = await get(`/api/symbols/basket:${id}`);
    expect(b.json()).toEqual({ id: `basket:${id}`, assetClass: 'basket', ticker: 'Info', name: 'Info', pricePrecision: 2 });
    expect((await get('/api/symbols/stock:NOPE')).statusCode).toBe(404);
    expect((await get('/api/symbols/garbage')).statusCode).toBe(400);
  });

  it('GET /api/quotes for stock + crypto + basket', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody() });
    const id = `basket:${created.json<{ id: string }>().id}`;
    const r = await get(`/api/quotes?symbols=stock:AAPL,crypto:BTC,${id}`);
    expect(r.statusCode).toBe(200);
    const quotes = r.json<Quote[]>();
    expect(quotes.map((q) => q.id).sort()).toEqual([id, 'crypto:BTC', 'stock:AAPL'].sort());
    const bq = quotes.find((q) => q.id === id)!;
    expect(bq.price).toBeGreaterThan(0);
    expect(typeof bq.changePct).toBe('number');

    const many = Array.from({ length: 51 }, (_, i) => `stock:S${i}`).join(',');
    expect((await get(`/api/quotes?symbols=${many}`)).statusCode).toBe(400);
    expect((await get('/api/quotes?symbols=bogus')).statusCode).toBe(400);
  });

  it('GET /api/sparklines returns ≤ 30 closes per id and omits failures', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody() });
    const id = `basket:${created.json<{ id: string }>().id}`;
    const r = await get(`/api/sparklines?symbols=stock:AAPL,crypto:BTC,${id},stock:NOPE`);
    expect(r.statusCode).toBe(200);
    const body = r.json<Record<string, number[]>>();
    expect(Object.keys(body).sort()).toEqual([id, 'crypto:BTC', 'stock:AAPL'].sort());
    for (const v of Object.values(body)) {
      expect(v.length).toBeGreaterThan(0);
      expect(v.length).toBeLessThanOrEqual(30);
      expect(v.every((x) => typeof x === 'number')).toBe(true);
    }
    expect(body['crypto:BTC']).toHaveLength(30);
  });

  it('sparklines and basket quotes are cached for 10 s keyed by the sorted id list', async () => {
    let now = Date.now();
    await t.close();
    t = await makeApp({}, { now: () => now });
    const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody(undefined, now) });
    const id = `basket:${created.json<{ id: string }>().id}`;
    const mBars = vi.spyOn(t.market, 'getBars');
    const live = vi.spyOn(t.baskets, 'liveQuotes');
    await get(`/api/sparklines?symbols=stock:AAPL,${id}`);
    await get(`/api/quotes?symbols=${id},stock:AAPL`);
    const n = mBars.mock.calls.length;
    now += 9_000;
    const spark2 = await get(`/api/sparklines?symbols=${id},stock:AAPL`); // same set, other order
    const q2 = await get(`/api/quotes?symbols=stock:AAPL,${id}`);
    expect(mBars.mock.calls.length).toBe(n);
    expect(live).toHaveBeenCalledTimes(1);
    expect(Object.keys(spark2.json()).sort()).toEqual([id, 'stock:AAPL'].sort());
    expect(q2.json<Quote[]>().map((q) => q.id)).toEqual(['stock:AAPL', id]);
    now += 1_001;
    await get(`/api/sparklines?symbols=stock:AAPL,${id}`);
    await get(`/api/quotes?symbols=${id}`);
    expect(mBars.mock.calls.length).toBeGreaterThan(n);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it('unknown /api route → 404 JSON', async () => {
    const r = await get('/api/x');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'not_found', message: expect.any(String) });
  });

  describe('error mapping', () => {
    const barsUrl = () => `/api/bars?symbol=stock:AAPL&tf=1h&session=rth&from=${Date.now() - DAY}&to=${Date.now()}`;

    it('ProviderError → 503 provider_unavailable', async () => {
      vi.spyOn(t.market, 'getBars').mockRejectedValue(new ProviderError('yahoo', 'boom', true, 500));
      const r = await get(barsUrl());
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ code: 'provider_unavailable', message: 'Market data provider unavailable' });
    });

    it('unknown errors → 500 internal without leaking the message', async () => {
      vi.spyOn(t.market, 'getBars').mockRejectedValue(new Error('secret db detail'));
      const r = await get(barsUrl());
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ code: 'internal', message: 'Internal error' });
    });

    it('Fastify 4xx errors (unsupported media type, body too large) → invalid_request', async () => {
      const r = await t.app.inject({ method: 'PUT', url: '/api/watchlist', headers: { 'content-type': 'text/xml' }, payload: '<x/>' });
      expect(r.statusCode).toBe(415);
      expect(r.json()).toMatchObject({ code: 'invalid_request' });
      const big = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: JSON.stringify(['x'.repeat(1_100_000)]), headers: { 'content-type': 'application/json' } });
      expect(big.statusCode).toBe(413);
      expect(big.json()).toMatchObject({ code: 'invalid_request' });
    });

    it('/api/quotes omits the market part when it fails but keeps basket quotes', async () => {
      const created = await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody() });
      const id = `basket:${created.json<{ id: string }>().id}`;
      vi.spyOn(t.market, 'quotes').mockRejectedValue(new ProviderError('yahoo', 'down', true));
      const r = await get(`/api/quotes?symbols=stock:AAPL,${id}`);
      expect(r.statusCode).toBe(200);
      expect(r.json<Quote[]>().map((q) => q.id)).toEqual([id]);
    });

    it('search degrades to basket matches when the provider is down', async () => {
      await t.app.inject({ method: 'POST', url: '/api/baskets', payload: basketBody('Apple Pie') });
      vi.spyOn(t.market, 'search').mockRejectedValue(new ProviderError('yahoo', 'down', true));
      const r = await get('/api/symbols/search?q=apple');
      expect(r.statusCode).toBe(200);
      expect(r.json<SymbolInfo[]>().map((s) => s.assetClass)).toEqual(['basket']);
      const none = await get('/api/symbols/search?q=zzz');
      expect(none.statusCode).toBe(503);
    });
  });
});
