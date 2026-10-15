import type { Bar, SymbolInfo } from '@chartmate/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Date ranges against the real KLineChart (not a fake): showRange relies on its private data store (`getChartStore()`
 * with `_processDataLoad`, `_loading`, `_dataLoadMore`) to page in older bars, and on its public bar space, offset and
 * zoom / scroll actions. If an upgrade renames those internals this fails here, loudly, instead of ranges quietly
 * fitting only what happens to be loaded. jsdom has no canvas: a no-op 2D context stands in.
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
  // jsdom lays nothing out: every element (the chart's own container included) reads 900 × 500.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
});

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const DAY = 86_400_000;

const weekdays = (from: number, to: number): Bar[] => {
  const out: Bar[] = [];
  for (let t = from; t <= to; t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) out.push({ ts: t, open: 1, high: 2, low: 0.5, close: 1, volume: 1 });
  return out;
};
const page = (bars: Bar[], hasMoreBefore: boolean) => ({ symbol: AAPL.id, tf: '1D' as const, session: 'rth' as const, hasMoreBefore, stale: false, notices: [], markers: [], bars });

describe('date ranges with the real KLineChart', () => {
  it('pages in older bars through the chart\'s data store, fits the range, and a user zoom cancels it', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const recent = weekdays(Date.UTC(2025, 5, 2), Date.UTC(2025, 9, 15));
    const older = weekdays(Date.UTC(2024, 0, 1), Date.UTC(2025, 4, 30));
    const bars = vi.spyOn(api, 'bars').mockResolvedValueOnce(page(recent, true)).mockResolvedValueOnce(page(older, false));
    const a = new ChartAdapter(el, { theme: 'dark' });
    await new Promise<void>((resolve) => {
      a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 60_000 }, { onMeta: () => resolve(), onError: () => {}, onConnection: () => {} });
    });

    // The private store the ranges page through: these must exist with these shapes.
    const store = (a as unknown as { chart: { getChartStore: () => Record<string, unknown> } }).chart.getChartStore();
    expect(typeof store['_processDataLoad']).toBe('function');
    expect(typeof store['_loading']).toBe('boolean');
    expect(store['_dataLoadMore']).toEqual(expect.objectContaining({ forward: true }));

    const shown = vi.fn();
    const canceled = vi.fn();
    a.onRangeShown(shown);
    a.onRangeCanceled(canceled);
    a.showRange('1Y', 'stock');
    await vi.waitFor(() => expect(shown).toHaveBeenCalled());
    expect(bars).toHaveBeenCalledTimes(2); // the init page, then one older page requested for the range
    const last = shown.mock.calls.at(-1)![0] as { first: number; last: number; bars: number };
    expect(last).toEqual(expect.objectContaining({ first: Date.UTC(2024, 9, 16), last: Date.UTC(2025, 9, 15), bars: 261 }));
    const chart = (a as unknown as { chart: import('klinecharts').Chart }).chart;
    expect(chart.getBarSpace().bar).toBeCloseTo((a.plotWidth() - 80) / 261, 5);
    expect(a.plotWidth()).toBeGreaterThan(0);
    expect(canceled).not.toHaveBeenCalled(); // fitting is not a user zoom / scroll

    chart.zoomAtCoordinate(1.2, { x: 100, y: 100 });
    expect(canceled).toHaveBeenCalledTimes(1);
    a.destroy();
    el.remove();
  });
});
