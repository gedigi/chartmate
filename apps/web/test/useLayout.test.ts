import type { Layout } from '@chartmate/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { COLOR_DEFAULTS_REV, INDICATOR_PALETTE, THEME_TOKENS } from '../src/chart/theme';
import { DEFAULT_LAYOUT, migrateColorDefaults, sanitizeIndicators, useLayout, withoutLegacyDefaults } from '../src/state/useLayout';

const ma = { name: 'MA', pane: 'main' as const, calcParams: [20], visible: true };
const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [14], visible: true };
/** Saved by the current version (colors already migrated). */
const saved: Layout = { symbol: 'stock:AAPL', tf: '1h', session: 'rth', chartType: 'candle', indicators: [ma], colorDefaultsRev: COLOR_DEFAULTS_REV };
/** The same layout as saved before the color-defaults revision existed. */
const { colorDefaultsRev: _rev, ...savedRev0 } = saved;
/** A legacy per-symbol row: must be ignored (never requested, never adopted). */
const legacyMsftSym: Layout = { ...saved, symbol: 'stock:MSFT', indicators: [rsi] };

let put: MockInstance<typeof api.layouts.put>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(api.layouts, 'get').mockImplementation(async (key) =>
    key === 'default' ? saved : key === 'sym:stock:MSFT' ? legacyMsftSym : null);
  put = vi.spyOn(api.layouts, 'put').mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1500); });
const keysRequested = () => [
  ...vi.mocked(api.layouts.get).mock.calls.map((c) => c[0]),
  ...put.mock.calls.map((c) => c[0]),
];

