// Tests for the port of 'Wyckoff Accumulation Distribution' by faytterro (MPL-2.0, https://mozilla.org/MPL/2.0/).
import { describe, expect, it, vi } from 'vitest';
import wyckoffIndicator, { barcolorRects, drawWyckoff, wyckoffBarResults, type WyckoffBarResult } from '../../src/chart/indicators/custom/wyckoff';
import { WYCKOFF_COLORS as C } from '../../src/chart/indicators/wyckoffCalc';

const THEME_TEXT = '#131722';

function makeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const state: Record<string, unknown> = {};
  const fn = (name: string) => vi.fn((...a: unknown[]) => { calls.push([name, [...a, state.fillStyle, state.globalAlpha]]); });
  const ctx = {
    save: fn('save'), restore: fn('restore'), fillRect: fn('fillRect'), strokeRect: fn('strokeRect'), beginPath: fn('beginPath'),
    moveTo: fn('moveTo'), lineTo: fn('lineTo'), closePath: fn('closePath'), fill: fn('fill'), fillText: fn('fillText'), setLineDash: fn('setLineDash'),
    measureText: (t: string) => ({ width: t.length * 3 }),
    set fillStyle(v: unknown) { state.fillStyle = v; }, get fillStyle() { return state.fillStyle; },
    set globalAlpha(v: unknown) { state.globalAlpha = v; }, get globalAlpha() { return state.globalAlpha ?? 1; },
    strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  };
  return { ctx, calls };
}

function run(
  data: Array<{ open: number; high: number; low: number; close: number }>, result: WyckoffBarResult[],
  range = { realFrom: 0, realTo: data.length }, candleType = 'candle_solid',
) {
  const { ctx, calls } = makeCtx();
  const ret = drawWyckoff({
    ctx: ctx as never,
    chart: {
      getDataList: () => data,
      getVisibleRange: () => range,
      getBarSpace: () => ({ bar: 10, halfBar: 5, gapBar: 8, halfGapBar: 4 }),
      getStyles: () => ({ candle: { type: candleType, tooltip: { title: { color: THEME_TEXT, family: 'Arial' } } }, indicator: {} }),
    } as never,
    indicator: { result } as never,
    bounding: {} as never,
    xAxis: { convertToPixel: (i: number) => i * 10 } as never,
    yAxis: { convertToPixel: (v: number) => 1000 - v * 10 } as never,
  });
  return { ret, calls };
}

describe('WYCKOFF template', () => {
  it('is a figure-less price overlay with the agreed defaults', () => {
    expect(wyckoffIndicator.template).toMatchObject({ name: 'WYCKOFF', calcParams: [14, 20, 5], figures: [], series: 'price' });
    expect(wyckoffIndicator.catalog.label).toBe('Wyckoff Accumulation and Distribution');
  });

  it('calc returns one entry per bar (and nothing on empty data)', () => {
    expect(wyckoffBarResults([], [14, 20, 5])).toEqual([]);
    const bars = Array.from({ length: 30 }, (_, i) => ({ high: i + 1, low: i - 1, close: i }));
    expect(wyckoffBarResults(bars, [2, 20, 1])).toHaveLength(30);
  });
});

describe('drawWyckoff', () => {
  it('does not throw on empty data / result and suppresses default figures', () => {
    expect(run([], []).ret).toBe(true);
    expect(run([{ open: 1, high: 2, low: 0, close: 1 }], []).ret).toBe(true);
  });

  it('draws the box, its 20%-alpha theme-colored text, the recolored candle and labeled triangles', () => {
    const data = Array.from({ length: 6 }, () => ({ open: 10, high: 12, low: 8, close: 11 }));
    const result: WyckoffBarResult[] = data.map(() => ({ barColor: null, signals: [], boxes: [] }));
    result[5]!.boxes.push({ left: 0, right: 5, top: 12, bottom: 8, bgColor: C.accumulationBg, text: 'Accumulation' });
    result[2]!.barColor = C.lime;
    result[3]!.signals.push({ index: 3, kind: 'SC', text: 'SC', position: 'below', color: C.green });
    const { calls } = run(data, result);
    const fillRects = calls.filter(([n]) => n === 'fillRect').map(([, a]) => a);
    expect(fillRects[0]).toEqual([0, 880, 50, 40, C.accumulationBg, undefined]); // box background
    expect(calls.find(([n]) => n === 'strokeRect')).toBeDefined();
    expect(calls.find(([n]) => n === 'setLineDash')![1][0]).toEqual([]); // solid border
    const texts = calls.filter(([n]) => n === 'fillText').map(([, a]) => a);
    expect(texts[0]!.slice(0, 1)).toEqual(['Accumulation']);
    expect(texts[0]!.slice(3)).toEqual([THEME_TEXT, 0.2]);
    expect(texts[1]!.slice(0, 1)).toEqual(['SC']);
    expect(texts[1]![3]).toBe(THEME_TEXT);
    expect(fillRects.filter((a) => a[4] === C.lime)).toHaveLength(2); // wick + body
    expect(calls.filter(([n, a]) => n === 'fill' && a[0] === C.green)).toHaveLength(1);
  });

  it('only draws within the visible range', () => {
    const data = Array.from({ length: 100 }, () => ({ open: 10, high: 12, low: 8, close: 11 }));
    const result: WyckoffBarResult[] = data.map(() => ({ barColor: C.purple, signals: [], boxes: [] }));
    const { calls } = run(data, result, { realFrom: 50, realTo: 60 });
    const xs = calls.filter(([n]) => n === 'fillRect').map(([, a]) => a[0] as number);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(480);
    expect(Math.max(...xs)).toBeLessThanOrEqual(610);
  });
});

