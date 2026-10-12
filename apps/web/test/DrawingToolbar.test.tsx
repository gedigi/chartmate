import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingToolbar, type DrawingControls } from '../src/components/DrawingToolbar';

function makeControls() {
  let onEnd: (() => void) | undefined;
  let lockCb: ((locked: boolean) => void) | null = null;
  const c = {
    startDrawing: vi.fn((_tool: string, opts?: { text?: string; onEnd?: () => void }) => { onEnd = opts?.onEnd; }),
    cancelDrawing: vi.fn(),
    clearDrawings: vi.fn(),
    removeSelected: vi.fn(() => true),
    setMagnet: vi.fn(),
    setLockAll: vi.fn(),
    setMagnetOverride: vi.fn(),
    deselect: vi.fn(),
    onLockAllChange: vi.fn((cb: (locked: boolean) => void) => { lockCb = cb; return () => { lockCb = null; }; }),
  };
  return {
    c: c as typeof c & DrawingControls,
    end: () => act(() => onEnd?.()),
    emitLock: (v: boolean) => act(() => lockCb?.(v)),
    hasLockListener: () => lockCb !== null,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('DrawingToolbar strong magnet (Meta on macOS, Ctrl elsewhere)', () => {
  const setPlatform = (p: string) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(p);

  it('holding Meta on macOS switches the active drawing to strong magnet; release and blur revert', () => {
    setPlatform('MacIntel');
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(document.body, { key: 'Meta' });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(document.body, { key: 'Control', ctrlKey: true });
    expect(c.setMagnetOverride).toHaveBeenCalledTimes(2); // Ctrl does nothing on macOS
    fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
    fireEvent.blur(window);
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(false);
  });

  it('resets when the page is hidden or a pointer event arrives without the modifier', () => {
    setPlatform('MacIntel');
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
    fireEvent.pointerMove(document.body, { metaKey: true });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(true); // still held
    fireEvent.pointerDown(document.body, { metaKey: false });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(true);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(false);
    hidden.mockRestore();
  });

  it('prefers navigator.userAgentData.platform over navigator.platform', () => {
    setPlatform('Linux x86_64');
    Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' }, configurable: true });
    try {
      const { c } = makeControls();
      render(<DrawingToolbar controls={c} ticker="AAPL" />);
      fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
      expect(c.setMagnetOverride).toHaveBeenLastCalledWith(true);
    } finally {
      delete (navigator as { userAgentData?: unknown }).userAgentData;
    }
  });

  it('uses Ctrl on other platforms and ignores keys typed into inputs', () => {
    setPlatform('Linux x86_64');
    const { c } = makeControls();
    render(<><input aria-label="field" /><DrawingToolbar controls={c} ticker="AAPL" /></>);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Control', ctrlKey: true });
    expect(c.setMagnetOverride).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
    expect(c.setMagnetOverride).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Control', ctrlKey: true });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(document.body, { key: 'Control' });
    expect(c.setMagnetOverride).toHaveBeenLastCalledWith(false);
  });
});

describe('DrawingToolbar', () => {
  it('Escape deselects the selected drawing (closing its style bar) unless typing', () => {
    const { c } = makeControls();
    render(<><input aria-label="field" /><DrawingToolbar controls={c} ticker="AAPL" /></>);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Escape' });
    expect(c.deselect).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(c.deselect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Trend line', 'segment'], ['Ray', 'rayLine'], ['Extended line', 'straightLine'],
    ['Horizontal line', 'horizontalStraightLine'], ['Vertical line', 'verticalStraightLine'], ['Price line', 'priceLine'],
    ['Parallel channel', 'parallelStraightLine'], ['Fibonacci retracement', 'fibonacciLine'],
  ])('clicking %s starts drawing %s and highlights it until the drawing completes', async (label, tool) => {
    const { c, end } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const btn = screen.getByRole('button', { name: label });
    expect(btn).toHaveAttribute('title', label);
    await userEvent.click(btn);
    expect(c.startDrawing).toHaveBeenCalledWith(tool, expect.objectContaining({ onEnd: expect.any(Function) }));
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    end();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('Escape cancels the active tool', async () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const btn = screen.getByRole('button', { name: 'Ray' });
    await userEvent.click(btn);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(c.cancelDrawing).toHaveBeenCalled();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('Text asks for the text in a popover, then starts a simpleAnnotation with it', async () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(c.startDrawing).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Annotation text' }), 'Breakout');
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(c.startDrawing).toHaveBeenCalledWith('simpleAnnotation', expect.objectContaining({ text: 'Breakout' }));
    expect(screen.queryByRole('textbox', { name: 'Annotation text' })).not.toBeInTheDocument();
  });

  it('Text popover: Enter submits, Cancel and empty text do not draw', async () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(c.startDrawing).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Annotation text' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Annotation text' }), 'Hi{Enter}');
    expect(c.startDrawing).toHaveBeenCalledWith('simpleAnnotation', expect.objectContaining({ text: 'Hi' }));
  });

  it('Clear all asks for confirmation before clearing', async () => {
    const { c } = makeControls();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const btn = screen.getByRole('button', { name: 'Clear all drawings' });
    await userEvent.click(btn);
    expect(confirm).toHaveBeenCalledWith('Remove all drawings on AAPL?');
    expect(c.clearDrawings).not.toHaveBeenCalled();
    await userEvent.click(btn);
    expect(c.clearDrawings).toHaveBeenCalledTimes(1);
  });

  it('Magnet and Lock all are toggles reflected via aria-pressed', async () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const magnet = screen.getByRole('button', { name: 'Magnet' });
    expect(magnet).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(magnet);
    expect(magnet).toHaveAttribute('aria-pressed', 'true');
    expect(c.setMagnet).toHaveBeenLastCalledWith(true);
    await userEvent.click(magnet);
    expect(magnet).toHaveAttribute('aria-pressed', 'false');
    expect(c.setMagnet).toHaveBeenLastCalledWith(false);
    const lock = screen.getByRole('button', { name: 'Lock all drawings' });
    await userEvent.click(lock);
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    expect(c.setLockAll).toHaveBeenLastCalledWith(true);
  });

  it('Delete/Backspace remove the selected drawing unless typing in an input', () => {
    const { c } = makeControls();
    render(<><input aria-label="other" /><DrawingToolbar controls={c} ticker="AAPL" /></>);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(c.removeSelected).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'other' }), { key: 'Delete' });
    expect(c.removeSelected).toHaveBeenCalledTimes(2);
  });

  it('Delete/Backspace ignore watchlist, dialogs, buttons and listbox options, and do nothing while disabled', () => {
    const { c } = makeControls();
    const { rerender } = render(
      <>
        <section data-testid="watchlist"><span tabIndex={0}>row</span></section>
        <div role="dialog" aria-label="dlg"><span tabIndex={0}>in dialog</span></div>
        <button type="button">btn</button>
        <ul role="listbox" aria-label="lb"><li role="option" aria-selected="false">opt</li></ul>
        <DrawingToolbar controls={c} ticker="AAPL" />
      </>,
    );
    fireEvent.keyDown(screen.getByText('row'), { key: 'Delete' });
    fireEvent.keyDown(screen.getByText('in dialog'), { key: 'Backspace' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'btn' }), { key: 'Delete' });
    fireEvent.keyDown(screen.getByRole('option', { name: 'opt' }), { key: 'Delete' });
    expect(c.removeSelected).not.toHaveBeenCalled();
    rerender(<DrawingToolbar controls={c} disabled ticker="AAPL" />);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(c.removeSelected).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Trend line' })).toBeDisabled();
  });

  it('Lock all reflects the adapter state (e.g. 2 locked drawings restored) and a click unlocks all', async () => {
    const { c, emitLock } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const lock = screen.getByRole('button', { name: 'Lock all drawings' });
    expect(lock).toHaveAttribute('aria-pressed', 'false');
    emitLock(true);
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(lock);
    expect(c.setLockAll).toHaveBeenLastCalledWith(false);
    expect(lock).toHaveAttribute('aria-pressed', 'false');
  });

  it('Clear all cancelled in the confirm keeps the in-progress drawing', async () => {
    const { c } = makeControls();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const ray = screen.getByRole('button', { name: 'Ray' });
    await userEvent.click(ray);
    await userEvent.click(screen.getByRole('button', { name: 'Clear all drawings' }));
    expect(c.cancelDrawing).not.toHaveBeenCalled();
    expect(ray).toHaveAttribute('aria-pressed', 'true');
  });

  it('Escape typed inside an input does not cancel the active tool', async () => {
    const { c } = makeControls();
    render(<><input aria-label="other" /><DrawingToolbar controls={c} ticker="AAPL" /></>);
    const ray = screen.getByRole('button', { name: 'Ray' });
    await userEvent.click(ray);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'other' }), { key: 'Escape' });
    expect(c.cancelDrawing).not.toHaveBeenCalled();
    expect(ray).toHaveAttribute('aria-pressed', 'true');
  });

  it('removes its keyboard listener and lock subscription on unmount', () => {
    const { c, hasLockListener } = makeControls();
    const { unmount } = render(<DrawingToolbar controls={c} ticker="AAPL" />);
    expect(hasLockListener()).toBe(true);
    unmount();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(c.removeSelected).not.toHaveBeenCalled();
    expect(hasLockListener()).toBe(false);
  });

  it('Delete selected button removes the selected drawing', async () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected drawing' }));
    expect(c.removeSelected).toHaveBeenCalledTimes(1);
  });

  it('buttons are disabled without a chart', () => {
    render(<DrawingToolbar controls={null} ticker="AAPL" />);
    expect(screen.getByRole('button', { name: 'Trend line' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear all drawings' })).toBeDisabled();
  });
});
