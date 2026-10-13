import { MAX_INDICATOR_LEVEL, MAX_INDICATOR_LEVELS } from '@chartmate/shared';
import type { IndicatorDrawCallback, IndicatorDrawParams } from 'klinecharts';

/** Dash pattern of reference levels (px on, px off). */
export const LEVEL_DASH = [4, 4];

/**
 * KLineChart `draw` callback that strokes `levels` as thin dashed horizontal lines across the pane, then runs the
 * template's own `draw` (if any). It returns that callback's result, else false, so KLineChart still draws the
 * indicator's figures on top: the levels sit behind the lines and stay out of the tooltip / legend. Levels
 * outside the pane's visible value range are skipped. `color` is read on every draw, so a theme toggle (which
 * re-renders the chart) recolors the levels without touching the indicator.
 */
export function levelsDraw<D, C, E>(
  levels: readonly number[], color: () => string, inner?: IndicatorDrawCallback<D, C, E> | null,
): IndicatorDrawCallback<D, C, E> {
  return (params: IndicatorDrawParams<D, C, E>) => {
    const { ctx, bounding, yAxis } = params;
    if (levels.length > 0) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = color();
      ctx.setLineDash(LEVEL_DASH);
      ctx.beginPath();
      for (const v of levels) {
        const y = yAxis.convertToPixel(v);
        if (!Number.isFinite(y) || y < 0 || y > bounding.height) continue;
        const py = Math.floor(y) + 0.5; // crisp 1px line
        ctx.moveTo(0, py);
        ctx.lineTo(bounding.width, py);
      }
      ctx.stroke();
      ctx.restore();
    }
    return inner ? inner(params) : false;
  };
}

/**
 * The y-axis range bounds that keep `levels` visible (KLineChart's `minValue` / `maxValue` only widen the
 * auto-range, like a TradingView `hline`): RSI's pane then always shows 30-70, MACD's always its zero line.
 * Null bounds (no levels) restore plain auto-ranging.
 */
export function levelsRange(levels: readonly number[]): { minValue: number | null; maxValue: number | null } {
  if (levels.length === 0) return { minValue: null, maxValue: null };
  return { minValue: Math.min(...levels), maxValue: Math.max(...levels) };
}

/** Levels as the settings dialog shows them: `70, 30`. */
export function formatLevels(levels: readonly number[]): string {
  return levels.join(', ');
}

/**
 * Parses the settings dialog's levels text (numbers separated by commas or spaces; empty = no levels). Returns
 * the levels, or an error message for a non-number, an out-of-range value or more than MAX_INDICATOR_LEVELS values.
 */
export function parseLevels(raw: string): { levels: number[] } | { error: string } {
  const levels = raw.split(/[\s,;]+/).filter((p) => p !== '').map(Number);
  if (levels.some((v) => !Number.isFinite(v))) return { error: 'Enter numbers separated by commas' };
  if (levels.some((v) => Math.abs(v) > MAX_INDICATOR_LEVEL)) return { error: `Must be between -${MAX_INDICATOR_LEVEL} and ${MAX_INDICATOR_LEVEL}` };
  if (levels.length > MAX_INDICATOR_LEVELS) return { error: `At most ${MAX_INDICATOR_LEVELS} levels` };
  return { levels };
}
