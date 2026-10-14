import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, clampSidebarWidth, sidebarWidthBounds, useSidebarWidth,
} from '../src/state/sidebarWidth';

const setViewport = (w: number) => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: w }); };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setViewport(1024);
});

describe('sidebarWidthBounds', () => {
  it('caps the sidebar at half the window', () => {
    expect(sidebarWidthBounds(1600)).toEqual({ min: MIN_SIDEBAR_WIDTH, max: 800 });
  });

  it('keeps at least 480 px for the chart (plus the gutters)', () => {
    // 900 - 480 - 24 = 396 < 450
    expect(sidebarWidthBounds(900).max).toBe(396);
  });

  it('never drops max below min on a tiny window', () => {
    expect(sidebarWidthBounds(600)).toEqual({ min: MIN_SIDEBAR_WIDTH, max: MIN_SIDEBAR_WIDTH });
  });
});

describe('clampSidebarWidth', () => {
  it('clamps into the bounds and rounds', () => {
    expect(clampSidebarWidth(100, 1600)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(2000, 1600)).toBe(800);
    expect(clampSidebarWidth(333.6, 1600)).toBe(334);
  });

  it('falls back to the default for a non-number', () => {
    expect(clampSidebarWidth(Number.NaN, 1600)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe('useSidebarWidth', () => {
  it('starts at the default width', () => {
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('loads the stored width, clamped to the window', () => {
    localStorage.setItem('chartmate.sidebar.width', '700');
    setViewport(1000); // max = min(500, 496) = 496
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(496);
  });

  it('ignores a garbage stored value', () => {
    localStorage.setItem('chartmate.sidebar.width', 'wide');
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('survives unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH);
    act(() => result.current.commit(400));
    expect(result.current.width).toBe(400);
  });

  it('previews on the shell element only (no React state, nothing stored), and persists on commit', () => {
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    const shell = document.createElement('div');
    result.current.shellRef.current = shell;
    let shown = 0;
    act(() => { shown = result.current.preview(410); });
    expect(shown).toBe(410);
    expect(shell.style.getPropertyValue('--sidebar-w')).toBe('410px');
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(localStorage.getItem('chartmate.sidebar.width')).toBeNull();
    act(() => { shown = result.current.preview(5000); });
    expect(shown).toBe(800);
    act(() => result.current.commit(420));
    expect(result.current.width).toBe(420);
    expect(shell.style.getPropertyValue('--sidebar-w')).toBe('420px');
    expect(localStorage.getItem('chartmate.sidebar.width')).toBe('420');
  });

  it('a commit equal to the current width still overwrites a previewed value', () => {
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    const shell = document.createElement('div');
    result.current.shellRef.current = shell;
    act(() => { result.current.preview(500); });
    act(() => result.current.commit(DEFAULT_SIDEBAR_WIDTH));
    expect(shell.style.getPropertyValue('--sidebar-w')).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`);
  });

  it('clamps commits to the window', () => {
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.commit(5000));
    expect(result.current.width).toBe(800);
    expect(localStorage.getItem('chartmate.sidebar.width')).toBe('800');
  });

  it('re-clamps on window resize and restores the preference when the window grows again', () => {
    localStorage.setItem('chartmate.sidebar.width', '600');
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(600);
    act(() => { setViewport(1000); window.dispatchEvent(new Event('resize')); });
    expect(result.current.width).toBe(496);
    expect(result.current.max).toBe(496);
    act(() => { setViewport(1600); window.dispatchEvent(new Event('resize')); });
    expect(result.current.width).toBe(600);
  });

  it('reset returns to the default width and stores it', () => {
    localStorage.setItem('chartmate.sidebar.width', '600');
    setViewport(1600);
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.reset());
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(localStorage.getItem('chartmate.sidebar.width')).toBe(String(DEFAULT_SIDEBAR_WIDTH));
  });
});
