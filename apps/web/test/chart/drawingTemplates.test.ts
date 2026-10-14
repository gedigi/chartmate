import { readableTextOn } from '../../src/chart/contrast';
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
const { roundPrice, constrainForDrawing, constrainPointMove, flattenBase, channelMidline, midlineDash, labelOptions, drawingConstraint, channelGeometry, extendOptions } = T;

type Fig = { type: string; attrs: any; styles?: any; ignoreEvent?: boolean };
/** The channel's midline figure (a single line; the channel's own lines are one figure with an array of lines). */
const midOf = (figs: Fig[]) => figs.find((f) => f.type === 'line' && !Array.isArray(f.attrs));
const linesOf = (figs: Fig[]) => figs.find((f) => f.type === 'line' && Array.isArray(f.attrs))!.attrs as Array<{ coordinates: Array<{ x: number; y: number }> }>;

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

  it('parallel channel (new and legacy): the two base points are constrained, the width (third) point stays free', () => {
    const n = pts(50, 60, 70);
    constrainForDrawing('parallelChannel', n, 1, 2);
    expect(n.map((x) => x.value)).toEqual([50, 50, 70]);
    const f = pts(10, 20, 30);
    flattenBase('parallelChannel', f, 2);
    expect(f.map((x) => x.value)).toEqual([10, 10, 30]);
    const m = pts(10, 20, 30);
    constrainPointMove('parallelChannel', m, 1, 2);
    expect(m.map((x) => x.value)).toEqual([10, 10, 30]);
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
    expect(midOf(figs)!.styles.dashedValue).toEqual(midlineDash('dotted', 1));
  });
});