describe('useLayout (one global indicator set in the default layout)', () => {
  it('starts from DEFAULT_LAYOUT and loads the saved default without re-saving it', async () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout).toEqual(saved);
    await settle();
    expect(put).not.toHaveBeenCalled();
  });

  it('switching symbols keeps the current indicators and never reads or writes sym: keys', async () => {
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.selectSymbol('stock:MSFT'));
    await settle();
    expect(result.current.layout).toMatchObject({ symbol: 'stock:MSFT', indicators: [ma] });
    act(() => result.current.setLayout((l) => ({ ...l, symbol: 'crypto:BTC' })));
    await settle();
    expect(result.current.layout).toMatchObject({ symbol: 'crypto:BTC', indicators: [ma] });
    expect(keysRequested().filter((k) => k !== 'default')).toEqual([]);
    expect(put.mock.calls.at(-1)).toEqual(['default', { ...saved, symbol: 'crypto:BTC' }]);
  });

  it('an indicator edit saves the default key only and persists across a reload and on any symbol', async () => {
    const { result, unmount } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setLayout((l) => ({ ...l, indicators: [rsi] })));
    await settle();
    expect(put.mock.calls.map((c) => c[0])).toEqual(['default']);
    const stored = put.mock.calls.at(-1)![1];
    unmount();
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? stored : legacyMsftSym));
    const reloaded = renderHook(() => useLayout());
    await waitFor(() => expect(reloaded.result.current.loaded).toBe(true));
    expect(reloaded.result.current.layout.indicators).toEqual([rsi]);
    act(() => reloaded.result.current.selectSymbol('stock:MSFT'));
    await settle();
    expect(reloaded.result.current.layout.indicators).toEqual([rsi]);
    expect(keysRequested().filter((k) => k !== 'default')).toEqual([]);
  });

  it('migrates a legacy flat appearance to the dark theme on load', async () => {
    const flat = { upColor: '#ffffff', downColor: '#e63b7a', drawing: { color: '#ffffff', size: 1, style: 'solid' as const } };
    vi.mocked(api.layouts.get).mockResolvedValue({ ...saved, appearance: flat } as unknown as Layout);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout).toEqual({ ...saved, appearance: { dark: flat } });
  });

  it('once: a layout from before the color revision gets old-default colors unset, is stamped and saved back', async () => {
    const appearance = {
      dark: { upColor: '#26A69A', downColor: '#e63b7a', drawing: { color: '#2962ff', size: 1, style: 'solid' as const } },
      light: { upColor: '#10a37a', downColor: '#f23645', lineColor: '#3d6af5' },
    };
    const vol = { name: 'VOL', pane: 'sub' as const, calcParams: [5, 10, 20], visible: true, barColors: { up: '#26a69a', down: '#ef5350' } };
    const macd = { name: 'MACD', pane: 'sub' as const, calcParams: [12, 26, 9], visible: true, barColors: { up: '#00ff00', down: '#f23645' } };
    vi.mocked(api.layouts.get).mockResolvedValue({ ...savedRev0, indicators: [ma, vol, macd], appearance });
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const { barColors: _gone, ...volPlain } = vol;
    const expected = {
      ...saved, appearance: { dark: { downColor: '#e63b7a' } },
      indicators: [ma, volPlain, { ...macd, barColors: { up: '#00ff00', down: THEME_TOKENS.light.down } }],
    };
    expect(result.current.layout).toEqual(expected);
    expect(put.mock.calls).toEqual([['default', expected]]);
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a layout already at the current revision keeps old-default colors the user picked (no revert on reload)', async () => {
    const l = { ...saved, appearance: { dark: { upColor: '#26a69a', lineColor: '#2962ff' } } };
    vi.mocked(api.layouts.get).mockResolvedValue(l);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout).toEqual(l);
    await settle();
    expect(put).not.toHaveBeenCalled();
    expect(migrateColorDefaults(l)).toBe(l);
  });

  it('the sticky drawing color survives the one-time color migration and a reload; older layouts have none', async () => {
    const old = { ...saved, colorDefaultsRev: 0, appearance: { dark: { drawing: { color: '#2962ff', size: 1, style: 'solid' as const } } }, drawingColor: 'palette:3' };
    expect(migrateColorDefaults(old)).toEqual({ ...saved, colorDefaultsRev: COLOR_DEFAULTS_REV, drawingColor: 'palette:3' });
    const l = { ...saved, drawingColor: 'up' };
    vi.mocked(api.layouts.get).mockResolvedValue(l);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout.drawingColor).toBe('up');
    expect(DEFAULT_LAYOUT).not.toHaveProperty('drawingColor');
  });

  it('withoutLegacyDefaults: an all-default appearance is dropped; a custom drawing width keeps it with the new accent', () => {
    expect(withoutLegacyDefaults({ ...saved, appearance: { dark: { upColor: '#26a69a' } } })).toEqual(saved);
    expect(withoutLegacyDefaults({ ...saved, appearance: { light: { drawing: { color: '#2962FF', size: 3, style: 'dashed' } } } }))
      .toEqual({ ...saved, appearance: { light: { drawing: { color: THEME_TOKENS.light.accent, size: 3, style: 'dashed' } } } });
    // The other theme's old defaults are user colors here (light #089981 in the dark theme stays).
    expect(withoutLegacyDefaults({ ...saved, appearance: { dark: { upColor: '#089981' } } })).toEqual({ ...saved, appearance: { dark: { upColor: '#089981' } } });
    expect(withoutLegacyDefaults(saved)).toBe(saved);
  });

  it('bar colors: direction-aware — an inverted legacy pair is the user\'s choice and is kept', () => {
    const ind = (barColors: { up: string; down: string }) => ({ ...saved, indicators: [{ ...ma, barColors }] });
    expect(withoutLegacyDefaults(ind({ up: '#ef5350', down: '#26a69a' }))).toEqual(ind({ up: '#ef5350', down: '#26a69a' }));
    expect(withoutLegacyDefaults(ind({ up: '#089981', down: '#123456' }))).toEqual(ind({ up: THEME_TOKENS.light.up, down: '#123456' }));
    expect(withoutLegacyDefaults(ind({ up: '#34d399', down: '#c41d3d' }))).toEqual({ ...saved, indicators: [ma] });
  });

  it('rev 2 ("Graphite & Signal") defaults are old defaults too: users on them get the current palette; picks survive', () => {
    const l = (appearance: Layout['appearance'], indicators = [ma]) => ({ ...savedRev0, indicators, appearance });
    const migrated = migrateColorDefaults(l({
      dark: { upColor: '#00d68f', downColor: '#FF3B5C', lineColor: '#2b66ff' },
      light: { upColor: '#00a870', downColor: '#123456', drawing: { color: '#2b66ff', size: 1, style: 'solid' } },
    }));
    expect(migrated).toEqual({ ...saved, appearance: { light: { downColor: '#123456' } } });
    // Bar colors: a rev 2 default pair follows the candles again; one rev 2 side next to a user color becomes today's.
    const vol = (barColors: { up: string; down: string }) => ({ ...ma, name: 'VOL', barColors });
    expect(withoutLegacyDefaults({ ...saved, indicators: [vol({ up: '#00d68f', down: '#ff3b5c' })] }).indicators).toEqual([{ ...ma, name: 'VOL' }]);
    expect(withoutLegacyDefaults({ ...saved, indicators: [vol({ up: '#abcdef', down: '#d4113b' })] }).indicators)
      .toEqual([vol({ up: '#abcdef', down: THEME_TOKENS.light.down })]);
  });

  it('rev 3 ("Luminous" teal / rose) defaults are old defaults too: a rev 3 layout moves to aqua / ruby once; picks survive', () => {
    expect(COLOR_DEFAULTS_REV).toBeGreaterThanOrEqual(4);
    const rev3 = (appearance: Layout['appearance'], indicators = [ma]) => ({ ...saved, colorDefaultsRev: 3, indicators, appearance });
    const migrated = migrateColorDefaults(rev3({
      dark: { upColor: '#34E0B8', downColor: '#ff4d73', lineWidth: 3 },
      light: { upColor: '#12b996', downColor: '#d92855' },
    }));
    expect(migrated).toEqual({ ...saved, appearance: { dark: { lineWidth: 3 } } });
    expect(migrated.colorDefaultsRev).toBe(COLOR_DEFAULTS_REV);
    // A user pick of another color is kept.
    expect(migrateColorDefaults(rev3({ dark: { upColor: '#3366ff', downColor: '#ff4d73' } })))
      .toEqual({ ...saved, appearance: { dark: { upColor: '#3366ff' } } });
    // Bar colors: a rev 3 default pair follows the candles again; one rev 3 side next to a user color becomes today's.
    const vol = (barColors: { up: string; down: string }) => ({ ...ma, name: 'VOL', barColors });
    expect(migrateColorDefaults(rev3(undefined, [vol({ up: '#34e0b8', down: '#ff4d73' })])).indicators).toEqual([{ ...ma, name: 'VOL' }]);
    expect(migrateColorDefaults(rev3(undefined, [vol({ up: '#12b996', down: '#abcdef' })])).indicators)
      .toEqual([vol({ up: THEME_TOKENS.light.up, down: '#abcdef' })]);
    expect(migrateColorDefaults(rev3(undefined, [vol({ up: '#abcdef', down: '#ff4d73' })])).indicators)
      .toEqual([vol({ up: '#abcdef', down: THEME_TOKENS.dark.down })]);
    // Already on the current revision: an old default the user picks later is never touched again.
    const current = { ...saved, appearance: { dark: { upColor: '#34e0b8' } } };
    expect(migrateColorDefaults(current)).toBe(current);
  });

  it('indicator line colors: old defaults move per line to today\'s palette, user picks stay', () => {
    const ind = (name: string, lineColors?: string[]) => ({ name, pane: 'main' as const, calcParams: [20, 2], visible: true, ...(lineColors ? { lineColors } : {}) });
    const migrate = (name: string, lineColors: string[]) => withoutLegacyDefaults({ ...saved, indicators: [ind(name, lineColors)] }).indicators[0];
    const dark = INDICATOR_PALETTE.dark;
    const light = INDICATOR_PALETTE.light;
    // All old defaults (rev 2 dark, any case) → dropped: the lines follow the active theme.
    expect(migrate('EMA', ['#2488f7', '#E56C19', '#00b3c2'])).toEqual(ind('EMA'));
    // Rev 1 light and rev 0 (KLineChart's colors by line index) too.
    expect(migrate('EMA', ['#2a78d6', '#eb6834', '#0097a7'])).toEqual(ind('EMA'));
    expect(migrate('EMA', ['#ff9600', '#935ebd', '#1677ff'])).toEqual(ind('EMA'));
    expect(migrate('VWAP', ['#01c5c4'])).toEqual(ind('VWAP'));
    // BOLL (upper / middle / lower = slots 2 / 1 / 3): one edited line, old-default siblings → siblings get today's
    // default for their own slot (in the theme of the palette they came from), the edit is kept.
    expect(migrate('BOLL', ['#e56c19', '#ff0000', '#00b3c2'])).toEqual(ind('BOLL', [dark[1]!, '#ff0000', dark[2]!]));
    expect(migrate('BOLL', ['#eb6111', '#123456', '#0095a0'])).toEqual(ind('BOLL', [light[1]!, '#123456', light[2]!]));
    // A swapped palette (slot 1 color on line 0) is a user pick, kept as is.
    expect(migrate('EMA', ['#e56c19', '#2488f7', '#00b3c2'])).toEqual(ind('EMA', ['#e56c19', '#2488f7', dark[2]!]));
    // Already migrated layouts are never touched again.
    const current = { ...saved, indicators: [ind('EMA', ['#2488f7', '#e56c19', '#00b3c2'])] };
    expect(migrateColorDefaults(current)).toBe(current);
  });

  it('rev 4 → 5: VWAP moved from the cyan slot (shared with the BOLL lower band) to blue; its old default follows the palette again, picks stay', () => {
    expect(COLOR_DEFAULTS_REV).toBe(5);
    const vwap = (lineColors?: string[]) => ({ name: 'VWAP', pane: 'main' as const, calcParams: [], visible: true, ...(lineColors ? { lineColors } : {}) });
    const rev4 = (lineColors: string[]) => ({ ...saved, colorDefaultsRev: 4, indicators: [vwap(lineColors)] });
    // The rev 4 default of either theme (any case) → unset: the line takes today's slot.
    expect(migrateColorDefaults(rev4(['#3fc8e4'])).indicators).toEqual([vwap()]);
    expect(migrateColorDefaults(rev4(['#0A8EA6'])).indicators).toEqual([vwap()]);
    expect(migrateColorDefaults(rev4(['#3fc8e4'])).colorDefaultsRev).toBe(5);
    // Older palettes at VWAP's old slot too (rev 2 dark cyan).
    expect(migrateColorDefaults({ ...rev4(['#00b3c2']), colorDefaultsRev: 2 }).indicators).toEqual([vwap()]);
    // Old generations only match at the slot VWAP used then: an old pink pick (rev 1 / rev 2 slot 5, today's VWAP slot)
    // was never VWAP's default and is kept.
    expect(migrateColorDefaults({ ...rev4(['#f631aa']), colorDefaultsRev: 2 }).indicators).toEqual([vwap(['#f631aa'])]);
    expect(migrateColorDefaults({ ...rev4(['#d55181']), colorDefaultsRev: 1 }).indicators).toEqual([vwap(['#d55181'])]);
    // A user pick — including another palette color — is kept.
    expect(migrateColorDefaults(rev4(['#123456'])).indicators).toEqual([vwap(['#123456'])]);
    expect(migrateColorDefaults(rev4(['#f2b861'])).indicators).toEqual([vwap(['#f2b861'])]);
    // Another indicator's cyan line (the BOLL lower band keeps slot 3) is not a moved default: untouched.
    const boll = { name: 'BOLL', pane: 'main' as const, calcParams: [20, 2], visible: true, lineColors: ['#a99bff', '#ff0000', '#3fc8e4'] };
    expect(migrateColorDefaults({ ...saved, colorDefaultsRev: 4, indicators: [boll] }).indicators).toEqual([boll]);
    // Already on rev 5: never touched again.
    const current = { ...saved, indicators: [vwap(['#3fc8e4'])] };
    expect(migrateColorDefaults(current)).toBe(current);
  });

  it('an appearance change saves the default key only', async () => {
    const appearance = { dark: { upColor: '#00ff00', drawing: { color: '#123456', size: 2, style: 'dashed' as const } } };
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await settle();
    act(() => result.current.setLayout((l) => ({ ...l, appearance })));
    await settle();
    expect(put.mock.calls.map((c) => c[0])).toEqual(['default']);
    expect(put.mock.calls[0]![1]).toMatchObject({ appearance });
  });
});

/** Promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('sanitizeIndicators (stored indicator values are checked on read)', () => {
  it('replaces invalid params with the catalog defaults and drops non-hex line colors; valid layouts are returned as is', () => {
    const l: Layout = {
      ...saved,
      indicators: [
        { name: 'RSI', pane: 'sub', calcParams: [0, 12.5, 1e9], visible: true, lineColors: ['red', '#123456', 'javascript:x'] },
        { name: 'BOLL', pane: 'main', calcParams: [20, -1], visible: true },
        { name: 'MA', pane: 'main', calcParams: [5, 10], visible: true, lineColors: ['', '#ABCDEF'] },
      ],
    };
    const out = sanitizeIndicators(l);
    expect(out.indicators[0]).toEqual({ name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true, lineColors: ['', '#123456'] });
    expect(out.indicators[1]).toEqual({ name: 'BOLL', pane: 'main', calcParams: [20, 2], visible: true });
    expect(out.indicators[2]).toBe(l.indicators[2]);
    expect(sanitizeIndicators(saved)).toBe(saved);
    // An indicator this version does not know keeps its finite params (its own validation is unknown).
    const unknown: Layout = { ...saved, indicators: [{ name: 'FUTURE', pane: 'sub', calcParams: [3, Number.NaN], visible: true }] };
    expect(sanitizeIndicators(unknown).indicators[0]!.calcParams).toEqual([3]);
  });

  it('keeps palette references in line and bar colors (they follow the theme); drops unknown references', () => {
    const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [6, 12, 24], visible: true };
    const ok: Layout = { ...saved, indicators: [{ ...rsi, lineColors: ['palette:3', '', 'up'] }] };
    expect(sanitizeIndicators(ok)).toBe(ok);
    const bad: Layout = { ...saved, indicators: [{ ...rsi, lineColors: ['palette:9', 'palette:1'] }] };
    expect(sanitizeIndicators(bad).indicators[0]!.lineColors).toEqual(['', 'palette:1']);
  });

  it('is applied when the default layout loads', async () => {
    vi.mocked(api.layouts.get).mockResolvedValue({ ...saved, indicators: [{ name: 'RSI', pane: 'sub', calcParams: [-3, 12, 24], visible: true }] });
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout.indicators[0]!.calcParams).toEqual([6, 12, 24]);
  });
});

describe('useLayout load failures and early edits', () => {
  it('a non-404 failure of the default load never adopts DEFAULT_LAYOUT or saves; it retries with backoff', async () => {
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default') throw new ApiError(500, 'internal', 'boom');
      return null;
    });
    const { result } = renderHook(() => useLayout());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(false);
    expect(result.current.loadError).toBe('boom');
    act(() => result.current.setLayout((l) => ({ ...l, tf: '1m' })));
    await settle();
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
    expect(put).not.toHaveBeenCalled();
    const calls = () => vi.mocked(api.layouts.get).mock.calls.filter((c) => c[0] === 'default').length;
    const before = calls();
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? saved : null));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls()).toBeGreaterThan(before);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loadError).toBeNull();
    expect(result.current.layout).toEqual(saved);
    await settle();
    expect(put).not.toHaveBeenCalled();
  });

  it('a permanent failure (e.g. 403) of the default load is not retried automatically; retry() still reloads it', async () => {
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default') throw new ApiError(403, 'forbidden', 'Forbidden');
      return null;
    });
    const { result } = renderHook(() => useLayout());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loadError).toBe('Forbidden');
    const calls = () => vi.mocked(api.layouts.get).mock.calls.filter((c) => c[0] === 'default').length;
    const before = calls();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls()).toBe(before);
    expect(result.current.loaded).toBe(false);
    vi.mocked(api.layouts.get).mockImplementation(async (key) => (key === 'default' ? saved : null));
    act(() => result.current.retry());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
  });

  it('retry() reloads the default layout at once', async () => {
    let fail = true;
    vi.mocked(api.layouts.get).mockImplementation(async (key) => {
      if (key === 'default') { if (fail) throw new ApiError(0, 'network_error', 'offline'); return saved; }
      return null;
    });
    const { result } = renderHook(() => useLayout());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loadError).toBe('offline');
    fail = false;
    act(() => result.current.retry());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loaded).toBe(true);
    expect(result.current.layout).toEqual(saved);
  });

  it('a symbol selected before the default layout loads is applied on top of it (and saved)', async () => {
    const d = deferred<Layout | null>();
    vi.mocked(api.layouts.get).mockImplementation((key) => (key === 'default' ? d.promise : Promise.resolve(null)));
    const { result } = renderHook(() => useLayout());
    act(() => result.current.selectSymbol('stock:MSFT'));
    expect(result.current.layout.symbol).toBe(DEFAULT_LAYOUT.symbol);
    await act(async () => { d.resolve(saved); await Promise.resolve(); });
    await waitFor(() => expect(result.current.layout).toEqual({ ...saved, symbol: 'stock:MSFT' }));
    await settle();
    expect(put).toHaveBeenCalledWith('default', expect.objectContaining({ symbol: 'stock:MSFT', tf: saved.tf, indicators: [ma] }));
  });

  it('a failed save exposes saveError and is retried with backoff until it succeeds', async () => {
    put.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'down')).mockRejectedValueOnce(new ApiError(0, 'network_error', 'offline'));
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.saveError).toBeNull();
    act(() => result.current.setLayout((l) => ({ ...l, tf: '1m' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.saveError).toBe('down');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.saveError).toBe('offline');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls.every((c) => c[0] === 'default' && c[1].tf === '1m')).toBe(true);
    expect(result.current.saveError).toBeNull();
  });

  it('a missing default layout (null) falls back to DEFAULT_LAYOUT', async () => {
    vi.mocked(api.layouts.get).mockResolvedValue(null);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
  });
});
