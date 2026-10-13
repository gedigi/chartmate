import { MAX_INDICATORS, type Layout } from '@chartmate/shared';
import { useState, type JSX } from 'react';
import { IndicatorPicker } from './IndicatorPicker';

export interface IndicatorButtonProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  disabled?: boolean;
}

/** TopBar "Indicators" button: opens the indicator picker; picked indicators are appended to the layout
 * (never beyond MAX_INDICATORS, which the server's layout schema enforces). */
export function IndicatorButton({ layout, setLayout, disabled }: IndicatorButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="indicators-button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M1.5 11.5c2-5 3.5-7 5-7s2 4 3.5 4 2.5-3 4.5-6" />
        </svg>
        Indicators
      </button>
      {open && (
        <IndicatorPicker
          count={layout.indicators.length}
          onAdd={(s) => setLayout((l) => (l.indicators.length >= MAX_INDICATORS ? l : { ...l, indicators: [...l.indicators, s] }))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
