import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MAX_INDICATORS, type DrawingState, type Layout } from '@altv/shared';
import { makeApp, type TestApp } from './helpers.js';

const layout: Layout = {
  symbol: 'stock:AAPL', tf: '1h', session: 'eth', chartType: 'candle',
  indicators: [{ name: 'MA', pane: 'main', calcParams: [5, 10], visible: true, lineColors: ['#ff0000'] }],
};

const SEC_A = '0b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f60';
const SEC_B = '1b6f7c1e-3f1a-4c1e-9a7b-2a1d3c4e5f61';
const entries = (ids: string[]) => ids.map((id) => ({ type: 'symbol', id }));

describe('user routes', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  it('watchlist PUT/GET round-trip', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).json()).toEqual([]);
    const ids = ['stock:AAPL', 'crypto:BTC'];
    const put = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ids });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(entries(ids));
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).json()).toEqual(entries(ids));
  });

  it('legacy watchlist PUT (symbol id array) is stored as symbol entries; duplicates dropped', async () => {
    const put = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ['stock:AAPL', 'crypto:BTC', 'stock:AAPL'] });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(entries(['stock:AAPL', 'crypto:BTC']));
  });

  it('a legacy PUT merges into a list with sections instead of wiping them; [] still empties it', async () => {
    const stored = [
      { type: 'symbol', id: 'stock:SPY' },
      { type: 'section', id: SEC_A, title: 'Tech', collapsed: true },
      { type: 'symbol', id: 'stock:AAPL' },
      { type: 'symbol', id: 'stock:MSFT' },
    ];
    await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: stored });
    // An old tab: MSFT removed, AAPL moved first, BTC added.
    const put = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ['stock:AAPL', 'stock:SPY', 'crypto:BTC'] });
    expect(put.statusCode).toBe(200);
    const merged = [
      { type: 'symbol', id: 'stock:AAPL' },
      { type: 'section', id: SEC_A, title: 'Tech', collapsed: true },
      { type: 'symbol', id: 'stock:SPY' },
      { type: 'symbol', id: 'crypto:BTC' },
    ];
    expect(put.json()).toEqual(merged);
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).json()).toEqual(merged);
    const empty = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: [] });
    expect(empty.json()).toEqual([]);
  });

  it('watchlist entries with sections round-trip in order', async () => {
    const body = [
      { type: 'symbol', id: 'stock:SPY' },
      { type: 'section', id: SEC_A, title: 'Tech', collapsed: false },
      { type: 'symbol', id: 'stock:AAPL' },
      { type: 'section', id: SEC_B, title: 'Crypto', collapsed: true },
      { type: 'symbol', id: 'crypto:BTC' },
    ];
    const put = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: body });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(body);
    expect((await t.app.inject({ method: 'GET', url: '/api/watchlist' })).json()).toEqual(body);
  });

  it('watchlist entries are validated (titles, ids, duplicates, limits, unknown keys)', async () => {
    const bad = async (payload: unknown) => {
      const r = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: payload as object });
      expect(r.statusCode, JSON.stringify(payload).slice(0, 120)).toBe(400);
      expect(r.json()).toMatchObject({ code: 'invalid_request' });
    };
    const section = (id: string, title = 'S') => ({ type: 'section', id, title, collapsed: false });
    await bad([section(SEC_A, '')]);
    await bad([section(SEC_A, '   ')]);
    await bad([section(SEC_A, 'x'.repeat(41))]);
    await bad([section('not-a-uuid')]);
    await bad([section(SEC_A), section(SEC_A)]);
    await bad([{ type: 'symbol', id: 'stock:A' }, { type: 'symbol', id: 'stock:A' }]);
    await bad([{ type: 'symbol', id: 'bogus' }]);
    await bad([{ type: 'section', id: SEC_A, title: 'S' }]);
    await bad([{ type: 'symbol', id: 'stock:A', extra: 1 }]);
    await bad([{ type: 'folder', id: SEC_A }]);
    await bad(Array.from({ length: 201 }, (_, i) => ({ type: 'symbol', id: `stock:S${i}` })));
    await bad(Array.from({ length: 51 }, (_, i) => section(`${String(i).padStart(8, '0')}-3f1a-4c1e-9a7b-2a1d3c4e5f60`)));
    await bad({ not: 'an array' });
    const ok = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: [
      ...Array.from({ length: 200 }, (_, i) => ({ type: 'symbol', id: `stock:S${i}` })),
      ...Array.from({ length: 50 }, (_, i) => section(`${String(i).padStart(8, '0')}-3f1a-4c1e-9a7b-2a1d3c4e5f60`, 'x'.repeat(40))),
    ] });
    expect(ok.statusCode).toBe(200);
  });

  it('watchlist rejects invalid ids', async () => {
    const r = await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: ['stock:AAPL', 'bogus'] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'invalid_request' });
    const tooMany = Array.from({ length: 201 }, (_, i) => `stock:S${i}`);
    expect((await t.app.inject({ method: 'PUT', url: '/api/watchlist', payload: tooMany })).statusCode).toBe(400);
  });

  it('layouts PUT/GET; unknown key 200 null; invalid key/body 400', async () => {
    const first = await t.app.inject({ method: 'GET', url: '/api/layouts/default' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toMatch(/application\/json/);
    expect(first.json()).toBeNull();
    const put = await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: layout });
    expect(put.statusCode).toBe(200);
    const got = await t.app.inject({ method: 'GET', url: '/api/layouts/default' });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(layout);

    const symKey = await t.app.inject({ method: 'PUT', url: '/api/layouts/sym:crypto:BTC', payload: { ...layout, symbol: 'crypto:BTC' } });
    expect(symKey.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/sym:crypto:BTC' })).json()).toMatchObject({ symbol: 'crypto:BTC' });

    const unknown = await t.app.inject({ method: 'GET', url: '/api/layouts/sym:stock:MSFT' });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe('null');

    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/whatever' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: { ...layout, tf: '7m' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: { ...layout, chartType: 'renko' } })).statusCode).toBe(400);
  });

  it(`layouts accept exactly MAX_INDICATORS (${MAX_INDICATORS}) indicators and reject one more`, async () => {
    const ind = { name: 'MA', pane: 'main' as const, calcParams: [5], visible: true };
    const at = { ...layout, indicators: Array.from({ length: MAX_INDICATORS }, () => ind) };
    expect((await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: at })).statusCode).toBe(200);
    const over = { ...layout, indicators: [...at.indicators, ind] };
    expect((await t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: over })).statusCode).toBe(400);
  });

  it('drawings PUT/GET', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json()).toEqual([]);
    const drawings: DrawingState[] = [
      { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 3, value: 4 }], lock: false, styles: { line: { color: '#ffffff', size: 2, style: 'solid' } } },
      { name: 'text', points: [{ timestamp: 5, value: 6 }], lock: true, text: 'hello' },
    ];
    const put = await t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: drawings });
    expect(put.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json()).toEqual(drawings);

    const tooMany = Array.from({ length: 501 }, () => drawings[1]);
    expect((await t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: tooMany })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/drawings/bogus', payload: [] })).statusCode).toBe(400);
    const badStyles = [{ ...drawings[0], styles: { line: { color: 'x'.repeat(11_000), size: 1, style: 'solid' } } }];
    const dropped = await t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: badStyles });
    expect(dropped.statusCode).toBe(200);
    expect(dropped.json()[0]).not.toHaveProperty('styles');
  });
});
