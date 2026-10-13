import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real KLineChart overlay classes (pure JS, no canvas needed); registerOverlay is captured.
const k = vi.hoisted(() => ({ templates: new Map<string, Record<string, any>>() }));
vi.mock('klinecharts', async () => {
  const actual = await vi.importActual<typeof import('klinecharts')>('klinecharts');
  return {
    getOverlayClass: actual.getOverlayClass,
    registerOverlay: (t: { name: string }) => { k.templates.set(t.name, t); },
  };
});

const T = await import('../../src/chart/drawingTemplates');
const { roundPrice, constrainForDrawing, constrainPointMove, flattenBase, channelMidline, midlineDash, labelOptions, drawingConstraint } = T;

type P = { timestamp?: number; value?: number; dataIndex?: number };
const pts = (...values: number[]): P[] => values.map((value, i) => ({ timestamp: 1000 * (i + 1), dataIndex: i, value }));

describe('roundPrice', () => {
  it('rounds to the given decimals without binary noise', () => {
    expect(roundPrice(1.005, 2)).toBe(1.01);
    expect(roundPrice(84123.456789, 2)).toBe(84123.46);
    expect(roundPrice(0.1 + 0.2, 8)).toBe(0.3);
    expect(roundPrice(12.7, 0)).toBe(13);
  });
});

describe('Shift: horizontal constraint (pure functions)', () => {
  it('while placing, the point being placed takes the (rounded) price of the first point', () => {
    for (const name of ['segment', 'rayLine', 'straightLine']) {
      const p = pts(100.123, 140.5);
      constrainForDrawing(name, p, 1, 2);
      expect(p.map((x) => x.value), name).toEqual([100.12, 100.12]);
      expect(p.map((x) => x.timestamp), name).toEqual([1000, 2000]); // time is untouched
    }
  });

  it('while placing, the first point alone is left alone, and other tools are not constrained', () => {
    const first = pts(100.123);
    constrainForDrawing('segment', first, 0, 2);
    expect(first[0]!.value).toBe(100.123);
    const fib = pts(1, 2);
    constrainForDrawing('fibonacciLine', fib, 1, 2);
    expect(fib.map((x) => x.value)).toEqual([1, 2]);
  });

  it('parallel channel: the two base points are constrained, the width (third) point stays free', () => {
    const p = pts(50, 60, 70);
    constrainForDrawing('parallelStraightLine', p, 1, 2);
    expect(p.map((x) => x.value)).toEqual([50, 50, 70]);
    constrainForDrawing('parallelStraightLine', p, 2, 2);
    expect(p.map((x) => x.value)).toEqual([50, 50, 70]);
  });

  it('dragging one endpoint: it takes the price of the opposite (fixed) point', () => {
    const a = pts(10, 20);
    constrainPointMove('segment', a, 1, 2);
    expect(a.map((x) => x.value)).toEqual([10, 10]);
    const b = pts(10, 20);
    constrainPointMove('rayLine', b, 0, 2);
    expect(b.map((x) => x.value)).toEqual([20, 20]);
    const ch = pts(10, 20, 30);
    constrainPointMove('parallelStraightLine', ch, 0, 2);
    expect(ch.map((x) => x.value)).toEqual([20, 20, 30]);
    constrainPointMove('parallelStraightLine', ch, 2, 2); // width point: free
    expect(ch.map((x) => x.value)).toEqual([20, 20, 30]);
  });

  it('dragging the whole line flattens the base points to the first one', () => {
    const a = pts(10.555, 20);
    flattenBase('straightLine', a, 2);
    expect(a.map((x) => x.value)).toEqual([10.56, 10.56]);
    const ch = pts(10, 20, 30);
    flattenBase('parallelStraightLine', ch, 2);
    expect(ch.map((x) => x.value)).toEqual([10, 10, 30]);
    const h = pts(1, 2);
    flattenBase('verticalStraightLine', h, 2);
    expect(h.map((x) => x.value)).toEqual([1, 2]);
  });
});

