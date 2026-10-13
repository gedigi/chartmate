import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contrastRatio, DARK_TEXT, LIGHT_TEXT } from '../../src/chart/contrast';
import { textToOverlay } from '../../src/chart/drawingStyles';
import { markerStyles } from '../../src/chart/markers';
import {
  candleStyles, chartStyles, defaultAppearance, defaultBarColors, hexToRgba, overlayStyles, refreshThemeTokens, resolveAppearance, THEME_CSS_VARS, THEME_TOKENS, themeTokens,
} from '../../src/chart/theme';

describe('resolveAppearance', () => {
  it('fills unset fields with theme defaults', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(resolveAppearance(theme, undefined)).toEqual({
        upColor: THEME_TOKENS[theme].up, downColor: THEME_TOKENS[theme].down, candleBody: 'solid', lineColor: THEME_TOKENS[theme].accent, lineWidth: 2,
        drawing: { color: THEME_TOKENS[theme].accent, size: 1, style: 'solid' },
      });
    }
    expect(resolveAppearance('dark', { dark: { upColor: '#00ff00', lineWidth: 4 } })).toMatchObject({ upColor: '#00ff00', downColor: '#ef5350', lineWidth: 4 });
  });

  it('picks the active theme\'s settings; the other theme keeps its defaults', () => {
    const a = { dark: { upColor: '#ffffff' }, light: { downColor: '#000000' } };
    expect(resolveAppearance('dark', a)).toMatchObject({ upColor: '#ffffff', downColor: '#ef5350' });
    expect(resolveAppearance('light', a)).toMatchObject({ upColor: '#089981', downColor: '#000000' });
    expect(resolveAppearance('light', { dark: { upColor: '#ffffff' } })).toEqual(resolveAppearance('light', undefined));
  });
});

describe('per-theme default candle colours (match the --up / --down CSS tokens)', () => {
  it('dark #26a69a / #ef5350, light #089981 / #f23645', () => {
    expect(THEME_TOKENS.dark).toMatchObject({ up: '#26a69a', down: '#ef5350' });
    expect(THEME_TOKENS.light).toMatchObject({ up: '#089981', down: '#f23645' });
    expect(THEME_CSS_VARS).toMatchObject({ up: '--up', down: '--down' });
    for (const theme of ['dark', 'light'] as const) {
      const { up, down } = THEME_TOKENS[theme];
      expect(defaultAppearance(theme)).toMatchObject({ upColor: up, downColor: down });
      expect(chartStyles(theme).candle?.bar).toMatchObject({ upColor: up, downColor: down, upWickColor: up, downBorderColor: down });
      expect(chartStyles(theme).candle?.priceMark?.last).toMatchObject({ upColor: up, downColor: down });
      expect(candleStyles('candle', theme, undefined).bar).toMatchObject({ upColor: up, downColor: down });
      expect(candleStyles('candle', theme, undefined).priceMark?.last).toMatchObject({ upColor: up, downColor: down });
    }
  });
});

describe('indicator histogram bar defaults follow the theme up / down colours', () => {
  it('defaultBarColors(theme) and the chart-level indicator bar styles', () => {
    expect(defaultBarColors('dark')).toEqual({ up: '#26a69a', down: '#ef5350' });
    expect(defaultBarColors('light')).toEqual({ up: '#089981', down: '#f23645' });
    for (const theme of ['dark', 'light'] as const) {
      const { up, down } = defaultBarColors(theme);
      // Same translucency as KLineChart's own default bars.
      expect(chartStyles(theme).indicator?.bars).toEqual([{ upColor: hexToRgba(up, 0.7), downColor: hexToRgba(down, 0.7) }]);
    }
  });
});