describe('channel geometry (finite / extended)', () => {
  const B = { width: 400, height: 300 };
  const C = [{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 150, y: 175 }];
  const none = { left: false, right: false };

  it('finite: both lines span exactly from the first to the second point; the offset comes from the third point', () => {
    const g = channelGeometry(C, B, none);
    expect(g.lines).toEqual([
      { coordinates: [{ x: 100, y: 50 }, { x: 200, y: 100 }] },
      { coordinates: [{ x: 100, y: 150 }, { x: 200, y: 200 }] },
    ]);
    expect(g.midline).toEqual({ coordinates: [{ x: 100, y: 100 }, { x: 200, y: 150 }] });
    expect(g.fill).toEqual([{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 150 }]);
  });

  it('left / right are screen directions whichever way the base was drawn', () => {
    const g = channelGeometry([C[1]!, C[0]!, C[2]!], B, { left: false, right: true });
    expect(g.lines[0]).toEqual({ coordinates: [{ x: 100, y: 50 }, { x: 400, y: 200 }] });
  });

  it('extend left / right / both', () => {
    expect(channelGeometry(C, B, { left: true, right: false }).lines).toEqual([
      { coordinates: [{ x: 0, y: 0 }, { x: 200, y: 100 }] },
      { coordinates: [{ x: 0, y: 100 }, { x: 200, y: 200 }] },
    ]);
    const r = channelGeometry(C, B, { left: false, right: true });
    expect(r.lines[1]).toEqual({ coordinates: [{ x: 100, y: 150 }, { x: 400, y: 300 }] });
    expect(r.midline).toEqual({ coordinates: [{ x: 100, y: 100 }, { x: 400, y: 250 }] });
    expect(r.fill).toEqual([{ x: 100, y: 50 }, { x: 400, y: 200 }, { x: 400, y: 300 }, { x: 100, y: 150 }]);
    const both = channelGeometry(C, B, { left: true, right: true });
    expect(both.lines[0]).toEqual({ coordinates: [{ x: 0, y: 0 }, { x: 400, y: 200 }] }); // = the old infinite channel
  });

  it('the third point on the other side of the base: the parallel line lies on that side (fill too)', () => {
    const g = channelGeometry([C[0]!, C[1]!, { x: 150, y: 25 }], B, none); // base at x=150 is y=75: offset -50
    expect(g.lines[1]).toEqual({ coordinates: [{ x: 100, y: 0 }, { x: 200, y: 50 }] });
    expect(g.midline).toEqual({ coordinates: [{ x: 100, y: 25 }, { x: 200, y: 75 }] });
    expect(g.fill).toEqual([{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 200, y: 50 }, { x: 100, y: 0 }]);
  });

  it('a reversed base (drawn right to left) extends by screen side too', () => {
    const rev = [C[1]!, C[0]!, C[2]!];
    expect(channelGeometry(rev, B, none).lines[0]).toEqual({ coordinates: [{ x: 100, y: 50 }, { x: 200, y: 100 }] });
    const l = channelGeometry(rev, B, { left: true, right: false });
    expect(l.lines).toEqual([
      { coordinates: [{ x: 0, y: 0 }, { x: 200, y: 100 }] },
      { coordinates: [{ x: 0, y: 100 }, { x: 200, y: 200 }] },
    ]);
    expect(l.midline).toEqual({ coordinates: [{ x: 0, y: 50 }, { x: 200, y: 150 }] });
    expect(channelGeometry(rev, B, { left: true, right: true }).lines[1]).toEqual({ coordinates: [{ x: 0, y: 100 }, { x: 400, y: 300 }] });
  });

  it('extending never shortens a base reaching past the pane edge', () => {
    const g = channelGeometry([{ x: -50, y: 0 }, { x: 500, y: 0 }, { x: 0, y: 10 }], B, { left: true, right: true });
    expect(g.lines[0]).toEqual({ coordinates: [{ x: -50, y: 0 }, { x: 500, y: 0 }] });
  });

  it('only the base line while placing; nothing for a single point', () => {
    const g = channelGeometry(C.slice(0, 2), B, none);
    expect(g).toEqual({ lines: [{ coordinates: [{ x: 100, y: 50 }, { x: 200, y: 100 }] }], midline: null, fill: null });
    expect(channelGeometry(C.slice(0, 1), B, none)).toEqual({ lines: [], midline: null, fill: null });
  });

  it('a vertical base: finite vertical segments offset horizontally; extend reaches the pane top / bottom', () => {
    const v = [{ x: 100, y: 50 }, { x: 100, y: 150 }, { x: 160, y: 80 }];
    expect(channelGeometry(v, B, none).lines).toEqual([
      { coordinates: [{ x: 100, y: 50 }, { x: 100, y: 150 }] },
      { coordinates: [{ x: 160, y: 50 }, { x: 160, y: 150 }] },
    ]);
    const both = channelGeometry(v, B, { left: true, right: true });
    expect(both.lines).toEqual([
      { coordinates: [{ x: 100, y: 0 }, { x: 100, y: 300 }] },
      { coordinates: [{ x: 160, y: 0 }, { x: 160, y: 300 }] },
    ]);
    expect(both.midline).toEqual({ coordinates: [{ x: 130, y: 0 }, { x: 130, y: 300 }] });
    // left = past the upper end, right = past the lower end (whichever point was placed first).
    const rv = [v[1]!, v[0]!, v[2]!];
    expect(channelGeometry(rv, B, { left: true, right: false }).lines[0]).toEqual({ coordinates: [{ x: 100, y: 0 }, { x: 100, y: 150 }] });
    expect(channelGeometry(rv, B, { left: false, right: true }).lines[0]).toEqual({ coordinates: [{ x: 100, y: 50 }, { x: 100, y: 300 }] });
  });
});

describe('extend options', () => {
  it('new channels default to finite; legacy channels (no extend) to extended both ways; own options win', () => {
    expect(extendOptions('parallelChannel', undefined)).toEqual({ left: false, right: false });
    expect(extendOptions('parallelStraightLine', null)).toEqual({ left: true, right: true });
    expect(extendOptions('parallelChannel', { chartmateExtend: { right: true } })).toEqual({ left: false, right: true });
    expect(extendOptions('parallelStraightLine', { chartmateExtend: { left: false } })).toEqual({ left: false, right: true });
    expect(extendOptions('segment', undefined)).toBeNull();
  });
});

