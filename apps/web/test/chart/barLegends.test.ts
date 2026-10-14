import { describe, expect, it } from 'vitest';
import type { TooltipLegendChild } from 'klinecharts';
import { textColoredLegends } from '../../src/chart/barLegends';
import { softTone } from '../../src/chart/color';
import { THEME_TOKENS } from '../../src/chart/theme';

const t = THEME_TOKENS.dark;
const theme = () => ({ up: t.up, down: t.down, upFg: t.upFg, downFg: t.downFg, soften: (c: string) => softTone(c, t.bg) });
const defaults = {
  lines: [{ color: '#111111' }, { color: '#222222' }],
  bars: [{ upColor: t.up, downColor: t.down, noChangeColor: t.muted }],
  circles: [{ noChangeColor: '#333333' }],
  texts: [{ color: '#444444' }],
  tooltip: { legend: { defaultValue: 'n/a', color: t.muted } },
};
/** A MACD-like indicator: two lines and a bar figure whose draw color is the soft tone (a rising bar). */
function call(barColor: string, ownBars?: Array<{ upColor: string; downColor: string; noChangeColor: string }>, data: Record<string, number> = { dif: 1.23456, dea: 2, macd: -8.93 }) {
  const indicator = {
    precision: 2, shouldFormatBigNumber: false, styles: ownBars ? { bars: ownBars } : null,
    result: [data, data],
    figures: [
      { key: 'dif', title: 'DIF: ', type: 'line' },
      { key: 'dea', title: 'DEA: ', type: 'line' },
      { key: 'macd', title: 'MACD: ', type: 'bar', styles: () => ({ style: 'fill', color: barColor }) },
      { key: 'hidden', type: 'line' },
    ],
  };
  const chart = { getStyles: () => ({ indicator: defaults }), getBarSpace: () => ({}), getFormatter: () => ({ formatBigNumber: (v: string) => `${v}!` }) };
  return textColoredLegends(theme)({ chart, indicator, crosshair: { dataIndex: 1 } } as never).legends as Array<{ title: TooltipLegendChild; value: TooltipLegendChild }>;
}

describe('textColoredLegends', () => {
  it('a rising (soft) down bar shows its value in the down TEXT tone; lines keep their colors; values formatted', () => {
    const legends = call(softTone(t.down, t.bg));
    expect(legends).toEqual([
      { title: { text: 'DIF: ', color: '#111111' }, value: { text: '1.23', color: '#111111' } },
      { title: { text: 'DEA: ', color: '#222222' }, value: { text: '2.00', color: '#222222' } },
      { title: { text: 'MACD: ', color: t.downFg }, value: { text: '-8.93', color: t.downFg } },
    ]);
  });

  it('strong up / soft up → the up text tone; a custom bar color shows as its strong color, never its soft tone', () => {
    expect(call(t.up)[2]!.value.color).toBe(t.upFg);
    expect(call(softTone(t.up, t.bg))[2]!.value.color).toBe(t.upFg);
    const custom = [{ upColor: '#3366ff', downColor: '#ffaa00', noChangeColor: t.muted }];
    expect(call(softTone('#ffaa00', t.bg), custom)[2]!.value.color).toBe('#ffaa00');
  });

  it('missing values use the default legend value', () => {
    expect(call(t.up, undefined, {})[2]!.value.text).toBe('n/a');
  });
});
