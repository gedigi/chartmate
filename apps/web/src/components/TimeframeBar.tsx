import { TIMEFRAMES, type ChartType, type SessionMode, type Timeframe } from '@chartmate/shared';
import type { JSX } from 'react';

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'candle', label: 'Candles' },
  { value: 'ohlc', label: 'Bars' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
];

export interface TimeframeBarProps {
  tf: Timeframe;
  onTf: (tf: Timeframe) => void;
  session: SessionMode;
  onSession: (s: SessionMode) => void;
  /** Only stocks (or baskets containing a stock) have extended hours. */
  showSession: boolean;
  chartType: ChartType;
  onChartType: (t: ChartType) => void;
  disabled?: boolean;
}

export function TimeframeBar(p: TimeframeBarProps): JSX.Element {
  return (
    <div className="timeframe-bar">
      <div className="segmented" role="group" aria-label="Timeframe">
        {TIMEFRAMES.map((tf) => (
          <button key={tf} type="button" aria-pressed={tf === p.tf} disabled={p.disabled} onClick={() => p.onTf(tf)}>{tf}</button>
        ))}
      </div>
      {p.showSession && (
        <div className="segmented" role="group" aria-label="Session">
          {(['rth', 'eth'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={s === p.session} disabled={p.disabled} onClick={() => p.onSession(s)}
              title={s === 'rth' ? 'Regular trading hours' : 'Extended trading hours'}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      <select aria-label="Chart type" disabled={p.disabled} value={p.chartType} onChange={(e) => p.onChartType(e.target.value as ChartType)}>
        {CHART_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
    </div>
  );
}
