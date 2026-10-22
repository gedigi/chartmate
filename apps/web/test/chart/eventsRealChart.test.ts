import type { CorporateEvent, SymbolInfo } from '@chartmate/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** Corporate event badges against the real KLineChart (a no-op 2D context stands in for jsdom's missing canvas). */
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
type Adapter = InstanceType<typeof ChartAdapter>;

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const MSFT: SymbolInfo = { ...AAPL, id: 'stock:MSFT', ticker: 'MSFT', name: 'Microsoft' };
const DAY = 86_400_000;
const D1 = Date.UTC(2026, 2, 2, 14, 30); // Mon 09:30 New York

let adapter: Adapter | null = null;
afterEach(() => { adapter?.destroy(); adapter = null; vi.restoreAllMocks(); });

async function chart(symbol = AAPL): Promise<Adapter> {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 500 });
  document.body.appendChild(el);
  const bars = Array.from({ length: 30 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  vi.spyOn(api, 'bars').mockResolvedValue({ symbol: symbol.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
  const a = new ChartAdapter(el, { theme: 'dark' });
  adapter = a;
  await load(a, symbol);
  return a;
}

const load = (a: Adapter, symbol: SymbolInfo) => new Promise<void>((resolve) => {
  a.load({ symbol, tf: '1D', session: 'rth', pollMs: 60_000 }, { onMeta: () => resolve(), onError: () => {}, onConnection: () => {} });
});

type Priv = { chart: { getOverlays: (f?: { groupId?: string }) => Array<{ id: string; points: Array<{ timestamp?: number }>; extendData: unknown }> } };
const badges = (a: Adapter) => (a as unknown as Priv).chart.getOverlays({ groupId: 'events' });

const events: CorporateEvent[] = [
  { kind: 'dividend', ts: D1 + 3 * DAY, amount: 0.25 },
  { kind: 'earnings', ts: D1 + 3 * DAY + 6 * 3_600_000, epsActual: 2, epsEstimate: 1.9 },
  { kind: 'split', ts: D1 + 10 * DAY, ratio: '4:1' },
  { kind: 'earnings', ts: D1 + 40 * DAY, epsEstimate: 2.1, upcoming: true },
];

describe('corporate event badges with the real KLineChart', () => {
  it('one overlay per bar with its badges bottom-up; an upcoming report right of the last bar; never a drawing', async () => {
    const a = await chart();
    const shown = vi.fn();
    a.onEventsShown(shown);
    a.setEvents(events);
    const list = badges(a);
    expect(list.map((o) => o.points[0]!.timestamp)).toEqual([D1 + 3 * DAY, D1 + 10 * DAY, D1 + 40 * DAY]);
    expect((list[0]!.extendData as { badges: Array<{ letter: string }> }).badges.map((b) => b.letter)).toEqual(['E', 'D']);
    expect(shown).toHaveBeenLastCalledWith([
      { barTs: D1 + 3 * DAY, events: [events[1], events[0]] },
      { barTs: D1 + 10 * DAY, events: [events[2]] },
      { barTs: D1 + 40 * DAY, events: [events[3]] },
    ]);
    expect(a.serializeDrawings()).toEqual([]);
    expect(a.drawingCount().total).toBe(0);
    a.clearDrawings();
    expect(badges(a)).toHaveLength(3);
  });

  it('events handed over before the first page of bars are drawn once it arrives', async () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 800 });
    Object.defineProperty(el, 'clientHeight', { value: 500 });
    document.body.appendChild(el);
    const bars = Array.from({ length: 30 }, (_, i) => ({ ts: D1 + i * DAY, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(api, 'bars').mockImplementation(async () => {
      await gate;
      return { symbol: AAPL.id, tf: '1D', session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars };
    });
    const a = new ChartAdapter(el, { theme: 'dark' });
    adapter = a;
    const loaded = load(a, AAPL);
    a.setEvents(events);
    expect(badges(a)).toEqual([]);
    release();
    await loaded;
    await vi.waitFor(() => expect(badges(a)).toHaveLength(3));
  });

  it('hidden kinds are left out; a theme change recolors; a new symbol drops the old events', async () => {
    const a = await chart();
    a.setEvents(events, ['split', 'dividend']);
    expect(badges(a).map((o) => (o.extendData as { badges: Array<{ letter: string }> }).badges.map((b) => b.letter))).toEqual([['E'], ['E']]);
    const before = JSON.stringify(badges(a).map((o) => o.extendData));
    a.setTheme('light');
    expect(JSON.stringify(badges(a).map((o) => o.extendData))).not.toBe(before);
    await load(a, MSFT);
    expect(badges(a)).toEqual([]);
  });
});
