import type { IndicatorCreateTooltipDataSourceCallback, IndicatorStyle, IndicatorTooltipData, TooltipLegend } from 'klinecharts';

/**
 * Tooltip legends of an indicator with histogram bars (VOL, MACD, AO) whose colors are TEXT colors. KLineChart colors
 * a legend with its figure's draw color, so a bar's value would take the bar color — for a falling MACD bar the soft
 * tone, which is too faint to read as small text. This rebuilds the default legends (same titles, values and number
 * formatting, line colors untouched) with the bar colors as text: a bar's up / down color or its soft tone becomes the
 * theme's up / down text tone (`upFg` / `downFg`) when it is the theme's default, else the strong custom color itself.
 * Name, parameters and features are left to KLineChart. `theme()` is read on every call (it follows theme switches).
 */
export interface LegendTheme { up: string; down: string; upFg: string; downFg: string; soften: (color: string) => string }

export function textColoredLegends<D>(theme: () => LegendTheme): IndicatorCreateTooltipDataSourceCallback<D> {
  return ({ chart, indicator, crosshair }) => {
    const defaults = chart.getStyles().indicator as IndicatorStyle;
    const own = (indicator.styles ?? {}) as Partial<IndicatorStyle>;
    const pick = <K extends 'lines' | 'bars' | 'circles' | 'texts'>(k: K): IndicatorStyle[K] =>
      (Array.isArray(own[k]) && own[k]!.length > 0 ? own[k]! : defaults[k]) as IndicatorStyle[K];
    const lines = pick('lines');
    const bars = pick('bars');
    const circles = pick('circles');
    const texts = pick('texts');
    const t = theme();
    const same = (a: string | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
    const toText = (color: string): string => {
      for (const [strong, tone, fg] of [[bars[0]?.upColor, t.up, t.upFg], [bars[0]?.downColor, t.down, t.downFg]] as const) {
        if (typeof strong !== 'string') continue;
        if (same(strong, color) || same(t.soften(strong), color)) return same(strong, tone) ? fg : strong;
      }
      return color;
    };
    const counts = { line: 0, bar: 0, circle: 0, text: 0 };
    const i = crosshair.dataIndex ?? -1;
    const result = indicator.result as Array<Record<string, unknown> | undefined>;
    const data = { prev: result[i - 1], current: result[i], next: result[i + 1] };
    const current = data.current ?? {};
    const fallback = defaults.tooltip.legend.defaultValue;
    const legends: TooltipLegend[] = [];
    for (const figure of indicator.figures) {
      let base: string | undefined;
      switch (figure.type) {
        case 'line': base = lines[counts.line++ % lines.length]?.color; break;
        case 'bar': base = bars[counts.bar++ % bars.length]?.noChangeColor; break;
        case 'circle': base = circles[counts.circle++ % circles.length]?.noChangeColor; break;
        case 'text': base = texts[counts.text++ % texts.length]?.color; break;
        default: break;
      }
      const dynamic = figure.styles?.({ data, indicator, barSpace: chart.getBarSpace(), defaultStyles: defaults } as never);
      if (typeof figure.title !== 'string') continue;
      const color = toText((typeof dynamic?.color === 'string' ? dynamic.color : base) ?? defaults.tooltip.legend.color);
      const raw = current[figure.key];
      let value = typeof raw === 'number' ? raw.toFixed(indicator.precision ?? 2) : fallback; // toFixed = KLineChart's formatPrecision
      if (typeof raw === 'number' && indicator.shouldFormatBigNumber) value = chart.getFormatter().formatBigNumber(value);
      legends.push({ title: { text: figure.title, color }, value: { text: value, color } });
    }
    return { legends } as unknown as IndicatorTooltipData;
  };
}
