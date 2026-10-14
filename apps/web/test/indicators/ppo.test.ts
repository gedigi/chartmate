import { describe, expect, it } from 'vitest';
import { catalogEntry, defaultLineColors } from '../../src/chart/indicators/catalog';
import indicator, { calcPpo, ema } from '../../src/chart/indicators/custom/ppo';
import { customIndicatorProblem } from '../../src/chart/indicators/extensions';
import { INDICATOR_PALETTE } from '../../src/chart/theme';

const bars = (closes: number[]) => closes.map((close) => ({ open: close, high: close, low: close, close, volume: 0, timestamp: 0 }));

describe('ema', () => {
  it('is null until `period` values, seeded with their average, then smooths with 2 / (period + 1)', () => {
    expect(ema([10, 11, 12, 13], 2)).toEqual([null, 10.5, 11.5, 12.5]);
    expect(ema([10, 11, 12, 13], 3)).toEqual([null, null, 11, 12]);
  });

  it('skips leading nulls (the warm-up of the series it smooths)', () => {
    expect(ema([null, null, 2, 4, 6], 2)).toEqual([null, null, null, 3, 5]);
  });
});

describe('calcPpo', () => {
  it('fast and slow EMA spread as a percentage of the slow EMA, its signal line and the histogram', () => {
    // Hand-computed with fast 2, slow 3, signal 2 (see the ema test for the EMAs).
    const ppo = [50 / 11, 25 / 6, 25 / 18]; // (11.5 - 11) / 11, (12.5 - 12) / 12, (73/6 - 12) / 12, in %
    const signal = [(ppo[0]! + ppo[1]!) / 2, (2 / 3) * ppo[2]! + (1 / 3) * ((ppo[0]! + ppo[1]!) / 2)];
    const out = calcPpo(bars([10, 11, 12, 13, 12]), 2, 3, 2);
    expect(out.slice(0, 2)).toEqual([{ ppo: null, signal: null, hist: null }, { ppo: null, signal: null, hist: null }]);
    expect(out[2]).toEqual({ ppo: expect.closeTo(ppo[0]!, 10), signal: null, hist: null });
    expect(out[3]).toEqual({ ppo: expect.closeTo(ppo[1]!, 10), signal: expect.closeTo(signal[0]!, 10), hist: expect.closeTo(ppo[1]! - signal[0]!, 10) });
    expect(out[4]).toEqual({ ppo: expect.closeTo(ppo[2]!, 10), signal: expect.closeTo(signal[1]!, 10), hist: expect.closeTo(ppo[2]! - signal[1]!, 10) });
  });

  it('is zero on a flat series, and returns one result per bar', () => {
    const out = calcPpo(bars(Array(40).fill(50)), 12, 26, 9);
    expect(out).toHaveLength(40);
    expect(out[39]).toEqual({ ppo: expect.closeTo(0, 10), signal: expect.closeTo(0, 10), hist: expect.closeTo(0, 10) });
    expect(calcPpo([], 12, 26, 9)).toEqual([]);
  });

  it('is null where the slow EMA is zero (no percentage of nothing)', () => {
    expect(calcPpo(bars([0, 0, 0]), 1, 2, 1).map((r) => r.ppo)).toEqual([null, null, null]);
  });
});

describe('PPO indicator', () => {
  it('is a valid custom indicator, listed in the picker with its params and zero level', () => {
    expect(customIndicatorProblem(indicator)).toBeNull();
    expect(catalogEntry('PPO')).toMatchObject({
      label: 'Percentage price oscillator', pane: 'sub', defaultParams: [12, 26, 9], lines: ['PPO', 'Signal'], levels: [0], bars: true,
    });
  });

  it('runs the calculation with the indicator params', async () => {
    const out = await indicator.template.calc(bars([10, 11, 12, 13, 12]) as never, { calcParams: [2, 3, 2] } as never);
    expect(out).toEqual(calcPpo(bars([10, 11, 12, 13, 12]), 2, 3, 2));
  });

  it.each(['dark', 'light'] as const)('draws its two lines in distinct palette colors on the %s theme', (theme) => {
    expect(defaultLineColors('PPO', theme)).toEqual([INDICATOR_PALETTE[theme][0], INDICATOR_PALETTE[theme][1]]);
  });

  it('colors the histogram with the chart\'s up / down bar colors: above zero up, below down, rising bars softened', () => {
    const hist = indicator.template.figures!.find((f) => f.type === 'bar')!;
    const bars0 = { upColor: 'UP', downColor: 'DOWN', noChangeColor: 'FLAT' };
    const style = (prev: number | null, current: number | null) => (hist.styles as (p: unknown) => { color: string; style: string })({
      data: { prev: { hist: prev }, current: { hist: current } }, indicator: { styles: null }, defaultStyles: { bars: [bars0] },
    });
    expect(style(1, 2)).toMatchObject({ color: 'UP', style: 'stroke' }); // rising: the chart softens it
    expect(style(2, 1)).toMatchObject({ color: 'UP', style: 'fill' });
    expect(style(-1, -2)).toMatchObject({ color: 'DOWN', style: 'fill' });
    expect(style(1, 0)).toMatchObject({ color: 'FLAT' });
    // A user's bar colors (indicator settings) win over the theme defaults.
    expect((hist.styles as (p: unknown) => { color: string })({
      data: { prev: null, current: { hist: -1 } }, indicator: { styles: { bars: [{ downColor: 'MINE' }] } }, defaultStyles: { bars: [bars0] },
    }).color).toBe('MINE');
  });
});
