import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectedDrawing } from '../src/chart/ChartAdapter';
import { positionMetrics } from '../src/chart/position';
import { DrawingStyleBar, type DrawingStyleControls } from '../src/components/DrawingStyleBar';

function makeControls() {
  let cb: ((s: SelectedDrawing | null) => void) | null = null;
  const c = {
    onSelectionChange: vi.fn((f: (s: SelectedDrawing | null) => void) => { cb = f; return () => { cb = null; }; }),
    setSelectedStyle: vi.fn(),
    setSelectedPrice: vi.fn(() => true),
    setSelectedLabel: vi.fn(), setSelectedExtend: vi.fn(),
    onPriceEditRequest: vi.fn(() => () => {}),
    setSelectedLock: vi.fn((_locked: boolean) => true),
    setSelectedPositionPrices: vi.fn((_p: { entry?: number; target?: number; stop?: number }): string | null => null),
  };
  return { c: c as typeof c & DrawingStyleControls, emit: (s: SelectedDrawing | null) => act(() => cb?.(s)) };
}

function position(over: Partial<{ side: 'long' | 'short'; entry: number; target: number; stop: number; locked: boolean }> = {}): SelectedDrawing {
  const side = over.side ?? 'long';
  const g = { start: 0, end: 1, entry: over.entry ?? 100, target: over.target ?? (side === 'long' ? 102 : 98), stop: over.stop ?? (side === 'long' ? 98 : 102) };
  return {
    id: 'p', kind: 'position', side, locked: over.locked ?? false, ownLock: over.locked ?? false, entry: g.entry, target: g.target, stop: g.stop, precision: 2,
    metrics: positionMetrics(side, g), outcome: { kind: 'waiting' },
  };
}
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const type = (name: string, value: string, key = 'Enter') => {
  fireEvent.change(field(name), { target: { value } });
  if (key === 'blur') fireEvent.blur(field(name));
  else fireEvent.keyDown(field(name), { key });
};

