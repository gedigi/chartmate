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

  it('the color-literal scanner catches hex / functional / named colors in strings and skips comments only', () => {
    expect(colorLiterals(`const a = '#fff'; const b = "1px solid #1A2b3C"; const c = \`#12345678\`;`)).toEqual(['#fff', '#1A2b3C', '#12345678']);
    expect(colorLiterals(`x('rgba(1,2,3,0.5)'); y("hsl(120 50% 50%)"); z('HSLA(1, 2%, 3%, .4)'); w('oklch(0.7 0.1 200)')`))
      .toEqual(['rgba(', 'hsl(', 'HSLA(', 'oklch(']);
    expect(colorLiterals(`const n = 'red'; const m = "Gray"; const t = \`stroke \${w} white\`;`)).toEqual(['red', 'Gray', 'white']);
    // Not colors: identifiers, words inside other words, a '#' that is not a hex color.
    expect(colorLiterals(`const red = 1; s('Bull and Bear Index'); s('reduce'); s('#1 pick'); s('#zzz')`)).toEqual([]);
    // Comments are skipped (line and block, including '*' lines inside a block), but a line starting with '*' outside a
    // block comment (a multiplication continuing an expression) is still scanned.
    expect(colorLiterals(`// '#fff'\n/* 'red'\n * '#000'\n */ const k = 2\n  * Number('3') + f('#abc')`)).toEqual(['#abc']);
    // Comment markers inside strings do not start a comment.
    expect(colorLiterals(`s('// not a comment #123456')`)).toEqual(['#123456']);
  });

  it('no hardcoded colors in indicator code (src/chart/indicators/**)', () => {
    const root = resolve(__dirname, '../../src/chart/indicators');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
    const offenders = files(root).flatMap((f) => colorLiterals(readFileSync(f, 'utf8')).map((c) => `${f.slice(root.length + 1)}: ${c}`));
    expect(offenders).toEqual([]);
  });
});

const NAMED_COLORS = [
  'red', 'green', 'blue', 'white', 'black', 'gray', 'grey', 'orange', 'purple', 'lime', 'yellow', 'pink', 'cyan', 'magenta',
  'aqua', 'fuchsia', 'navy', 'teal', 'maroon', 'olive', 'silver', 'gold', 'brown', 'violet', 'indigo', 'crimson', 'coral',
];
const COLOR_IN_STRING = new RegExp(
  [
    String.raw`(?<![\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])`,
    String.raw`\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(`,
    String.raw`\b(?:${NAMED_COLORS.join('|')})\b`,
  ].join('|'),
  'gi',
);

/**
 * Color literals inside the string / template literals of TypeScript `source` (comments skipped): '#rgb[a]' /
 * '#rrggbb[aa]' anywhere in a string, CSS color functions (rgb / rgba / hsl / hsla / hwb / lab / lch / oklab / oklch,
 * reported as the function name and paren) and common named colors as whole words.
 */
function colorLiterals(source: string): string[] {
  const strings: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
        text += source[j];
        j++;
      }
      strings.push(text);
      i = j + 1;
    } else {
      i++;
    }
  }
  return strings.flatMap((s) => [...s.matchAll(COLOR_IN_STRING)].map((m) => m[0]));
}
