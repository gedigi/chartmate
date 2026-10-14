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
    render(<IndicatorSettings state={{ ...RSI, lineColors: ['#f2b861', '#a99bff', '#3fc8e4'] }} onSave={onSave} onClose={() => {}} />);
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

  describe('reference levels', () => {
    const show = () => screen.getByRole('checkbox', { name: 'Show reference lines' });
    const values = () => screen.getByLabelText('Values');

    it('oscillators show their default levels (old layouts without levels); unchanged levels are not saved', async () => {
      const onSave = vi.fn();
      render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
      expect(screen.getByRole('group', { name: 'Levels' })).toBeInTheDocument();
      expect(show()).toBeChecked();
      expect(values()).toHaveValue('70, 30');
      await userEvent.click(save());
      expect(onSave.mock.calls[0]![0]).toEqual(RSI);
    });

    it('overlays have no Levels section', () => {
      render(<IndicatorSettings state={BOLL} onSave={() => {}} onClose={() => {}} />);
      expect(screen.queryByRole('group', { name: 'Levels' })).not.toBeInTheDocument();
    });

    it('edited values and the hide toggle are saved; stored values are shown', async () => {
      const onSave = vi.fn();
      render(<IndicatorSettings state={{ ...RSI, levels: [80, 20] }} onSave={onSave} onClose={() => {}} />);
      expect(values()).toHaveValue('80, 20');
      await userEvent.clear(values());
      await userEvent.type(values(), '75, 50, 25');
      await userEvent.click(show());
      expect(values()).toBeDisabled();
      await userEvent.click(save());
      expect(onSave.mock.calls[0]![0]).toEqual({ ...RSI, levels: [75, 50, 25], showLevels: false });
    });

    it('invalid values show an error and disable Save while the levels are shown', async () => {
      render(<IndicatorSettings state={RSI} onSave={() => {}} onClose={() => {}} />);
      await userEvent.clear(values());
      await userEvent.type(values(), '70, high');
      expect(values()).toHaveAttribute('aria-invalid', 'true');
      expect(save()).toBeDisabled();
      await userEvent.clear(values());
      await userEvent.type(values(), '1 2 3 4 5 6');
      expect(screen.getByText('At most 5 levels')).toBeInTheDocument();
      await userEvent.click(show()); // hidden levels never block saving
      expect(save()).toBeEnabled();
    });

    it('clearing the values saves an empty list (no lines)', async () => {
      const onSave = vi.fn();
      render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
      await userEvent.clear(values());
      await userEvent.click(save());
      expect(onSave.mock.calls[0]![0]).toEqual({ ...RSI, levels: [] });
    });

    it('Reset restores the default levels and shows them', async () => {
      const onSave = vi.fn();
      render(<IndicatorSettings state={{ ...RSI, levels: [90, 10], showLevels: false }} onSave={onSave} onClose={() => {}} />);
      expect(show()).not.toBeChecked();
      await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
      expect(show()).toBeChecked();
      expect(values()).toHaveValue('70, 30');
      await userEvent.click(save());
      const saved = onSave.mock.calls[0]![0] as IndicatorState;
      expect(saved).not.toHaveProperty('levels');
      expect(saved).not.toHaveProperty('showLevels');
    });
  });

  it('an indicator with no params says so', () => {
    render(<IndicatorSettings state={{ name: 'VWAP', pane: 'main', calcParams: [], visible: true }} onSave={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no parameters/i)).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });
});
