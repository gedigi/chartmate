import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DrawingState, Layout } from '@altv/shared';
import { makeApp, type TestApp } from './helpers.js';

const layout: Layout = {
  symbol: 'stock:AAPL', tf: '1h', session: 'eth', chartType: 'candle',
  indicators: [{ name: 'MA', pane: 'main', calcParams: [5, 10], visible: true }],
};

describe('layout appearance + indicator styles + drawing styles validation', () => {
  let t: TestApp;
  beforeEach(async () => { t = await makeApp(); });
  afterEach(async () => { await t.close(); });

  const putLayout = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/layouts/default', payload: body as object });
  const putDrawings = (body: unknown) => t.app.inject({ method: 'PUT', url: '/api/drawings/stock:AAPL', payload: body as object });

  it('accepts and round-trips a full appearance', async () => {
    const appearance = {
      upColor: '#00ff00', downColor: '#FF0000', candleBody: 'hollow_up', lineColor: '#123456', lineWidth: 3,
      drawing: { color: '#abcdef', size: 2, style: 'dashed' },
    } as const;
    expect((await putLayout({ ...layout, appearance })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, appearance });
    expect((await putLayout({ ...layout, appearance: {} })).statusCode).toBe(200);
  });

  it('rejects invalid appearance values and unknown keys', async () => {
    for (const appearance of [
      { upColor: 'red' }, { downColor: '#fff' }, { candleBody: 'filled' }, { lineWidth: 0 }, { lineWidth: 5 }, { lineWidth: 1.5 },
      { drawing: { color: '#000000', size: 2 } }, { drawing: { color: '#000000', size: 2, style: 'dotted' } }, { bogus: 1 },
    ]) {
      expect((await putLayout({ ...layout, appearance })).statusCode, JSON.stringify(appearance)).toBe(400);
    }
  });

  it('indicator lineWidths / lineStyles / barColors are validated', async () => {
    const ok = { ...layout.indicators[0]!, lineWidths: [1, 4], lineStyles: ['solid', 'dashed'], barColors: { up: '#00ff00', down: '#ff0000' } };
    expect((await putLayout({ ...layout, indicators: [ok] })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json().indicators[0]).toEqual(ok);
    for (const bad of [
      { lineWidths: [5] }, { lineWidths: [0] }, { lineWidths: Array(11).fill(1) }, { lineStyles: ['dotted'] },
      { lineStyles: Array(11).fill('solid') }, { barColors: { up: 'green', down: '#ff0000' } }, { barColors: { up: '#00ff00' } },
    ]) {
      expect((await putLayout({ ...layout, indicators: [{ ...layout.indicators[0]!, ...bad }] })).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('drawing styles: normalized shape accepted, missing styles ok, unknown keys stripped, invalid styles dropped', async () => {
    const drawings: DrawingState[] = [
      { name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false, styles: { line: { color: '#ff0000', size: 3, style: 'dashed' } } },
      { name: 'simpleAnnotation', points: [{ timestamp: 1, value: 2 }], lock: false, text: 'hi', styles: { text: { color: '#00ff00', size: 18 } } },
      { name: 'rayLine', points: [{ timestamp: 1, value: 2 }], lock: true },
    ];
    expect((await putDrawings(drawings)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json()).toEqual(drawings);

    const extra = [{ ...drawings[0], styles: { line: { color: '#ff0000', size: 1, style: 'solid', smooth: true }, point: { radius: 4 } } }];
    const put = await putDrawings(extra);
    expect(put.statusCode).toBe(200);
    expect(put.json()[0].styles).toEqual({ line: { color: '#ff0000', size: 1, style: 'solid' } });

    for (const styles of [
      { line: { color: '#fff', size: 1, style: 'solid' } }, { line: { color: '#ffffff', size: 5, style: 'solid' } },
      { line: { color: '#ffffff', size: 1, style: 'dotted' } }, { text: { color: '#ffffff', size: 9 } }, { text: { color: '#ffffff', size: 25 } },
      { line: { color: '#ffffff' } }, 'x',
    ]) {
      // Tolerant: invalid / legacy styles are dropped rather than failing the whole save.
      const r = await putDrawings([{ ...drawings[0], styles }]);
      expect(r.statusCode, JSON.stringify(styles)).toBe(200);
      expect(r.json()[0], JSON.stringify(styles)).not.toHaveProperty('styles');
    }
  });
});
