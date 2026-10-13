import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingToolbar, type DrawingControls } from '../src/components/DrawingToolbar';

function makeControls() {
  let onEnd: (() => void) | undefined;
  let lockCb: ((locked: boolean) => void) | null = null;
  let selCb: ((s: { locked: boolean } | null) => void) | null = null;
  const c = {
    startDrawing: vi.fn((_tool: string, opts?: { text?: string; onEnd?: () => void }) => { onEnd = opts?.onEnd; }),
    cancelDrawing: vi.fn(),
    clearDrawings: vi.fn(),
    drawingCount: vi.fn(() => ({ total: 2, locked: 0 })),
    removeSelected: vi.fn(() => true),
    setMagnet: vi.fn(),
    setLockAll: vi.fn(),
    setMagnetOverride: vi.fn(),
    setShiftConstraint: vi.fn(),
    deselect: vi.fn(),
    onLockAllChange: vi.fn((cb: (locked: boolean) => void) => { lockCb = cb; return () => { lockCb = null; }; }),
    onSelectionChange: vi.fn((cb: (s: { locked: boolean } | null) => void) => { selCb = cb; return () => { selCb = null; }; }),
  };
  return {
    c: c as typeof c & DrawingControls,
    end: () => act(() => onEnd?.()),
    emitLock: (v: boolean) => act(() => lockCb?.(v)),
    emitSelection: (s: { locked: boolean } | null) => act(() => selCb?.(s)),
    hasLockListener: () => lockCb !== null,
  };
}

afterEach(() => vi.restoreAllMocks());