describe('candleStyles', () => {
  it('maps up/down colours onto bodies, borders, wicks and the last-price mark', () => {
    const s = candleStyles('candle', 'dark', { dark: { upColor: '#00ff00', downColor: '#ff00ff' } });
    expect(s.type).toBe('candle_solid');
    expect(s.bar).toMatchObject({
      upColor: '#00ff00', upBorderColor: '#00ff00', upWickColor: '#00ff00',
      downColor: '#ff00ff', downBorderColor: '#ff00ff', downWickColor: '#ff00ff',
    });
    expect(s.priceMark?.last).toMatchObject({ upColor: '#00ff00', downColor: '#ff00ff' });
  });

  it('maps the body style for candles; OHLC bars keep type ohlc but take the colours', () => {
    expect(candleStyles('candle', 'dark', { dark: { candleBody: 'hollow' } }).type).toBe('candle_stroke');
    expect(candleStyles('candle', 'dark', { dark: { candleBody: 'hollow_up' } }).type).toBe('candle_up_stroke');
    expect(candleStyles('candle', 'dark', { dark: { candleBody: 'hollow_down' } }).type).toBe('candle_down_stroke');
    const ohlc = candleStyles('ohlc', 'light', { light: { candleBody: 'hollow', upColor: '#010203' } });
    expect(ohlc.type).toBe('ohlc');
    expect(ohlc.bar?.upColor).toBe('#010203');
  });

  it('line/area use the appearance line colour and width; defaults follow the theme accent', () => {
    const line = candleStyles('line', 'dark', { dark: { lineColor: '#ff8800', lineWidth: 3 } });
    expect(line.type).toBe('area');
    expect(line.area).toMatchObject({ lineColor: '#ff8800', lineSize: 3 });
    const area = candleStyles('area', 'light', { light: { lineColor: '#ff8800' } });
    expect(area.area?.backgroundColor).toEqual([
      { offset: 0, color: 'rgba(255,136,0,0.02)' }, { offset: 1, color: 'rgba(255,136,0,0.28)' },
    ]);
    expect(candleStyles('line', 'light', undefined).area).toMatchObject({ lineColor: THEME_TOKENS.light.accent, lineSize: 2 });
  });
});

describe('readable label text', () => {
  const lastText = (theme: 'dark' | 'light', a: Parameters<typeof candleStyles>[2]) => candleStyles('candle', theme, a).priceMark?.last?.text?.color;

  it('the last price label text stays readable on a white up colour, in both themes', () => {
    // The reported layout: white up, pink down (white text on the white label was invisible).
    const user = { upColor: '#ffffff', downColor: '#e63b7a' };
    for (const theme of ['dark', 'light'] as const) {
      const text = lastText(theme, { [theme]: user });
      expect(text).toBe(DARK_TEXT);
      for (const bg of [user.upColor, user.downColor]) expect(contrastRatio(text!, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('the default last price label keeps white text in both themes (TradingView-style)', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(lastText(theme, undefined)).toBe(LIGHT_TEXT);
      expect(chartStyles(theme).candle?.priceMark?.last?.text?.color).toBe(LIGHT_TEXT);
    }
  });

  it('the last price label text is light on dark label colours', () => {
    expect(lastText('dark', { dark: { upColor: '#000000', downColor: '#1a237e' } })).toBe(LIGHT_TEXT);
  });

  it('the default overlay text (annotation bubble = drawing colour) is readable', () => {
    expect(overlayStyles({ color: '#ffffff', size: 1, style: 'solid' }).text).toMatchObject({ color: DARK_TEXT, backgroundColor: '#ffffff' });
    expect(overlayStyles({ color: '#2962ff', size: 1, style: 'solid' }).text).toMatchObject({ color: LIGHT_TEXT });
  });

  it('per-drawing annotation styles carry a readable text colour', () => {
    expect(textToOverlay({ color: '#ffffff', size: 14 }).text).toMatchObject({ color: DARK_TEXT, backgroundColor: '#ffffff', size: 14 });
    expect(textToOverlay({ color: '#000000', size: 14 }).text).toMatchObject({ color: LIGHT_TEXT });
  });

  it('crosshair labels and Start/version markers are readable in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const t = THEME_TOKENS[theme];
      const cross = chartStyles(theme).crosshair!.horizontal!.text!;
      expect(contrastRatio(cross.color!, t.crossBg)).toBeGreaterThanOrEqual(4.5);
      expect(chartStyles(theme).crosshair!.vertical!.text!.color).toBe(cross.color);
      // Markers draw muted text on a transparent background: it has to read on the chart background.
      const m = markerStyles(theme).text!;
      expect(m.backgroundColor).toBe('rgba(0,0,0,0)');
      expect(contrastRatio(m.color!, t.bg)).toBeGreaterThanOrEqual(3);
      expect(m.color).toBe(t.muted); // muted is kept while it reads
      expect(cross.color).toBe(LIGHT_TEXT);
    }
  });

  it('marker text falls back to white / dark when the muted colour would not read on the background', () => {
    const root = document.documentElement;
    root.dataset['theme'] = 'dark';
    root.style.setProperty('--text-muted', '#1a1e2a');
    try {
      refreshThemeTokens('dark');
      expect(markerStyles('dark').text?.color).toBe(LIGHT_TEXT);
    } finally {
      root.style.removeProperty('--text-muted');
      delete root.dataset['theme'];
      refreshThemeTokens('dark');
    }
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
