import type { IndicatorState } from '@chartmate/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { catalogEntry } from '../src/chart/indicators/catalog';
import { defaultBarColors } from '../src/chart/theme';

const DEFAULT_BAR_COLORS = defaultBarColors('dark');
import { IndicatorSettings } from '../src/components/IndicatorSettings';

const RSI: IndicatorState = { name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true };
const VOL: IndicatorState = { name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true };
const save = () => screen.getByRole('button', { name: 'Save' });

describe('IndicatorSettings line width / style and bar colors', () => {
  it('catalog flags the histogram indicators', () => {
    expect(['VOL', 'MACD', 'AO'].map((n) => catalogEntry(n)?.bars)).toEqual([true, true, true]);
    expect(catalogEntry('RSI')?.bars).toBeFalsy();
  });

  it('shows width and style next to each line color; untouched values are not saved', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('RSI1 width')).toHaveValue('1');
    expect(screen.getByLabelText('RSI1 style')).toHaveValue('solid');
    expect(screen.queryByLabelText('Up bar color')).not.toBeInTheDocument();
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

  it('Reset after customized widths and dashed styles saves a clean shape', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...RSI, lineWidths: [3, 1, 1], lineStyles: ['dashed', 'solid', 'solid'] }} onSave={onSave} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(RSI);
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineWidths');
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineStyles');
  });

  it('histogram indicators get up/down bar colors; Reset restores everything', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={{ ...VOL, lineWidths: [2, 1, 1] }} onSave={onSave} onClose={() => {}} />);
    const up = screen.getByLabelText('Up bar color');
    expect(up).toHaveValue(DEFAULT_BAR_COLORS.up);
    expect(screen.getByLabelText('Down bar color')).toHaveValue(DEFAULT_BAR_COLORS.down);
    fireEvent.input(up, { target: { value: '#00ff00' } });
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith({ ...VOL, lineWidths: [2, 1, 1], barColors: { up: '#00ff00', down: DEFAULT_BAR_COLORS.down } });

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('MA1 width')).toHaveValue('1');
    expect(screen.getByLabelText('Up bar color')).toHaveValue(DEFAULT_BAR_COLORS.up);
    await userEvent.click(save());
    // Back to the defaults: no width/style/bar overrides are saved (the adapter restores the chart defaults).
    expect(onSave).toHaveBeenLastCalledWith(VOL);
  });

  it('bar color defaults follow the active theme; untouched defaults are not saved; overrides win', async () => {
    const onSave = vi.fn();
    const { unmount } = render(<IndicatorSettings state={VOL} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('Up bar color')).toHaveValue('#00a870');
    expect(screen.getByLabelText('Down bar color')).toHaveValue('#d4113b');
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith(VOL);
    unmount();
    render(<IndicatorSettings state={{ ...VOL, barColors: { up: '#00ff00', down: '#ff0000' } }} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('Up bar color')).toHaveValue('#00ff00');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Up bar color')).toHaveValue('#00a870');
  });

  it('bar color defaults follow the custom candle colors of the active theme', async () => {
    const onSave = vi.fn();
    const appearance = { dark: { upColor: '#3366ff', downColor: '#ffaa00' } };
    render(<IndicatorSettings state={VOL} theme="dark" appearance={appearance} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('Up bar color')).toHaveValue('#3366ff');
    expect(screen.getByLabelText('Down bar color')).toHaveValue('#ffaa00');
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith(VOL); // untouched → no override, the bars keep following the candles
  });
});

describe('IndicatorSettings default line colors follow the theme palette', () => {
  const values = (names: string[]) => names.map((n) => (screen.getByLabelText(`${n} color`) as HTMLInputElement).value);
  it('color pickers show the current theme defaults; untouched are not saved; user colors win; Reset returns to theme defaults', async () => {
    const onSave = vi.fn();
    const { unmount } = render(<IndicatorSettings state={RSI} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(values(['RSI1', 'RSI2', 'RSI3'])).toEqual(['#1272da', '#eb6111', '#0095a0']);
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(RSI);
    unmount();

    const user = { ...RSI, lineColors: ['#111111', '#222222', '#333333'] };
    render(<IndicatorSettings state={user} theme="dark" onSave={onSave} onClose={() => {}} />);
    expect(screen.getByLabelText('RSI1 color')).toHaveValue('#111111');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(values(['RSI1', 'RSI2', 'RSI3'])).toEqual(['#2488f7', '#e56c19', '#00b3c2']);
    onSave.mockClear();
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineColors');
  });
});
