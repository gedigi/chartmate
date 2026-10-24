import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_QUERY, useCompact } from '../src/state/useCompact';

/** A controllable matchMedia: `set(true)` flips every query's match and notifies the listeners. */
function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    queries.push(query);
    return {
      get matches() { return matches; },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
  });
  return { queries, listeners, set: (v: boolean) => { matches = v; listeners.forEach((fn) => fn()); } };
}

afterEach(() => vi.unstubAllGlobals());

describe('useCompact', () => {
  it('follows the phone-width media query, live', () => {
    const mm = mockMatchMedia(false);
    const { result, unmount } = renderHook(() => useCompact());
    expect(mm.queries).toContain(COMPACT_QUERY);
    expect(result.current).toBe(false);
    act(() => mm.set(true));
    expect(result.current).toBe(true);
    unmount();
    expect(mm.listeners.size).toBe(0);
  });

  it('is false without matchMedia (wide layout)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useCompact());
    expect(result.current).toBe(false);
  });
});
