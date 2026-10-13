import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectedDrawing } from '../src/chart/ChartAdapter';
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
    onPriceEditRequest: vi.fn((f: (id: string) => void) => { editCb = f; return () => { editCb = null; }; }),
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

  it('line kind: colour, widths 1–4 and solid/dashed', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 'a', kind: 'line', style: { color: '#123456', size: 3, style: 'dashed' }, locked: false });
    expect(screen.getByLabelText('Drawing colour')).toHaveValue('#123456');
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

  it('text kind: colour + font sizes 10–24 (an unusual current size is listed too)', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 't', kind: 'text', style: { color: '#ff0000', size: 12 }, locked: false });
    const size = screen.getByLabelText('Font size');
    expect(size).toHaveValue('12');
    expect(within(size).getAllByRole('option').map((o) => o.textContent)).toEqual(['10px', '12px', '14px', '16px', '18px', '20px', '22px', '24px']);
    expect(screen.queryByLabelText('Line width')).toBeNull();
    expect(screen.queryByLabelText('Line style')).toBeNull();
    fireEvent.change(size, { target: { value: '24' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ size: 24 });
    fireEvent.input(screen.getByLabelText('Drawing colour'), { target: { value: '#00ff00' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ color: '#00ff00' });
    emit({ id: 't', kind: 'text', style: { color: '#ff0000', size: 13 }, locked: false });
    expect(within(screen.getByLabelText('Font size')).getAllByRole('option').map((o) => o.textContent)).toContain('13px');
  });

  it('locked drawings are shown read-only', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ id: 'a', kind: 'line', style: { color: '#123456', size: 1, style: 'solid' }, locked: true });
    expect(bar()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Locked')).toBeInTheDocument();
    for (const label of ['Drawing colour', 'Line width', 'Line style']) expect(screen.getByLabelText(label)).toBeDisabled();
  });

  it('unsubscribes on unmount', () => {
    const { c, subscribed } = makeControls();
    const { unmount } = render(<DrawingStyleBar controls={c} />);
    expect(subscribed()).toBe(true);
    unmount();
    expect(subscribed()).toBe(false);
  });

  describe('price of horizontal drawings', () => {
    const LINE = { id: 'h', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const }, locked: false };
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
    const LINE = { id: 'p', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const }, locked: false, price: { value: 5, precision: 2 } };

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
    const CH = { id: 'c', kind: 'line' as const, style: { color: '#123456', size: 1, style: 'solid' as const }, locked: false };

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
});
