import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candleStyles, chartStyles, DOWN, overlayStyles, refreshThemeTokens, resolveAppearance, THEME_CSS_VARS, THEME_TOKENS, themeTokens, UP,
} from '../../src/chart/theme';

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

describe('overlayStyles', () => {
  it('derives the chart overlay defaults from the resolved default drawing style', () => {
    const d = resolveAppearance('dark', undefined).drawing;
    expect(overlayStyles(d)).toMatchObject({
      line: { color: d.color, size: d.size, style: d.style },
      point: { color: d.color, activeColor: d.color },
      text: { backgroundColor: d.color, borderColor: d.color, size: 12 },
    });
    expect(overlayStyles({ color: '#ff0000', size: 3, style: 'dashed' }).line).toMatchObject({ color: '#ff0000', size: 3, style: 'dashed', dashedValue: [6, 4] });
  });
});

describe('theme tokens from CSS custom properties', () => {
  const root = document.documentElement;
  afterEach(() => {
    for (const v of ['--accent', '--text-muted', '--border']) root.style.removeProperty(v);
    delete root.dataset['theme'];
    refreshThemeTokens('dark');
    refreshThemeTokens('light');
  });

  it('reads the CSS tokens of the active theme at refresh; constants are the fallback', () => {
    root.dataset['theme'] = 'dark';
    root.style.setProperty('--accent', '#ff0000');
    root.style.setProperty('--text-muted', '#00ff00');
    refreshThemeTokens('dark');
    expect(themeTokens('dark')).toMatchObject({ accent: '#ff0000', muted: '#00ff00', border: THEME_TOKENS.dark.border });
    expect(resolveAppearance('dark', undefined).lineColor).toBe('#ff0000');
    expect(chartStyles('dark').xAxis).toMatchObject({ tickText: { color: '#00ff00' } });
    // Not the active theme: never read from the document (its variables belong to the other theme).
    refreshThemeTokens('light');
    expect(themeTokens('light')).toEqual(THEME_TOKENS.light);
  });

  it('falls back to the constants when the variables are missing or not colours', () => {
    root.dataset['theme'] = 'dark';
    root.style.setProperty('--accent', 'not a colour');
    refreshThemeTokens('dark');
    expect(themeTokens('dark')).toEqual(THEME_TOKENS.dark);
  });

  it('parity: the fallback constants match the token values in styles.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
      return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
    };
    const vars = { dark: block(":root[data-theme='dark']"), light: block(":root[data-theme='light']") };
    for (const theme of ['dark', 'light'] as const) {
      for (const [key, cssVar] of Object.entries(THEME_CSS_VARS)) {
        expect(vars[theme][cssVar], `${theme} ${cssVar}`).toBe(THEME_TOKENS[theme][key as keyof typeof THEME_TOKENS.dark]);
      }
    }
  });
});
