import type { SymbolInfo } from '@chartmate/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOverlay {
  id: string; name: string; groupId: string; points: Array<{ timestamp: number; value: number }>; lock: boolean;
  extendData: unknown; styles: unknown; onRemoved?: (e: unknown) => void; onDrawEnd?: (e: unknown) => void; onPressedMoveEnd?: (e: unknown) => void;
  onSelected?: (e: unknown) => void; onDeselected?: (e: unknown) => void; mode?: string;
}
interface FakeIndicator { id: string; name: string; paneId: string; calcParams: number[]; visible: boolean; styles: unknown }

const k = vi.hoisted(() => {
  const state = { chart: null as unknown as ReturnType<typeof makeChart>, registered: [] as string[], overlayTemplates: [] as any[] };
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  function mergeStyles(target: unknown, source: unknown): unknown {
    if (!isObj(source)) return source;
    const out: Record<string, unknown> = isObj(target) ? { ...target } : {};
    for (const [key, v] of Object.entries(source)) out[key] = isObj(v) && isObj(out[key]) ? mergeStyles(out[key], v) : v;
    return out;
  }
  function makeChart() {
    let seq = 0;
    const overlays: FakeOverlay[] = [];
    const indicators: FakeIndicator[] = [];
    const data: Array<{ timestamp: number; high: number }> = [];
    const chart = {
      overlays, indicators, data,
      setStyles: vi.fn(), setFormatter: vi.fn(), overrideXAxis: vi.fn(), setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), setTimezone: vi.fn(), resetData: vi.fn(),
      resize: vi.fn(), getDataList: vi.fn(() => data),
      visible: { from: 0, to: 0, realFrom: 0, realTo: 0 },
      getVisibleRange: vi.fn(() => chart.visible),
      clicked: null as FakeOverlay | null,
      // Like KLineChart's store: the previously clicked overlay is deselected, the new one selected.
      getChartStore: () => ({
        setClickOverlayInfo: (info: { overlay: FakeOverlay | null }, onSel: (o: FakeOverlay) => void, onDesel: (o: FakeOverlay) => void) => {
          const prev = chart.clicked;
          if (prev?.id === info.overlay?.id) return;
          chart.clicked = info.overlay;
          if (prev) onDesel(prev);
          if (info.overlay) onSel(info.overlay);
        },
      }),
      getStyles: vi.fn(() => ({
        indicator: {
          lines: [{ color: '#d1', size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }, { color: '#d2', size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }, { color: '#d3', size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }],
          bars: [{ style: 'fill', borderStyle: 'solid', borderSize: 1, borderDashedValue: [2, 2], upColor: 'rgba(45,192,142,0.7)', downColor: 'rgba(249,40,85,0.7)', noChangeColor: '#76808F' }],
        },
        overlay: { line: { style: 'solid', smooth: false, color: '#1677FF', size: 1, dashedValue: [2, 2] }, text: { color: '#FFFFFF', size: 12, backgroundColor: '#1677FF' } },
      })),
      createIndicator: vi.fn((v: Partial<FakeIndicator> & { name: string }, _isStack?: boolean) => {
        const id = `ind_${++seq}`;
        indicators.push({ id, paneId: v.paneId ?? `pane_${seq}`, calcParams: v.calcParams ?? [], visible: v.visible ?? true, styles: v.styles ?? null, name: v.name });
        return id;
      }),
      overrideIndicator: vi.fn((o: Partial<FakeIndicator>) => {
        const ind = indicators.find((i) => i.id === o.id);
        if (ind) Object.assign(ind, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
        return true;
      }),
      removeIndicator: vi.fn((f: { id?: string; name?: string }) => {
        for (let i = indicators.length - 1; i >= 0; i--) {
          const ind = indicators[i]!;
          if ((f.id && ind.id === f.id) || (f.name && ind.name === f.name)) indicators.splice(i, 1);
        }
        return true;
      }),
      getIndicators: vi.fn((f?: { name?: string }) => indicators.filter((i) => !f?.name || i.name === f.name)),
      createOverlay: vi.fn((v: Partial<FakeOverlay> & { name: string }) => {
        const id = `ov_${++seq}`;
        overlays.push({ id, groupId: v.groupId ?? '', points: v.points ?? [], lock: v.lock ?? false, extendData: v.extendData, styles: v.styles ?? null, ...v, name: v.name } as FakeOverlay);
        return id;
      }),
      getOverlays: vi.fn((f?: { groupId?: string }) => overlays.filter((o) => !f?.groupId || o.groupId === f.groupId)),
      overrideOverlay: vi.fn((o: Partial<FakeOverlay>) => {
        const ov = overlays.find((x) => x.id === o.id);
        if (!ov) return true;
        const { styles, ...rest } = o;
        Object.assign(ov, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
        // Like KLineChart (utils merge): styles are deep-merged, a null value replaces the key.
        if (styles !== undefined) ov.styles = mergeStyles(ov.styles, styles);
        return true;
      }),
      removeOverlay: vi.fn((f: { id?: string; groupId?: string }) => {
        for (let i = overlays.length - 1; i >= 0; i--) {
          const o = overlays[i]!;
          if ((f.id && o.id === f.id) || (f.groupId && o.groupId === f.groupId)) {
            o.onRemoved?.({ overlay: o }); // like KLineChart: onRemoved fires while the overlay is still listed
            overlays.splice(i, 1);
          }
        }
        return true;
      }),
    };
    return chart;
  }
  return {
    state,
    makeChart,
    init: vi.fn(() => { state.chart = makeChart(); return state.chart; }),
    dispose: vi.fn(),
    registerIndicator: vi.fn((t: { name: string }) => { state.registered.push(t.name); }),
    registerOverlay: vi.fn((t: { name: string }) => { state.overlayTemplates.push(t); }),
  };
});

vi.mock('klinecharts', () => ({
  init: k.init,
  dispose: k.dispose,
  registerIndicator: k.registerIndicator,
  registerOverlay: k.registerOverlay,
  getOverlayClass: () => null,
  getSupportedIndicators: () => k.state.registered,
}));

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { api } = await import('../../src/api/client');

type Adapter = InstanceType<typeof ChartAdapter>;
const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };
const BTC: SymbolInfo = { id: 'crypto:BTC', assetClass: 'crypto', ticker: 'BTC', name: 'Bitcoin', pricePrecision: 2 };
const ETH: SymbolInfo = { id: 'crypto:ETH', assetClass: 'crypto', ticker: 'ETH', name: 'Ethereum', pricePrecision: 2 };
const events = () => ({ onMeta: vi.fn(), onError: vi.fn(), onConnection: vi.fn() });

