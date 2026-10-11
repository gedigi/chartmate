import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('flushes a pending save when disabled', () => {
    const { save, rerender } = setup(1);
    rerender({ v: 5, en: true });
    rerender({ v: 5, en: false });
    expect(save).toHaveBeenCalledWith(5);
  });
});