describe('channel midline geometry', () => {
  it('joins the midpoints of the corresponding endpoints of the two parallel lines', () => {
    const lines = [
      { coordinates: [{ x: 0, y: 10 }, { x: 200, y: 110 }] },
      { coordinates: [{ x: 0, y: 50 }, { x: 200, y: 150 }] },
    ];
    expect(channelMidline(lines)).toEqual({ coordinates: [{ x: 0, y: 30 }, { x: 200, y: 130 }] });
    expect(channelMidline(lines.slice(0, 1))).toBeNull(); // only the base line so far
  });

  it('is dashed; distinctly longer when the channel itself is dashed or dotted; scales with the width', () => {
    expect(midlineDash('solid', 1)).toEqual([6, 4]);
    expect(midlineDash('dashed', 1)).toEqual([14, 6]);
    expect(midlineDash('dotted', 1)).toEqual([14, 6]);
    expect(midlineDash('solid', 4)).toEqual([12, 8]);
  });

  it('reads a 1px dotted channel (square-dot pattern) as dotted', () => {
    const t = (k.templates.get('parallelStraightLine') ?? (T.registerDrawingTemplates(), k.templates.get('parallelStraightLine')))!;
    const bounding = { width: 200, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const chart = { getStyles: () => ({ overlay: { line: { color: '#2962ff', size: 1, style: 'solid' } } }) };
    const overlay = { styles: { line: { color: '#ff0000', size: 1, style: 'dashed', dashedValue: [1, 2], lineCap: 'butt' } } };
    const figs = t.createPointFigures({ chart, overlay, coordinates: [{ x: 0, y: 10 }, { x: 100, y: 60 }, { x: 0, y: 50 }], bounding });
    expect(figs[1].styles.dashedValue).toEqual(midlineDash('dotted', 1));
  });
});

describe('price label options', () => {
  it('defaults: price line on line + on axis; horizontal line on axis only; others none', () => {
    expect(labelOptions('priceLine', undefined)).toEqual({ onLine: true, onAxis: true });
    expect(labelOptions('horizontalStraightLine', null)).toEqual({ onLine: false, onAxis: true });
    expect(labelOptions('segment', undefined)).toBeNull();
    expect(labelOptions('priceLine', { altvLabel: { onLine: false } })).toEqual({ onLine: false, onAxis: true });
    expect(labelOptions('horizontalStraightLine', { altvLabel: { onLine: true, onAxis: false } })).toEqual({ onLine: true, onAxis: false });
  });
});

describe('registerDrawingTemplates (wrapping the real KLineChart templates)', () => {
  beforeEach(() => {
    T.registerDrawingTemplates();
    drawingConstraint.shift = false;
    drawingConstraint.precision = 2;
    drawingConstraint.draggingId = null;
  });
  const tpl = (name: string) => k.templates.get(name)!;
  const chart = (precision = 2) => ({
    getSymbol: () => ({ pricePrecision: precision }),
    getStyles: () => ({ overlay: { line: { color: '#2962ff', size: 1, style: 'solid' } } }),
  });

  it('re-registers the affected built-ins once, keeping their own behaviour', () => {
    T.registerDrawingTemplates();
    expect([...k.templates.keys()].sort()).toEqual(['horizontalStraightLine', 'parallelStraightLine', 'priceLine', 'rayLine', 'segment', 'straightLine']);
    expect(tpl('segment').totalStep).toBe(3);
    expect(tpl('parallelStraightLine').totalStep).toBe(4);
  });

  it('placing with Shift held keeps a trend line horizontal; without Shift it is free', () => {
    const t = tpl('segment');
    const p = pts(100, 150);
    t.performEventMoveForDrawing.call({ id: 'x', name: 'segment' }, { currentStep: 2, points: p, performPointIndex: 1, performPoint: p[1] });
    expect(p[1]!.value).toBe(150);
    drawingConstraint.shift = true;
    t.performEventMoveForDrawing.call({ id: 'x', name: 'segment' }, { currentStep: 2, points: p, performPointIndex: 1, performPoint: p[1] });
    expect(p.map((x) => x.value)).toEqual([100, 100]);
  });

  it('dragging a point with Shift held applies only to the overlay being dragged (never to restores/overrides)', () => {
    const t = tpl('rayLine');
    drawingConstraint.shift = true;
    const p = pts(10, 20);
    t.performEventPressedMove.call({ id: 'other', name: 'rayLine' }, { currentStep: -1, points: p, performPointIndex: 1, performPoint: p[1] });
    expect(p.map((x) => x.value)).toEqual([10, 20]);
    drawingConstraint.draggingId = 'me';
    t.performEventPressedMove.call({ id: 'me', name: 'rayLine' }, { currentStep: -1, points: p, performPointIndex: 1, performPoint: p[1] });
    expect(p.map((x) => x.value)).toEqual([10, 10]);
  });

  it('parallel channel draws a dashed midline through the midpoints, inheriting colour/width; none until the width point', () => {
    const t = tpl('parallelStraightLine');
    const bounding = { width: 200, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const two = t.createPointFigures({ chart: chart(), overlay: { styles: null }, coordinates: [{ x: 0, y: 10 }, { x: 100, y: 60 }], bounding });
    expect(two).toHaveLength(1);
    const overlay = { styles: { line: { color: '#ff0000', size: 2, style: 'dashed', dashedValue: [6, 4], lineCap: 'butt' } } };
    const figs = t.createPointFigures({ chart: chart(), overlay, coordinates: [{ x: 0, y: 10 }, { x: 100, y: 60 }, { x: 0, y: 50 }], bounding });
    expect(figs).toHaveLength(2);
    const [lines, mid] = figs;
    const [a, b] = lines.attrs as Array<{ coordinates: Array<{ x: number; y: number }> }>;
    expect(mid.type).toBe('line');
    expect(mid.attrs.coordinates).toEqual(a!.coordinates.map((c, i) => ({ x: c.x, y: (c.y + b!.coordinates[i]!.y) / 2 })));
    expect(mid.styles).toEqual({ style: 'dashed', dashedValue: midlineDash('dashed', 2), lineCap: 'butt' });
    expect(mid.styles).not.toHaveProperty('color'); // colour and width come from the channel's line style
  });

  it('price line: on-line text can be hidden; the axis label shows the exact price at the symbol precision', () => {
    const t = tpl('priceLine');
    expect(t.needDefaultYAxisFigure).toBe(false); // replaced by the persistent label below
    const bounding = { width: 300, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const yAxis = { isInCandle: () => true, isFromZero: () => false };
    const base = { chart: { ...chart(2), getDecimalFold: () => ({ format: (s: string) => s }), getThousandsSeparator: () => ({ format: (s: string) => s.replace(/^(\d+)(\d{3})/, '$1,$2') }) }, coordinates: [{ x: 10, y: 40 }], bounding, yAxis };
    const shown = t.createPointFigures({ ...base, overlay: { points: [{ value: 84123.45 }], styles: null } });
    expect(shown.map((f: { type: string }) => f.type)).toEqual(['line', 'text']);
    const hidden = t.createPointFigures({ ...base, overlay: { points: [{ value: 84123.45 }], styles: { altvLabel: { onLine: false, onAxis: true } } } });
    expect(hidden.map((f: { type: string }) => f.type)).toEqual(['line']);
    const axis = t.createYAxisFigures({ ...base, overlay: { points: [{ value: 84123.4 }], styles: null } });
    expect(axis).toEqual([expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ text: '84,123.40', y: 40, x: 300, align: 'right' }) })]);
    expect(t.createYAxisFigures({ ...base, overlay: { points: [{ value: 1 }], styles: { altvLabel: { onAxis: false } } } })).toEqual([]);
  });

  it('horizontal line: no text on the line by default, can be turned on; axis label on by default', () => {
    const t = tpl('horizontalStraightLine');
    const bounding = { width: 300, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const base = { chart: chart(3), coordinates: [{ x: 10, y: 40 }], bounding, yAxis: { isFromZero: () => true } };
    expect(t.createPointFigures({ ...base, overlay: { points: [{ value: 5 }], styles: null } }).map((f: { type: string }) => f.type)).toEqual(['line']);
    const on = t.createPointFigures({ ...base, overlay: { points: [{ value: 5 }], styles: { altvLabel: { onLine: true, onAxis: true } } } });
    expect(on.map((f: { type: string }) => f.type)).toEqual(['line', 'text']);
    expect(on[1].attrs.text).toBe('5.000');
    expect(t.createYAxisFigures({ ...base, overlay: { points: [{ value: 5 }], styles: null } })[0].attrs).toMatchObject({ text: '5.000', x: 0, align: 'left' });
  });
});

