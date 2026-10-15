import type { DrawingState, SymbolInfo } from '@chartmate/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Rectangles against the real KLineChart (not a fake): jsdom has no canvas, so a no-op 2D context stands in;
 * overlay creation, its point handlers and the click / selection store are the library's own.
 */
vi.doUnmock('klinecharts');

function noopContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {
    canvas,
    measureText: (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    getLineDash: () => [],
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
