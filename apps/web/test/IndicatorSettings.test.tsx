import type { IndicatorState } from '@chartmate/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IndicatorSettings } from '../src/components/IndicatorSettings';

const RSI: IndicatorState = { name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true };
const BOLL: IndicatorState = { name: 'BOLL', pane: 'main', calcParams: [20, 2], visible: true };

const save = () => screen.getByRole('button', { name: 'Save' });

describe('IndicatorSettings', () => {
  it('renders a dialog with one numeric input per param and one color input per line', () => {
    render(<IndicatorSettings state={RSI} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: /RSI/ })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('RSI1 period')).toHaveValue('6');
    expect(screen.getByLabelText('RSI2 period')).toHaveValue('12');
    expect(screen.getByLabelText('RSI3 period')).toHaveValue('24');
    expect(screen.getByLabelText('RSI1 color')).toHaveAttribute('type', 'color');
    expect(screen.getByLabelText('RSI3 color')).toBeInTheDocument();
  });

  it('entering 0 for an RSI period shows an error and disables Save', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
    const input = screen.getByLabelText('RSI1 period');
    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(screen.getByText(/whole number/i)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, '2.5');
    expect(save()).toBeDisabled();
  });

  it('a valid edit saves the new params (no colors unless changed)', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={onClose} />);
    const input = screen.getByLabelText('RSI1 period');
    await userEvent.clear(input);
    await userEvent.type(input, '14');
    expect(save()).toBeEnabled();
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ name: 'RSI', pane: 'sub', calcParams: [14, 12, 24], visible: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('BOLL std-dev accepts decimals; color edits are saved as lineColors', async () => {
    const onSave = vi.fn();
    const { fireEvent } = await import('@testing-library/react');
    render(<IndicatorSettings state={BOLL} onSave={onSave} onClose={() => {}} />);
    const sd = screen.getByLabelText('Std dev');
    await userEvent.clear(sd);
    await userEvent.type(sd, '2.5');
    fireEvent.input(screen.getByLabelText('Middle color'), { target: { value: '#00ff00' } });
    await userEvent.click(save());
    const saved = onSave.mock.calls[0]![0] as IndicatorState;
    expect(saved.calcParams).toEqual([20, 2.5]);
    expect(saved.lineColors).toHaveLength(3);
    expect(saved.lineColors![1]).toBe('#00ff00');
  });

  it('Reset restores default params and colors', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...RSI, calcParams: [3, 4, 5], lineColors: ['#000000', '#111111', '#222222'] }} onSave={onSave} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('RSI1 period')).toHaveValue('6');
    await userEvent.click(save());
    const saved = onSave.mock.calls[0]![0] as IndicatorState;
    expect(saved.calcParams).toEqual([6, 12, 24]);
    // Clean shape: colors equal to the defaults are dropped (the adapter writes the defaults back itself).
    expect(saved).not.toHaveProperty('lineColors');
  });

  it('stored colors that all equal the defaults are dropped on save (clean shape)', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...RSI, lineColors: ['#2488f7', '#e56c19', '#00b3c2'] }} onSave={onSave} onClose={() => {}} />);
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineColors');
  });

  it('migrates stored calcParams shorter than the param labels: padded with defaults, silently, saved clean', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...RSI, calcParams: [7] }} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('RSI1 period')).toHaveValue('7');
    expect(screen.getByLabelText('RSI2 period')).toHaveValue('12');
    expect(screen.getByLabelText('RSI3 period')).toHaveValue('24');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('.settings-error')).toBeNull();
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0].calcParams).toEqual([7, 12, 24]);
  });

  it('Cancel / Escape close without saving', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('an indicator with no params says so', () => {
    render(<IndicatorSettings state={{ name: 'VWAP', pane: 'main', calcParams: [], visible: true }} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no parameters/i)).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });
});
