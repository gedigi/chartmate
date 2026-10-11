import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState, Layout } from '@altv/shared';
import { makeApp, type TestApp } from './helpers.js';

const layout: Layout = {
  symbol: 'stock:AAPL', tf: '1h', session: 'eth', chartType: 'candle',
  indicators: [{ name: 'MA', pane: 'main', calcParams: [5, 10], visible: true, lineColors: ['#ff0000'] }],
};

describe('user routes', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  it('watchlist PUT/GET round-trip', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).json()).toEqual([]);
    const ids = ['stock:AAPL', 'crypto:BTC'];
    const put = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ids });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(ids);
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).json()).toEqual(ids);
  });

  it('watchlist rejects invalid ids', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ['stock:AAPL', 'bogus'] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invalid_request' });
    const tooMany = Array.from({ length: 201 }, (_, i) => `stock:S${i}`);
    expect((await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: tooMany })).statusCode).toBe(400);
  });

  it('layouts PUT/GET; unknown key 404; invalid key/body 400', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).statusCode).toBe(404);
    const put = await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: layout });
    expect(put.statusCode).toBe(200);
    const got = await t.app.inject({ method: 'GET', url: '/api/layouts/default' });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(layout);

    const symKey = await t.app.inject({ method: 'PUT', url: '/api/layouts/sym:crypto:BTC', payload: { ...layout, symbol: 'crypto:BTC' } });
    expect(symKey.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/sym:crypto:BTC' })).json()).toMatchObject({ symbol: 'crypto:BTC' });

    const unknown = await t.app.inject({ method: 'GET', url: '/api/layouts/sym:stock:MSFT' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'not_found' });

    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/whatever' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: { ...layout, tf: '7m' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: { ...layout, chartType: 'renko' } })).statusCode).toBe(400);
  });

  it('drawings PUT/GET', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json()).toEqual([]);
    const drawings: DrawingState[] = [
      { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: false, styles: { line: { color: '#fff' } } },
      { name: 'text', points: [{ timestamp: 5, value: 6 }], lock: true, text: 'hello' },
    ];
    const put = await t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: drawings });
    expect(put.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json()).toEqual(drawings);

    const tooMany = Array.from({ length: 501 }, () => drawings[1]);
    expect((await t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: tooMany })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/drawings/bogus', payload: [] })).statusCode).toBe(400);
    const bigStyles = [{ ...drawings[0], styles: { blob: 'x'.repeat(11_000) } }];
    expect((await t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: bigStyles })).statusCode).toBe(400);
  });
});
