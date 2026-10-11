import type { JSX } from 'react';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
}

/** Inline SVG sparkline. Renders nothing for fewer than 2 points. Green if last >= first, else red. */
export function Sparkline({ values: raw, width = 80, height = 24 }: SparklineProps): JSX.Element | null {
  const values = raw.filter((v) => Number.isFinite(v));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const pad = 2;
  const step = (width - 2 * pad) / (values.length - 1);
  const points = values
    .map((v, i) => {
      const y = range === 0 ? height / 2 : pad + (1 - (v - min) / range) * (height - 2 * pad);
      return `${(pad + i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline className={up ? 'up' : 'down'} points={points} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
