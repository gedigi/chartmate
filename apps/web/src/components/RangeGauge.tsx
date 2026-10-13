import type { JSX } from 'react';
import { rangePosition } from '../state/symbolStats';

export interface RangeGaugeProps {
  value: number;
  low: number;
  high: number;
  /** Colors the marker: up / down / neutral. */
  dir: 'up' | 'down' | '';
  width?: number;
  /** Accessible description, e.g. "30-day range 180.10 – 214.50". */
  label: string;
}

/**
 * A thin engraved track with end ticks and a marker at `value`'s place between `low` and `high` (watchlist rows).
 * Colors come from CSS classes (no inline styles).
 */
export function RangeGauge({ value, low, high, dir, width = 140, label }: RangeGaugeProps): JSX.Element {
  const x = rangePosition(value, low, high) * (width - 3);
  return (
    <svg className="range-gauge" width={width} height={8} viewBox={`0 0 ${width} 8`} role="img" aria-label={label}>
      <line className="rg-track" x1={0} x2={width} y1={4.5} y2={4.5} />
      <line className="rg-track" x1={0.5} x2={0.5} y1={1.5} y2={7.5} />
      <line className="rg-track" x1={width - 0.5} x2={width - 0.5} y1={1.5} y2={7.5} />
      <rect className={`rg-mark ${dir}`} x={x.toFixed(1)} y={0} width={3} height={8} rx={1} />
    </svg>
  );
}

export interface DayRangeGaugeProps { open: number; value: number; low: number; high: number; dir: 'up' | 'down' | '' }

/**
 * The detail panel's day range: a ruled track (minor ticks every 5 %, major every 25 %), the open → now move as a
 * colored segment and a caret at the current price.
 */
export function DayRangeGauge({ open, value, low, high, dir }: DayRangeGaugeProps): JSX.Element {
  const w = 264;
  const xo = rangePosition(open, low, high) * w;
  const xl = Math.min(w - 4, Math.max(4, rangePosition(value, low, high) * w));
  const ticks = Array.from({ length: 21 }, (_, k) => Math.round((k / 20) * (w - 1)) + 0.5);
  return (
    <svg className="day-gauge" viewBox={`0 0 ${w} 15`} aria-hidden="true">
      <line className="rg-track" x1={0} x2={w} y1={7.5} y2={7.5} />
      {ticks.map((x, k) => <line key={k} className="rg-track" x1={x} x2={x} y1={k % 5 ? 5 : 3} y2={7.5} />)}
      <rect className={`dg-move ${dir}`} x={Math.min(xo, xl)} y={6.5} width={Math.abs(xl - xo)} height={2} />
      <path className={`rg-mark ${dir}`} d={`M${xl - 4},15 L${xl},10 L${xl + 4},15Z`} />
      <line className={`dg-needle ${dir}`} x1={xl} x2={xl} y1={1} y2={10} />
    </svg>
  );
}
