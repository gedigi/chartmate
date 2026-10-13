import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState, Layout } from '@altv/shared';
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

  it('round-trips a position with its own risk settings', async () => {
    const d: DrawingState = {
      name: 'longPosition', points, lock: false, anchorTf: '1D',
      styles: { position: { accountSize: 25000, riskMode: 'amount', riskValue: 250, currency: 'EUR' } },
    };
    expect((await putDrawings([d])).statusCode).toBe(200);
    expect(await getDrawings()).toEqual([d]);
    const partial: DrawingState = { name: 'shortPosition', points, lock: true, styles: { position: { riskValue: 0.5 } } };
    expect((await putDrawings([partial])).statusCode).toBe(200);
    expect(await getDrawings()).toEqual([partial]);
  });

  it('drops an invalid position part on its own (strict: positive finite numbers, risk mode enum, currency ≤ 8 chars)', async () => {
    for (const position of [
      { accountSize: 0 }, { accountSize: -5 }, { riskValue: 0 }, { riskMode: 'shares' }, { currency: 'TOOLONGXY' }, { currency: '' },
      { accountSize: 1000, bogus: true }, { accountSize: '1000' }, 'x', { accountSize: 2e15 }, { riskValue: 2e15 },
      { riskMode: 'percent', riskValue: 150 },
    ]) {
      const res = await putDrawings([{ name: 'longPosition', points, lock: false, styles: { position, line: { color: '#123456', size: 1, style: 'solid' } } }]);
      expect(res.statusCode, JSON.stringify(position)).toBe(200);
      expect((await getDrawings())[0]!.styles, JSON.stringify(position)).toEqual({ line: { color: '#123456', size: 1, style: 'solid' } });
    }
    await putDrawings([{ name: 'longPosition', points, lock: false, styles: { position: { riskMode: 'x' } } }]);
    expect((await getDrawings())[0]).not.toHaveProperty('styles');
  });

  it('accepts and round-trips layout colorDefaultsRev; rejects a non-integer', async () => {
    expect((await putLayout({ ...layout, colorDefaultsRev: 2 })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, colorDefaultsRev: 2 });
    expect((await putLayout({ ...layout, colorDefaultsRev: 1.5 })).statusCode).toBe(400);
    expect((await putLayout({ ...layout, colorDefaultsRev: -1 })).statusCode).toBe(400);
  });

  it('accepts and round-trips layout positionDefaults; missing stays missing (backward compatible)', async () => {
    const positionDefaults = { accountSize: 50000, riskMode: 'percent', riskValue: 0.5, currency: 'USDT' } as const;
    expect((await putLayout({ ...layout, positionDefaults })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, positionDefaults });
    expect((await putLayout(layout)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual(layout);
  });

  it('drops invalid positionDefaults on their own: the rest of the layout is still saved', async () => {
    const ok = { accountSize: 1000, riskMode: 'amount', riskValue: 10, currency: 'USD' };
    for (const positionDefaults of [
      { ...ok, accountSize: 0 }, { ...ok, accountSize: -1 }, { ...ok, accountSize: 2e15 }, { ...ok, riskMode: 'shares' }, { ...ok, riskValue: -1 },
      { ...ok, currency: '' }, { ...ok, currency: 'NINECHARS' }, { ...ok, extra: 1 }, { accountSize: 1000 }, { ...ok, riskMode: 'percent', riskValue: 101 },
      'x',
    ]) {
      const res = await putLayout({ ...layout, tf: '4h', positionDefaults });
      expect(res.statusCode, JSON.stringify(positionDefaults)).toBe(200);
      const saved = (await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json();
      expect(saved, JSON.stringify(positionDefaults)).toEqual({ ...layout, tf: '4h' });
    }
  });
});
