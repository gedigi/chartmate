import { describe, expect, it, vi } from 'vitest';
import { focusOrCreateWindow, probeTheme, visibleBounds } from '../src/lib/windowState.js';

describe('visibleBounds: size clamped to the chosen display', () => {
  const laptop = { x: 0, y: 0, width: 1440, height: 875 };
  const external = { x: 1440, y: 0, width: 2560, height: 1415 };

  it('keeps bounds that fit', () => {
    expect(visibleBounds({ x: 100, y: 50, width: 1000, height: 700 }, [laptop])).toEqual({ x: 100, y: 50, width: 1000, height: 700 });
  });

  it('shrinks a window saved on a larger display to the work area it reopens on, fully inside it', () => {
    // Saved full size on the external display, which is now gone.
    expect(visibleBounds({ x: 10, y: 0, width: 2560, height: 1415 }, [laptop])).toEqual({ x: 0, y: 0, width: 1440, height: 875 });
  });

  it('1440×900 screen (menu bar: work area from y=25): a full-screen-sized window fits exactly', () => {
    const mac = { x: 0, y: 25, width: 1440, height: 875 };
    expect(visibleBounds({ x: 0, y: 0, width: 1440, height: 900 }, [mac])).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    // Fits in size but hangs off the right and bottom edges: moved in, not shrunk.
    expect(visibleBounds({ x: 200, y: 100, width: 1400, height: 850 }, [mac])).toEqual({ x: 40, y: 50, width: 1400, height: 850 });
  });

  it('uses the display the window overlaps most, not the first match', () => {
    // Top-left on the laptop, but most of the window is on the external display.
    expect(visibleBounds({ x: 1300, y: 20, width: 2000, height: 1200 }, [laptop, external]))
      .toEqual({ x: 1440, y: 20, width: 2000, height: 1200 });
    expect(visibleBounds({ x: 1500, y: 20, width: 3000, height: 2000 }, [laptop, external]))
      .toEqual({ x: 1440, y: 0, width: 2560, height: 1415 });
  });

  it('still drops bounds that are off every display', () => {
    expect(visibleBounds({ x: 9000, y: 0, width: 1000, height: 700 }, [laptop, external])).toBeNull();
    expect(visibleBounds(null, [laptop])).toBeNull();
  });
});

describe('probeTheme (window close)', () => {
  it('returns the page theme', async () => {
    expect(await probeTheme(async () => 'light', 'dark')).toBe('light');
    expect(await probeTheme(async () => 'dark', 'light')).toBe('dark');
  });

  it('keeps the previous theme when the page does not answer in time (not dark)', async () => {
    vi.useFakeTimers();
    try {
      const p = probeTheme(() => new Promise(() => {}), 'light', 300);
      await vi.advanceTimersByTimeAsync(300);
      expect(await p).toBe('light');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the previous theme when the probe fails or returns something else', async () => {
    expect(await probeTheme(async () => { throw new Error('gone'); }, 'light')).toBe('light');
    expect(await probeTheme(async () => undefined, 'light')).toBe('light');
    expect(await probeTheme(async () => 'neon', 'light')).toBe('light');
  });
});

describe('focusOrCreateWindow (second instance)', () => {
  const win = (minimized = false) => ({
    isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => minimized), restore: vi.fn(), focus: vi.fn(),
  });

  it('focuses (and restores) the existing window', () => {
    const w = win(true);
    const create = vi.fn();
    focusOrCreateWindow(w, { ready: true, create });
    expect(w.restore).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('opens a window when there is none (e.g. macOS after closing it)', () => {
    const create = vi.fn();
    focusOrCreateWindow(null, { ready: true, create });
    expect(create).toHaveBeenCalledOnce();
  });

  it('does nothing before startup has finished (startup opens the window itself)', () => {
    const create = vi.fn();
    focusOrCreateWindow(null, { ready: false, create });
    expect(create).not.toHaveBeenCalled();
  });
});
