import type { DrawingState, SymbolInfo } from '@chartmate/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Rectangles against the real KLineChart (not a fake): jsdom has no canvas, so a no-op 2D context stands in;
 * overlay creation, its point handlers and the click / selection store are the library's own.
 */
vi.doUnmock('klinecharts');

/** Circles drawn on any canvas (handles are circles): x, y, radius in CSS px. */
const arcs: Array<{ x: number; y: number; r: number }> = [];

function noopContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {
    canvas,
    measureText: (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    getLineDash: () => [],
    arc: (x: number, y: number, r: number) => { arcs.push({ x, y, r }); },
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) { return noopContext(this); } as never;
});

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');
const { drawingClipboard } = await import('../../src/chart/drawingClipboard');

const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const DAY = 86_400_000;
const D1 = Date.UTC(2024, 2, 4);

type Ov = { id: string; name: string; points: Array<{ timestamp?: number; value?: number }>; lock: boolean; styles: Record<string, unknown> | null };
type Internals = {
  userOverlays: () => Ov[];
  selectOverlay: (id: string) => void;
};

async function setup() {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 500 });
  document.body.appendChild(el);
  drawingClipboard.clear();
  const bars = Array.from({ length: 30 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  vi.spyOn(api, 'bars').mockResolvedValue({ symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
  const a = new ChartAdapter(el, { theme: 'dark' });
  await new Promise<void>((resolve) => {
    a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 60_000 }, { onMeta: () => resolve(), onError: () => {}, onConnection: () => {} });
  });
  return { a, i: a as unknown as Internals };
}

const corners = [{ timestamp: D1 + 2 * DAY, value: 99.5 }, { timestamp: D1 + 8 * DAY, value: 100.75 }];

describe('rectangle with the real KLineChart', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a stored rectangle (two corners) gets its eight handles and is saved back as the same two corners', async () => {
    const { a, i } = await setup();
    const rect: DrawingState = { name: 'rectangle', points: corners, lock: false, styles: { line: { color: 'palette:1', size: 2, style: 'dashed' }, fill: false } };
    const old: DrawingState = { name: 'parallelStraightLine', points: [...corners, { timestamp: D1 + 5 * DAY, value: 99 }], lock: false };
    a.restoreDrawings([old, rect], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(2));
    const o = i.userOverlays().find((x) => x.name === 'rectangle')!;
    expect(o.points).toHaveLength(8);
    expect(o.points[2]).toMatchObject({ timestamp: corners[0]!.timestamp, value: corners[1]!.value });
    expect(a.serializeDrawings()).toEqual([old, rect]);
    a.destroy();
  });

  it('resizing by an edge handle changes only that edge; the selection reports the fill toggle', async () => {
    const { a, i } = await setup();
    a.restoreDrawings([{ name: 'rectangle', points: corners, lock: false }], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(1));
    const o = i.userOverlays()[0] as Ov & { eventPressedPointMove: (p: object, i: number) => void };
    // What a drag of handle 7 (the midpoint of B's horizontal edge) does inside KLineChart.
    o.eventPressedPointMove({ timestamp: D1 + 20 * DAY, dataIndex: 20, value: 101.25 }, 7);
    expect(a.serializeDrawings()[0]!.points).toEqual([corners[0], { timestamp: corners[1]!.timestamp, value: 101.25 }]);
    o.eventPressedPointMove({ timestamp: D1 + 1 * DAY, dataIndex: 1, value: 50 }, 4);
    expect(a.serializeDrawings()[0]!.points).toEqual([{ timestamp: D1 + DAY, value: 99.5 }, { timestamp: corners[1]!.timestamp, value: 101.25 }]);

    i.selectOverlay(o.id);
    const sel = a.getSelectedDrawing();
    expect(sel).toMatchObject({ kind: 'line', fill: true });
    a.setSelectedFill(false);
    expect(a.getSelectedDrawing()).toMatchObject({ kind: 'line', fill: false });
    expect(a.serializeDrawings()[0]!.styles).toEqual({ fill: false });
    // A style change keeps the fill option.
    a.setSelectedStyle({ color: 'palette:2', size: 3, style: 'dotted' });
    expect(a.serializeDrawings()[0]!.styles).toEqual({ line: { color: 'palette:2', size: 3, style: 'dotted' }, fill: false });
    a.setSelectedFill(true);
    expect(a.serializeDrawings()[0]!.styles).toEqual({ line: { color: 'palette:2', size: 3, style: 'dotted' } });
    a.destroy();
  });

  it('a locked rectangle cannot change its fill; copy / paste keeps its corners and style and cascades', async () => {
    const { a, i } = await setup();
    const rect: DrawingState = { name: 'rectangle', points: corners, lock: true, locked: true, styles: { color: 'up', fill: false } };
    a.restoreDrawings([rect], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(1));
    const id = i.userOverlays()[0]!.id;
    i.selectOverlay(id);
    a.setSelectedFill(true);
    expect(a.serializeDrawings()[0]!.styles).toEqual({ color: 'up', fill: false });
    expect(a.copySelected()).toBe(true);
    expect(a.pasteDrawing()).toBe(true);
    expect(a.pasteDrawing()).toBe(true);
    const saved = a.serializeDrawings();
    expect(saved).toHaveLength(3);
    for (const d of saved.slice(1)) {
      expect(d.name).toBe('rectangle');
      expect(d.points).toHaveLength(2);
      expect(d.points.map((p) => p.value)).toEqual([99.5, 100.75]);
      expect(d.points[1]!.timestamp - d.points[0]!.timestamp).toBe(6 * DAY);
      expect(d.styles).toEqual({ color: 'up', fill: false });
      expect(d.lock).toBe(false);
    }
    // Each paste moved clear of the previous copy.
    const starts = saved.map((d) => d.points[0]!.timestamp);
    expect(new Set(starts).size).toBe(3);
    expect(i.userOverlays().every((o) => o.points.length === 8)).toBe(true);
    a.destroy();
  });
});

