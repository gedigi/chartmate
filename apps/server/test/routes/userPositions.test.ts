import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState, Layout } from '@chartmate/shared';
import { makeApp, type TestApp } from './helpers.js';

const layout: Layout = { symbol: 'stock:AAPL', tf: '1h', session: 'eth', chartType: 'candle', indicators: [] };
const points = [
  { timestamp: 1000, value: 100 }, { timestamp: 1000, value: 102 }, { timestamp: 1000, value: 98 }, { timestamp: 5000, value: 100 },
];

describe('long / short positions: drawing styles and layout position defaults', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const putLayout = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: body as object });
  const putDrawings = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: body as object });
  const getDrawings = async () => (await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json() as DrawingState[];

  it('round-trips a position (no styles)', async () => {
    const d: DrawingState = { name: 'longPosition', points, lock: false, anchorTf: '1D' };
    expect((await putDrawings([d])).statusCode).toBe(200);
    expect(await getDrawings()).toEqual([d]);
  });

  it('strips the sizing settings of positions saved when they were sized; other style parts survive', async () => {
    const position = { accountSize: 25000, riskMode: 'amount', riskValue: 250, currency: 'EUR' };
    const res = await putDrawings([{ name: 'longPosition', points, lock: false, styles: { position, line: { color: '#123456', size: 1, style: 'solid' } } }]);
    expect(res.statusCode).toBe(200);
    expect((await getDrawings())[0]!.styles).toEqual({ line: { color: '#123456', size: 1, style: 'solid' } });
    await putDrawings([{ name: 'shortPosition', points, lock: true, styles: { position } }]);
    expect((await getDrawings())[0]).toEqual({ name: 'shortPosition', points, lock: true });
  });

  it('accepts and round-trips layout colorDefaultsRev; rejects a non-integer', async () => {
    expect((await putLayout({ ...layout, colorDefaultsRev: 2 })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, colorDefaultsRev: 2 });
    expect((await putLayout({ ...layout, colorDefaultsRev: 1.5 })).statusCode).toBe(400);
    expect((await putLayout({ ...layout, colorDefaultsRev: -1 })).statusCode).toBe(400);
  });

  it('accepts and round-trips layout positionDefaults; missing stays missing (backward compatible)', async () => {
    const positionDefaults = { targetPct: 3, stopPct: 1.5 };
    expect((await putLayout({ ...layout, positionDefaults })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, positionDefaults });
    expect((await putLayout(layout)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual(layout);
  });

  it('strips the sizing fields of positionDefaults saved when positions were sized', async () => {
    const sizing = { accountSize: 50000, riskMode: 'percent', riskValue: 0.5, currency: 'USDT' };
    expect((await putLayout({ ...layout, positionDefaults: { targetPct: 3, stopPct: 1, ...sizing } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, positionDefaults: { targetPct: 3, stopPct: 1 } });
    // Sizing-only defaults (no distances) are dropped: the rest of the layout is still saved.
    expect((await putLayout({ ...layout, tf: '4h', positionDefaults: sizing })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, tf: '4h' });
  });

  it('drops invalid positionDefaults on their own: the rest of the layout is still saved', async () => {
    const ok = { targetPct: 2, stopPct: 2 };
    for (const positionDefaults of [
      { ...ok, targetPct: 0 }, { ...ok, stopPct: -1 }, { ...ok, targetPct: 100 }, { ...ok, stopPct: '2' }, { targetPct: 2 }, 'x',
    ]) {
      const res = await putLayout({ ...layout, tf: '4h', positionDefaults });
      expect(res.statusCode, JSON.stringify(positionDefaults)).toBe(200);
      const saved = (await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json();
      expect(saved, JSON.stringify(positionDefaults)).toEqual({ ...layout, tf: '4h' });
    }
  });
});
