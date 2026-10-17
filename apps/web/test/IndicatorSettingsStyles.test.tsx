import type { IndicatorState } from '@chartmate/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { catalogEntry } from '../src/chart/indicators/catalog';
import { defaultBarColors } from '../src/chart/theme';

const DEFAULT_BAR_COLORS = defaultBarColors('dark');
import { IndicatorSettings } from '../src/components/IndicatorSettings';

const RSI: IndicatorState = { name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true };
const VOL: IndicatorState = { name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true };
const save = () => screen.getByRole('button', { name: 'Save' });

/** The color a palette picker button shows (its chip), as #rrggbb. */
function shown(label: string): string {
  const chip = screen.getByRole('button', { name: label }).querySelector<HTMLElement>('.color-picker-chip')!;
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(chip.style.backgroundColor);
  return m ? `#${m.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : chip.style.backgroundColor;
}
/** The swatch name a palette picker button shows ("Gold", "Up color", "Custom #123456", …). */
const shownName = (label: string) => screen.getByRole('button', { name: label }).title.replace(/^Color: /, '');
/** Opens the picker labeled `label` and picks the swatch named `swatch`. */
async function pick(label: string, swatch: string) {
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(screen.getByRole('option', { name: swatch }));
}

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
    expect(shownName('Up bar color')).toBe('Up color');
    expect(shown('Up bar color')).toBe(DEFAULT_BAR_COLORS.up);
    expect(shown('Down bar color')).toBe(DEFAULT_BAR_COLORS.down);
    await pick('Up bar color', 'Blue');
    await userEvent.click(save());
    // The untouched side is stored as its default reference ('down'), so it keeps following the candle color.
    expect(onSave).toHaveBeenLastCalledWith({ ...VOL, lineWidths: [2, 1, 1], barColors: { up: 'palette:5', down: 'down' } });

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('MA1 width')).toHaveValue('1');
    expect(shownName('Up bar color')).toBe('Up color');
    await userEvent.click(save());
    // Back to the defaults: no width/style/bar overrides are saved (the adapter restores the chart defaults).
    expect(onSave).toHaveBeenLastCalledWith(VOL);
  });

  it('bar color defaults follow the active theme; untouched defaults are not saved; overrides win', async () => {
    const onSave = vi.fn();
    const { unmount } = render(<IndicatorSettings state={VOL} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(shown('Up bar color')).toBe('#0b9da0');
    expect(shown('Down bar color')).toBe('#c43d68');
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith(VOL);
    unmount();
    // Hex colors saved before palette references show as a "Custom" swatch, kept until another swatch is picked.
    render(<IndicatorSettings state={{ ...VOL, barColors: { up: '#00ff00', down: '#ff0000' } }} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(shownName('Up bar color')).toBe('Custom #00ff00');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(shown('Up bar color')).toBe('#0b9da0');
  });

  it('bar color defaults follow the custom candle colors of the active theme', async () => {
    const onSave = vi.fn();
    const appearance = { dark: { upColor: '#3366ff', downColor: '#ffaa00' } };
    render(<IndicatorSettings state={VOL} theme="dark" appearance={appearance} onSave={onSave} onClose={() => {}} />);
    expect(shown('Up bar color')).toBe('#3366ff');
    expect(shown('Down bar color')).toBe('#ffaa00');
    await userEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith(VOL); // untouched → no override, the bars keep following the candles
  });
});

describe('IndicatorSettings default line colors follow the theme palette', () => {
  const values = (names: string[]) => names.map((n) => shown(`${n} color`));
  it('color pickers show the current theme defaults; untouched are not saved; user colors win; Reset returns to theme defaults', async () => {
    const onSave = vi.fn();
    const { unmount } = render(<IndicatorSettings state={RSI} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(values(['RSI1', 'RSI2', 'RSI3'])).toEqual(['#c98512', '#5b49e0', '#0a8ea6']);
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith(RSI);
    unmount();

    const user = { ...RSI, lineColors: ['#111111', '#222222', '#333333'] };
    render(<IndicatorSettings state={user} theme="dark" onSave={onSave} onClose={() => {}} />);
    expect(shownName('RSI1 color')).toBe('Custom #111111');
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(values(['RSI1', 'RSI2', 'RSI3'])).toEqual(['#f2b861', '#a99bff', '#3fc8e4']);
    onSave.mockClear();
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('lineColors');
  });
});

describe('IndicatorSettings stores only the edited colors (the rest keep following the theme)', () => {
  it('editing one line saves that line only; the others stay empty (theme default)', async () => {
    const onSave = vi.fn();
    render(<IndicatorSettings state={RSI} theme="dark" onSave={onSave} onClose={() => {}} />);
    await pick('RSI2 color', 'Pink');
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0].lineColors).toEqual(['', 'palette:4']);
  });

  it('a picked swatch follows the theme: the same reference shows each theme\'s palette color', () => {
    const picked = { ...RSI, lineColors: ['', 'palette:4'] };
    const { unmount } = render(<IndicatorSettings state={picked} theme="dark" onSave={() => {}} onClose={() => {}} />);
    expect(shown('RSI2 color')).toBe('#f27bd0');
    unmount();
    render(<IndicatorSettings state={picked} theme="light" onSave={() => {}} onClose={() => {}} />);
    expect(shown('RSI2 color')).toBe('#c8399a');
    expect(shownName('RSI2 color')).toBe('Pink');
  });

  it('an old dense payload: entries equal to either theme default are shown as the active theme default and saved as defaults', async () => {
    const onSave = vi.fn();
    // Saved in dark with only RSI2 edited: RSI1 / RSI3 hold the dark palette.
    const old = { ...RSI, lineColors: ['#f2b861', '#123456', '#3fc8e4'] };
    render(<IndicatorSettings state={old} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(shown('RSI1 color')).toBe('#c98512');
    expect(shownName('RSI2 color')).toBe('Custom #123456');
    expect(shown('RSI3 color')).toBe('#0a8ea6');
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0].lineColors).toEqual(['', '#123456']);
  });

  it('bar colors: a stored side equal to a theme default follows the active theme', () => {
    render(<IndicatorSettings state={{ ...VOL, barColors: { up: '#00ff00', down: DEFAULT_BAR_COLORS.down } }} theme="light" onSave={() => {}} onClose={() => {}} />);
    expect(shownName('Up bar color')).toBe('Custom #00ff00');
    expect(shown('Down bar color')).toBe(defaultBarColors('light').down);
  });
});
