import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CSSProperties, JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarResizer } from '../src/components/SidebarResizer';
import { DEFAULT_SIDEBAR_WIDTH, useSidebarWidth } from '../src/state/sidebarWidth';

const setViewport = (w: number) => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: w }); };

let renders = 0;
function Harness(): JSX.Element {
  const s = useSidebarWidth();
  renders += 1;
  return (
    <div data-testid="shell" ref={s.shellRef as never} style={{ '--sidebar-w': `${s.width}px` } as CSSProperties}>
      <SidebarResizer width={s.width} min={s.min} max={s.max} onPreview={s.preview} onCommit={s.commit} onReset={s.reset} />
    </div>
  );
}
const shellWidth = () => screen.getByTestId('shell').style.getPropertyValue('--sidebar-w');

const separator = () => screen.getByRole('separator', { name: 'Resize watchlist' });
const stored = () => localStorage.getItem('chartmate.sidebar.width');

// jsdom has no PointerEvent constructor with clientX; a MouseEvent carries the coordinates and pointer fields.
function pointer(type: string, el: Element, clientX: number, buttons = type === 'pointerup' ? 0 : 1): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, buttons });
  Object.assign(e, { pointerId: 1, isPrimary: true, pointerType: 'mouse' });
  fireEvent(el, e);
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setViewport(1024);
});

describe('SidebarResizer', () => {
  it('is a vertical separator exposing the width and its bounds', () => {
    setViewport(1600);
    render(<Harness />);
    const sep = separator();
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH));
    expect(sep).toHaveAttribute('aria-valuemin', '240');
    expect(sep).toHaveAttribute('aria-valuemax', '800');
    expect(sep).toHaveAttribute('tabindex', '0');
  });

  it('dragging left widens the sidebar live and stores the width on release', () => {
    setViewport(1600);
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointerdown', sep, 1000));
    const before = renders;
    act(() => pointer('pointermove', sep, 900));
    expect(raf).toHaveBeenCalled();
    expect(sep).toHaveAttribute('aria-valuenow', '420');
    expect(shellWidth()).toBe('420px');
    expect(renders).toBe(before); // the drag writes the CSS variable directly; React renders only on release
    expect(stored()).toBeNull();
    act(() => pointer('pointermove', sep, 950));
    act(() => pointer('pointerup', sep, 950));
    expect(sep).toHaveAttribute('aria-valuenow', '370');
    expect(stored()).toBe('370');
  });

  it('coalesces pointer moves into one update per animation frame', () => {
    setViewport(1600);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointerdown', sep, 1000));
    act(() => { pointer('pointermove', sep, 990); pointer('pointermove', sep, 980); pointer('pointermove', sep, 960); });
    expect(frames).toHaveLength(1);
    expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH));
    act(() => frames[0]!(0));
    expect(sep).toHaveAttribute('aria-valuenow', '360');
    // Release applies the last position even if its frame has not run yet.
    act(() => pointer('pointermove', sep, 940));
    act(() => pointer('pointerup', sep, 940));
    expect(sep).toHaveAttribute('aria-valuenow', '380');
    expect(stored()).toBe('380');
  });

  it('clamps a drag to the bounds', () => {
    setViewport(1000); // max 496
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointerdown', sep, 600));
    act(() => pointer('pointermove', sep, 0));
    act(() => pointer('pointerup', sep, 0));
    expect(sep).toHaveAttribute('aria-valuenow', '496');
    act(() => pointer('pointerdown', sep, 0));
    act(() => pointer('pointermove', sep, 900));
    act(() => pointer('pointerup', sep, 900));
    expect(sep).toHaveAttribute('aria-valuenow', '240');
    expect(stored()).toBe('240');
  });

  it('ignores moves without a press and non-primary buttons', () => {
    setViewport(1600);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointermove', sep, 100));
    expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH));
    const right = new MouseEvent('pointerdown', { bubbles: true, clientX: 1000, button: 2 });
    act(() => { fireEvent(sep, right); pointer('pointermove', sep, 800); });
    expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH));
  });

  it('resizes with the keyboard: arrows by 16 px, Home / End to the bounds', async () => {
    setViewport(1600);
    render(<Harness />);
    const sep = separator();
    sep.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(sep).toHaveAttribute('aria-valuenow', '336');
    expect(stored()).toBe('336');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(sep).toHaveAttribute('aria-valuenow', '304');
    await userEvent.keyboard('{End}');
    expect(sep).toHaveAttribute('aria-valuenow', '800');
    await userEvent.keyboard('{Home}');
    expect(sep).toHaveAttribute('aria-valuenow', '240');
    await userEvent.keyboard('{ArrowRight}');
    expect(sep).toHaveAttribute('aria-valuenow', '240');
    expect(stored()).toBe('240');
  });

  it('double-click resets to the default width', async () => {
    localStorage.setItem('chartmate.sidebar.width', '500');
    setViewport(1600);
    render(<Harness />);
    const sep = separator();
    expect(sep).toHaveAttribute('aria-valuenow', '500');
    await userEvent.dblClick(sep);
    expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH));
    expect(stored()).toBe(String(DEFAULT_SIDEBAR_WIDTH));
  });

  it('Enter also resets to the default width', async () => {
    localStorage.setItem('chartmate.sidebar.width', '500');
    setViewport(1600);
    render(<Harness />);
    separator().focus();
    await userEvent.keyboard('{Enter}');
    expect(separator()).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH));
  });

  it('pointercancel keeps the last previewed width and ignores the cancel position', () => {
    setViewport(1600);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointerdown', sep, 1000));
    act(() => pointer('pointermove', sep, 900));
    act(() => pointer('pointercancel', sep, 0, 0));
    expect(sep).toHaveAttribute('aria-valuenow', '420');
    expect(stored()).toBe('420');
  });

  it('losing pointer capture ends the drag at the last previewed width', () => {
    setViewport(1600);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointerdown', sep, 1000));
    act(() => pointer('pointermove', sep, 900));
    act(() => pointer('lostpointercapture', sep, 0, 0));
    expect(stored()).toBe('420');
    act(() => pointer('pointermove', sep, 700));
    expect(sep).toHaveAttribute('aria-valuenow', '420');
  });

  it('a move with no button pressed ends a drag whose release was missed', () => {
    setViewport(1600);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    render(<Harness />);
    const sep = separator();
    act(() => pointer('pointerdown', sep, 1000));
    act(() => pointer('pointermove', sep, 900));
    act(() => pointer('pointermove', sep, 800, 0));
    expect(stored()).toBe('420');
    act(() => pointer('pointermove', sep, 700));
    expect(sep).toHaveAttribute('aria-valuenow', '420');
  });

  it('Shift+arrows resize by 64 px', async () => {
    setViewport(1600);
    render(<Harness />);
    const sep = separator();
    sep.focus();
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(sep).toHaveAttribute('aria-valuenow', '384');
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(sep).toHaveAttribute('aria-valuenow', '256');
    expect(stored()).toBe('256');
  });
});
