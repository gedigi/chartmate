import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectedDrawing } from '../src/chart/ChartAdapter';
import { DrawingStyleBar, type DrawingStyleControls } from '../src/components/DrawingStyleBar';

function makeControls() {
  let cb: ((s: SelectedDrawing | null) => void) | null = null;
  const c = {
    onSelectionChange: vi.fn((f: (s: SelectedDrawing | null) => void) => { cb = f; return () => { cb = null; }; }),
    setSelectedStyle: vi.fn(),
  };
  return { c: c as typeof c & DrawingStyleControls, emit: (s: SelectedDrawing | null) => act(() => cb?.(s)), subscribed: () => cb !== null };
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
});
