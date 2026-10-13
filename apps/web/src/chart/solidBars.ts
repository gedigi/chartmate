import type { IndicatorFigure } from 'klinecharts';

const wrapped = new WeakSet<object>();

/**
 * Indicator figures with every histogram bar drawn filled. KLineChart's MACD and AO templates draw a bar as an
 * outline ('stroke') when it rises versus the previous one; here the color still follows the template (up / down /
 * no-change, rising / falling), only the outline-only style is replaced by a fill. Returns null when nothing
 * changes (no bar figure with a style callback, or already wrapped).
 */
export function solidBarFigures<D>(figures: ReadonlyArray<IndicatorFigure<D>> | undefined): Array<IndicatorFigure<D>> | null {
  if (!figures) return null;
  let changed = false;
  const out = figures.map((f) => {
    const styles = f.styles;
    if (f.type !== 'bar' || typeof styles !== 'function' || wrapped.has(styles)) return f;
    changed = true;
    const solid: typeof styles = (params) => {
      const s = styles(params);
      return s?.style === 'stroke' ? { ...s, style: 'fill' } : s;
    };
    wrapped.add(solid);
    return { ...f, styles: solid };
  });
  return changed ? out : null;
}