describe('DrawingStyleBar: long / short positions', () => {
  it('shows the precise Entry / Target / Stop, % and tick distances, and no line style controls', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    expect(screen.getByRole('toolbar', { name: 'Position settings' })).toBeInTheDocument();
    expect(field('Entry').value).toBe('100.00');
    expect(field('Target').value).toBe('102.00');
    expect(field('Stop').value).toBe('98.00');
    expect(field('Target %').value).toBe('2.00');
    expect(field('Target ticks').value).toBe('200');
    expect(field('Stop %').value).toBe('2.00');
    expect(field('Stop ticks').value).toBe('200');
    expect(screen.queryByLabelText('Drawing color')).toBeNull();
  });

  it('Enter or blur applies a price, Escape reverts', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    type('Target', '104.5');
    expect(c.setSelectedPositionPrices).toHaveBeenLastCalledWith({ target: 104.5 });
    type('Stop', '97', 'blur');
    expect(c.setSelectedPositionPrices).toHaveBeenLastCalledWith({ stop: 97 });
    type('Entry', '99.5', 'Escape');
    expect(field('Entry').value).toBe('100.00');
    expect(c.setSelectedPositionPrices).toHaveBeenCalledTimes(2);
  });

  it('validation: long needs stop < entry < target, short target < entry < stop (inline error, nothing applied)', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    type('Target', '99');
    expect(screen.getByRole('alert')).toHaveTextContent(/target must be above the entry/i);
    expect(field('Target')).toHaveAttribute('aria-invalid', 'true');
    type('Target', 'abc');
    expect(screen.getByRole('alert')).toHaveTextContent(/positive number/i);
    emit(position({ side: 'short' }));
    type('Stop', '99');
    expect(screen.getByRole('alert')).toHaveTextContent(/stop must be above the entry/i);
    expect(c.setSelectedPositionPrices).not.toHaveBeenCalled();
  });

  it('an error from the adapter is shown inline', () => {
    const { c, emit } = makeControls();
    c.setSelectedPositionPrices.mockReturnValueOnce('The position is locked');
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    type('Target', '103');
    expect(screen.getByRole('alert')).toHaveTextContent('The position is locked');
  });

  it('% and tick inputs set the target / stop on their side, and stay in sync with the prices', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    type('Target %', '3');
    expect(c.setSelectedPositionPrices).toHaveBeenLastCalledWith({ target: 103 });
    type('Stop ticks', '150');
    expect(c.setSelectedPositionPrices).toHaveBeenLastCalledWith({ stop: 98.5 });
    emit(position({ side: 'short' }));
    type('Target ticks', '250');
    expect(c.setSelectedPositionPrices).toHaveBeenLastCalledWith({ target: 97.5 });
    type('Stop %', '1.5');
    expect(c.setSelectedPositionPrices).toHaveBeenLastCalledWith({ stop: 101.5 });
    emit(position({ target: 105, stop: 99 }));
    expect(field('Target %').value).toBe('5.00');
    expect(field('Target ticks').value).toBe('500');
    expect(field('Stop %').value).toBe('1.00');
    expect(field('Stop ticks').value).toBe('100');
    type('Target ticks', '1.5');
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/i);
  });

  it('summary: R:R only, no sizing (account, risk, currency, quantity, money amounts)', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position({ target: 106, stop: 97 }));
    expect(screen.getByTestId('position-summary')).toHaveTextContent(/^R:R 2\.00$/);
    for (const name of ['Account size', 'Risk mode', 'Risk', 'Currency']) expect(screen.queryByLabelText(name), name).toBeNull();
    expect(screen.getByRole('toolbar', { name: 'Position settings' })).not.toHaveTextContent(/Qty|USD/);
  });

  it('shows the outcome with its % result', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ ...position(), outcome: { kind: 'stop', fillTs: 0, ts: Date.UTC(2024, 0, 5), price: 98, pnlPct: -2 } } as SelectedDrawing);
    expect(screen.getByTestId('position-outcome')).toHaveTextContent('Stop hit · -2.00% · 2024-01-05');
  });

  it('"Use as default" saves the target / stop distances (%) as the defaults of new positions', () => {
    const { c, emit } = makeControls();
    const onUse = vi.fn();
    render(<DrawingStyleBar controls={c} onUsePositionDefaults={onUse} />);
    emit(position({ target: 103, stop: 98.5 }));
    fireEvent.click(screen.getByRole('button', { name: 'Use as default' }));
    expect(onUse).toHaveBeenCalledWith({ targetPct: 3, stopPct: 1.5 });
    emit(position({ side: 'short', entry: 3, target: 2.9, stop: 3.1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Use as default' }));
    expect(onUse).toHaveBeenLastCalledWith({ targetPct: 3.3333, stopPct: 3.3333 }); // rounded to 4 decimals
  });

  it('locked positions are read-only', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position({ locked: true }));
    for (const name of ['Entry', 'Target', 'Stop', 'Target %', 'Target ticks', 'Stop %', 'Stop ticks']) {
      expect(field(name), name).toBeDisabled();
    }
    const lock = screen.getByRole('button', { name: 'Lock drawing' });
    expect(lock).toBeEnabled();
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(lock);
    expect(c.setSelectedLock).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Use as default' })).toBeEnabled();
  });

  it('a position locked by "Lock all" says so; its lock toggle locks it on its own', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ ...position(), locked: true, ownLock: false });
    expect(field('Entry')).toBeDisabled();
    expect(screen.getByText('All drawings locked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lock drawing' }));
    expect(c.setSelectedLock).toHaveBeenLastCalledWith(true);
  });

  it('"Use as default" is disabled while a distance is over 99 %', () => {
    const { c, emit } = makeControls();
    const onUse = vi.fn();
    render(<DrawingStyleBar controls={c} onUsePositionDefaults={onUse} />);
    emit(position({ target: 250 }));
    const btn = screen.getByRole('button', { name: 'Use as default' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onUse).not.toHaveBeenCalled();
  });

  it('shows waiting / needs-data states without a result', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    expect(screen.getByTestId('position-outcome')).toHaveTextContent('Waiting for entry');
    emit({ ...position(), outcome: { kind: 'needsData' } } as SelectedDrawing);
    expect(screen.getByTestId('position-outcome')).toHaveTextContent('Outcome needs earlier data');
  });
});
