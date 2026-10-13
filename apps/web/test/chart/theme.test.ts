import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { oklch, parseColor, softTone } from '../../src/chart/color';
import { contrastRatio, DARK_TEXT, LIGHT_TEXT } from '../../src/chart/contrast';
import { textToOverlay } from '../../src/chart/drawingStyles';
import { markerStyles } from '../../src/chart/markers';
import {
  candleStyles, CHART_FONT, chartStyles, defaultAppearance, defaultBarColors, defaultIndicatorBars, hexToRgba, indicatorLevelColor, overlayStyles, themeSoftTone, refreshThemeTokens, resolveAppearance, THEME_CSS_VARS, THEME_TOKENS, themeTokens,
} from '../../src/chart/theme';

describe('resolveAppearance', () => {
  it('fills unset fields with theme defaults', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(resolveAppearance(theme, undefined)).toEqual({
        upColor: THEME_TOKENS[theme].up, downColor: THEME_TOKENS[theme].down, candleBody: 'solid', lineColor: THEME_TOKENS[theme].accent, lineWidth: 2,
        drawing: { color: THEME_TOKENS[theme].accent, size: 1, style: 'solid' }, lastPriceLine: 'neutral',
      });
    }
    expect(resolveAppearance('dark', { dark: { upColor: '#00ff00', lineWidth: 4 } })).toMatchObject({ upColor: '#00ff00', downColor: '#ff4d73', lineWidth: 4 });
  });

  it('picks the active theme\'s settings; the other theme keeps its defaults', () => {
    const a = { dark: { upColor: '#ffffff' }, light: { downColor: '#000000' } };
    expect(resolveAppearance('dark', a)).toMatchObject({ upColor: '#ffffff', downColor: '#ff4d73' });
    expect(resolveAppearance('light', a)).toMatchObject({ upColor: '#12b996', downColor: '#000000' });
    expect(resolveAppearance('light', { dark: { upColor: '#ffffff' } })).toEqual(resolveAppearance('light', undefined));
  });
});

describe('per-theme default candle colors (match the --up / --down CSS tokens)', () => {
  it('dark #34e0b8 / #ff4d73, light #12b996 / #d92855', () => {
    expect(THEME_TOKENS.dark).toMatchObject({ up: '#34e0b8', down: '#ff4d73' });
    expect(THEME_TOKENS.light).toMatchObject({ up: '#12b996', down: '#d92855' });
    expect(THEME_CSS_VARS).toMatchObject({ up: '--up', down: '--down' });
    for (const theme of ['dark', 'light'] as const) {
      const { up, down } = THEME_TOKENS[theme];
      expect(defaultAppearance(theme)).toMatchObject({ upColor: up, downColor: down });
      expect(chartStyles(theme).candle?.bar).toMatchObject({ upColor: up, downColor: down, upWickColor: up, downBorderColor: down });
      expect(candleStyles('candle', theme, undefined).bar).toMatchObject({ upColor: up, downColor: down });
      // The last price mark is neutral by default; 'candle' follows the up / down colors.
      expect(candleStyles('candle', theme, { [theme]: { lastPriceLine: 'candle' } }).priceMark?.last).toMatchObject({ upColor: up, downColor: down });
    }
  });
});