describe('price label options', () => {
  it('defaults: price line on line + on axis; horizontal line on axis only; others none', () => {
    expect(labelOptions('priceLine', undefined)).toEqual({ onLine: true, onAxis: true });
    expect(labelOptions('horizontalStraightLine', null)).toEqual({ onLine: false, onAxis: true });
    expect(labelOptions('segment', undefined)).toBeNull();
    expect(labelOptions('priceLine', { chartmateLabel: { onLine: false } })).toEqual({ onLine: false, onAxis: true });
    expect(labelOptions('horizontalStraightLine', { chartmateLabel: { onLine: true, onAxis: false } })).toEqual({ onLine: true, onAxis: false });
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

  it('re-registers the affected built-ins once, keeping their own behavior', () => {
    T.registerDrawingTemplates();
    expect([...k.templates.keys()].sort()).toEqual(['horizontalStraightLine', 'parallelChannel', 'parallelStraightLine', 'priceLine', 'rayLine', 'segment', 'straightLine']);
    expect(tpl('segment').totalStep).toBe(3);
    expect(tpl('parallelStraightLine').totalStep).toBe(4);
    expect(tpl('parallelChannel')).toMatchObject({ name: 'parallelChannel', totalStep: 4, needDefaultPointFigure: true });
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

  it('legacy channel (no extend): infinite lines across the pane, as KLineChart drew them, plus the midline', () => {
    const t = tpl('parallelStraightLine');
    const bounding = { width: 200, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const two = t.createPointFigures({ chart: chart(), overlay: { name: 'parallelStraightLine', styles: null }, coordinates: [{ x: 50, y: 10 }, { x: 100, y: 60 }], bounding });
    expect(linesOf(two)).toEqual([{ coordinates: [{ x: 0, y: -40 }, { x: 200, y: 160 }] }]);
    expect(midOf(two)).toBeUndefined();
    const overlay = { name: 'parallelStraightLine', styles: { line: { color: '#ff0000', size: 2, style: 'dashed', dashedValue: [6, 4], lineCap: 'butt' } } };
    const figs = t.createPointFigures({ chart: chart(), overlay, coordinates: [{ x: 50, y: 10 }, { x: 100, y: 60 }, { x: 50, y: 50 }], bounding });
    expect(figs.map((f: Fig) => f.type)).not.toContain('polygon'); // exactly as before: no fill
    expect(figs.map((f: Fig) => f.type)).toEqual(['line', 'line']);
    const [a, b] = linesOf(figs);
    expect(a).toEqual({ coordinates: [{ x: 0, y: -40 }, { x: 200, y: 160 }] });
    expect(b).toEqual({ coordinates: [{ x: 0, y: 0 }, { x: 200, y: 200 }] });
    const mid = midOf(figs)!;
    expect(mid.attrs.coordinates).toEqual([{ x: 0, y: -20 }, { x: 200, y: 180 }]);
    expect(mid.styles).toEqual({ style: 'dashed', dashedValue: midlineDash('dashed', 2), lineCap: 'butt' });
    expect(mid.styles).not.toHaveProperty('color'); // color and width come from the channel's line style
  });

  it('new channel: finite by default; lines and midline span the first to the second point, a translucent fill between', () => {
    const t = tpl('parallelChannel');
    const bounding = { width: 400, height: 300, left: 0, top: 0, right: 0, bottom: 0 };
    const coords = [{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 150, y: 175 }];
    const two = t.createPointFigures({ chart: chart(), overlay: { name: 'parallelChannel', styles: null }, coordinates: coords.slice(0, 2), bounding });
    expect(two.map((f: Fig) => f.type)).toEqual(['line']); // the base segment only while placing the width point
    expect(linesOf(two)).toEqual([{ coordinates: [{ x: 100, y: 50 }, { x: 200, y: 100 }] }]);
    const figs = t.createPointFigures({ chart: chart(), overlay: { name: 'parallelChannel', styles: { line: { color: '#ff0000', size: 1, style: 'solid' } } }, coordinates: coords, bounding });
    expect(figs.map((f: Fig) => f.type)).toEqual(['polygon', 'line', 'line']); // fill under the lines
    expect(linesOf(figs)).toEqual([
      { coordinates: [{ x: 100, y: 50 }, { x: 200, y: 100 }] },
      { coordinates: [{ x: 100, y: 150 }, { x: 200, y: 200 }] },
    ]);
    expect(midOf(figs)!.attrs.coordinates).toEqual([{ x: 100, y: 100 }, { x: 200, y: 150 }]);
    const fill = figs[0];
    expect(fill.attrs.coordinates).toEqual([{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 150 }]);
    expect(fill.styles).toMatchObject({ style: 'fill', color: 'rgba(255, 0, 0, 0.08)' });
    expect(fill.ignoreEvent).toEqual(['onRightClick']); // left click selects / drags; right click (remove) is ignored
    // Default (theme) line color when the channel has none of its own.
    const plain = t.createPointFigures({ chart: chart(), overlay: { name: 'parallelChannel', styles: null }, coordinates: coords, bounding });
    expect(plain[0].styles.color).toBe('rgba(41, 98, 255, 0.08)');
  });

  it('new channel: extend toggles (styles) extend the lines, the midline and the fill', () => {
    const t = tpl('parallelChannel');
    const bounding = { width: 400, height: 300, left: 0, top: 0, right: 0, bottom: 0 };
    const coords = [{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 150, y: 175 }];
    const both = t.createPointFigures({ chart: chart(), overlay: { name: 'parallelChannel', styles: { chartmateExtend: { left: true, right: true } } }, coordinates: coords, bounding });
    expect(linesOf(both)[0]).toEqual({ coordinates: [{ x: 0, y: 0 }, { x: 400, y: 200 }] });
    expect(midOf(both)!.attrs.coordinates).toEqual([{ x: 0, y: 50 }, { x: 400, y: 250 }]);
    expect(both[0].attrs.coordinates).toEqual([{ x: 0, y: 0 }, { x: 400, y: 200 }, { x: 400, y: 300 }, { x: 0, y: 100 }]);
  });

  it('price line: on-line text can be hidden; the axis label shows the exact price at the symbol precision', () => {
    const t = tpl('priceLine');
    expect(t.needDefaultYAxisFigure).toBe(false); // replaced by the persistent label below
    const bounding = { width: 300, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const yAxis = { isInCandle: () => true, isFromZero: () => false };
    const base = { chart: { ...chart(2), getDecimalFold: () => ({ format: (s: string) => s }), getThousandsSeparator: () => ({ format: (s: string) => s.replace(/^(\d+)(\d{3})/, '$1,$2') }) }, coordinates: [{ x: 10, y: 40 }], bounding, yAxis };
    const shown = t.createPointFigures({ ...base, overlay: { points: [{ value: 84123.45 }], styles: null } });
    expect(shown.map((f: { type: string }) => f.type)).toEqual(['line', 'text']);
    const hidden = t.createPointFigures({ ...base, overlay: { points: [{ value: 84123.45 }], styles: { chartmateLabel: { onLine: false, onAxis: true } } } });
    expect(hidden.map((f: { type: string }) => f.type)).toEqual(['line']);
    const axis = t.createYAxisFigures({ ...base, overlay: { points: [{ value: 84123.4 }], styles: null } });
    expect(axis).toEqual([expect.objectContaining({ type: 'text', attrs: expect.objectContaining({ text: '84,123.40', y: 40, x: 300, align: 'right' }) })]);
    expect(t.createYAxisFigures({ ...base, overlay: { points: [{ value: 1 }], styles: { chartmateLabel: { onAxis: false } } } })).toEqual([]);
  });

  it('the axis price label text reads on its fill (dark text on a white or light line)', () => {
    const t = tpl('horizontalStraightLine');
    const bounding = { width: 300, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const base = { chart: chart(2), coordinates: [{ x: 10, y: 40 }], bounding, yAxis: { isFromZero: () => false } };
    const label = (color: string) => t.createYAxisFigures({ ...base, overlay: { points: [{ value: 5 }], styles: { line: { color } } } })[0].styles;
    expect(label('#e9ecf4')).toMatchObject({ backgroundColor: '#e9ecf4', color: readableTextOn('#e9ecf4') });
    expect(readableTextOn('#e9ecf4')).not.toBe('#ffffff');
    expect(label('#131726')).toMatchObject({ backgroundColor: '#131726', color: readableTextOn('#131726') });
  });

  it('horizontal line: no text on the line by default, can be turned on; axis label on by default', () => {
    const t = tpl('horizontalStraightLine');
    const bounding = { width: 300, height: 100, left: 0, top: 0, right: 0, bottom: 0 };
    const base = { chart: chart(3), coordinates: [{ x: 10, y: 40 }], bounding, yAxis: { isFromZero: () => true } };
    expect(t.createPointFigures({ ...base, overlay: { points: [{ value: 5 }], styles: null } }).map((f: { type: string }) => f.type)).toEqual(['line']);
    const on = t.createPointFigures({ ...base, overlay: { points: [{ value: 5 }], styles: { chartmateLabel: { onLine: true, onAxis: true } } } });
    expect(on.map((f: { type: string }) => f.type)).toEqual(['line', 'text']);
    expect(on[1].attrs.text).toBe('5.000');
    expect(t.createYAxisFigures({ ...base, overlay: { points: [{ value: 5 }], styles: null } })[0].attrs).toMatchObject({ text: '5.000', x: 0, align: 'left' });
  });
});

describe('channel hit-testing (KLineChart line / polygon figures)', () => {
  const B = { width: 400, height: 300, left: 0, top: 0, right: 0, bottom: 0 };
  const coords = [{ x: 100, y: 50 }, { x: 200, y: 100 }, { x: 150, y: 175 }];
  const chartStub = { getStyles: () => ({ overlay: { line: { color: '#2962ff', size: 1, style: 'solid' } } }) };

  async function hits(styles: unknown) {
    const actual = await vi.importActual<typeof import('klinecharts')>('klinecharts');
    T.registerDrawingTemplates();
    const t = k.templates.get('parallelChannel')!;
    const figs: Fig[] = t.createPointFigures({ chart: chartStub, overlay: { name: 'parallelChannel', styles }, coordinates: coords, bounding: B });
    const shapes = figs.map((f) => {
      const Cls = actual.getFigureClass(f.type)!;
      return new Cls({ name: f.type, attrs: f.attrs, styles: f.styles ?? {} } as never) as unknown as { checkEventOn: (c: { x: number; y: number }) => boolean };
    });
    return (x: number, y: number) => shapes.some((sh) => sh.checkEventOn({ x, y }));
  }

  it('finite: on a line or inside the fill hits; beyond the ends (where an infinite line would be) does not', async () => {
    const on = await hits(null);
    expect(on(150, 75)).toBe(true); // on the base line
    expect(on(150, 125)).toBe(true); // inside the fill (on the midline too)
    expect(on(150, 150)).toBe(true); // inside the fill
    expect(on(300, 150)).toBe(false); // the base line's extension to the right
    expect(on(50, 25)).toBe(false); // ... and to the left
    expect(on(350, 275)).toBe(false); // the parallel line's extension
  });

  it('extended right: the extension hits on the right only', async () => {
    const on = await hits({ chartmateExtend: { right: true } });
    expect(on(300, 150)).toBe(true);
    expect(on(300, 200)).toBe(true); // inside the extended fill
    expect(on(50, 25)).toBe(false);
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
    const figs = t.createPointFigures({ chart: chart(), overlay: { name: 'parallelStraightLine', styles: null }, coordinates: [{ x: 0, y: 10 }, { x: 100, y: 60 }, { x: 0, y: 50 }], bounding });
    expect(figs.filter((f: { type: string; attrs: unknown }) => f.type === 'line' && !Array.isArray(f.attrs))).toHaveLength(1); // one midline
    expect(t[fresh.WRAPPED_MARK]).toBe(true);
    vi.doUnmock('klinecharts');
  });
});
