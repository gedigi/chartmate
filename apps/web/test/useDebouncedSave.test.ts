import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { useDebouncedSave } from '../src/state/useDebouncedSave';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(initial: number, enabled = true) {
  const save = vi.fn<(v: number) => Promise<void>>().mockResolvedValue(undefined);
  const hook = renderHook(({ v, en }) => useDebouncedSave(v, save, 1000, en), { initialProps: { v: initial, en: enabled } });
  return { save, ...hook };
}

describe('useDebouncedSave', () => {
  it('does not save the initial value', () => {
    const { save } = setup(1);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(save).not.toHaveBeenCalled();
  });

  it('coalesces multiple changes within the delay into one save of the last value', async () => {
    const { save, rerender, result } = setup(1);
    rerender({ v: 2, en: true });
    act(() => { vi.advanceTimersByTime(400); });
    rerender({ v: 3, en: true });
    act(() => { vi.advanceTimersByTime(400); });
    rerender({ v: 4, en: true });
    expect(result.current.saving).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(4);
    expect(result.current.saving).toBe(false);
  });

  it('flushes a pending save on unmount', () => {
    const { save, rerender, unmount } = setup(1);
    rerender({ v: 7, en: true });
    unmount();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(7);
  });

  it('flushes a pending save on beforeunload', () => {
    const { save, rerender } = setup(1);
    rerender({ v: 9, en: true });
    act(() => { window.dispatchEvent(new Event('beforeunload')); });
    expect(save).toHaveBeenCalledWith(9);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending save on pagehide too (fires where beforeunload does not, e.g. mobile and bfcache)', () => {
    const { save, rerender } = setup(1);
    rerender({ v: 5, en: true });
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(save).toHaveBeenCalledWith(5);
    act(() => { window.dispatchEvent(new Event('beforeunload')); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reports save errors', async () => {
    const save = vi.fn<(v: number) => Promise<void>>().mockRejectedValue(new Error('disk full'));
    const { rerender, result } = renderHook(({ v }) => useDebouncedSave(v, save, 1000), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(result.current.error).toBe('disk full');
  });

  it('ignores changes while disabled and takes the value at enable time as baseline', () => {
    const { save, rerender } = setup(1, false);
    rerender({ v: 2, en: false });
    rerender({ v: 3, en: true });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(save).not.toHaveBeenCalled();
    rerender({ v: 4, en: true });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(save).toHaveBeenCalledWith(4);
  });

  it('with retry: re-saves a failed value with backoff (2 s, 5 s) and clears the error on success', async () => {
    const save = vi.fn<(v: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    const { rerender, result } = renderHook(({ v }) => useDebouncedSave(v, save, 1000, true, { retry: true }), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('down');
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls.map((c) => c[0])).toEqual([2, 2, 2]);
    expect(result.current.error).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('with retry: a newer value supersedes the retry; an older failure never re-saves over a newer value', async () => {
    let rejectFirst!: (e: Error) => void;
    const save = vi.fn<(v: number) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej; }))
      .mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v }) => useDebouncedSave(v, save, 1000, true, { retry: true }), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // save(2) in flight
    rerender({ v: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // save(3) succeeds
    await act(async () => { rejectFirst(new Error('late failure')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(save.mock.calls.map((c) => c[0])).toEqual([2, 3]);
  });

  it('out-of-order responses: only the latest save sets or clears the error', async () => {
    let settleFirst!: { resolve: () => void; reject: (e: Error) => void };
    const save = vi.fn<(v: number) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve, reject) => { settleFirst = { resolve, reject }; }))
      .mockRejectedValueOnce(new Error('latest failed'))
      .mockImplementationOnce(() => new Promise<void>((resolve, reject) => { settleFirst = { resolve, reject }; }))
      .mockResolvedValueOnce(undefined);
    const { rerender, result } = renderHook(({ v }) => useDebouncedSave(v, save, 1000), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // save(2) in flight
    rerender({ v: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // save(3) fails
    expect(result.current.error).toBe('latest failed');
    await act(async () => { settleFirst.resolve(); }); // stale success must not hide the live error
    expect(result.current.error).toBe('latest failed');
    rerender({ v: 4 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // save(4) in flight
    rerender({ v: 5 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // save(5) succeeds
    expect(result.current.error).toBeNull();
    await act(async () => { settleFirst.reject(new Error('stale failure')); }); // must not raise a stale badge
    expect(result.current.error).toBeNull();
  });

  it('with retry: a permanent 4xx is not retried and its error stays shown', async () => {
    const save = vi.fn<(v: number) => Promise<void>>().mockRejectedValue(new ApiError(400, 'invalid_request', 'too many indicators'));
    const { rerender, result } = renderHook(({ v }) => useDebouncedSave(v, save, 1000, true, { retry: true }), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('too many indicators');
  });

  it('with retry: transient statuses (e.g. 503, 429, 409) are retried', async () => {
    for (const status of [503, 429, 409]) {
      const save = vi.fn<(v: number) => Promise<void>>()
        .mockRejectedValueOnce(new ApiError(status, 'x', 'busy')).mockResolvedValue(undefined);
      const { rerender, unmount } = renderHook(({ v }) => useDebouncedSave(v, save, 1000, true, { retry: true }), { initialProps: { v: 1 } });
      rerender({ v: 2 });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(save, String(status)).toHaveBeenCalledTimes(2);
      unmount();
    }
  });

  it('without retry, a failed save is not retried', async () => {
    const save = vi.fn<(v: number) => Promise<void>>().mockRejectedValue(new Error('x'));
    const { rerender } = renderHook(({ v }) => useDebouncedSave(v, save, 1000), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('uses the save function of the latest committed render', async () => {
    const first = vi.fn<(v: number) => Promise<void>>().mockResolvedValue(undefined);
    const second = vi.fn<(v: number) => Promise<void>>().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v, s }) => useDebouncedSave(v, s, 1000), { initialProps: { v: 1, s: first } });
    rerender({ v: 2, s: second });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(2);
  });

  it('flushes a pending save when disabled', () => {
    const { save, rerender } = setup(1);
    rerender({ v: 5, en: true });
    rerender({ v: 5, en: false });
    expect(save).toHaveBeenCalledWith(5);
  });
});