describe('rectangle handles and placement with the real KLineChart', () => {
  afterEach(() => vi.restoreAllMocks());
  // jsdom has no layout: a div is as large as its inline style says, else 800 × 500 (KLineChart sizes its panes from
  // its container's clientWidth / clientHeight).
  const size = (el: HTMLElement, key: 'width' | 'height', fallback: number) => {
    const v = parseFloat(el.style[key]);
    return Number.isFinite(v) ? v : fallback;
  };
  const saved = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  };
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return size(this, 'width', 800); } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return size(this, 'height', 500); } });
  });
  afterAll(() => {
    if (saved.w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', saved.w);
    if (saved.h) Object.defineProperty(HTMLElement.prototype, 'clientHeight', saved.h);
  });

  type ChartLike = {
    convertToPixel: (p: object[], f: object) => Array<{ x: number; y: number }>;
    getOverlays: () => Array<Ov & { onDrawEnd?: (e: object) => void; points: object[] }>;
    resize: () => void;
  };
  const chartOf = (a: object) => (a as unknown as { chart: ChartLike }).chart;

  it('a selected rectangle draws its handle circles on the corners and exactly halfway along the edges', async () => {
    const { a, i } = await setup();
    // Corners well inside the pane, wherever this canvas-less chart puts the bars.
    const fromPx = (chartOf(a) as unknown as { convertFromPixel: (c: object[], f: object) => Array<{ timestamp: number; value: number }> })
      .convertFromPixel([{ x: 200, y: 100 }, { x: 400, y: 300 }], { paneId: 'candle_pane' });
    const corners = fromPx.map((p) => ({ timestamp: p.timestamp, value: p.value }));
    const { drawingContext } = await import('../../src/chart/drawingTemplates');
    a.restoreDrawings([{ name: 'rectangle', points: corners, lock: false }], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(1));
    const o = i.userOverlays()[0]!;
    i.selectOverlay(o.id);
    expect(drawingContext.selectedId).toBe(o.id); // the time-axis range labels follow the selection
    const [pa, pb] = chartOf(a).convertToPixel(corners, { paneId: 'candle_pane' });
    expect(Math.abs(pb!.x - pa!.x)).toBeGreaterThan(40); // wide and tall enough for the midpoint handles
    expect(Math.abs(pb!.y - pa!.y)).toBeGreaterThan(40);
    const left = Math.round(Math.min(pa!.x, pb!.x));
    const right = Math.round(Math.max(pa!.x, pb!.x));
    const top = Math.round(Math.min(pa!.y, pb!.y));
    const bottom = Math.round(Math.max(pa!.y, pb!.y));
    const at = (x: number, y: number) => arcs.some((c) => Math.abs(c.x - x) < 0.01 && Math.abs(c.y - y) < 0.01);
    arcs.length = 0;
    chartOf(a).resize();
    // A click on the rectangle (figureType 'other'): KLineChart draws the handles of the clicked overlay.
    const store = (chartOf(a) as unknown as { getChartStore: () => { setClickOverlayInfo: (...x: unknown[]) => void } }).getChartStore();
    const overlay = chartOf(a).getOverlays().find((x) => x.id === o.id);
    store.setClickOverlayInfo({ paneId: 'candle_pane', overlay, figureType: 'other', figureIndex: 0, figure: null }, () => {}, () => {});
    chartOf(a).resize();
    // KLineChart draws the handles from the coordinates the template adjusted (10.0.x): if that changes, this fails.
    await vi.waitFor(() => {
      for (const [x, y] of [[pa!.x, pa!.y], [pb!.x, pb!.y]]) expect(at(x!, y!), `corner ${x},${y}`).toBe(true);
      expect(at(pa!.x, (top + bottom) / 2), 'midpoint of A\'s vertical edge').toBe(true);
      expect(at(pb!.x, (top + bottom) / 2), 'midpoint of B\'s vertical edge').toBe(true);
      expect(at((left + right) / 2, pa!.y), 'midpoint of A\'s horizontal edge').toBe(true);
      expect(at((left + right) / 2, pb!.y), 'midpoint of B\'s horizontal edge').toBe(true);
    });
    a.destroy();
    expect(drawingContext.selectedId).toBeNull();
  });

  it('a rectangle one bar wide draws a single centered column of handles (no doubled dots)', async () => {
    const { a, i } = await setup();
    const conv = chartOf(a) as unknown as { convertFromPixel: (c: object[], f: object) => Array<{ timestamp: number; value: number }> };
    // Two neighboring bars: find the pixel where the bar changes right of x = 200.
    const [first] = conv.convertFromPixel([{ x: 200, y: 100 }], { paneId: 'candle_pane' });
    let x = 201;
    while (conv.convertFromPixel([{ x, y: 100 }], { paneId: 'candle_pane' })[0]!.timestamp === first!.timestamp) x++;
    const [second] = conv.convertFromPixel([{ x, y: 300 }], { paneId: 'candle_pane' });
    const corners = [first!, second!].map((p) => ({ timestamp: p.timestamp, value: p.value }));
    a.restoreDrawings([{ name: 'rectangle', points: corners, lock: false }], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(1));
    const o = i.userOverlays()[0]!;
    i.selectOverlay(o.id);
    const [pa, pb] = chartOf(a).convertToPixel(corners, { paneId: 'candle_pane' });
    const width = Math.abs(pb!.x - pa!.x);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(18); // narrower than a handle and a gap
    const midX = (Math.round(Math.min(pa!.x, pb!.x)) + Math.round(Math.max(pa!.x, pb!.x))) / 2;
    const midY = (Math.round(Math.min(pa!.y, pb!.y)) + Math.round(Math.max(pa!.y, pb!.y))) / 2;
    const near = (x0: number, y0: number) => arcs.some((c) => Math.abs(c.x - x0) < 0.01 && Math.abs(c.y - y0) < 0.01);
    arcs.length = 0;
    const store = (chartOf(a) as unknown as { getChartStore: () => { setClickOverlayInfo: (...x: unknown[]) => void } }).getChartStore();
    const overlay = chartOf(a).getOverlays().find((ov) => ov.id === o.id);
    store.setClickOverlayInfo({ paneId: 'candle_pane', overlay, figureType: 'other', figureIndex: 0, figure: null }, () => {}, () => {});
    chartOf(a).resize();
    await vi.waitFor(() => {
      expect(near(midX, pa!.y), 'top / bottom center').toBe(true);
      expect(near(midX, pb!.y), 'top / bottom center').toBe(true);
      expect(near(midX, midY), 'middle center').toBe(true);
    });
    // No handle at the corners' own x on screen: the left / right pairs are gone.
    const visible = arcs.filter((c) => c.x > -1000);
    expect(visible.every((c) => Math.abs(c.x - midX) < 0.01)).toBe(true);
    a.destroy();
  });

  it('a rectangle placed with no width or height is dropped when drawing ends; a real one is kept', async () => {
    const { a } = await setup();
    const changes = vi.fn();
    a.onDrawingsChange(changes);
    const finish = (pts: object[]) => {
      const ended = vi.fn();
      a.startDrawing('rectangle', { onEnd: ended });
      const id = (a as unknown as { drawing: { id: string } }).drawing.id;
      const o = chartOf(a).getOverlays().find((x) => x.id === id)!;
      o.points = pts;
      o.onDrawEnd?.({ overlay: o });
      return ended;
    };
    const flat = finish([{ timestamp: D1 + 2 * DAY, value: 100 }, { timestamp: D1 + 6 * DAY, value: 100 }]);
    expect(flat).toHaveBeenCalledTimes(1); // the tool is done
    expect(a.drawingCount().total).toBe(0);
    const thin = finish([{ timestamp: D1 + 2 * DAY, value: 99 }, { timestamp: D1 + 2 * DAY, value: 101 }]);
    expect(thin).toHaveBeenCalledTimes(1);
    expect(a.drawingCount().total).toBe(0);
    expect(changes).not.toHaveBeenCalled();
    finish([{ timestamp: D1 + 2 * DAY, value: 99 }, { timestamp: D1 + 6 * DAY, value: 101 }]);
    expect(a.drawingCount().total).toBe(1);
    expect(changes).toHaveBeenCalledTimes(1);
    a.destroy();
  });

  it('a stored rectangle collapsed on this timeframe (both corners in one bar) is kept', async () => {
    const { a } = await setup();
    const collapsed: DrawingState = {
      name: 'rectangle', points: [{ timestamp: D1 + 3 * DAY, value: 99 }, { timestamp: D1 + 3 * DAY, value: 101 }], lock: false,
    };
    a.restoreDrawings([collapsed], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(1));
    expect(a.serializeDrawings()).toEqual([collapsed]);
    a.destroy();
  });
});
