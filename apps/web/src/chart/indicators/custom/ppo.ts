// The worked example of CONTRIBUTING.md, "Add an indicator": an oscillator with params, two lines, a histogram and a
// reference level. Read it top to bottom.
import type { IndicatorFigureStylesCallback } from 'klinecharts';
import type { CustomIndicator } from '../types';

/** One result per bar; `null` while there is not enough history yet (the warm-up), so nothing is drawn there. */
export interface PpoResult {
  ppo: number | null;
  signal: number | null;
  hist: number | null;
}

/**
 * Exponential moving average of `values` (leading nulls skipped): null until `period` values, seeded with their
 * average, then `value * k + previous * (1 - k)` with `k = 2 / (period + 1)`.
 */
export function ema(values: ReadonlyArray<number | null>, period: number): Array<number | null> {
  const n = Math.max(1, Math.floor(period));
  const k = 2 / (n + 1);
  let count = 0;
  let sum = 0;
  let prev: number | null = null;
  return values.map((v) => {
    if (v === null) return null;
    count++;
    if (prev === null) {
      sum += v;
      if (count < n) return null;
      prev = sum / n;
    } else {
      prev = v * k + prev * (1 - k);
    }
    return prev;
  });
}

/**
 * Step 1, the calculation: pure (bars in, results out; no chart, no DOM), so it is tested on its own
 * (apps/web/test/indicators/ppo.test.ts).
 *
 * Percentage price oscillator: the spread between a fast and a slow EMA of the close, as a percentage of the slow
 * one; a signal line (EMA of that spread); and the histogram, spread minus signal.
 */
export function calcPpo(bars: ReadonlyArray<{ close: number }>, fast: number, slow: number, signal: number): PpoResult[] {
  const closes = bars.map((b) => b.close);
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const ppo = fastEma.map((f, i) => {
    const s = slowEma[i];
    return f === null || s === null || s === undefined || s === 0 ? null : ((f - s) / s) * 100;
  });
  const sig = ema(ppo, signal);
  return ppo.map((p, i) => {
    const s = sig[i] ?? null;
    return { ppo: p, signal: s, hist: p === null || s === null ? null : p - s };
  });
}

/**
 * Histogram bar colors. No color is written here: they are the chart's bar colors (the theme's up / down colors, or
 * the user's own from the indicator settings), which KLineChart passes in. Above zero: up; below: down. A bar that
 * rises is returned as 'stroke', which the chart draws filled in the soft tone of its color.
 */
const histStyles: IndicatorFigureStylesCallback<PpoResult> = ({ data, indicator, defaultStyles }) => {
  const own = indicator.styles?.bars?.[0];
  const theme = defaultStyles!.bars[0]!;
  const hist = data.current?.hist ?? 0;
  const prev = data.prev?.hist ?? null;
  const color = hist > 0 ? own?.upColor ?? theme.upColor : hist < 0 ? own?.downColor ?? theme.downColor : own?.noChangeColor ?? theme.noChangeColor;
  return { color, borderColor: color, style: prev !== null && hist > prev ? 'stroke' : 'fill' };
};

const indicator: CustomIndicator = {
  // Step 2, the chart template: how KLineChart computes and draws it.
  template: {
    name: 'PPO', // unique; equal to catalog.name
    shortName: 'PPO', // the chart legend
    calcParams: [12, 26, 9], // default params; the user edits them in the settings dialog
    precision: 2, // values are percentages
    // One figure per value: `key` names the field of PpoResult, `type` line or bar. Lines are listed in
    // catalog.lines in this same order; their colors come from catalog.lineSlots, never from here.
    figures: [
      { key: 'hist', title: 'Hist: ', type: 'bar', baseValue: 0, styles: histStyles },
      { key: 'ppo', title: 'PPO: ', type: 'line' },
      { key: 'signal', title: 'Signal: ', type: 'line' },
    ],
    calc: (dataList, ind) => calcPpo(dataList, ind.calcParams[0] ?? 12, ind.calcParams[1] ?? 26, ind.calcParams[2] ?? 9),
  },
  // Step 3, the picker and settings entry.
  catalog: {
    name: 'PPO',
    label: 'Percentage price oscillator',
    pane: 'sub', // its own pane under the candles
    defaultParams: [12, 26, 9],
    paramLabels: ['Fast period', 'Slow period', 'Signal period'],
    lines: ['PPO', 'Signal'], // the line figures, in figure order
    lineSlots: [0, 1], // palette slots: PPO gold, signal violet, in each theme's own shade
    levels: [0], // a dashed zero line, editable in the settings dialog
    // `bars: true` is inferred from the 'bar' figure: the settings dialog offers its up / down colors.
    description: 'The fast and slow EMA spread as a percentage of the slow EMA, so readings compare across symbols and price levels.',
  },
};

export default indicator;
