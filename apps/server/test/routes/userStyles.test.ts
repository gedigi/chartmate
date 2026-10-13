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

  const full = {
    upColor: '#00ff00', downColor: '#FF0000', candleBody: 'hollow_up', lineColor: '#123456', lineWidth: 3,
    drawing: { color: '#abcdef', size: 2, style: 'dotted' },
  } as const;

  it('accepts and round-trips a per-theme appearance', async () => {
    const appearance = { dark: full, light: { upColor: '#000000' } };
    expect((await putLayout({ ...layout, appearance })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, appearance });
    for (const a of [{}, { dark: {} }, { light: full }]) expect((await putLayout({ ...layout, appearance: a })).statusCode).toBe(200);
  });

  it('accepts the legacy flat appearance and migrates it to the dark theme', async () => {
    const res = await putLayout({ ...layout, appearance: full });
    expect(res.statusCode).toBe(200);
    expect(res.json().appearance).toEqual({ dark: full });
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json().appearance).toEqual({ dark: full });
  });

  it('migrates a legacy flat appearance stored before the per-theme change when it is read', async () => {
    const userFlat = { upColor: '#ffffff', downColor: '#e63b7a', drawing: { color: '#ffffff', size: 1, style: 'solid' } };
    await t.repos.layouts.put('default', { ...layout, appearance: userFlat } as unknown as Layout);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json()).toEqual({ ...layout, appearance: { dark: userFlat } });
  });

  it('rejects invalid appearance values and unknown keys', async () => {
    for (const appearance of [
      { upColor: 'red' }, { downColor: '#fff' }, { candleBody: 'filled' }, { lineWidth: 0 }, { lineWidth: 5 }, { lineWidth: 1.5 },
      { drawing: { color: '#000000', size: 2 } }, { drawing: { color: '#000000', size: 2, style: 'wavy' } }, { bogus: 1 },
    ]) {
      expect((await putLayout({ ...layout, appearance })).statusCode, JSON.stringify(appearance)).toBe(400);
      expect((await putLayout({ ...layout, appearance: { dark: appearance } })).statusCode, JSON.stringify(appearance)).toBe(400);
      expect((await putLayout({ ...layout, appearance: { light: appearance } })).statusCode, JSON.stringify(appearance)).toBe(400);
    }
    // Mixing the shapes, or unknown theme keys, is rejected.
    for (const appearance of [{ dark: {}, upColor: '#000000' }, { sepia: {} }]) {
      expect((await putLayout({ ...layout, appearance })).statusCode, JSON.stringify(appearance)).toBe(400);
    }
  });

  it('indicator lineWidths / lineStyles / barColors are validated', async () => {
    const ok = { ...layout.indicators[0]!, lineWidths: [1, 4], lineStyles: ['solid', 'dashed', 'dotted'], barColors: { up: '#00ff00', down: '#ff0000' } };
    expect((await putLayout({ ...layout, indicators: [ok] })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/layouts/default' })).json().indicators[0]).toEqual(ok);
    for (const bad of [
      { lineWidths: [5] }, { lineWidths: [0] }, { lineWidths: Array(11).fill(1) }, { lineStyles: ['wavy'] },
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
      { name: 'fibonacciLine', points: [{ timestamp: 1, value: 2 }], lock: false, styles: { line: { color: '#0000ff', size: 2, style: 'dotted' } } },
    ];
    expect((await putDrawings(drawings)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/drawings/stock:AAPL' })).json()).toEqual(drawings);

    const extra = [{ ...drawings[0], styles: { line: { color: '#ff0000', size: 1, style: 'solid', smooth: true }, point: { radius: 4 } } }];
    const put = await putDrawings(extra);
    expect(put.statusCode).toBe(200);
    expect(put.json()[0].styles).toEqual({ line: { color: '#ff0000', size: 1, style: 'solid' } });

    for (const styles of [
      { line: { color: '#fff', size: 1, style: 'solid' } }, { line: { color: '#ffffff', size: 5, style: 'solid' } },
      { line: { color: '#ffffff', size: 1, style: 'wavy' } }, { text: { color: '#ffffff', size: 9 } }, { text: { color: '#ffffff', size: 25 } },
      { line: { color: '#ffffff' } }, 'x',
    ]) {
      // Tolerant: invalid / legacy styles are dropped rather than failing the whole save.
      const r = await putDrawings([{ ...drawings[0], styles }]);
      expect(r.statusCode, JSON.stringify(styles)).toBe(200);
      expect(r.json()[0], JSON.stringify(styles)).not.toHaveProperty('styles');
    }
  });

  it('drawing styles: price label options are accepted alone or with a line; invalid ones are dropped', async () => {
    const base = { name: 'priceLine', points: [{ timestamp: 1, value: 2 }], lock: false };
    const r = await putDrawings([
      { ...base, styles: { label: { onLine: false } } },
      { ...base, styles: { line: { color: '#ff0000', size: 2, style: 'dotted' }, label: { onLine: true, onAxis: false } } },
      { ...base, styles: { label: { onLine: 'no' } } },
      { ...base, styles: { label: {} } },
    ]);
    expect(r.statusCode).toBe(200);
    expect(r.json().map((d: DrawingState) => d.styles)).toEqual([
      { label: { onLine: false } },
      { line: { color: '#ff0000', size: 2, style: 'dotted' }, label: { onLine: true, onAxis: false } },
      undefined, undefined,
    ]);
  });

  it('drawing styles: an invalid part is dropped but valid parts survive', async () => {
    const base = { name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false };
    const r = await putDrawings([
      { ...base, styles: { line: { color: '#ff0000', size: 2, style: 'solid' }, text: { color: 'red', size: 14 } } },
      { ...base, styles: { line: { color: '#ff0000', size: 9, style: 'solid' }, text: { color: '#00ff00', size: 14 } } },
    ]);
    expect(r.statusCode).toBe(200);
    expect(r.json()[0].styles).toEqual({ line: { color: '#ff0000', size: 2, style: 'solid' } });
    expect(r.json()[1].styles).toEqual({ text: { color: '#00ff00', size: 14 } });
  });
});
