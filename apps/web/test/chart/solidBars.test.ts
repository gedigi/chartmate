import type { IndicatorFigure } from 'klinecharts';
import { describe, expect, it, vi } from 'vitest';
import { solidBarFigures } from '../../src/chart/solidBars';

type Params = Parameters<NonNullable<IndicatorFigure['styles']>>[0];
/** Draw-time params for a bar whose value moved from `prev` to `current` (prev undefined: the first bar). */
const at = (current: number, prev?: number) => ({
  data: { current: { macd: current, ao: current }, prev: prev === undefined ? undefined : { macd: prev, ao: prev }, next: undefined },
}) as unknown as Params;
const soften = (c: string) => `soft(${c})`;
/** KLineChart's MACD / AO template: up / down by sign, an outline when the bar rose versus the previous one. */
const template = vi.fn((p: Params) => {
  const { current, prev } = p.data as unknown as { current: { macd: number }; prev?: { macd: number } };
  return {
    style: (prev?.macd ?? Number.MIN_SAFE_INTEGER) < current.macd ? 'stroke' as const : 'fill' as const,
    color: current.macd > 0 ? '#00ff00' : '#ff0000', borderColor: current.macd > 0 ? '#00ff00' : '#ff0000',
  };
});

describe('solidBarFigures', () => {
  const bars = () => solidBarFigures([
    { key: 'dif', title: 'DIF: ', type: 'line' },
    { key: 'macd', title: 'MACD: ', type: 'bar', baseValue: 0, styles: template },
  ], soften)!;

  it('keeps the other figures and the bar\'s own fields', () => {
    const out = bars();
    expect(out[0]).toEqual({ key: 'dif', title: 'DIF: ', type: 'line' });
    expect(out[1]).toMatchObject({ key: 'macd', title: 'MACD: ', type: 'bar', baseValue: 0 });
  });

  it('every bar is filled: rising bars (green growing, red shrinking toward zero) in the full color', () => {
    const style = bars()[1]!.styles!;
    expect(style(at(3, 2))).toEqual({ style: 'fill', color: '#00ff00', borderColor: '#00ff00' });
    expect(style(at(-2, -3))).toEqual({ style: 'fill', color: '#ff0000', borderColor: '#ff0000' });
  });

  it('falling bars (green shrinking, red growing downward) in the soft tone of their color', () => {
    const style = bars()[1]!.styles!;
    expect(style(at(2, 3))).toEqual({ style: 'fill', color: 'soft(#00ff00)', borderColor: 'soft(#00ff00)' });
    expect(style(at(-3, -2))).toEqual({ style: 'fill', color: 'soft(#ff0000)', borderColor: 'soft(#ff0000)' });
  });

  it('an unchanged bar and the first bar keep the full color', () => {
    const style = bars()[1]!.styles!;
    expect(style(at(2, 2))).toMatchObject({ color: '#00ff00' });
    expect(style(at(-1))).toMatchObject({ color: '#ff0000' });
  });

  it('bars whose template sets no style (volume, colored by candle) are left exactly as drawn, even when falling', () => {
    const volume = () => ({ color: '#00ff00' });
    const out = solidBarFigures([{ key: 'volume', type: 'bar', styles: volume }], soften)!;
    expect(out[0]!.styles!(at(1, 5))).toEqual({ color: '#00ff00' });
  });

  it('calls `soften` at draw time (it follows the active theme)', () => {
    let theme = 'dark';
    const out = solidBarFigures([{ key: 'ao', type: 'bar', styles: () => ({ style: 'fill', color: '#123456' }) }], (c) => `${theme}:${c}`)!;
    expect(out[0]!.styles!(at(1, 2))).toMatchObject({ color: 'dark:#123456' });
    theme = 'light';
    expect(out[0]!.styles!(at(1, 2))).toMatchObject({ color: 'light:#123456' });
  });

  it('returns null when nothing changes: no bar callback, nothing given, or already wrapped', () => {
    expect(solidBarFigures(undefined, soften)).toBeNull();
    expect(solidBarFigures([{ key: 'v', type: 'bar' }, { key: 'l', type: 'line', styles: () => ({ color: '#fff' }) }], soften)).toBeNull();
    const once = solidBarFigures([{ key: 'ao', type: 'bar', styles: () => ({ style: 'stroke' }) }], soften)!;
    expect(solidBarFigures(once, soften)).toBeNull();
  });
});