const DAY = 86_400_000;
const HOUR = 3_600_000;
const D1 = Date.UTC(2024, 2, 4);
const day = (i: number) => D1 + i * DAY;

let el: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  el = document.createElement('div');
});
const chart = () => k.state.chart;
const userOverlays = () => chart().overlays.filter((o) => o.groupId !== 'markers');

/** Loads `count` bars (from `t0`, one per bar of `tf`, prices around `price`) into `a` (a new adapter by default). */
async function loadAt(symbol: SymbolInfo, tf: '1D' | '1h', opts: { a?: Adapter; t0?: number; count?: number; price?: number } = {}): Promise<Adapter> {
  const a = opts.a ?? new ChartAdapter(el, { theme: 'dark' });
  const step = tf === '1D' ? DAY : HOUR;
  const t0 = opts.t0 ?? D1;
  const price = opts.price ?? 100;
  const bars = Array.from({ length: opts.count ?? 30 }, (_, i) => ({ ts: t0 + i * step, open: price, high: price + 1, low: price - 1, close: price, volume: 1 }));
  a.load({ symbol, tf, session: 'rth', pollMs: 15000 }, events());
  vi.spyOn(api, 'bars').mockResolvedValue({ symbol: symbol.id, tf, session: 'rth', hasMoreBefore: false, stale: false, notices: [], markers: [], bars });
  const loader = chart().setDataLoader.mock.calls.at(-1)![0] as { getBars: (p: unknown) => Promise<void> };
  await loader.getBars({
    type: 'init', timestamp: null, symbol: { ticker: symbol.id }, period: { type: tf === '1D' ? 'day' : 'hour', span: 1 },
    callback: (d: Array<{ timestamp: number; high: number }>) => { chart().data.splice(0, chart().data.length, ...d); },
  });
  chart().visible = { from: 10, to: 30, realFrom: 10, realTo: 34 };
  return a;
}
const select = (o: FakeOverlay) => o.onSelected?.({ overlay: o });
const segment = { name: 'segment', points: [{ timestamp: day(2), value: 100 }, { timestamp: day(6), value: 101 }], lock: false };
const position = (start: number, end: number, entry = 100, target = 102, stop = 98) => [
  { timestamp: start, value: entry }, { timestamp: start, value: target }, { timestamp: start, value: stop }, { timestamp: end, value: entry },
];

