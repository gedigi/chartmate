import { describe, expect, it } from 'vitest';
import { candleStyles, DOWN, resolveAppearance, THEME_TOKENS, UP } from '../../src/chart/theme';

describe('resolveAppearance', () => {
  it('fills unset fields with theme defaults', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(resolveAppearance(theme, undefined)).toEqual({
        upColor: UP, downColor: DOWN, candleBody: 'solid', lineColor: THEME_TOKENS[theme].accent, lineWidth: 2,
        drawing: { color: THEME_TOKENS[theme].accent, size: 1, style: 'solid' },
      });
    }
    expect(resolveAppearance('dark', { upColor: '#00ff00', lineWidth: 4 })).toMatchObject({ upColor: '#00ff00', downColor: DOWN, lineWidth: 4 });
  });
});

describe('candleStyles', () => {
  it('maps up/down colours onto bodies, borders, wicks and the last-price mark', () => {
    const s = candleStyles('candle', 'dark', { upColor: '#00ff00', downColor: '#ff00ff' });
    expect(s.type).toBe('candle_solid');
    expect(s.bar).toMatchObject({
      upColor: '#00ff00', upBorderColor: '#00ff00', upWickColor: '#00ff00',
      downColor: '#ff00ff', downBorderColor: '#ff00ff', downWickColor: '#ff00ff',
    });
    expect(s.priceMark?.last).toMatchObject({ upColor: '#00ff00', downColor: '#ff00ff' });
  });

  it('maps the body style for candles; OHLC bars keep type ohlc but take the colours', () => {
    expect(candleStyles('candle', 'dark', { candleBody: 'hollow' }).type).toBe('candle_stroke');
    expect(candleStyles('candle', 'dark', { candleBody: 'hollow_up' }).type).toBe('candle_up_stroke');
    expect(candleStyles('candle', 'dark', { candleBody: 'hollow_down' }).type).toBe('candle_down_stroke');
    const ohlc = candleStyles('ohlc', 'light', { candleBody: 'hollow', upColor: '#010203' });
    expect(ohlc.type).toBe('ohlc');
    expect(ohlc.bar?.upColor).toBe('#010203');
  });

  it('line/area use the appearance line colour and width; defaults follow the theme accent', () => {
    const line = candleStyles('line', 'dark', { lineColor: '#ff8800', lineWidth: 3 });
    expect(line.type).toBe('area');
    expect(line.area).toMatchObject({ lineColor: '#ff8800', lineSize: 3 });
    const area = candleStyles('area', 'light', { lineColor: '#ff8800' });
    expect(area.area?.backgroundColor).toEqual([
      { offset: 0, color: 'rgba(255,136,0,0.02)' }, { offset: 1, color: 'rgba(255,136,0,0.28)' },
    ]);
    expect(candleStyles('line', 'light', undefined).area).toMatchObject({ lineColor: THEME_TOKENS.light.accent, lineSize: 2 });
  });
});