/** Every kind of form control: a style bar like the drawing one, and controls inside a dialog. */
function FormControls() {
  return (
    <>
      <div role="toolbar" aria-label="Drawing style">
        <input type="color" aria-label="Drawing color" defaultValue="#123456" />
        <select aria-label="Line width"><option>1px</option></select>
        <input type="number" aria-label="Price" defaultValue="5" />
        <input type="checkbox" aria-label="Price on line" />
        <input type="radio" aria-label="radio" />
        <input type="range" aria-label="range" />
        <button type="button">style button</button>
      </div>
      <div role="dialog" aria-label="dlg">
        <input type="checkbox" aria-label="dialog checkbox" />
        <button type="button">dialog button</button>
      </div>
    </>
  );
}
const formControls = () => [
  'Drawing color', 'Line width', 'Price', 'Price on line', 'radio', 'range', 'dialog checkbox',
].map((l) => screen.getByLabelText(l)).concat(
  screen.getByRole('button', { name: 'style button' }), screen.getByRole('button', { name: 'dialog button' }),
);

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

  it('Escape inside a dialog, modal, listbox or popup closes only that, never deselecting the drawing', () => {
    const { c } = makeControls();
    render(
      <>
        <div role="dialog" aria-label="dlg"><button type="button">in dialog</button></div>
        <dialog open><span tabIndex={0}>native dialog</span></dialog>
        <div aria-modal="true"><span tabIndex={0}>modal</span></div>
        <ul role="listbox" aria-label="lb"><li role="option" aria-selected="false" tabIndex={0}>opt</li></ul>
        <div role="menu"><span tabIndex={0}>menu item</span></div>
        <DrawingToolbar controls={c} ticker="AAPL" />
      </>,
    );
    for (const name of ['in dialog', 'native dialog', 'modal', 'opt', 'menu item']) {
      fireEvent.keyDown(screen.getByText(name), { key: 'Escape' });
    }
    expect(c.deselect).not.toHaveBeenCalled();
    expect(c.cancelDrawing).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(c.deselect).toHaveBeenCalledTimes(1);
  });

  it('Escape already handled by a popup (defaultPrevented) does not deselect', () => {
    const { c } = makeControls();
    render(<><span tabIndex={0} onKeyDown={(e) => e.preventDefault()}>popup</span><DrawingToolbar controls={c} ticker="AAPL" /></>);
    fireEvent.keyDown(screen.getByText('popup'), { key: 'Escape' });
    expect(c.deselect).not.toHaveBeenCalled();
  });

  it.each([
    ['Trend line', 'segment'], ['Ray', 'rayLine'], ['Extended line', 'straightLine'],
    ['Horizontal line', 'horizontalStraightLine'], ['Vertical line', 'verticalStraightLine'], ['Price line', 'priceLine'],
    ['Parallel channel', 'parallelChannel'], ['Fibonacci retracement', 'fibonacciLine'],
    ['Long position', 'longPosition'], ['Short position', 'shortPosition'],
  ])('clicking %s starts drawing %s and highlights it until the drawing completes', async (label, tool) => {
    const { c, end } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const btn = screen.getByRole('button', { name: label });
    expect(btn.getAttribute('title')).toMatch(new RegExp(`^${label}( \\(.+\\))?$`)); // shortcut tools add e.g. (Alt+T)
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

  it('Clear all asks for confirmation before clearing (locked drawings kept)', async () => {
    const { c } = makeControls();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const btn = screen.getByRole('button', { name: 'Clear all drawings' });
    await userEvent.click(btn);
    expect(confirm).toHaveBeenCalledWith('Remove all drawings on AAPL?');
    expect(c.clearDrawings).not.toHaveBeenCalled();
    await userEvent.click(btn);
    expect(c.clearDrawings).toHaveBeenCalledTimes(1);
    expect(c.clearDrawings).toHaveBeenCalledWith({ keepLocked: true });
  });

  it('Clear all with no drawings neither asks nor clears (lock all stays as it is)', async () => {
    const { c } = makeControls();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    c.drawingCount.mockReturnValue({ total: 0, locked: 0 });
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear all drawings' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(c.clearDrawings).not.toHaveBeenCalled();
  });

  it('Delete selected drawing is disabled while the selected drawing is locked', async () => {
    const { c, emitSelection } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const del = screen.getByRole('button', { name: 'Delete selected drawing' });
    expect(del).toBeEnabled();
    emitSelection({ locked: true });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', 'Drawing is locked');
    emitSelection({ locked: false });
    expect(del).toBeEnabled();
    expect(del).toHaveAttribute('title', 'Delete selected drawing (Del)');
    emitSelection({ locked: true });
    emitSelection(null);
    expect(del).toBeEnabled();
  });

  it('Clear all keeps locked drawings and says so; with every drawing locked it removes nothing', async () => {
    const { c } = makeControls();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const btn = screen.getByRole('button', { name: 'Clear all drawings' });
    c.drawingCount.mockReturnValue({ total: 3, locked: 1 });
    await userEvent.click(btn);
    expect(confirm).toHaveBeenLastCalledWith('Remove 2 unlocked drawings on AAPL? 1 locked drawing is kept.');
    expect(c.clearDrawings).toHaveBeenLastCalledWith({ keepLocked: true });
    c.drawingCount.mockReturnValue({ total: 4, locked: 3 });
    await userEvent.click(btn);
    expect(confirm).toHaveBeenLastCalledWith('Remove 1 unlocked drawing on AAPL? 3 locked drawings are kept.');
    c.clearDrawings.mockClear();
    confirm.mockClear();
    c.drawingCount.mockReturnValue({ total: 2, locked: 2 });
    await userEvent.click(btn);
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('All drawings on AAPL are locked. Unlock them to remove them.');
    expect(c.clearDrawings).not.toHaveBeenCalled();
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

  it('Delete/Backspace never remove a drawing while ANY form control has the focus (style bar toggles, dialogs)', () => {
    const { c } = makeControls();
    render(<><DrawingToolbar controls={c} ticker="AAPL" /><FormControls /></>);
    for (const el of formControls()) {
      expect(fireEvent.keyDown(el, { key: 'Delete' }), el.outerHTML).toBe(true); // not prevented
      fireEvent.keyDown(el, { key: 'Backspace' });
    }
    expect(c.removeSelected).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Delete' }); // the chart / page itself still works
    expect(c.removeSelected).toHaveBeenCalledTimes(1);
  });

  it('Escape on a style-bar control still deselects the drawing (closing the bar)', () => {
    const { c } = makeControls();
    render(<><DrawingToolbar controls={c} ticker="AAPL" /><FormControls /></>);
    fireEvent.keyDown(screen.getByLabelText('Price on line'), { key: 'Escape' });
    expect(c.deselect).toHaveBeenCalledTimes(1);
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

  it('Clear all canceled in the confirm keeps the in-progress drawing', async () => {
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

describe('DrawingToolbar keyboard shortcuts (Option/Alt+T trend line, Option/Alt+H horizontal line)', () => {
  const setPlatform = (p: string) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(p);
  // On macOS Option+T types '†' and Option+H '˙': shortcuts must match the physical key (event.code).
  const altT = (target: Element | Document = document.body, extra: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(target, { key: '†', code: 'KeyT', altKey: true, ...extra });
  const altH = (target: Element | Document = document.body, extra: Partial<KeyboardEventInit> = {}) =>
    fireEvent.keyDown(target, { key: '˙', code: 'KeyH', altKey: true, ...extra });

  it('Alt+T starts a trend line and Alt+H a horizontal line, like clicking the buttons (matched by code)', () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    expect(altT()).toBe(false); // preventDefault → dispatchEvent returns false
    expect(c.startDrawing).toHaveBeenLastCalledWith('segment', expect.objectContaining({ onEnd: expect.any(Function) }));
    expect(screen.getByRole('button', { name: 'Trend line' })).toHaveAttribute('aria-pressed', 'true');
    altH();
    expect(c.startDrawing).toHaveBeenLastCalledWith('horizontalStraightLine', expect.objectContaining({ onEnd: expect.any(Function) }));
    expect(screen.getByRole('button', { name: 'Horizontal line' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Trend line' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('pressing the shortcut of the active tool toggles it off', () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    altT();
    altT();
    expect(c.startDrawing).toHaveBeenCalledTimes(1);
    expect(c.cancelDrawing).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Trend line' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('needs Alt alone: plain T, Ctrl/Meta+Alt+T and other Alt keys do nothing (not prevented)', () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    expect(fireEvent.keyDown(document.body, { key: 't', code: 'KeyT' })).toBe(true);
    expect(altT(document.body, { metaKey: true })).toBe(true);
    expect(altT(document.body, { ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: '∫', code: 'KeyB', altKey: true })).toBe(true);
    // A 't' produced by another physical key does not match (code-based, layout independent).
    expect(fireEvent.keyDown(document.body, { key: 't', code: 'KeyY', altKey: true })).toBe(true);
    expect(c.startDrawing).not.toHaveBeenCalled();
  });

  it('is ignored while typing in inputs / textareas / selects / contenteditable and inside dialogs', () => {
    const { c } = makeControls();
    render(
      <>
        <DrawingToolbar controls={c} ticker="AAPL" />
        <input aria-label="field" />
        <textarea aria-label="area" />
        <select aria-label="pick"><option>a</option></select>
        <div aria-label="editable" contentEditable suppressContentEditableWarning />
        <div role="dialog" aria-label="dlg"><button type="button">inside</button></div>
      </>,
    );
    for (const el of [
      screen.getByLabelText('field'), screen.getByLabelText('area'), screen.getByLabelText('pick'),
      screen.getByLabelText('editable'), screen.getByRole('button', { name: 'inside' }),
    ]) {
      // jsdom has no isContentEditable: emulate the browser for the editable div
      if (el.getAttribute('aria-label') === 'editable') Object.defineProperty(el, 'isContentEditable', { value: true });
      expect(altT(el), el.tagName).toBe(true);
      altH(el);
    }
    expect(c.startDrawing).not.toHaveBeenCalled();
  });

  it('never fires on a form control: checkbox, radio, color, range, number, select or button (style bar, dialogs)', () => {
    const { c } = makeControls();
    render(<><DrawingToolbar controls={c} ticker="AAPL" /><FormControls /></>);
    for (const el of formControls()) {
      expect(altT(el), el.outerHTML).toBe(true);
      expect(altH(el), el.outerHTML).toBe(true);
    }
    expect(c.startDrawing).not.toHaveBeenCalled();
  });

  it('does nothing while disabled or without a chart', () => {
    const { c } = makeControls();
    const { rerender } = render(<DrawingToolbar controls={c} disabled ticker="AAPL" />);
    expect(altT()).toBe(true);
    rerender(<DrawingToolbar controls={null} ticker="AAPL" />);
    expect(altH()).toBe(true);
    expect(c.startDrawing).not.toHaveBeenCalled();
  });

  it('shows the shortcut in the button title and aria-keyshortcuts (⌥ on Apple platforms, Alt+ elsewhere)', () => {
    setPlatform('MacIntel');
    const { c } = makeControls();
    const { unmount } = render(<DrawingToolbar controls={c} ticker="AAPL" />);
    const trend = screen.getByRole('button', { name: 'Trend line' });
    expect(trend).toHaveAttribute('title', 'Trend line (⌥T)');
    expect(trend).toHaveAttribute('aria-keyshortcuts', 'Alt+T');
    expect(screen.getByRole('button', { name: 'Horizontal line' })).toHaveAttribute('title', 'Horizontal line (⌥H)');
    expect(screen.getByRole('button', { name: 'Ray' })).toHaveAttribute('title', 'Ray');
    expect(screen.getByRole('button', { name: 'Ray' })).not.toHaveAttribute('aria-keyshortcuts');
    unmount();
    setPlatform('Win32');
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    expect(screen.getByRole('button', { name: 'Trend line' })).toHaveAttribute('title', 'Trend line (Alt+T)');
    expect(screen.getByRole('button', { name: 'Horizontal line' })).toHaveAttribute('aria-keyshortcuts', 'Alt+H');
  });

  it('closes the text prompt like a click on the tool would', async () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    const input = screen.getByLabelText('Annotation text');
    altT(input); // typing in the text prompt: ignored
    expect(c.startDrawing).not.toHaveBeenCalled();
    altT(document.body);
    expect(screen.queryByLabelText('Annotation text')).toBeNull();
    expect(c.startDrawing).toHaveBeenCalledWith('segment', expect.anything());
  });
});

describe('DrawingToolbar Shift (horizontal constraint while placing / dragging)', () => {
  it('holding Shift turns the constraint on; release, blur, hidden page and unmount turn it off', () => {
    const { c } = makeControls();
    const { unmount } = render(<DrawingToolbar controls={c} ticker="AAPL" />);
    fireEvent.keyDown(document.body, { key: 'Shift', shiftKey: true });
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(document.body, { key: 'Shift' });
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(document.body, { key: 'Shift', shiftKey: true });
    fireEvent.blur(window);
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(document.body, { key: 'Shift', shiftKey: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(false);
    hidden.mockRestore();
    fireEvent.keyDown(document.body, { key: 'Shift', shiftKey: true });
    unmount();
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(false);
  });

  it('follows the pointer events\' shiftKey (e.g. Shift pressed while the window had no focus)', () => {
    const { c } = makeControls();
    render(<DrawingToolbar controls={c} ticker="AAPL" />);
    fireEvent.pointerMove(document.body, { shiftKey: true });
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(true);
    fireEvent.pointerDown(document.body, { shiftKey: false });
    expect(c.setShiftConstraint).toHaveBeenLastCalledWith(false);
    const calls = c.setShiftConstraint.mock.calls.length;
    fireEvent.pointerMove(document.body, { shiftKey: false });
    expect(c.setShiftConstraint).toHaveBeenCalledTimes(calls); // only changes are forwarded
  });

  it('Shift typed into an input is ignored', () => {
    const { c } = makeControls();
    render(<><DrawingToolbar controls={c} ticker="AAPL" /><input aria-label="field" /></>);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Shift', shiftKey: true });
    expect(c.setShiftConstraint).not.toHaveBeenCalledWith(true);
  });
});
