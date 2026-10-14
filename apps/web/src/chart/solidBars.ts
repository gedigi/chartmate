import type { IndicatorFigure } from 'klinecharts';

const wrapped = new WeakSet<object>();

/**
 * Indicator figures with every histogram bar drawn filled. KLineChart's MACD and AO templates draw a bar as an
 * outline ('stroke') when it rises versus the previous one; here those bars are filled in the soft tone of their
 * template color (up / down / no-change) — `soften(color)`, called at draw time so it follows the active theme (the
 * ChartAdapter passes the OPAQUE theme soft tone, see color.ts softTone) — and the others keep the full color.
 * Returns null when nothing changes (no bar figure with a style callback, or already wrapped).
 */
export function solidBarFigures<D>(
  figures: ReadonlyArray<IndicatorFigure<D>> | undefined, soften: (color: string) => string,
): Array<IndicatorFigure<D>> | null {
  if (!figures) return null;
  let changed = false;
  const out = figures.map((f) => {
    const styles = f.styles;
    if (f.type !== 'bar' || typeof styles !== 'function' || wrapped.has(styles)) return f;
    changed = true;
    const solid: typeof styles = (params) => {
      const s = styles(params);
      if (s?.style !== 'stroke') return s;
      const soft = typeof s.color === 'string' ? soften(s.color) : s.color;
      return { ...s, style: 'fill', color: soft, borderColor: soft };
    };
    wrapped.add(solid);
    return { ...f, styles: solid };
  });
  return changed ? out : null;
}
