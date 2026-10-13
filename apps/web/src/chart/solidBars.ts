import type { IndicatorFigure } from 'klinecharts';

const wrapped = new WeakSet<object>();

/** Opacity factor of the softer tone that replaces KLineChart's outline-only histogram bars. */
export const SOFT_BAR_ALPHA = 0.45;

/**
 * `color` in a softer tone of the same hue: its opacity times SOFT_BAR_ALPHA ('#rgb', '#rrggbb', 'rgb()' or
 * 'rgba()'; any other value is returned unchanged).
 */
export function softerTone(color: unknown): unknown {
  if (typeof color !== 'string') return color;
  let hex = /^#[0-9a-fA-F]{6}$/.test(color) ? color.slice(1) : null;
  if (!hex && /^#[0-9a-fA-F]{3}$/.test(color)) hex = [...color.slice(1)].map((c) => c + c).join('');
  if (hex) {
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${SOFT_BAR_ALPHA})`;
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (!m) return color;
  const a = m[4] === undefined ? 1 : Math.min(1, Number(m[4]));
  return `rgba(${m[1]},${m[2]},${m[3]},${Number((a * SOFT_BAR_ALPHA).toFixed(3))})`;
}

/**
 * Indicator figures with every histogram bar drawn filled. KLineChart's MACD and AO templates draw a bar as an
 * outline ('stroke') when it rises versus the previous one; here those bars are filled in a softer tone of their
 * template color (up / down / no-change), the others keep the full color. Returns null when nothing changes (no bar
 * figure with a style callback, or already wrapped).
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
      if (s?.style !== 'stroke') return s;
      const soft = softerTone(s.color) as string;
      return { ...s, style: 'fill', color: soft, borderColor: soft };
    };
    wrapped.add(solid);
    return { ...f, styles: solid };
  });
  return changed ? out : null;
}