describe('indicator histogram bar defaults follow the theme up / down colors', () => {
  it('defaultBarColors(theme) and the chart-level indicator bar styles', () => {
    expect(defaultBarColors('dark')).toEqual({ up: '#34e0b8', down: '#ff4d73' });
    expect(defaultBarColors('light')).toEqual({ up: '#12b996', down: '#d92855' });
    for (const theme of ['dark', 'light'] as const) {
      const { up, down } = defaultBarColors(theme);
      // Opaque: exactly the candle colors (an rgba() of them reads pink on white / brown on dark).
      expect(chartStyles(theme).indicator?.bars).toEqual([{ style: 'fill', borderSize: 0, upColor: up, downColor: down, noChangeColor: THEME_TOKENS[theme].muted }]);
      expect(chartStyles(theme).candle?.bar).toMatchObject({ upColor: up, downColor: down });
    }
  });

  it('follow the resolved custom candle colors of the active theme when set (soft tones derive from them)', () => {
    const appearance = { dark: { upColor: '#3366ff', downColor: '#ffaa00' } };
    expect(defaultBarColors('dark', appearance)).toEqual({ up: '#3366ff', down: '#ffaa00' });
    // Another theme's custom colors never leak: light keeps its own defaults.
    expect(defaultBarColors('light', appearance)).toEqual(defaultBarColors('light'));
    expect(defaultIndicatorBars('dark', appearance)).toEqual({ upColor: '#3366ff', downColor: '#ffaa00', noChangeColor: THEME_TOKENS.dark.muted });
    expect(themeSoftTone('dark', '#3366ff')).not.toBe('#3366ff');
  });
});