describe('ChartAdapter copy / paste of drawings', () => {
  it('nothing to copy without a selection; nothing to paste before a copy', async () => {
    const a = await loadAt(BTC, '1D');
    a.restoreDrawings([segment], BTC.id);
    expect(a.copySelected()).toBe(false);
    expect(a.pasteDrawing()).toBe(false);
    expect(userOverlays()).toHaveLength(1);
  });

  it('pastes a copy 5 bars later at the same prices, selects it and saves it like a new drawing', async () => {
    const a = await loadAt(BTC, '1D');
    const styled = { ...segment, styles: { line: { color: '#ff0000', size: 2, style: 'dashed' as const } } };
    a.restoreDrawings([styled], BTC.id);
    const onChange = vi.fn();
    a.onDrawingsChange(onChange);
    select(userOverlays()[0]!);
    expect(a.copySelected()).toBe(true);
    expect(a.pasteDrawing()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    const [orig, copy] = userOverlays();
    expect(copy!.id).not.toBe(orig!.id);
    expect(a.getSelectedDrawing()?.id).toBe(copy!.id);
    expect(a.serializeDrawings()).toEqual([
      styled,
      { ...styled, points: [{ timestamp: day(7), value: 100 }, { timestamp: day(11), value: 101 }] },
    ]);
  });

  it('repeated pastes keep offsetting (each lands past the previous copy)', async () => {
    const a = await loadAt(BTC, '1D');
    a.restoreDrawings([segment], BTC.id);
    select(userOverlays()[0]!);
    a.copySelected();
    a.pasteDrawing();
    a.pasteDrawing();
    expect(userOverlays().map((o) => o.points[0]!.timestamp)).toEqual([day(2), day(7), day(12)]);
    // The original removed: a paste lands back where it was (nothing in the way).
    chart().removeOverlay({ id: userOverlays()[0]!.id });
    a.pasteDrawing();
    expect(userOverlays().map((o) => o.points[0]!.timestamp)).toEqual([day(7), day(12), day(2)]);
  });

  it('the clipboard is a snapshot: later edits of the original do not change what is pasted', async () => {
    const a = await loadAt(BTC, '1D');
    a.restoreDrawings([segment], BTC.id);
    select(userOverlays()[0]!);
    a.copySelected();
    a.setSelectedStyle({ color: '#00ff00' });
    a.pasteDrawing();
    expect(a.serializeDrawings()[1]).not.toHaveProperty('styles');
  });

  it('a locked drawing can be copied; the copy is unlocked, unless "Lock all" is on', async () => {
    const a = await loadAt(BTC, '1D');
    a.restoreDrawings([{ ...segment, lock: true, locked: true }], BTC.id);
    select(userOverlays()[0]!);
    expect(a.copySelected()).toBe(true);
    a.pasteDrawing();
    expect(a.serializeDrawings()[1]).toEqual({ name: 'segment', points: [{ timestamp: day(7), value: 100 }, { timestamp: day(11), value: 101 }], lock: false });
    expect(a.getSelectedDrawing()).toMatchObject({ locked: false, ownLock: false });
    a.setLockAll(true);
    a.pasteDrawing();
    expect(a.serializeDrawings()[2]).toEqual({ name: 'segment', points: [{ timestamp: day(12), value: 100 }, { timestamp: day(16), value: 101 }], lock: true });
    expect(a.getSelectedDrawing()).toMatchObject({ locked: true, ownLock: false });
  });

  it('long / short positions: entry, target, stop and width are kept; the copy goes right past the original', async () => {
    const a = await loadAt(BTC, '1D');
    const long = { name: 'longPosition', points: position(day(1), day(9), 100, 104.5, 97.25), lock: false };
    const short = { name: 'shortPosition', points: position(day(3), day(8), 100, 95, 101), lock: false };
    a.restoreDrawings([long, short], BTC.id);
    for (const o of userOverlays().slice()) {
      select(o);
      a.copySelected();
      a.pasteDrawing();
    }
    // Moved by their own width (8 / 5 bars) plus a 2-bar gap, so boxes and labels never overlap.
    expect(a.serializeDrawings().slice(2)).toEqual([
      { ...long, points: position(day(11), day(19), 100, 104.5, 97.25) },
      { ...short, points: position(day(10), day(15), 100, 95, 101) },
    ]);
    expect(a.getSelectedDrawing()).toMatchObject({ kind: 'position', side: 'short', entry: 100, target: 95, stop: 101 });
    a.pasteDrawing(); // repeated: past the previous copy too
    expect(a.serializeDrawings()[4]).toEqual({ ...short, points: position(day(17), day(22), 100, 95, 101) });
  });

  it('channels keep their extend options, price lines their label options, text its text and style', async () => {
    const a = await loadAt(BTC, '1D');
    const channel = {
      name: 'parallelChannel', lock: false, styles: { extend: { right: true } },
      points: [{ timestamp: day(1), value: 100 }, { timestamp: day(4), value: 101 }, { timestamp: day(2), value: 99 }],
    };
    const priceLine = { name: 'priceLine', points: [{ timestamp: day(3), value: 100.5 }], lock: false, styles: { label: { onLine: false } } };
    const text = { name: 'simpleAnnotation', points: [{ timestamp: day(5), value: 100 }], lock: false, text: 'Breakout', styles: { text: { color: '#123456', size: 16 } } };
    const fib = { name: 'fibonacciLine', points: [{ timestamp: day(1), value: 99 }, { timestamp: day(5), value: 101 }], lock: false };
    a.restoreDrawings([channel, priceLine, text, fib], BTC.id);
    for (const o of userOverlays().slice()) {
      select(o);
      a.copySelected();
      a.pasteDrawing();
    }
    const shift = <T extends { points: Array<{ timestamp: number; value: number }> }>(d: T) =>
      ({ ...d, points: d.points.map((p) => ({ ...p, timestamp: p.timestamp + 5 * DAY })) });
    expect(a.serializeDrawings().slice(4)).toEqual([shift(channel), shift(priceLine), shift(text), shift(fib)]);
  });

  it('a horizontal line is offset in price (a shift in time would not show)', async () => {
    const a = await loadAt(BTC, '1D'); // visible bars: low 99, high 101
    a.restoreDrawings([{ name: 'horizontalStraightLine', points: [{ timestamp: day(3), value: 100 }], lock: false }], BTC.id);
    select(userOverlays()[0]!);
    a.copySelected();
    a.pasteDrawing();
    a.pasteDrawing();
    // 5 % of the visible price range per paste, rounded to the symbol precision.
    expect(userOverlays().map((o) => o.points[0]!.value)).toEqual([100, 100.1, 100.2]);
  });

  it('on another symbol / timeframe with overlapping data the copy keeps its times and prices', async () => {
    const a = await loadAt(BTC, '1D');
    a.restoreDrawings([segment], BTC.id);
    select(userOverlays()[0]!);
    a.copySelected();
    await loadAt(ETH, '1h', { a, t0: day(1), count: 200, price: 100 });
    a.restoreDrawings([], ETH.id);
    expect(a.pasteDrawing()).toBe(true);
    expect(a.serializeDrawings()).toEqual([segment]);
  });

  it('outside the loaded data the copy is placed in the middle of the visible range, prices scaled into it', async () => {
    const a = await loadAt(BTC, '1D');
    const long = { name: 'longPosition', points: position(day(2), day(6), 100, 104, 98), lock: false };
    a.restoreDrawings([long], BTC.id);
    select(userOverlays()[0]!);
    a.copySelected();
    // Later data around 50: visible bars 10…29 (low 49, high 51).
    const t0 = day(400);
    await loadAt(ETH, '1D', { a, t0, price: 50 });
    a.restoreDrawings([], ETH.id);
    expect(a.pasteDrawing()).toBe(true);
    // 4 bars wide, centered on the visible range (bars 10…33, incl. the space right of the last bar → 20…24);
    // the prices scaled by 50 / 101 (visible middle / drawing middle) keep their percentages.
    const at = (i: number) => t0 + i * DAY;
    expect(a.serializeDrawings()).toEqual([{ ...long, points: position(at(20), at(24), 49.5, 51.49, 48.51) }]);
  });

  it('a copy pasted on a daily stock chart is daily-anchored, like a drawing made there', async () => {
    const a = await loadAt(AAPL, '1D');
    a.restoreDrawings([segment], AAPL.id);
    select(userOverlays()[0]!);
    a.copySelected();
    a.pasteDrawing();
    expect(a.serializeDrawings()[1]).toMatchObject({ anchorTf: '1D' });
  });

  it('a paste cancels the drawing being placed; nothing is pasted while drawings wait for data', async () => {
    const a = await loadAt(BTC, '1D');
    a.restoreDrawings([segment], BTC.id);
    select(userOverlays()[0]!);
    a.copySelected();
    const onEnd = vi.fn();
    a.startDrawing('rayLine', { onEnd });
    expect(a.pasteDrawing()).toBe(true);
    expect(onEnd).toHaveBeenCalled();
    expect(userOverlays().map((o) => o.name)).toEqual(['segment', 'segment']);
    a.restoreDrawings([segment], 'crypto:OTHER'); // queued until that symbol's data is in
    expect(a.pasteDrawing()).toBe(false);
  });
});