// Last: it swaps the registered templates for a fresh module instance's (as HMR does).
describe('registerDrawingTemplates across module instances (HMR)', () => {
  const chart = () => ({ getStyles: () => ({ overlay: { line: { color: '#2962ff', size: 1, style: 'solid' } } }) });
  it('never wraps an already wrapped template (HMR re-runs the module: the midline must not be drawn twice)', async () => {
    // A fresh module instance (as after HMR) whose getOverlayClass now returns the classes registered above.
    const actual = await vi.importActual<typeof import('klinecharts')>('klinecharts');
    for (const t of k.templates.values()) actual.registerOverlay(t as never);
    vi.resetModules();
    vi.doMock('klinecharts', () => ({
      getOverlayClass: actual.getOverlayClass,
      registerOverlay: (t: { name: string }) => { k.templates.set(t.name, t); },
    }));
    const fresh = await import('../../src/chart/drawingTemplates');
    fresh.registerDrawingTemplates();
    const t = k.templates.get('parallelStraightLine')!;
    const bounding = { width: 200, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const figs = t.createPointFigures({ chart: chart(), overlay: { styles: null }, coordinates: [{ x: 0, y: 10 }, { x: 100, y: 60 }, { x: 0, y: 50 }], bounding });
    expect(figs.filter((f: { type: string; attrs: unknown }) => f.type === 'line' && !Array.isArray(f.attrs))).toHaveLength(1); // one midline
    expect(t[fresh.WRAPPED_MARK]).toBe(true);
    vi.doUnmock('klinecharts');
  });
});