describe('barcolorRects (recolored bar keeps the chart bar style, like KLineChart draws it)', () => {
  // pixels: high 100 (top), open 120, close 140, low 160; gapBar 8 (even → +1 correction), x = 50
  const up = { open: 10, close: 12 }; // close > open
  const down = { open: 12, close: 10 };
  const px = { open: 120, close: 140, high: 100, low: 160 };
  const space = { gapBar: 8, halfGapBar: 4 };
  const solid = [
    { x: 50, y: 100, w: 1, h: 60, stroke: false }, // wick
    { x: 46, y: 120, w: 9, h: 20, stroke: false }, // body
  ];
  const hollow = [
    { x: 50, y: 100, w: 1, h: 20, stroke: false }, // upper wick
    { x: 50, y: 140, w: 1, h: 20, stroke: false }, // lower wick
    { x: 46, y: 120, w: 9, h: 20, stroke: true }, // stroke-only body
  ];

  it('candle_solid: wick + filled body', () => {
    expect(barcolorRects('candle_solid', 50, px, up, space)).toEqual(solid);
  });

  it('candle_stroke: hollow body for every bar', () => {
    expect(barcolorRects('candle_stroke', 50, px, up, space)).toEqual(hollow);
    expect(barcolorRects('candle_stroke', 50, px, down, space)).toEqual(hollow);
  });

  it('candle_up_stroke / candle_down_stroke: hollow only in their direction', () => {
    expect(barcolorRects('candle_up_stroke', 50, px, up, space)).toEqual(hollow);
    expect(barcolorRects('candle_up_stroke', 50, px, down, space)).toEqual(solid);
    expect(barcolorRects('candle_down_stroke', 50, px, down, space)).toEqual(hollow);
    expect(barcolorRects('candle_down_stroke', 50, px, up, space)).toEqual(solid);
  });

  it('ohlc: vertical bar with the open tick on the left and the close tick on the right', () => {
    // size = min(max(round(8·0.2), 1), 8) = 2, half 1
    expect(barcolorRects('ohlc', 50, px, up, space)).toEqual([
      { x: 49, y: 100, w: 2, h: 60, stroke: false },
      { x: 46, y: 120, w: 3, h: 2, stroke: false },
      { x: 51, y: 140, w: 3, h: 2, stroke: false },
    ]);
    // ticks are kept inside the bar at the low end
    const atLow = barcolorRects('ohlc', 50, { open: 159, close: 100, high: 100, low: 160 }, down, space);
    expect(atLow[1]).toEqual({ x: 46, y: 158, w: 3, h: 2, stroke: false });
  });

  it('area: nothing to recolor', () => {
    expect(barcolorRects('area', 50, px, up, space)).toEqual([]);
  });
});

describe('drawWyckoff bar styles', () => {
  const data = [{ open: 10, high: 12, low: 8, close: 11 }];
  const result: WyckoffBarResult[] = [{ barColor: C.lime, signals: [], boxes: [] }];

  it('hollow candles get a stroke-only recolored body', () => {
    const { calls } = run(data, result, undefined, 'candle_stroke');
    expect(calls.filter(([n]) => n === 'strokeRect')).toHaveLength(1);
    expect(calls.filter(([n, a]) => n === 'fillRect' && a[4] === C.lime)).toHaveLength(2); // the two wick halves
  });

  it('area charts are not recolored', () => {
    const { calls } = run(data, result, undefined, 'area');
    expect(calls.filter(([n, a]) => n === 'fillRect' && a[4] === C.lime)).toHaveLength(0);
  });
});
