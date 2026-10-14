import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectedDrawing } from '../src/chart/ChartAdapter';
import { drawingSwatches } from '../src/chart/drawingColors';
import { DrawingStyleBar, type DrawingStyleControls } from '../src/components/DrawingStyleBar';

function makeControls() {
  let cb: ((s: SelectedDrawing | null) => void) | null = null;
  let editCb: ((id: string) => void) | null = null;
  const c = {
    onSelectionChange: vi.fn((f: (s: SelectedDrawing | null) => void) => { cb = f; return () => { cb = null; }; }),
    setSelectedStyle: vi.fn(),
    setSelectedPrice: vi.fn((_v: number) => true),
    setSelectedLabel: vi.fn(),
    setSelectedExtend: vi.fn(),
    setSelectedLock: vi.fn((_locked: boolean) => true),
    onPriceEditRequest: vi.fn((f: (id: string) => void) => { editCb = f; return () => { editCb = null; }; }),
    drawingSwatches: vi.fn(() => drawingSwatches('dark')),
    resetSelectedColor: vi.fn(),
  };
  return {
    c: c as typeof c & DrawingStyleControls,
    emit: (s: SelectedDrawing | null) => act(() => cb?.(s)),
    requestPriceEdit: (id = 'h') => act(() => editCb?.(id)),
    subscribed: () => cb !== null && editCb !== null,
  };
}

const bar = () => screen.queryByRole('toolbar', { name: 'Drawing style' });

