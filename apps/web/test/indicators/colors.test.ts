import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compositeOver, softTone } from '../../src/chart/color';
import { contrastRatio } from '../../src/chart/contrast';
import { CATALOG, defaultLineColors } from '../../src/chart/indicators/catalog';
import { activeIndicatorColors, indicatorColorContext, indicatorColors } from '../../src/chart/indicators/colors';
import { chartStyles, defaultIndicatorBars, defaultIndicatorCircles, INDICATOR_PALETTE, THEME_TOKENS } from '../../src/chart/theme';

const THEMES = ['dark', 'light'] as const;

describe('indicatorColors', () => {
  it('resolves the theme tokens: strong, soft and text tones of up / down, neutrals and the palette', () => {
    for (const theme of THEMES) {
      const t = THEME_TOKENS[theme];
      const c = indicatorColors(theme, undefined);
      expect(c).toMatchObject({
        theme, bg: t.bg, text: t.text, muted: t.muted, level: t.level,
        up: t.up, down: t.down, upSoft: t.upSoft, downSoft: t.downSoft, upText: t.upFg, downText: t.downFg,
      });
      expect(c.palette).toEqual(INDICATOR_PALETTE[theme]);
    }
  });

  it('follows the user\'s custom up / down colors: soft tone derived, text tone the custom color while it reads on the chart', () => {
    const c = indicatorColors('dark', { dark: { upColor: '#33aaff', downColor: '#ff8800' } });
    expect(c.up).toBe('#33aaff');
    expect(c.down).toBe('#ff8800');
    expect(c.upSoft).toBe(softTone('#33aaff', THEME_TOKENS.dark.bg));
    expect(c.upText).toBe('#33aaff');
    expect(c.downText).toBe('#ff8800');
    // A custom color too dark for small text on the dark chart falls back to a readable text color.
    const dim = indicatorColors('dark', { dark: { upColor: '#202a30' } });
    expect(contrastRatio(dim.upText, THEME_TOKENS.dark.bg)).toBeGreaterThanOrEqual(3);
  });

  it('activeIndicatorColors reads the context at call time (theme toggle / appearance change)', () => {
    indicatorColorContext.theme = 'light';
    indicatorColorContext.appearance = undefined;
    expect(activeIndicatorColors().up).toBe(THEME_TOKENS.light.up);
    indicatorColorContext.theme = 'dark';
    expect(activeIndicatorColors().up).toBe(THEME_TOKENS.dark.up);
    indicatorColorContext.appearance = { dark: { upColor: '#33aaff' } };
    expect(activeIndicatorColors().up).toBe('#33aaff');
  });

  afterEach(() => {
    indicatorColorContext.theme = 'dark';
    indicatorColorContext.appearance = undefined;
  });
});

describe('compositeOver', () => {
  it('flattens a translucent fill onto the background (opaque input unchanged)', () => {
    expect(compositeOver('rgba(255,255,255,0.5)', '#000000')).toBe('#808080');
    expect(compositeOver('#123456', '#ffffff')).toBe('#123456');
    expect(compositeOver('nope', '#ffffff')).toBe('#ffffff');
  });
});

describe('every indicator default color is in the palette', () => {
  it('lines: each catalog line defaults to an INDICATOR_PALETTE slot of the theme', () => {
    for (const theme of THEMES) {
      for (const e of CATALOG) {
        for (const c of defaultLineColors(e.name, theme)) expect(INDICATOR_PALETTE[theme], `${e.name} ${theme}`).toContain(c);
      }
    }
  });

  it('chart-level indicator styles (bars, SAR circles, OHLC fallback, texts) use theme tokens only', () => {
    for (const theme of THEMES) {
      const t = THEME_TOKENS[theme];
      const ind = chartStyles(theme).indicator!;
      const tokens = new Set<string>(Object.values(t));
      const colors = [
        ...['upColor', 'downColor', 'noChangeColor'].map((k) => (ind.bars![0] as Record<string, string>)[k]),
        ...['upColor', 'downColor', 'noChangeColor'].map((k) => (ind.circles![0] as Record<string, string>)[k]),
        ...['upColor', 'downColor', 'noChangeColor'].map((k) => (ind.ohlc as Record<string, string>)[k]),
        (ind.texts![0] as { color: string }).color,
      ];
      for (const c of colors) expect(tokens.has(c!), `${theme} ${c}`).toBe(true);
    }
  });

  it('SAR circles: the candle up / down colors, the user\'s custom ones included, opaque', () => {
    expect(defaultIndicatorCircles('light')).toEqual({ ...defaultIndicatorBars('light'), style: 'fill', borderSize: 0 });
    expect(defaultIndicatorCircles('dark', { dark: { upColor: '#33aaff' } })).toMatchObject({ upColor: '#33aaff', downColor: THEME_TOKENS.dark.down });
  });

  it('no hardcoded colors in indicator code (src/chart/indicators/**)', () => {
    const root = resolve(__dirname, '../../src/chart/indicators');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
    const offenders: string[] = [];
    for (const f of files(root)) {
      const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      for (const m of code.matchAll(/['"`](#[0-9a-f]{3,8}|rgba?\([^)]*\))['"`]/gi)) offenders.push(`${f.slice(root.length + 1)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});
