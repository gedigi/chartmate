import type { IndicatorFigure } from 'klinecharts';

const wrapped = new WeakSet<object>();

/** The figure's value in a draw-time data row (undefined when missing or not a number). */
function valueOf(row: unknown, key: string): number | undefined {
  const v = row !== null && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Indicator figures with every histogram bar drawn filled (KLineChart's MACD and AO templates draw a bar as an outline
 * when it rises versus the previous one). A bar that FELL versus the previous one — a green bar shrinking, a red bar
 * growing downward — takes the soft tone of its template color (up / down / no-change); a rising, unchanged or first
 * bar keeps the full color, so growing green bars and red bars recovering toward zero are the bright ones.
 * `soften(color)` is called at draw time so it follows the active theme (the ChartAdapter passes the OPAQUE theme soft
 * tone, see color.ts softTone). Returns null when nothing changes (no bar figure with a style callback, or already
 * wrapped).
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
      // Only momentum histograms (their template sets a style: MACD, AO, PPO); volume bars color by candle and stay as is.
      if (!s || s.style === undefined) return s;
      const current = valueOf(params.data?.current, f.key);
      const prev = valueOf(params.data?.prev, f.key);
      // Without both values, read the template's own flag: an outline marks a rising bar.
      const falling = current !== undefined && prev !== undefined ? current < prev : s.style !== 'stroke';
      const color = falling && typeof s.color === 'string' ? soften(s.color) : s.color;
      return { ...s, style: 'fill', color, borderColor: falling ? color : s.borderColor ?? color };
    };
    wrapped.add(solid);
    return { ...f, styles: solid };
  });
  return changed ? out : null;
}
