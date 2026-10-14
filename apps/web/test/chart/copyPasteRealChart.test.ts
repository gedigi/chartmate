import type { SymbolInfo } from '@chartmate/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Copy / paste against the real KLineChart (not a fake): jsdom has no canvas, so a no-op 2D context stands in;
 * everything else (overlay creation, its callbacks, the click/selection store) is the library's own.
 */
vi.doUnmock('klinecharts');

/** A 2D context whose methods do nothing (measureText: 6 px per character). */
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

describe('copy / paste with the real KLineChart', () => {
  it('a paste creates one selected drawing and fires exactly one onDrawingsChange', async () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 800 });
    Object.defineProperty(el, 'clientHeight', { value: 500 });
    document.body.appendChild(el);
    drawingClipboard.clear();
    const bars = Array.from({ length: 30 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    vi.spyOn(api, 'bars').mockResolvedValue({ symbol: BTC.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
    const a = new ChartAdapter(el, { theme: 'dark' });
    const ready = new Promise<void>((resolve) => {
      a.load({ symbol: BTC, tf: '1D', session: 'rth', pollMs: 60_000 }, { onMeta: () => resolve(), onError: () => {}, onConnection: () => {} });
    });
    await ready;
    const segment = { name: 'segment', points: [{ timestamp: D1 + 2 * DAY, value: 100 }, { timestamp: D1 + 6 * DAY, value: 101 }], lock: false };
    a.restoreDrawings([segment], BTC.id);
    await vi.waitFor(() => expect(a.drawingCount().total).toBe(1));
    expect(a.serializeDrawings()).toEqual([segment]);

    // Select the original through the library's own click store, as a click would.
    const sel = vi.fn();
    a.onSelectionChange(sel);
    (a as unknown as { selectOverlay: (id: string) => void }).selectOverlay(
      (a as unknown as { userOverlays: () => Array<{ id: string }> }).userOverlays()[0]!.id,
    );
    expect(a.getSelectedDrawing()).not.toBeNull();
    expect(a.copySelected()).toBe(true);

    const changes = vi.fn();
    a.onDrawingsChange(changes);
    expect(a.pasteDrawing()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    const saved = a.serializeDrawings();
    expect(saved).toHaveLength(2);
    // Same prices and width (where it lands depends on the visible range of this canvas-less chart).
    const [p0, p1] = saved[1]!.points;
    expect([p0!.value, p1!.value]).toEqual([100, 101]);
    expect(p1!.timestamp - p0!.timestamp).toBe(4 * DAY);
    const ids = (a as unknown as { userOverlays: () => Array<{ id: string }> }).userOverlays().map((o) => o.id);
    expect(a.getSelectedDrawing()?.id).toBe(ids[1]);
    a.destroy();
  });
});
