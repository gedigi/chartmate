import { beforeEach, describe, expect, it, vi } from 'vitest';

const k = vi.hoisted(() => ({ templates: new Map<string, Record<string, any>>() }));
vi.mock('klinecharts', async () => {
  const actual = await vi.importActual<typeof import('klinecharts')>('klinecharts');
  return { getOverlayClass: actual.getOverlayClass, registerOverlay: (t: { name: string }) => { k.templates.set(t.name, t); } };
});

const P = await import('../../src/chart/positionOverlay');
const { drawingConstraint } = await import('../../src/chart/drawingTemplates');
const { evaluateOutcome, positionMetrics, toPositionPoints } = await import('../../src/chart/position');
const { parseColor } = await import('../../src/chart/color');
type PositionOutcome = import('../../src/chart/position').PositionOutcome;
const { positionContext, positionFigures, positionState, registerPositionOverlays } = P;

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const g = { start: T0, end: T0 + 20 * DAY, entry: 100, target: 102, stop: 98 };
const colors = { up: '#26a69a', down: '#ef5350', neutral: '#868b98' };
const coords = [{ x: 10, y: 100 }, { x: 10, y: 80 }, { x: 10, y: 120 }, { x: 210, y: 100 }];
type B = { timestamp: number; open: number; high: number; low: number; close: number };
const bar = (i: number, open: number, high: number, low: number, close = (high + low) / 2): B => ({ timestamp: T0 + i * DAY, open, high, low, close });
const fill = bar(0, 100, 100.5, 99.5); // touches the entry on the start bar
const metrics = positionMetrics('long', g);
const base = {
  side: 'long' as const, g, coords, precision: 2, metrics, outcome: { kind: 'waiting' } as PositionOutcome, colors,
  xOf: (ts: number) => 10 + ((ts - T0) / DAY) * 10, yOf: (v: number) => 100 - (v - 100) * 10,
  formatTime: (ts: number) => new Date(ts).toISOString().slice(0, 10), font: { family: 'Arial', size: 12 }, paneWidth: 800,
};
const withBars = (bars: B[], over: Partial<typeof base> = {}) => {
  const b = { ...base, ...over };
  return positionFigures({ ...b, outcome: evaluateOutcome(bars, b.side, b.g, { historyComplete: true }) }) as Fig[];
};
type Fig = { type: string; attrs: any; styles?: any; ignoreEvent?: unknown };
const texts = (f: Fig[]) => f.filter((x) => x.type === 'text').map((x) => x.attrs.text as string);
const label = (f: Fig[], prefix: string) => f.find((x) => x.type === 'text' && String(x.attrs.text).startsWith(prefix))!;

