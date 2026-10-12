import type { IndicatorState } from '@altv/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { catalogEntry, DEFAULT_BAR_COLORS } from '../src/chart/indicators/catalog';
import { IndicatorSettings } from '../src/components/IndicatorSettings';

const RSI: IndicatorState = { name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true };
const VOL: IndicatorState = { name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true };
const save = () => screen.getByRole('button', { name: 'Save' });

describe('IndicatorSettings line width / style and bar colours', () => {
  it('catalog flags the histogram indicators', () => {
    expect(['VOL', 'MACD', 'AO'].map((n) => catalogEntry(n)?.bars)).toEqual([true, true, true]);
    expect(catalogEntry('RSI')?.bars).toBeFalsy();
  });

  it('shows width and style next to each line colour; untouched values are not saved', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('RSI1 width')).toHaveValue('1');
    expect(screen.getByLabelText('RSI1 style')).toHaveValue('solid');
    expect(screen.queryByLabelText('Up bar colour')).not.toBeInTheDocument();
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(RSI);
  });

  it('saves edited widths and styles as lineWidths / lineStyles', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText('RSI2 width'), '3');
    await userEvent.selectOptions(screen.getByLabelText('RSI3 style'), 'dashed');
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({ ...RSI, lineWidths: [1, 3, 1], lineStyles: ['solid', 'solid', 'dashed'] });
  });

  it('Reset after customised widths and dashed styles saves a clean shape', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...RSI, lineWidths: [3, 1, 1], lineStyles: ['dashed', 'solid', 'solid'] }} onSave={onSave} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(RSI);
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineWidths');
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineStyles');
  });

  it('histogram indicators get up/down bar colours; Reset restores everything', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...VOL, lineWidths: [2, 1, 1] }} onSave={onSave} onClose={() => {}} />);
    const up = screen.getByLabelText('Up bar colour');
    expect(up).toHaveValue(DEFAULT_BAR_COLORS.up);
    expect(screen.getByLabelText('Down bar colour')).toHaveValue(DEFAULT_BAR_COLORS.down);
    fireEvent.input(up, { target: { value: '#00ff00' } });
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith({ ...VOL, lineWidths: [2, 1, 1], barColors: { up: '#00ff00', down: DEFAULT_BAR_COLORS.down } });

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('MA1 width')).toHaveValue('1');
    expect(screen.getByLabelText('Up bar colour')).toHaveValue(DEFAULT_BAR_COLORS.up);
    await userEvent.click(save());
    // Back to the defaults: no width/style/bar overrides are saved (the adapter restores the chart defaults).
    expect(onSave).toHaveBeenLastCalledWith(VOL);
  });
});
