import type { Layout } from '@altv/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { api, ApiError } from '../src/api/client';
import { COLOR_DEFAULTS_REV } from '../src/chart/theme';
import { DEFAULT_LAYOUT, migrateColorDefaults, useLayout, withoutLegacyDefaults } from '../src/state/useLayout';

const ma = { name: 'MA', pane: 'main' as const, calcParams: [20], visible: true };
const rsi = { name: 'RSI', pane: 'sub' as const, calcParams: [14], visible: true };
/** Saved by the current version (colours already migrated). */
const saved: Layout = { symbol: 'stock:AAPL', tf: '1h', session: 'rth', chartType: 'candle', indicators: [ma], colorDefaultsRev: COLOR_DEFAULTS_REV };
/** The same layout as saved before the colour-defaults revision existed. */
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

  it('once: a layout from before the colour revision gets old-default colours unset, is stamped and saved back', async () => {
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
      indicators: [ma, volPlain, { ...macd, barColors: { up: '#00ff00', down: '#d4113b' } }],
    };
    expect(result.current.layout).toEqual(expected);
    expect(put.mock.calls).toEqual([['default', expected]]);
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a layout already at the current revision keeps old-default colours the user picked (no revert on reload)', async () => {
    const l = { ...saved, appearance: { dark: { upColor: '#26a69a', lineColor: '#2962ff' } } };
    vi.mocked(api.layouts.get).mockResolvedValue(l);
    const { result } = renderHook(() => useLayout());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.layout).toEqual(l);
    await settle();
    expect(put).not.toHaveBeenCalled();
    expect(migrateColorDefaults(l)).toBe(l);
  });

  it('withoutLegacyDefaults: an all-default appearance is dropped; a custom drawing width keeps it with the new accent', () => {
    expect(withoutLegacyDefaults({ ...saved, appearance: { dark: { upColor: '#26a69a' } } })).toEqual(saved);
    expect(withoutLegacyDefaults({ ...saved, appearance: { light: { drawing: { color: '#2962FF', size: 3, style: 'dashed' } } } }))
      .toEqual({ ...saved, appearance: { light: { drawing: { color: '#2b66ff', size: 3, style: 'dashed' } } } });
    // The other theme's old defaults are user colours here (light #089981 in the dark theme stays).
    expect(withoutLegacyDefaults({ ...saved, appearance: { dark: { upColor: '#089981' } } })).toEqual({ ...saved, appearance: { dark: { upColor: '#089981' } } });
    expect(withoutLegacyDefaults(saved)).toBe(saved);
  });

  it('bar colours: direction-aware — an inverted legacy pair is the user\'s choice and is kept', () => {
    const ind = (barColors: { up: string; down: string }) => ({ ...saved, indicators: [{ ...ma, barColors }] });
    expect(withoutLegacyDefaults(ind({ up: '#ef5350', down: '#26a69a' }))).toEqual(ind({ up: '#ef5350', down: '#26a69a' }));
    expect(withoutLegacyDefaults(ind({ up: '#089981', down: '#123456' }))).toEqual(ind({ up: '#00a870', down: '#123456' }));
    expect(withoutLegacyDefaults(ind({ up: '#34d399', down: '#c41d3d' }))).toEqual({ ...saved, indicators: [ma] });
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