describe('candleStyles', () => {
  it('maps up/down colors onto bodies, borders, wicks and the last-price mark', () => {
    const s = candleStyles('candle', 'dark', { dark: { upColor: '#00ff00', downColor: '#ff00ff' } });
    expect(s.type).toBe('candle_solid');
    expect(s.bar).toMatchObject({
      upColor: '#00ff00', upBorderColor: '#00ff00', upWickColor: '#00ff00',
      downColor: '#ff00ff', downBorderColor: '#ff00ff', downWickColor: '#ff00ff',
    });
    expect(s.priceMark?.last).toMatchObject({ upColor: THEME_TOKENS.dark.lastPrice, downColor: THEME_TOKENS.dark.lastPrice });
    const c = candleStyles('candle', 'dark', { dark: { upColor: '#00ff00', downColor: '#ff00ff', lastPriceLine: 'candle' } });
    expect(c.priceMark?.last).toMatchObject({ upColor: '#00ff00', downColor: '#ff00ff' });
  });

  it('maps the body style for candles; OHLC bars keep type ohlc but take the colors', () => {
    expect(candleStyles('candle', 'dark', { dark: { candleBody: 'hollow' } }).type).toBe('candle_stroke');
    expect(candleStyles('candle', 'dark', { dark: { candleBody: 'hollow_up' } }).type).toBe('candle_up_stroke');
    expect(candleStyles('candle', 'dark', { dark: { candleBody: 'hollow_down' } }).type).toBe('candle_down_stroke');
    const ohlc = candleStyles('ohlc', 'light', { light: { candleBody: 'hollow', upColor: '#010203' } });
    expect(ohlc.type).toBe('ohlc');
    expect(ohlc.bar?.upColor).toBe('#010203');
  });

  it('line/area use the appearance line color and width; defaults follow the theme accent', () => {
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

describe('market color family (one source of truth per theme)', () => {
  it('soft tones are the opaque softTone() of the strong colors on the chart background', () => {
    for (const theme of ['dark', 'light'] as const) {
      const t = THEME_TOKENS[theme];
      expect(t.upSoft).toBe(softTone(t.up, t.bg));
      expect(t.downSoft).toBe(softTone(t.down, t.bg));
      expect(themeSoftTone(theme, t.down)).toBe(t.downSoft);
      // A user's custom color gets its soft tone the same way.
      expect(themeSoftTone(theme, '#123abc')).toBe(softTone('#123abc', t.bg));
    }
  });

  it('text tones reach 4.5:1 on every surface they sit on (incl. a tinted pill on the selected row) and keep the hue', () => {
    const over = (fg: string, a: number, bg: string) => {
      const f = parseColor(fg)!.rgb;
      const b = parseColor(bg)!.rgb;
      return `#${f.map((v, i) => Math.round(v * a + b[i]! * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
    };
    const tints = { dark: { tint: 0.13, selected: '#131a28', raised: '#10131d' }, light: { tint: 0.12, selected: '#e9eff8', raised: '#f4f5f9' } } as const;
    for (const theme of ['dark', 'light'] as const) {
      const t = THEME_TOKENS[theme];
      const { tint, selected, raised } = tints[theme];
      const surfaces = [t.bg, t.panel, t.elevated, selected, raised];
      for (const [fg, strong] of [[t.upFg, t.up], [t.downFg, t.down]] as const) {
        for (const s of [...surfaces, over(strong, tint, t.panel), over(strong, tint, selected), over(strong, tint, raised)]) {
          expect(contrastRatio(fg, s), `${theme} ${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
        }
        const dh = Math.abs(((oklch(fg)[2] - oklch(strong)[2] + 540) % 360) - 180);
        expect(dh, `${theme} ${fg} hue`).toBeLessThan(2);
      }
    }
  });

  it('strong up / down stay apart by lightness (color-vision deficiency) on both themes', () => {
    expect(oklch(THEME_TOKENS.dark.up)[0] - oklch(THEME_TOKENS.dark.down)[0]).toBeGreaterThan(0.08);
    expect(oklch(THEME_TOKENS.light.up)[0] - oklch(THEME_TOKENS.light.down)[0]).toBeGreaterThan(0.08);
  });

  it('indicator reference levels use the muted, opaque level token', () => {
    expect(indicatorLevelColor('dark')).toBe(THEME_TOKENS.dark.level);
    expect(indicatorLevelColor('light')).toBe(THEME_TOKENS.light.level);
  });
});

describe('last price line', () => {
  it('the capsule carries a bar-close countdown under the price when asked (joined corners), none by default', () => {
    const plain = candleStyles('candle', 'dark', undefined).priceMark!.last!;
    expect(plain.extendTexts).toEqual([expect.objectContaining({ show: false })]);
    expect(plain.text).toMatchObject({ borderRadius: 6 });
    const withCountdown = candleStyles('candle', 'dark', undefined, true).priceMark!.last!;
    expect(withCountdown.text).toMatchObject({ borderRadius: [6, 6, 0, 0] });
    expect(withCountdown.extendTexts).toEqual([expect.objectContaining({
      show: true, position: 'below_price', updateInterval: 1000, borderRadius: [0, 0, 6, 6], color: withCountdown.text!.color, family: CHART_FONT,
    })]);
  });

  it('is neutral by default: the primary text color of the theme, with contrasting label text', () => {
    const lamp = THEME_TOKENS.dark.text;
    for (const s of [chartStyles('dark').candle?.priceMark?.last, candleStyles('candle', 'dark', undefined).priceMark?.last]) {
      expect(s).toMatchObject({ upColor: lamp, downColor: lamp, noChangeColor: lamp, text: { color: DARK_TEXT } });
      expect(THEME_TOKENS.dark.lastPrice).toBe(lamp);
    }
    const ink = THEME_TOKENS.light.text;
    for (const s of [chartStyles('light').candle?.priceMark?.last, candleStyles('candle', 'light', undefined).priceMark?.last]) {
      expect(s).toMatchObject({ upColor: ink, downColor: ink, noChangeColor: ink, text: { color: LIGHT_TEXT } });
      expect(THEME_TOKENS.light.lastPrice).toBe(ink);
    }
    expect(contrastRatio(DARK_TEXT, lamp)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(LIGHT_TEXT, ink)).toBeGreaterThanOrEqual(4.5);
  });

  it('neutral ignores custom candle colors; unknown values fall back to neutral; it is per theme', () => {
    expect(candleStyles('line', 'dark', { dark: { upColor: '#00ff00', lastPriceLine: 'neutral' } }).priceMark?.last?.upColor).toBe(THEME_TOKENS.dark.lastPrice);
    expect(resolveAppearance('dark', { dark: { lastPriceLine: 'bogus' as never } }).lastPriceLine).toBe('neutral');
    expect(resolveAppearance('light', { dark: { lastPriceLine: 'candle' } }).lastPriceLine).toBe('neutral');
    expect(resolveAppearance('dark', { dark: { lastPriceLine: 'candle' } }).lastPriceLine).toBe('candle');
  });
});

describe('readable label text', () => {
  // These cover the 'candle' mode (label fill = up / down color).
  const lastText = (theme: 'dark' | 'light', a: Parameters<typeof candleStyles>[2]) =>
    candleStyles('candle', theme, a && Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { ...v, lastPriceLine: 'candle' }])))
      .priceMark?.last?.text?.color;

  it('the last price label text stays readable on a white up color, in both themes', () => {
    // The reported layout: white up, pink down (white text on the white label was invisible).
    const user = { upColor: '#ffffff', downColor: '#e63b7a' };
    for (const theme of ['dark', 'light'] as const) {
      const text = lastText(theme, { [theme]: user });
      expect(text).toBe(DARK_TEXT);
      for (const bg of [user.upColor, user.downColor]) expect(contrastRatio(text!, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('the default last price label text reads on every label color (dark on the vivid teal / rose and a neutral gray for no change)', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(lastText(theme, { [theme]: {} })).toBe(DARK_TEXT);
      const { up, down, crosshair, muted } = THEME_TOKENS[theme];
      const noChange = candleStyles('candle', theme, { [theme]: { lastPriceLine: 'candle' } }).priceMark?.last?.noChangeColor;
      expect([muted, crosshair]).toContain(noChange);
      for (const bg of [up, down, noChange!]) expect(contrastRatio(DARK_TEXT, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('the last price label text is light on dark label colors', () => {
    expect(lastText('dark', { dark: { upColor: '#000000', downColor: '#1a237e' } })).toBe(LIGHT_TEXT);
  });

  it('the default overlay text (annotation bubble = drawing color) is readable', () => {
    expect(overlayStyles({ color: '#ffffff', size: 1, style: 'solid' }).text).toMatchObject({ color: DARK_TEXT, backgroundColor: '#ffffff' });
    expect(overlayStyles({ color: '#2b66ff', size: 1, style: 'solid' }).text).toMatchObject({ color: LIGHT_TEXT });
  });

  it('per-drawing annotation styles carry a readable text color', () => {
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
      // Ink chips: the label fill is the theme's text color, its text the opposite.
      expect(t.crossBg).toBe(t.text);
      expect(cross.color).toBe(theme === 'dark' ? DARK_TEXT : LIGHT_TEXT);
    }
  });

  it('marker text falls back to white / dark when the muted color would not read on the background', () => {
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

describe('UI token contrast (styles.css)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
  const vars = (selector: string) => {
    const start = css.indexOf(selector);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  it('accent buttons, badges, accent / muted text reach 4.5:1 in both themes', () => {
    for (const sel of [":root[data-theme='dark']", ":root[data-theme='light']"]) {
      const v = vars(sel);
      const check = (fg: string, bg: string) => expect(contrastRatio(v[fg]!, v[bg]!), `${sel} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      check('--accent-text', '--accent');
      check('--accent-text', '--accent-hover');
      for (const b of ['--badge-stock', '--badge-crypto', '--badge-basket']) { check(b, '--bg-elevated'); check(b, '--bg-raised'); }
      for (const t of ['--text-muted', '--accent-fg', '--error']) for (const s of ['--bg', '--bg-panel', '--bg-raised', '--bg-elevated']) check(t, s);
      check('--warn-text', '--warn-bg');
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

  it('falls back to the constants when the variables are missing or not colors', () => {
    root.dataset['theme'] = 'dark';
    root.style.setProperty('--accent', 'not a color');
    refreshThemeTokens('dark');
    expect(themeTokens('dark')).toEqual(THEME_TOKENS.dark);
  });

  it('every chart token has a CSS custom property', () => {
    expect(Object.keys(THEME_CSS_VARS).sort()).toEqual(Object.keys(THEME_TOKENS.dark).sort());
    expect(Object.keys(THEME_TOKENS.light).sort()).toEqual(Object.keys(THEME_TOKENS.dark).sort());
  });

  it('the chart canvas typeface is the UI one (--font-sans)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(/--font-sans:\s*([^;]+);/.exec(css)?.[1]?.trim()).toBe(CHART_FONT);
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