describe('DrawingStyleBar', () => {
  it('renders nothing without controls or selection', () => {
    const { c, emit } = makeControls();
    const { rerender } = render(<DrawingStyleBar controls={null} />);
    expect(bar()).toBeNull();
    rerender(<DrawingStyleBar controls={c} />);
    expect(bar()).toBeNull();
    emit(null);
    expect(bar()).toBeNull();
  });

  it('line kind: color, widths 1–4 and solid/dashed', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 'a', kind: 'line', style: { color: '#123456', size: 3, style: 'dashed' }, locked: false, ownLock: false });
    expect(screen.getByRole('button', { name: 'Drawing color' })).toHaveAttribute('title', 'Color: Custom #123456');
    const width = screen.getByLabelText('Line width');
    expect(width).toHaveValue('3');
    expect(within(width).getAllByRole('option').map((o) => o.textContent)).toEqual(['1px', '2px', '3px', '4px']);
    expect(screen.getByLabelText('Line style')).toHaveValue('dashed');
    expect(screen.queryByLabelText('Font size')).toBeNull();
    fireEvent.change(width, { target: { value: '1' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ size: 1 });
    fireEvent.change(screen.getByLabelText('Line style'), { target: { value: 'solid' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ style: 'solid' });
  });

  it('text kind: color + font sizes 10–24 (an unusual current size is listed too)', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 't', kind: 'text', style: { color: '#ff0000', size: 12 }, locked: false, ownLock: false });
    const size = screen.getByLabelText('Font size');
    expect(size).toHaveValue('12');
    expect(within(size).getAllByRole('option').map((o) => o.textContent)).toEqual(['10px', '12px', '14px', '16px', '18px', '20px', '22px', '24px']);
    expect(screen.queryByLabelText('Line width')).toBeNull();
    expect(screen.queryByLabelText('Line style')).toBeNull();
    fireEvent.change(size, { target: { value: '24' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ size: 24 });
    fireEvent.click(screen.getByRole('button', { name: 'Drawing color' }));
    fireEvent.click(screen.getByRole('option', { name: 'Cyan' }));
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: 'palette:2' });
    emit({ id: 't', kind: 'text', style: { color: '#ff0000', size: 13 }, locked: false, ownLock: false });
    expect(within(screen.getByLabelText('Font size')).getAllByRole('option').map((o) => o.textContent)).toContain('13px');
  });

  it('drawings locked by "Lock all" are shown read-only, with the lock toggle still available', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 'a', kind: 'line', style: { color: '#123456', size: 1, style: 'solid' }, locked: true, ownLock: false });
    expect(bar()).not.toHaveAttribute('aria-disabled'); // the lock toggle inside stays operable
    expect(screen.getByRole('status')).toHaveTextContent('All drawings locked');
    for (const label of ['Line width', 'Line style']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Drawing color' })).toBeDisabled();
    const lock = screen.getByRole('button', { name: 'Lock drawing' });
    expect(lock).toBeEnabled();
    expect(lock).toHaveAttribute('aria-pressed', 'false');
  });

  it('the lock toggle locks / unlocks the selected drawing; a locked drawing is read-only except the toggle', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    const line = { id: 'a', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const } };
    emit({ ...line, locked: false, ownLock: false });
    const lock = screen.getByRole('button', { name: 'Lock drawing' });
    expect(lock).toHaveAttribute('aria-pressed', 'false');
    expect(lock).toHaveAttribute('title', 'Lock drawing');
    fireEvent.click(lock);
    expect(c.setSelectedLock).toHaveBeenLastCalledWith(true);
    emit({ ...line, locked: true, ownLock: true });
    expect(bar()).not.toHaveAttribute('aria-disabled'); // the lock toggle inside stays operable
    for (const label of ['Line width', 'Line style']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Drawing color' })).toBeDisabled();
    expect(screen.queryByText('All drawings locked')).toBeNull();
    const pressed = screen.getByRole('button', { name: 'Lock drawing' });
    expect(pressed).toBeEnabled();
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    expect(pressed).toHaveAttribute('title', 'Unlock drawing');
    fireEvent.click(pressed);
    expect(c.setSelectedLock).toHaveBeenLastCalledWith(false);
  });

  it('text drawings have the lock toggle too', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 't', kind: 'text', style: { color: '#ff0000', size: 12 }, locked: true, ownLock: true });
    expect(screen.getByLabelText('Font size')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Lock drawing' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('unsubscribes on unmount', () => {
    const { c, subscribed } = makeControls();
    const { unmount } = render(<DrawingStyleBar controls={c} />);
    expect(subscribed()).toBe(true);
    unmount();
    expect(subscribed()).toBe(false);
  });

  describe('price of horizontal drawings', () => {
    const LINE = { id: 'h', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const }, locked: false, ownLock: false };
    const price = () => screen.getByLabelText('Price') as HTMLInputElement;

    it('shows a Price field only for horizontal drawings, formatted to the symbol precision with a matching step', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit(LINE);
      expect(screen.queryByLabelText('Price')).toBeNull();
      emit({ ...LINE, price: { value: 84123.5, precision: 2 } });
      expect(price()).toHaveValue(84123.5);
      expect(price().value).toBe('84123.50');
      expect(price()).toHaveAttribute('step', '0.01');
      emit({ ...LINE, price: { value: 0.1234567, precision: 4 } }); // finer than the precision: not hidden
      expect(price().value).toBe('0.1234567');
      expect(price()).toHaveAttribute('step', '0.0001');
      emit({ ...LINE, price: { value: 12, precision: 0 } });
      expect(price().value).toBe('12');
      expect(price()).toHaveAttribute('step', '1');
    });

    it('Enter applies the typed price (more decimals than the precision are accepted, up to 8)', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...LINE, price: { value: 84000, precision: 2 } });
      fireEvent.change(price(), { target: { value: '84123.45' } });
      expect(c.setSelectedPrice).not.toHaveBeenCalled();
      fireEvent.keyDown(price(), { key: 'Enter' });
      expect(c.setSelectedPrice).toHaveBeenCalledWith(84123.45);
      fireEvent.change(price(), { target: { value: '0.12345678' } });
      fireEvent.keyDown(price(), { key: 'Enter' });
      expect(c.setSelectedPrice).toHaveBeenLastCalledWith(0.12345678);
    });

    it('blur applies; an unchanged value does not', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...LINE, price: { value: 100, precision: 2 } });
      fireEvent.blur(price());
      expect(c.setSelectedPrice).not.toHaveBeenCalled();
      fireEvent.change(price(), { target: { value: '101.5' } });
      fireEvent.blur(price());
      expect(c.setSelectedPrice).toHaveBeenCalledWith(101.5);
    });

    it('Escape reverts the field to the current price without applying (and is not propagated)', () => {
      const { c, emit } = makeControls();
      const outer = vi.fn();
      render(<div onKeyDown={outer}><DrawingStyleBar controls={c} /></div>);
      emit({ ...LINE, price: { value: 100, precision: 2 } });
      fireEvent.change(price(), { target: { value: '150' } });
      fireEvent.keyDown(price(), { key: 'Escape' });
      expect(price().value).toBe('100.00');
      fireEvent.blur(price());
      expect(c.setSelectedPrice).not.toHaveBeenCalled();
      expect(outer).not.toHaveBeenCalled();
    });

    it('invalid prices show an inline error and are not applied', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...LINE, price: { value: 100, precision: 2 } });
      for (const bad of ['', '0', '-5', '1.123456789']) {
        fireEvent.change(price(), { target: { value: bad } });
        fireEvent.keyDown(price(), { key: 'Enter' });
        expect(screen.getByRole('alert'), bad).toBeInTheDocument();
        expect(price(), bad).toHaveAttribute('aria-invalid', 'true');
      }
      expect(c.setSelectedPrice).not.toHaveBeenCalled();
      fireEvent.change(price(), { target: { value: '99' } });
      expect(screen.queryByRole('alert')).toBeNull(); // the error clears while editing
      fireEvent.keyDown(price(), { key: 'Enter' });
      expect(c.setSelectedPrice).toHaveBeenCalledWith(99);
    });

    it('malformed text (validity.badInput, e.g. "1.2.3") says the price must be a positive number', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...LINE, price: { value: 100, precision: 2 } });
      // Browsers report unparsable number-input text as an empty value with validity.badInput set.
      Object.defineProperty(price(), 'validity', { configurable: true, get: () => ({ badInput: true }) });
      fireEvent.change(price(), { target: { value: '' } });
      fireEvent.keyDown(price(), { key: 'Enter' });
      expect(screen.getByRole('alert')).toHaveTextContent('Price must be a positive number');
      Object.defineProperty(price(), 'validity', { configurable: true, get: () => ({ badInput: false }) });
      fireEvent.change(price(), { target: { value: '' } });
      fireEvent.keyDown(price(), { key: 'Enter' });
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a price');
      expect(c.setSelectedPrice).not.toHaveBeenCalled();
    });

    it('the field follows the selection (new price / other drawing) and is disabled for locked drawings', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...LINE, price: { value: 100, precision: 2 } });
      fireEvent.change(price(), { target: { value: '120' } });
      fireEvent.keyDown(price(), { key: 'Enter' });
      emit({ ...LINE, price: { value: 120, precision: 2 } }); // the adapter re-emits the applied price
      expect(price().value).toBe('120.00');
      emit({ ...LINE, id: 'other', locked: true, price: { value: 5, precision: 2 } });
      expect(price().value).toBe('5.00');
      expect(price()).toBeDisabled();
    });

    it('a double-click request focuses the Price field, also when it arrives with the selection (same tick)', () => {
      const { c, emit, requestPriceEdit } = makeControls();
      render(<><DrawingStyleBar controls={c} /><button type="button">elsewhere</button></>);
      emit({ ...LINE, price: { value: 100, precision: 2 } });
      expect(price()).not.toHaveFocus(); // a plain selection does not steal the focus
      requestPriceEdit();
      expect(price()).toHaveFocus();
      act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
      emit(null);
      act(() => { emit({ ...LINE, id: 'h2', price: { value: 7, precision: 2 } }); requestPriceEdit('h2'); });
      expect(price()).toHaveFocus();
      // Handled requests are not replayed: re-selecting later does not grab the focus again.
      act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
      emit(null);
      emit({ ...LINE, id: 'h2', price: { value: 7, precision: 2 } });
      expect(price()).not.toHaveFocus();
    });
  });

  describe('price label toggles (price line / horizontal line)', () => {
    const LINE = { id: 'p', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const }, locked: false, ownLock: false, price: { value: 5, precision: 2 } };

    it('shows "Price on line" / "Price on axis" only when the drawing has label options, reflecting them', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit(LINE);
      expect(screen.queryByLabelText('Price on line')).toBeNull();
      emit({ ...LINE, label: { onLine: true, onAxis: false } });
      expect(screen.getByLabelText('Price on line')).toBeChecked();
      expect(screen.getByLabelText('Price on axis')).not.toBeChecked();
      fireEvent.click(screen.getByLabelText('Price on line'));
      expect(c.setSelectedLabel).toHaveBeenLastCalledWith({ onLine: false });
      fireEvent.click(screen.getByLabelText('Price on axis'));
      expect(c.setSelectedLabel).toHaveBeenLastCalledWith({ onAxis: true });
    });

    it('are disabled for locked drawings', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...LINE, locked: true, label: { onLine: true, onAxis: true } });
      expect(screen.getByLabelText('Price on line')).toBeDisabled();
      expect(screen.getByLabelText('Price on axis')).toBeDisabled();
    });
  });

  describe('channel extend toggles', () => {
    const CH = { id: 'c', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const }, locked: false, ownLock: false };

    it('shows "Extend left" / "Extend right" only for channels, reflecting them', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit(CH);
      expect(screen.queryByLabelText('Extend left')).toBeNull();
      expect(screen.queryByLabelText('Extend right')).toBeNull();
      emit({ ...CH, extend: { left: false, right: true } });
      expect(screen.getByLabelText('Extend left')).not.toBeChecked();
      expect(screen.getByLabelText('Extend right')).toBeChecked();
      fireEvent.click(screen.getByLabelText('Extend left'));
      expect(c.setSelectedExtend).toHaveBeenLastCalledWith({ left: true });
      fireEvent.click(screen.getByLabelText('Extend right'));
      expect(c.setSelectedExtend).toHaveBeenLastCalledWith({ right: false });
    });

    it('are disabled for locked channels', () => {
      const { c, emit } = makeControls();
      render(<DrawingStyleBar controls={c} />);
      emit({ ...CH, locked: true, extend: { left: false, right: false } });
      expect(screen.getByLabelText('Extend left')).toBeDisabled();
      expect(screen.getByLabelText('Extend right')).toBeDisabled();
    });
  });
  describe('color swatches', () => {
    const LINE = { id: 'a', kind: 'line' as const, style: { color: 'accent', size: 1, style: 'solid' as const }, locked: false, ownLock: false };
    const trigger = () => screen.getByRole('button', { name: 'Drawing color' });
    const list = () => screen.queryByRole('listbox', { name: 'Drawing color' });
    const setup = (sel: SelectedDrawing = LINE) => {
      const m = makeControls();
      const onPickColor = vi.fn();
      const onResetColor = vi.fn();
      render(<DrawingStyleBar controls={m.c} onPickColor={onPickColor} onResetColor={onResetColor} />);
      m.emit(sel);
      return { ...m, onPickColor, onResetColor };
    };

    it('a small popover of named theme palette swatches (no color wheel), the current one selected', () => {
      setup();
      expect(document.querySelector('input[type="color"]')).toBeNull();
      expect(trigger()).toHaveAttribute('aria-expanded', 'false');
      expect(trigger()).toHaveAttribute('title', 'Color: Sky');
      expect(list()).toBeNull();
      fireEvent.click(trigger());
      expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      const options = within(list()!).getAllByRole('option');
      expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
        'Sky', 'White', 'Gray', 'Up color', 'Down color', 'Pink', 'Cyan', 'Orange', 'Gold', 'Violet', 'Blue',
      ]);
      expect(options.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.getAttribute('aria-label'))).toEqual(['Sky']);
      expect(within(list()!).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Theme colors', 'Palette']);
      // The selected swatch takes the focus; only it is in the tab order.
      expect(screen.getByRole('option', { name: 'Sky' })).toHaveFocus();
      expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
      // Each swatch shows its color.
      expect(screen.getByRole('option', { name: 'Gold' }).style.color).toBe('rgb(242, 184, 97)');
    });

    it('picking a swatch colors the drawing with the reference, makes it the new default and closes', () => {
      const { c, onPickColor } = setup();
      fireEvent.click(trigger());
      fireEvent.click(screen.getByRole('option', { name: 'Violet' }));
      expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: 'palette:1' });
      expect(onPickColor).toHaveBeenLastCalledWith('palette:1');
      expect(list()).toBeNull();
      expect(trigger()).toHaveFocus();
    });

    it('picking the swatch the drawing already has still makes it the default of new drawings', () => {
      const { c, onPickColor } = setup({ ...LINE, style: { ...LINE.style, color: 'palette:1' } });
      fireEvent.click(trigger());
      fireEvent.click(screen.getByRole('option', { name: 'Violet' }));
      expect(c.setSelectedStyle).not.toHaveBeenCalled(); // nothing to change on the drawing
      expect(onPickColor).toHaveBeenCalledWith('palette:1');
      // By keyboard too.
      fireEvent.click(trigger());
      fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
      expect(onPickColor).toHaveBeenCalledTimes(2);
    });

    it('focus: moving inside the popover keeps it open; clicks that do not focus (Safari / Firefox on macOS) still land', () => {
      const { c, onResetColor } = setup();
      fireEvent.click(trigger());
      const sky = screen.getByRole('option', { name: 'Sky' });
      const reset = screen.getByRole('button', { name: 'Reset to default' });
      // Tab from the swatches to Reset: the focus stays inside.
      fireEvent.focusOut(sky, { relatedTarget: reset });
      expect(list()).not.toBeNull();
      // A click on Reset that does not focus it: the swatch loses the focus to nothing while the pointer is down inside.
      fireEvent.pointerDown(reset);
      fireEvent.focusOut(sky, { relatedTarget: null });
      expect(list()).not.toBeNull();
      fireEvent.pointerUp(reset);
      fireEvent.click(reset);
      expect(c.resetSelectedColor).toHaveBeenCalledTimes(1);
      expect(onResetColor).toHaveBeenCalledTimes(1);
      // Same for a swatch click.
      fireEvent.click(trigger());
      const gold = screen.getByRole('option', { name: 'Gold' });
      fireEvent.pointerDown(gold);
      fireEvent.focusOut(screen.getByRole('option', { name: 'Sky' }), { relatedTarget: null });
      fireEvent.click(gold);
      expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: 'palette:0' });
    });

    it('focus leaving the picker (Tab out, or to nothing without a press inside) closes it', () => {
      setup();
      const outside = document.createElement('button');
      document.body.append(outside);
      fireEvent.click(trigger());
      fireEvent.focusOut(screen.getByRole('button', { name: 'Reset to default' }), { relatedTarget: outside });
      expect(list()).toBeNull();
      fireEvent.click(trigger());
      fireEvent.focusOut(screen.getByRole('option', { name: 'Sky' }), { relatedTarget: null });
      expect(list()).toBeNull();
      outside.remove();
    });

    it('an old hex color is shown as a marked "Custom" swatch and left untouched', () => {
      const { c } = setup({ ...LINE, style: { ...LINE.style, color: '#3fc8e4' } }); // equal to Cyan, still custom
      fireEvent.click(trigger());
      const custom = screen.getByRole('option', { name: 'Custom #3fc8e4' });
      expect(custom).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('option', { name: 'Cyan' })).toHaveAttribute('aria-selected', 'false');
      fireEvent.click(custom); // already the drawing's color: nothing changes
      expect(c.setSelectedStyle).not.toHaveBeenCalled();
      expect(list()).toBeNull();
    });

    it('keyboard: open with ArrowDown, arrows move, rows with up / down, Enter picks, Escape closes', () => {
      const { c, onPickColor } = setup();
      const focused = () => document.activeElement?.getAttribute('aria-label');
      const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });
      trigger().focus();
      fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
      expect(focused()).toBe('Sky');
      key('ArrowRight');
      key('ArrowRight');
      expect(focused()).toBe('Gray');
      key('ArrowDown');
      expect(focused()).toBe('Orange');
      key('ArrowUp');
      expect(focused()).toBe('Gray');
      key('End');
      expect(focused()).toBe('Blue');
      key('ArrowRight'); // wraps
      expect(focused()).toBe('Sky');
      key('ArrowLeft');
      expect(focused()).toBe('Blue');
      key('Home');
      key('ArrowDown');
      expect(focused()).toBe('Pink');
      key('Enter');
      expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: 'palette:4' });
      expect(onPickColor).toHaveBeenLastCalledWith('palette:4');
      expect(trigger()).toHaveFocus();
      // Escape closes the popover only (it does not reach the chart, which would deselect the drawing).
      fireEvent.click(trigger());
      const outer = vi.fn();
      document.addEventListener('keydown', outer);
      key('Escape');
      document.removeEventListener('keydown', outer);
      expect(list()).toBeNull();
      expect(outer).not.toHaveBeenCalled();
      expect(trigger()).toHaveFocus();
      // Space picks too.
      fireEvent.click(trigger());
      key('ArrowRight');
      key(' ');
      expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: 'text' });
    });

    it('"Reset to default" resets the drawing and the default of new drawings', () => {
      const { c, onResetColor } = setup({ ...LINE, style: { ...LINE.style, color: 'palette:3' } });
      fireEvent.click(trigger());
      fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
      expect(c.resetSelectedColor).toHaveBeenCalledTimes(1);
      expect(onResetColor).toHaveBeenCalledTimes(1);
      expect(list()).toBeNull();
    });

    it('a press outside closes it; a locked drawing cannot open it', () => {
      const { emit } = setup();
      fireEvent.click(trigger());
      fireEvent.pointerDown(document.body);
      expect(list()).toBeNull();
      emit({ ...LINE, locked: true, ownLock: true });
      fireEvent.click(trigger());
      expect(list()).toBeNull();
    });

    it('text annotations pick from the same swatches', () => {
      const { c } = setup({ id: 't', kind: 'text', style: { color: 'up', size: 12 }, locked: false, ownLock: false });
      fireEvent.click(trigger());
      expect(screen.getByRole('option', { name: 'Up color' })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(screen.getByRole('option', { name: 'Down color' }));
      expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: 'down' });
    });
  });
});