describe('positionFigures', () => {
  it('profit zone (entry→target, up color 20 %) and loss zone (entry→stop, down color 20 %) from entry to end time', () => {
    const f = positionFigures(base) as Fig[];
    const rects = f.filter((x) => x.type === 'rect');
    expect(rects[0]).toMatchObject({ attrs: { x: 10, y: 80, width: 200, height: 20 }, styles: { style: 'fill', color: 'rgba(38,166,154,0.12)' } });
    expect(rects[1]).toMatchObject({ attrs: { x: 10, y: 100, width: 200, height: 20 }, styles: { style: 'fill', color: 'rgba(239,83,80,0.12)' } });
    expect(f.find((x) => x.type === 'line')).toMatchObject({ attrs: { coordinates: [{ x: 10, y: 100 }, { x: 210, y: 100 }] } });
  });

  it('with the chart background known, zones are light fills of one perceived weight (color.ts zoneTint)', async () => {
    const { zoneTint } = await import('../../src/chart/color');
    const light = { up: '#0b9da0', down: '#c43d68', neutral: '#545c6f', bg: '#ffffff' };
    const rects = (positionFigures({ ...base, colors: light }) as Fig[]).filter((x) => x.type === 'rect');
    expect(rects[0]!.styles.color).toBe(zoneTint('#0b9da0', '#ffffff', P.ZONE_WEIGHT, P.ZONE_ALPHA));
    expect(rects[1]!.styles.color).toBe(zoneTint('#c43d68', '#ffffff', P.ZONE_WEIGHT, P.ZONE_ALPHA));
    for (const r of rects) expect(parseColor(r.styles.color)!.alpha).toBeLessThanOrEqual(P.ZONE_ALPHA);
  });

  it('labels: target, stop, center (contrast-aware text, theme font) and the waiting state in a neutral style', () => {
    const f = positionFigures(base) as Fig[];
    expect(texts(f)).toEqual(['Target: 102.00 (+2.00%)', 'Stop: 98.00 (-2.00%)', 'Long · R:R 1.00', 'Waiting for entry']);
    const target = label(f, 'Target');
    expect(target.ignoreEvent).toBe(true);
    expect(target.styles).toMatchObject({ backgroundColor: '#26a69a', color: '#ffffff', family: 'Arial', size: 12 });
    // Centered on the box (x 110).
    expect(target.attrs).toMatchObject({ x: 110, y: 78, align: 'center', baseline: 'bottom' });
    // Kept fully inside the pane: a box at the left edge moves its labels right by half their width.
    const edge = positionFigures({ ...base, coords: coords.map((c) => ({ ...c, x: c.x - 10 })).map((c, i) => (i === 3 ? { ...c, x: 40 } : c)) }) as Fig[];
    const half = (label(edge, 'Target').attrs.text.length * 12 * 0.6 + 8) / 2;
    expect(label(edge, 'Target').attrs.x).toBeCloseTo(half);
    expect(label(f, 'Stop').attrs).toMatchObject({ y: 122, baseline: 'top' });
    expect(label(f, 'Waiting').styles).toMatchObject({ backgroundColor: '#868b98' });
    expect(f.filter((x) => x.type === 'rect')).toHaveLength(2); // no traversed shading
    const light = positionFigures({ ...base, colors: { ...colors, up: '#c8f7c5' } }) as Fig[];
    expect(label(light, 'Target').styles.color).toBe('#131722');
  });

  it('needs earlier data: neutral label, no shading', () => {
    const f = positionFigures({ ...base, outcome: { kind: 'needsData' } }) as Fig[];
    expect(label(f, 'Outcome needs earlier data').styles).toMatchObject({ backgroundColor: '#868b98' });
    expect(f.filter((x) => x.type === 'rect')).toHaveLength(2);
  });

  it('target hit: label with the % result and date, the profit zone shaded more strongly from the fill bar to the hit bar', () => {
    const f = withBars([bar(1, 100, 100.5, 99.5), bar(3, 101, 101.5, 99.5), bar(5, 101, 103, 100.5)]);
    expect(texts(f)).toContain('Target hit · +2.00% · 2024-01-06');
    const strong = f.filter((x) => x.type === 'rect')[2]!;
    expect(strong).toMatchObject({ attrs: { x: 20, y: 80, width: 40, height: 20 }, styles: { color: 'rgba(38,166,154,0.16)' } });
  });

  it('stop hit shades the loss zone; open shades from the entry to the last close', () => {
    const stop = withBars([fill, bar(2, 99, 100, 97)]);
    expect(texts(stop)).toContain('Stop hit · -2.00% · 2024-01-03');
    expect(stop.filter((x) => x.type === 'rect')[2]).toMatchObject({ attrs: { x: 10, y: 100, width: 20, height: 20 }, styles: { color: 'rgba(239,83,80,0.16)' } });
    const open = withBars([fill, bar(4, 100, 101.5, 99.5, 101)]);
    expect(texts(open)).toContain('Open · +1.00%');
    expect(open.filter((x) => x.type === 'rect')[2]).toMatchObject({ attrs: { x: 10, y: 90, width: 40, height: 10 } });
  });

  it('a box wider than the pane keeps its labels in the visible part', () => {
    const wide = [{ x: -500, y: 100 }, { x: -500, y: 80 }, { x: -500, y: 120 }, { x: 2000, y: 100 }];
    const f = positionFigures({ ...base, coords: wide }) as Fig[];
    for (const t of f.filter((x) => x.type === 'text')) expect(t.attrs.x, t.attrs.text).toBe(400);
    const leftCut = [{ x: -500, y: 100 }, { x: -500, y: 80 }, { x: -500, y: 120 }, { x: 100, y: 100 }];
    const g2 = positionFigures({ ...base, coords: leftCut }) as Fig[];
    // Visible part [0, 100] is narrower than the labels: they stay fully on the pane (not cut at x = 0).
    const target = label(g2, 'Target');
    const half = (target.attrs.text.length * 12 * 0.6 + 8) / 2;
    expect(target.attrs.x).toBeGreaterThanOrEqual(half);
  });

  it('a box narrower than the center / outcome labels shows them outside, right of the box', () => {
    const narrow = [{ x: 300, y: 100 }, { x: 300, y: 80 }, { x: 300, y: 120 }, { x: 320, y: 100 }];
    const f = positionFigures({ ...base, coords: narrow }) as Fig[];
    expect(label(f, 'Long').attrs).toMatchObject({ x: 324, align: 'left' });
    expect(label(f, 'Waiting').attrs).toMatchObject({ x: 324, align: 'left' });
  });

  it('without room beside the box, the center / outcome labels stay centered and fully on the pane', () => {
    const mid = [{ x: 140, y: 100 }, { x: 140, y: 80 }, { x: 140, y: 120 }, { x: 390, y: 100 }];
    const f = positionFigures({ ...base, coords: mid, paneWidth: 530, outcome: { kind: 'stop', fillTs: T0, ts: T0 + 2 * DAY, price: 98, pnlPct: -2 } }) as Fig[];
    const o = label(f, 'Stop hit');
    const w = o.attrs.text.length * 12 * 0.6 + 8;
    expect(o.attrs.align).toBe('center');
    expect(o.attrs.x - w / 2).toBeGreaterThanOrEqual(0);
    expect(o.attrs.x + w / 2).toBeLessThanOrEqual(530);
  });

  it('a narrow box with a short stop zone: the outcome label goes beside the box, beyond the stop label (no overlap)', () => {
    const narrowFlat = [{ x: 300, y: 100 }, { x: 300, y: 95 }, { x: 300, y: 105 }, { x: 320, y: 100 }];
    const f = positionFigures({ ...base, coords: narrowFlat }) as Fig[];
    expect(label(f, 'Stop').attrs).toMatchObject({ y: 107, baseline: 'top' });
    expect(label(f, 'Waiting').attrs).toMatchObject({ x: 324, align: 'left', y: 107 + 12 + 8, baseline: 'top' });
  });

  it('a zone too short for the outcome label puts it outside, beyond the stop label', () => {
    const flat = [{ x: 10, y: 100 }, { x: 10, y: 95 }, { x: 10, y: 105 }, { x: 410, y: 100 }];
    const f = positionFigures({ ...base, coords: flat }) as Fig[];
    const stop = label(f, 'Stop');
    expect(stop.attrs).toMatchObject({ y: 107, baseline: 'top' });
    expect(label(f, 'Waiting').attrs).toMatchObject({ y: 107 + 12 + 8, baseline: 'top' });
    const tall = [{ x: 10, y: 100 }, { x: 10, y: 40 }, { x: 10, y: 160 }, { x: 410, y: 100 }];
    const roomy = positionFigures({ ...base, coords: tall }) as Fig[];
    expect(label(roomy, 'Waiting').attrs).toMatchObject({ y: 120, baseline: 'middle' }); // inside, near the entry
  });

  it('labels wider than the pane are truncated with an ellipsis', () => {
    const f = positionFigures({ ...base, paneWidth: 100 }) as Fig[];
    const t = label(f, 'Target');
    expect(t.attrs.text.endsWith('…')).toBe(true);
    expect(t.attrs.text.length * 12 * 0.6 + 8).toBeLessThanOrEqual(100);
  });

  it('nothing without the four points', () => {
    expect(positionFigures({ ...base, coords: coords.slice(0, 1) })).toEqual([]);
  });
});

