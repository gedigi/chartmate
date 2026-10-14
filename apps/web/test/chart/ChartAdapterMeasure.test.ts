import type { SymbolInfo } from '@chartmate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeOverlay {
  id: string; name: string; groupId: string; points: Array<{ timestamp: number; value: number }>; lock: boolean;
  extendData: unknown; styles: unknown; mode?: string; onRemoved?: (e: unknown) => void; onDrawEnd?: (e: unknown) => void;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
/** Pixel ↔ value of the fake candle pane: 10 px per bar, 1 px per price unit, 300 px tall. */
const PANE = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 };

const k = vi.hoisted(() => {
  const state = { chart: null as unknown as ReturnType<typeof makeChart>, hover: null as unknown };
  function makeChart() {
    let seq = 0;
    const overlays: FakeOverlay[] = [];
    const data: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume?: number }> = [];
    const main = document.createElement('div');
    main.getBoundingClientRect = () => ({ ...PANE, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const chart = {
      overlays, data, main,
      setStyles: vi.fn(), setFormatter: vi.fn(), overrideXAxis: vi.fn(), setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), setTimezone: vi.fn(), resetData: vi.fn(),
      resize: vi.fn(), getDataList: vi.fn(() => data), getIndicators: vi.fn(() => []), getStyles: vi.fn(() => ({ indicator: { lines: [], bars: [{}] } })),
      createIndicator: vi.fn(() => 'ind'), overrideIndicator: vi.fn(), removeIndicator: vi.fn(),
      getDom: vi.fn((paneId?: string, pos?: string) => (paneId === 'candle_pane' && pos === 'main' ? main : null)),
      convertFromPixel: vi.fn((cs: Array<{ x: number; y: number }>) => cs.map((c) => {
        const dataIndex = Math.ceil(c.x / 10) - 1;
        return { dataIndex, timestamp: T0 + dataIndex * DAY, value: 300 - c.y };
      })),
      convertToPixel: vi.fn((p: { value?: number } | Array<{ value?: number }>) => {
        const one = (x: { value?: number }) => ({ y: 300 - (x.value ?? 0) });
        return Array.isArray(p) ? p.map(one) : one(p);
      }),
      getChartStore: vi.fn(() => ({ getHoverOverlayInfo: () => ({ overlay: state.hover }) })),
      createOverlay: vi.fn((v: Partial<FakeOverlay> & { name: string }) => {
        const id = `ov_${++seq}`;
        overlays.push({ id, groupId: v.groupId ?? '', points: v.points ?? [], lock: v.lock ?? false, extendData: v.extendData, styles: v.styles ?? null, ...v, name: v.name } as FakeOverlay);
        return id;
      }),
      getOverlays: vi.fn((f?: { groupId?: string }) => overlays.filter((o) => !f?.groupId || o.groupId === f.groupId)),
      overrideOverlay: vi.fn((o: Partial<FakeOverlay>) => {
        const ov = overlays.find((x) => x.id === o.id);
        if (ov) Object.assign(ov, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
        return true;
      }),
      removeOverlay: vi.fn((f: { id?: string; groupId?: string }) => {
        for (let i = overlays.length - 1; i >= 0; i--) {
          const o = overlays[i]!;
          if ((f.id && o.id === f.id) || (f.groupId && o.groupId === f.groupId)) {
            o.onRemoved?.({ overlay: o });
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
    init: vi.fn(() => { state.chart = makeChart(); return state.chart; }),
  };
});

vi.mock('klinecharts', () => ({
  init: k.init, dispose: vi.fn(), registerIndicator: vi.fn(), registerOverlay: vi.fn(), getOverlayClass: () => null, getSupportedIndicators: () => [],
}));

const { ChartAdapter } = await import('../../src/chart/ChartAdapter');
const { MEASURE_OVERLAY } = await import('../../src/chart/measure');
const { THEME_TOKENS } = await import('../../src/chart/theme');

const AAPL: SymbolInfo = { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 };

let el: HTMLElement;
let inner: HTMLElement;
let reached: ReturnType<typeof vi.fn<(e: MouseEvent) => void>>;
beforeEach(() => {
  vi.clearAllMocks();
  k.state.hover = null;
  el = document.createElement('div');
  inner = document.createElement('div'); // stands in for KLineChart's own container
  el.appendChild(inner);
  document.body.appendChild(el);
  reached = vi.fn<(e: MouseEvent) => void>();
  inner.addEventListener('mousedown', reached);
  // Animation frames run at once unless a test queues them.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

const chart = () => k.state.chart;
/** Adapters of the current test: destroyed after it, so none keeps listening on the document. */
const live: Array<InstanceType<typeof ChartAdapter>> = [];
afterEach(() => { for (const a of live.splice(0)) a.destroy(); el.remove(); vi.unstubAllGlobals(); });
/** An adapter with 30 daily bars: bar i closes at 100 + i (high +2, low −2), volume 1000. */
function make() {
  const a = new ChartAdapter(el, { theme: 'dark' });
  live.push(a);
  for (let i = 0; i < 30; i++) {
    const c = 100 + i;
    chart().data.push({ timestamp: T0 + i * DAY, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 });
  }
  return a;
}
const measures = () => chart().overlays.filter((o) => o.name === MEASURE_OVERLAY);
type View = { lines: string[]; colors: { stroke: string } };
const view = () => measures()[0]!.extendData as View;

/** Mouse event at (x, y) of the fake pane; mousedown on KLineChart's container, moves / ups on the document. */
const down = (x: number, y: number, init: MouseEventInit = {}) => inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }));
const move = (x: number, y: number) => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
const up = (x: number, y: number) => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));

describe('measure (adapter API)', () => {
  it('start / update / finish: one locked, non-drawing overlay whose label follows the end point', () => {
    const a = make();
    expect(a.startMeasure({ index: 2, value: 100 })).toBe(true);
    expect(measures()).toHaveLength(1);
    const o = measures()[0]!;
    expect(o).toMatchObject({ lock: true, groupId: 'measure' });
    expect(o.points).toEqual([{ timestamp: T0 + 2 * DAY, value: 100 }, { timestamp: T0 + 2 * DAY, value: 100 }]);
    a.updateMeasure({ index: 14, value: 110 });
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 14 * DAY, value: 110 });
    expect(view().lines).toEqual(['+10.00 (+10.00%)', '12 bars, 12d', 'Vol 13.0K']);
    a.finishMeasure();
    const m = a.getMeasurement()!;
    expect(m.phase).toBe('done');
    expect(m.stats).toMatchObject({ change: 10, percent: 10, bars: 12, up: true });
    expect(measures()).toHaveLength(1);
  });

  it('up family when the end price is at or above the start, down family below it', () => {
    const a = make();
    a.startMeasure({ index: 2, value: 100 });
    a.updateMeasure({ index: 5, value: 100 });
    expect(view().colors.stroke).toBe(THEME_TOKENS.dark.up);
    a.updateMeasure({ index: 5, value: 90 });
    expect(view().colors.stroke).toBe(THEME_TOKENS.dark.down);
    expect(view().lines[0]).toBe('−10.00 (−10.00%)');
    a.setTheme('light');
    expect(view().colors.stroke).toBe(THEME_TOKENS.light.down);
  });

  it('clearMeasure removes it; a new measure replaces the old one', () => {
    const a = make();
    a.startMeasure({ index: 2, value: 100 });
    a.startMeasure({ index: 4, value: 101 });
    expect(measures()).toHaveLength(1);
    a.clearMeasure();
    expect(measures()).toHaveLength(0);
    expect(a.getMeasurement()).toBeNull();
  });

  it('is not a drawing: never saved, counted, copied, selected or cleared with the drawings', () => {
    const a = make();
    const changed = vi.fn();
    a.onDrawingsChange(changed);
    a.startMeasure({ index: 2, value: 100 });
    a.updateMeasure({ index: 6, value: 104 });
    a.finishMeasure();
    expect(a.serializeDrawings()).toEqual([]);
    expect(a.drawingCount()).toEqual({ total: 0, locked: 0 });
    expect(a.copySelected()).toBe(false);
    expect(a.getSelectedDrawing()).toBeNull();
    a.setLockAll(true);
    a.clearDrawings();
    a.clearDrawings({ keepLocked: true });
    expect(changed).not.toHaveBeenCalled();
    expect(measures()[0]!.extendData).toBeTruthy();
    expect(measures()[0]!).not.toHaveProperty('onDrawEnd');
  });

  it('a new load (symbol / timeframe) and clear() drop it', () => {
    const a = make();
    a.startMeasure({ index: 2, value: 100 });
    a.load({ symbol: AAPL, tf: '1D', session: 'rth', pollMs: 1000 }, { onMeta: vi.fn(), onError: vi.fn() });
    expect(measures()).toHaveLength(0);
    a.startMeasure({ index: 2, value: 100 });
    a.clear();
    expect(measures()).toHaveLength(0);
  });

  it('needs bars', () => {
    const a = new ChartAdapter(el, { theme: 'dark' });
    expect(a.startMeasure({ index: 0, value: 1 })).toBe(false);
    expect(measures()).toHaveLength(0);
  });

  it('notifies on finish and clear (not on every move)', () => {
    const a = make();
    const cb = vi.fn();
    a.onMeasureChange(cb);
    a.startMeasure({ index: 2, value: 100 });
    a.updateMeasure({ index: 3, value: 101 });
    expect(cb).not.toHaveBeenCalled();
    a.finishMeasure();
    expect(cb).toHaveBeenLastCalledWith(expect.objectContaining({ lines: ['+1.00 (+1.00%)', '1 bar, 1d', 'Vol 2.0K'] }));
    a.clearMeasure();
    expect(cb).toHaveBeenLastCalledWith(null);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('measure (pointer)', () => {
  it('Shift-drag measures (KLineChart never sees the press, so the chart does not pan); a plain click clears it', () => {
    const a = make();
    down(25, 200, { shiftKey: true }); // bar 2, price 100
    expect(reached).not.toHaveBeenCalled();
    expect(a.getMeasurement()?.phase).toBe('dragging');
    move(145, 180); // bar 14, price 120
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 14 * DAY, value: 120 });
    up(145, 180);
    expect(a.getMeasurement()?.phase).toBe('done');
    move(300, 50); // a finished measure stays put
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 14 * DAY, value: 120 });
    down(300, 50);
    expect(reached).toHaveBeenCalledTimes(1);
    expect(a.getMeasurement()).toBeNull();
    expect(measures()).toHaveLength(0);
  });

  it('Shift-click starts, the end follows the mouse, the next click finishes', () => {
    const a = make();
    down(25, 200, { shiftKey: true });
    up(26, 200);
    expect(a.getMeasurement()?.phase).toBe('placing');
    move(95, 210);
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 9 * DAY, value: 90 });
    down(95, 210);
    expect(reached).not.toHaveBeenCalled();
    up(95, 210);
    expect(a.getMeasurement()?.phase).toBe('done');
    expect(a.getMeasurement()?.stats.up).toBe(false);
  });

  it('Shift-measuring again replaces the finished measure', () => {
    const a = make();
    down(25, 200, { shiftKey: true });
    move(145, 180);
    up(145, 180);
    down(55, 150, { shiftKey: true });
    expect(measures()).toHaveLength(1);
    expect(measures()[0]!.points[0]).toEqual({ timestamp: T0 + 5 * DAY, value: 150 });
    expect(a.getMeasurement()?.phase).toBe('dragging');
  });

  it('while a drawing tool is active, Shift presses go to the drawing (they keep it horizontal)', () => {
    const a = make();
    a.startDrawing('segment');
    down(25, 200, { shiftKey: true });
    expect(reached).toHaveBeenCalledTimes(1);
    expect(a.getMeasurement()).toBeNull();
  });

  it('a Shift press on a drawing drags that drawing', () => {
    const a = make();
    k.state.hover = { id: 'ov_x', groupId: '' };
    down(25, 200, { shiftKey: true });
    expect(reached).toHaveBeenCalledTimes(1);
    expect(a.getMeasurement()).toBeNull();
  });

  it('ignores other buttons, presses outside the candle pane and charts without bars', () => {
    const a = make();
    down(25, 200, { shiftKey: true, button: 2 });
    down(25, 350, { shiftKey: true }); // below the candle pane (an indicator pane)
    down(450, 100, { shiftKey: true }); // the price axis
    expect(reached).toHaveBeenCalledTimes(3);
    expect(a.getMeasurement()).toBeNull();
    chart().data.length = 0;
    down(25, 200, { shiftKey: true });
    expect(a.getMeasurement()).toBeNull();
  });

  it('points snap like drawings: the magnet (weak) and ⌘ / Ctrl held (strong)', () => {
    const a = make();
    // Bar 2: open 101, high 104, low 100, close 102.
    down(25, 300 - 104.5, { shiftKey: true });
    expect(measures()[0]!.points[0]!.value).toBeCloseTo(104.5);
    up(25, 300 - 104.5);
    a.clearMeasure();
    a.setMagnet(true);
    down(25, 300 - 104.5, { shiftKey: true });
    expect(measures()[0]!.points[0]!.value).toBe(104);
    a.clearMeasure();
    a.setMagnet(false);
    a.setMagnetOverride(true);
    down(25, 300 - 130, { shiftKey: true });
    expect(measures()[0]!.points[0]!.value).toBe(104);
  });

  it('destroy drops the document listeners', () => {
    const a = make();
    down(25, 200, { shiftKey: true });
    a.destroy();
    expect(() => move(145, 180)).not.toThrow();
    expect(chart().overrideOverlay).not.toHaveBeenCalledWith(expect.objectContaining({ points: expect.anything() }));
  });

  it('a Shift press that starts a measure deselects the selected drawing and blurs a focused field, like a click', () => {
    const a = make();
    a.startDrawing('segment');
    const o = chart().overlays.at(-1)! as FakeOverlay & { onSelected?: (e: unknown) => void };
    o.points = [{ timestamp: T0, value: 100 }, { timestamp: T0 + DAY, value: 101 }];
    o.onDrawEnd?.({ overlay: o });
    o.onSelected?.({ overlay: o });
    expect(a.getSelectedDrawing()).not.toBeNull();
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    down(25, 200, { shiftKey: true });
    expect(a.getMeasurement()?.phase).toBe('dragging');
    expect(a.getSelectedDrawing()).toBeNull();
    expect(document.activeElement).not.toBe(field);
    field.remove();
  });

  it('a Shift press over a marker still measures (markers are not drawings)', () => {
    const a = make();
    k.state.hover = { id: 'm1', groupId: 'markers' };
    down(25, 200, { shiftKey: true });
    expect(reached).not.toHaveBeenCalled();
    expect(a.getMeasurement()?.phase).toBe('dragging');
  });

  it('moves update the measure at most once per animation frame (the latest position)', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    make();
    down(25, 200, { shiftKey: true });
    const before = chart().overrideOverlay.mock.calls.length;
    move(55, 190);
    move(95, 180);
    move(145, 170);
    expect(chart().overrideOverlay.mock.calls.length).toBe(before);
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(chart().overrideOverlay.mock.calls.length).toBe(before + 1);
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 14 * DAY, value: 130 });
    // The release lands exactly where the mouse is, whatever frame is pending.
    move(205, 160);
    up(205, 160);
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 20 * DAY, value: 140 });
    frames.shift()?.(0); // a stale frame changes nothing
    expect(measures()[0]!.points[1]).toEqual({ timestamp: T0 + 20 * DAY, value: 140 });
  });
});

describe('measure (older bars prepended)', () => {
  it('keeps its bars, volume and label: indexes come from the bar times', () => {
    const a = make();
    a.startMeasure({ index: 2, value: 100 });
    a.updateMeasure({ index: 14, value: 110 });
    a.finishMeasure();
    chart().data.unshift(...Array.from({ length: 5 }, (_, i) => ({ timestamp: T0 - (5 - i) * DAY, open: 90, high: 91, low: 89, close: 90, volume: 7 })));
    const m = a.getMeasurement()!;
    expect(m.start.index).toBe(7);
    expect(m.end.index).toBe(19);
    expect(m.stats).toMatchObject({ bars: 12, volume: 13_000 });
    a.setTheme('light');
    expect(view().lines).toEqual(['+10.00 (+10.00%)', '12 bars, 12d', 'Vol 13.0K']);
  });
});
