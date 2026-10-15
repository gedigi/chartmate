import type { JSX } from 'react';
import { RANGE_PRESETS, RANGE_TITLES, type RangePreset } from '../chart/ranges';

export interface RangeBarProps {
  /** The preset shown (until the user zooms, scrolls or changes the interval or symbol); null when none is. */
  value: RangePreset | null;
  onSelect: (preset: RangePreset) => void;
  disabled?: boolean;
}

/** Date range presets under the chart: each shows that period, ending at the latest bar, at a fitting interval. */
export function RangeBar({ value, onSelect, disabled }: RangeBarProps): JSX.Element {
  return (
    <div className="segmented range-bar" role="group" aria-label="Date range">
      {RANGE_PRESETS.map((p) => (
        <button key={p} type="button" aria-pressed={p === value} disabled={disabled}
          title={`Show ${RANGE_TITLES[p].toLowerCase()}`} onClick={() => onSelect(p)}>{p}</button>
      ))}
    </div>
  );
}