describe('memoized position state', () => {
  it('reuses metrics / outcome while the points and data are unchanged; recomputes when the last bar changes', () => {
    const bars: B[] = [fill, bar(1, 100, 101, 99.5, 100.5)];
    const input = { id: 'p1', side: 'long' as const, g, bars, historyComplete: true, barMs: DAY };
    const a = positionState(input);
    expect(a.outcome).toMatchObject({ kind: 'open', price: 100.5 });
    expect(positionState({ ...input, g: { ...g } })).toBe(a);
    bars[1] = { ...bars[1]!, close: 101, high: 101.2 }; // polling updates the forming bar in place
    const b = positionState(input);
    expect(b).not.toBe(a);
    expect(b.outcome).toMatchObject({ kind: 'open', price: 101 });
    expect(positionState({ ...input, g: { ...g, target: 101.1 } }).outcome).toMatchObject({ kind: 'target' });
    expect(positionState({ ...input, historyComplete: false, bars: [bar(1, 100, 101, 99)], g: { ...g, start: T0 - DAY } }).outcome).toEqual({ kind: 'needsData' });
  });
});

describe('position overlay templates', () => {
  beforeEach(() => {
    k.templates.clear();
    registerPositionOverlays(true);
  });

  it('registers longPosition / shortPosition: one click (totalStep 2), default point handles', () => {
    for (const name of ['longPosition', 'shortPosition']) {
      const t = k.templates.get(name)!;
      expect(t).toMatchObject({ name, totalStep: 2, needDefaultPointFigure: true });
    }
  });

  it('while placing, the entry point drags the default target / stop (±2 %) and end (endFor) along', () => {
    drawingConstraint.precision = 2;
    positionContext.endFor = (ts) => ts + 20 * DAY;
    const points: any[] = [{ timestamp: T0, value: 100.004 }];
    k.templates.get('shortPosition')!.performEventMoveForDrawing({ points, performPointIndex: 0, currentStep: 1, mode: 'normal', performPoint: points[0] });
    expect(points).toEqual([
      { timestamp: T0, value: 100.004 }, { timestamp: T0, value: 98 }, { timestamp: T0, value: 102 }, { timestamp: T0 + 20 * DAY, value: 100 },
    ]);
  });

  it('while placing, the target / stop follow the default distances ("Use as default")', () => {
    drawingConstraint.precision = 2;
    positionContext.endFor = (ts) => ts + 20 * DAY;
    positionContext.defaults = { targetPct: 5, stopPct: 1 };
    const points: any[] = [{ timestamp: T0, value: 100 }];
    k.templates.get('longPosition')!.performEventMoveForDrawing({ points, performPointIndex: 0, currentStep: 1, mode: 'normal', performPoint: points[0] });
    expect(points.slice(1, 3)).toEqual([{ timestamp: T0, value: 105 }, { timestamp: T0, value: 99 }]);
    positionContext.defaults = { targetPct: 2, stopPct: 2 };
  });

  it('point drags follow the position drag rules', () => {
    drawingConstraint.precision = 2;
    positionContext.barMs = DAY;
    const points: any[] = toPositionPoints(g);
    points[1] = { timestamp: T0 + DAY, value: 104 };
    k.templates.get('longPosition')!.performEventPressedMove({ points, performPointIndex: 1, currentStep: -1, mode: 'normal', performPoint: points[1] });
    expect(points[1]).toEqual({ timestamp: T0, value: 104 });
  });

  it('the right edge stops at the next bar (positionContext.minEnd)', () => {
    drawingConstraint.precision = 2;
    positionContext.minEnd = () => T0 + 3 * DAY;
    const points: any[] = toPositionPoints(g);
    points[3] = { timestamp: T0, value: 100 };
    k.templates.get('longPosition')!.performEventPressedMove({ points, performPointIndex: 3, currentStep: -1, mode: 'normal', performPoint: points[3] });
    expect(points[3]).toEqual({ timestamp: T0 + 3 * DAY, value: 100 });
  });

  it('rendering: memoized outcome from the chart data, history state from the context, handle gap from the y axis', () => {
    const data = [{ timestamp: T0 + DAY, open: 105, high: 105.5, low: 104.5, close: 105 }]; // never touches the entry
    const chart = {
      getStyles: () => ({ overlay: { text: { family: 'Arial', size: 12 } } }), getSymbol: () => ({ pricePrecision: 2 }), getDataList: () => data,
    };
    const yAxis = { convertToPixel: (v: number) => 100 - (v - 100) * 10, convertFromPixel: (px: number) => 100 - (px - 100) / 10 };
    const xAxis = { convertTimestampToPixel: (ts: number) => 10 + ((ts - T0) / DAY) * 10 };
    const params = { chart, overlay: { id: 'ov', points: toPositionPoints(g), styles: null }, coordinates: coords, bounding: { width: 800 }, xAxis, yAxis };
    positionContext.historyComplete = () => false;
    const figs = k.templates.get('longPosition')!.createPointFigures(params) as Fig[];
    expect(texts(figs)).toContain('Outcome needs earlier data');
    expect(positionContext.minGapPrice).toBeCloseTo(1.2); // 12 px
    positionContext.historyComplete = () => true;
    expect(texts(k.templates.get('longPosition')!.createPointFigures(params) as Fig[])).toContain('Waiting for entry');
  });
});
