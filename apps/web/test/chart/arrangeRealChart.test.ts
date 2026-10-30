import type { SymbolInfo } from '@chartmate/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** Drawing order (bring to front / send to back) against the real KLineChart (a no-op 2D context stands in for jsdom's missing canvas). */
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

const rect = { name: 'rectangle', points: [{ timestamp: D1 + 1 * DAY, value: 99.5 }, { timestamp: D1 + 8 * DAY, value: 101.5 }], lock: false };
const names = (a: Adapter) => a.serializeDrawings().map((d) => d.name);
const overlays = (a: Adapter) => (a as unknown as { userOverlays: () => Array<{ id: string; zLevel: number; fixedZLevel: boolean }> }).userOverlays();

describe('drawing order with the real KLineChart', () => {
  it('drawings keep the stacking they were saved in (later on top), and hovering never lifts one above the others', async () => {
    const a = await chart([segment, hline, rect]);
    expect(names(a)).toEqual(['segment', 'horizontalStraightLine', 'rectangle']);
    const os = overlays(a);
    expect(os.every((o) => o.fixedZLevel)).toBe(true);
    expect(os[0]!.zLevel).toBeLessThan(os[1]!.zLevel);
    expect(os[1]!.zLevel).toBeLessThan(os[2]!.zLevel);
  });

  it('brings the selected drawing to the front / forward and sends it backward / to the back, saved and undoable', async () => {
    const a = await chart([segment, hline, rect]);
    const changes = vi.fn();
    a.onDrawingsChange(changes);
    select(a, 0); // the segment, at the back
    expect(a.selectedOrder()).toEqual({ atFront: false, atBack: true });
    expect(a.arrangeSelected('backward')).toBe(false); // already at the back: nothing changes
    expect(a.arrangeSelected('back')).toBe(false);
    expect(changes).not.toHaveBeenCalled();

    expect(a.arrangeSelected('forward')).toBe(true);
    expect(names(a)).toEqual(['horizontalStraightLine', 'segment', 'rectangle']);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(a.arrangeSelected('front')).toBe(true);
    expect(names(a)).toEqual(['horizontalStraightLine', 'rectangle', 'segment']);
    expect(a.selectedOrder()).toEqual({ atFront: true, atBack: false });
    expect(a.arrangeSelected('front')).toBe(false);
    expect(a.arrangeSelected('back')).toBe(true);
    expect(names(a)).toEqual(['segment', 'horizontalStraightLine', 'rectangle']);
    // The drawn order follows (KLineChart sorts by zLevel).
    const z = overlays(a).map((o) => o.zLevel);
    expect([...z].sort((x, y) => x - y)).toEqual(z);

    expect(a.undo()).toBe(true);
    expect(names(a)).toEqual(['horizontalStraightLine', 'rectangle', 'segment']);
    expect(a.redo()).toBe(true);
    expect(names(a)).toEqual(['segment', 'horizontalStraightLine', 'rectangle']);
  });

  it('a locked drawing keeps its place; nothing selected: nothing to arrange', async () => {
    const a = await chart([segment, { ...hline, lock: true, locked: true }]);
    expect(a.selectedOrder()).toBeNull();
    expect(a.arrangeSelected('front')).toBe(false);
    select(a, 1);
    expect(a.arrangeSelected('back')).toBe(false);
    expect(names(a)).toEqual(['segment', 'horizontalStraightLine']);
  });

  it('a pasted drawing lands on top of the others, also after a reorder', async () => {
    const a = await chart([segment, hline, rect]);
    select(a, 2);
    expect(a.arrangeSelected('back')).toBe(true);
    select(a, 2); // the horizontal line, now on top
    expect(a.copySelected()).toBe(true);
    expect(a.pasteDrawing()).toBe(true);
    expect(names(a)).toEqual(['rectangle', 'segment', 'horizontalStraightLine', 'horizontalStraightLine']);
    const z = overlays(a).map((o) => o.zLevel);
    expect(new Set(z).size).toBe(z.length);
  });
});
