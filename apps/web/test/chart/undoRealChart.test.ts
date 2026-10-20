import type { SymbolInfo } from '@chartmate/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** Drawing undo / redo against the real KLineChart (a no-op 2D context stands in for jsdom's missing canvas). */
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
type Adapter = InstanceType<typeof ChartAdapter>;

const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const DAY = 86_400_000;
const D1 = Date.UTC(2024, 2, 4);
const segment = { name: 'segment', points: [{ timestamp: D1 + 2 * DAY, value: 100 }, { timestamp: D1 + 6 * DAY, value: 101 }], lock: false };
const hline = { name: 'horizontalStraightLine', points: [{ timestamp: D1 + 3 * DAY, value: 100.5 }], lock: false };

let adapter: Adapter | null = null;
afterEach(() => { adapter?.destroy(); adapter = null; });

async function chart(drawings: unknown[]): Promise<Adapter> {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 500 });
  document.body.appendChild(el);
  drawingClipboard.clear();
  const bars = Array.from({ length: 30 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  vi.spyOn(api, 'bars').mockResolvedValue({ symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
  const a = new ChartAdapter(el, { theme: 'dark' });
  adapter = a;
  await new Promise<void>((resolve) => {
    a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 60_000 }, { onMeta: () => resolve(), onError: () => {}, onConnection: () => {} });
  });
  a.restoreDrawings(drawings as never, BTC.id);
  await vi.waitFor(() => expect(a.drawingCount().total).toBe(drawings.length));
  return a;
}

const select = (a: Adapter, i: number) => {
  const priv = a as unknown as { selectOverlay: (id: string) => void; userOverlays: () => Array<{ id: string }> };
  priv.selectOverlay(priv.userOverlays()[i]!.id);
};

describe('drawing undo / redo with the real KLineChart', () => {
  it('nothing to undo right after drawings are restored', async () => {
    const a = await chart([segment]);
    expect(a.canUndo()).toBe(false);
    expect(a.canRedo()).toBe(false);
    expect(a.undo()).toBe(false);
    expect(a.redo()).toBe(false);
    expect(a.serializeDrawings()).toEqual([segment]);
  });

  it('undoes a removal and redoes it, each saved with one onDrawingsChange', async () => {
    const a = await chart([segment, hline]);
    select(a, 0);
    expect(a.removeSelected()).toBe(true);
    expect(a.serializeDrawings()).toEqual([hline]);
    const changes = vi.fn();
    a.onDrawingsChange(changes);
    expect(a.canUndo()).toBe(true);
    expect(a.undo()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(a.serializeDrawings()).toEqual([segment, hline]);
    expect(a.canUndo()).toBe(false);
    expect(a.canRedo()).toBe(true);
    expect(a.redo()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(a.serializeDrawings()).toEqual([hline]);
    expect(a.canRedo()).toBe(false);
  });

  it('undoes edits one step at a time, back to the restored drawings', async () => {
    const a = await chart([segment]);
    select(a, 0);
    a.setSelectedStyle({ color: '#ff0000' });
    expect(a.copySelected()).toBe(true);
    expect(a.pasteDrawing()).toBe(true);
    expect(a.drawingCount().total).toBe(2);
    expect(a.undo()).toBe(true); // the paste
    expect(a.drawingCount().total).toBe(1);
    expect(a.serializeDrawings()[0]!.styles).toBeDefined();
    expect(a.undo()).toBe(true); // the color
    expect(a.serializeDrawings()).toEqual([segment]);
    expect(a.undo()).toBe(false);
  });

  it('a new edit after an undo drops the redo steps', async () => {
    const a = await chart([segment, hline]);
    select(a, 0);
    a.removeSelected();
    a.undo();
    expect(a.canRedo()).toBe(true);
    select(a, 1);
    a.removeSelected();
    expect(a.canRedo()).toBe(false);
    expect(a.serializeDrawings()).toEqual([segment]);
  });

  it('restoring drawings (a symbol switch, a reload) starts a new history', async () => {
    const a = await chart([segment, hline]);
    select(a, 0);
    a.removeSelected();
    a.restoreDrawings([segment], BTC.id);
    expect(a.canUndo()).toBe(false);
    expect(a.undo()).toBe(false);
    expect(a.serializeDrawings()).toEqual([segment]);
  });

  it('undo while a drawing is being placed cancels it and leaves the history alone', async () => {
    const a = await chart([segment, hline]);
    select(a, 0);
    a.removeSelected();
    const onEnd = vi.fn();
    a.startDrawing('segment', { onEnd });
    expect(a.undo()).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(a.serializeDrawings()).toEqual([hline]);
    expect(a.canUndo()).toBe(true);
  });

  it('undo brings back the removed drawings of "Clear all"', async () => {
    const a = await chart([segment, hline]);
    a.clearDrawings({ keepLocked: true });
    expect(a.drawingCount().total).toBe(0);
    expect(a.undo()).toBe(true);
    expect(a.serializeDrawings()).toEqual([segment, hline]);
  });
});
