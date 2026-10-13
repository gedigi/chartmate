import type { JSX } from 'react';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
}

/**
 * Inline SVG sparkline: a dotted baseline at the first value, the series and a dot on the last value. Renders nothing for
 * fewer than 2 points. Up color if last >= first, else down.
 */
export function Sparkline({ values: raw, width = 80, height = 24 }: SparklineProps): JSX.Element | null {
  const values = raw.filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const pad = 2;
  const step = (width - 2 * pad) / (values.length - 1);
  const y = (v: number) => (range === 0 ? height / 2 : pad + (1 - (v - min) / range) * (height - 2 * pad));
  const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = values[values.length - 1]! >= values[0]!;
  const base = y(values[0]!).toFixed(1);
  const endX = pad + (values.length - 1) * step;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {/* The first value as a dotted baseline: above it the series is up, below it down. */}
      <line className="sparkline-base" x1={pad} x2={width - pad} y1={base} y2={base} />
      <polyline className={up ? 'up' : 'down'} points={points} fill="none" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      <circle className={`sparkline-end ${up ? 'up' : 'down'}`} cx={endX.toFixed(1)} cy={y(values[values.length - 1]!).toFixed(1)} r={1.8} />
    </svg>
  );
}
