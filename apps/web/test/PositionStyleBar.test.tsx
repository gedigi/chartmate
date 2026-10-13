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
    setSelectedLabel: vi.fn(),
    onPriceEditRequest: vi.fn(() => () => {}),
    setSelectedPositionPrices: vi.fn((_p: { entry?: number; target?: number; stop?: number }): string | null => null),
    setSelectedPositionSettings: vi.fn(),
  };
  return { c: c as typeof c & DrawingStyleControls, emit: (s: SelectedDrawing | null) => act(() => cb?.(s)) };
}

const settings = { accountSize: 10000, riskMode: 'percent' as const, riskValue: 1, currency: 'USD' };
function position(over: Partial<{ side: 'long' | 'short'; entry: number; target: number; stop: number; locked: boolean }> = {}): SelectedDrawing {
  const side = over.side ?? 'long';
  const g = { start: 0, end: 1, entry: over.entry ?? 100, target: over.target ?? (side === 'long' ? 102 : 98), stop: over.stop ?? (side === 'long' ? 98 : 102) };
  return {
    id: 'p', kind: 'position', side, locked: over.locked ?? false, entry: g.entry, target: g.target, stop: g.stop, precision: 2,
    settings, metrics: positionMetrics(side, g, settings, 0), outcome: { kind: 'waiting' },
  };
}
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
/** The inline error of a field (aria-describedby). */
const errorOf = (name: string) => document.getElementById(field(name).getAttribute('aria-describedby') ?? '');
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
    expect(screen.queryByLabelText('Drawing colour')).toBeNull();
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

  it('risk section: account size, mode, value, currency; computed qty, amounts and R:R', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position({ target: 106, stop: 97 }));
    expect(field('Account size').value).toBe('10000');
    expect((screen.getByLabelText('Risk mode') as HTMLSelectElement).value).toBe('percent');
    expect(field('Risk').value).toBe('1');
    expect(field('Currency').value).toBe('USD');
    const summary = screen.getByTestId('position-summary');
    expect(summary).toHaveTextContent('Qty 33');
    expect(summary).toHaveTextContent('Risk 99.00 USD');
    expect(summary).toHaveTextContent('Reward 198.00 USD');
    expect(summary).toHaveTextContent('R:R 2.00');
    type('Account size', '25000');
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ accountSize: 25000 });
    fireEvent.change(screen.getByLabelText('Risk mode'), { target: { value: 'amount' } });
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ riskMode: 'amount', riskValue: 100 }); // 1 % of 10 000
    type('Risk', '2.5', 'blur');
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ riskValue: 2.5 });
    type('Currency', 'EUR');
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ currency: 'EUR' });
    type('Risk', '150');
    expect(errorOf('Risk')).toHaveTextContent(/at most 100/i);
    type('Currency', 'TOOLONGCUR');
    expect(errorOf('Currency')).toHaveTextContent(/at most 8/i);
    type('Account size', '0');
    expect(errorOf('Account size')).toHaveTextContent(/positive/i);
    expect(c.setSelectedPositionSettings).toHaveBeenCalledTimes(4);
  });

  it('shows the outcome', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ ...position(), outcome: { kind: 'stop', ts: Date.UTC(2024, 0, 5), price: 98, pnl: -100, pnlPct: -2 } } as SelectedDrawing);
    expect(screen.getByTestId('position-outcome')).toHaveTextContent('Stop hit · -100.00 USD (-2.00%) · 2024-01-05');
  });

  it('"Use as default" saves the risk settings as the global defaults', () => {
    const { c, emit } = makeControls();
    const onUse = vi.fn();
    render(<DrawingStyleBar controls={c} onUsePositionDefaults={onUse} />);
    emit({ ...position(), settings: { accountSize: 5000, riskMode: 'amount', riskValue: 50, currency: 'EUR' } } as SelectedDrawing);
    fireEvent.click(screen.getByRole('button', { name: 'Use as default' }));
    expect(onUse).toHaveBeenCalledWith({ accountSize: 5000, riskMode: 'amount', riskValue: 50, currency: 'EUR' });
  });

  it('locked positions are read-only', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position({ locked: true }));
    for (const name of ['Entry', 'Target', 'Stop', 'Target %', 'Target ticks', 'Stop %', 'Stop ticks', 'Account size', 'Risk', 'Currency']) {
      expect(field(name), name).toBeDisabled();
    }
    expect(screen.getByLabelText('Risk mode')).toBeDisabled();
    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('changing the risk mode converts the value so the money at risk stays the same (percentage at most 100)', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit({ ...position(), settings: { ...settings, riskMode: 'amount', riskValue: 500 } } as SelectedDrawing);
    fireEvent.change(screen.getByLabelText('Risk mode'), { target: { value: 'percent' } });
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ riskMode: 'percent', riskValue: 5 });
    emit({ ...position(), settings: { ...settings, riskMode: 'amount', riskValue: 50000 } } as SelectedDrawing);
    fireEvent.change(screen.getByLabelText('Risk mode'), { target: { value: 'percent' } });
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ riskMode: 'percent', riskValue: 100 });
    emit({ ...position(), settings: { ...settings, riskValue: 2 } } as SelectedDrawing);
    fireEvent.change(screen.getByLabelText('Risk mode'), { target: { value: 'amount' } });
    expect(c.setSelectedPositionSettings).toHaveBeenLastCalledWith({ riskMode: 'amount', riskValue: 200 });
  });

  it('"Use as default" is disabled while the risk settings are invalid', () => {
    const { c, emit } = makeControls();
    const onUse = vi.fn();
    render(<DrawingStyleBar controls={c} onUsePositionDefaults={onUse} />);
    emit({ ...position(), settings: { ...settings, riskValue: 500 } } as SelectedDrawing);
    const btn = screen.getByRole('button', { name: 'Use as default' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onUse).not.toHaveBeenCalled();
  });

  it('a quantity of 0 explains that the risk is below one unit', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    const sel = position();
    emit({ ...sel, metrics: { ...(sel as { metrics: object }).metrics, qty: 0, riskAmount: 0, rewardAmount: 0 } } as SelectedDrawing);
    expect(screen.getByTestId('position-summary')).toHaveTextContent('Qty 0 (Risk is below 1 unit)');
    expect(screen.getByTestId('position-summary')).toHaveTextContent('Risk 0.00 USD');
  });

  it('shows waiting / needs-data states without P&L', () => {
    const { c, emit } = makeControls();
    render(<DrawingStyleBar controls={c} />);
    emit(position());
    expect(screen.getByTestId('position-outcome')).toHaveTextContent('Waiting for entry');
    emit({ ...position(), outcome: { kind: 'needsData' } } as SelectedDrawing);
    expect(screen.getByTestId('position-outcome')).toHaveTextContent('Outcome needs earlier data');
  });
});
