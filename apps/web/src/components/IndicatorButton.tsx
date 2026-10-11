import { MAX_INDICATORS, type Layout } from '@altv/shared';
import { useState, type JSX } from 'react';
import { IndicatorPicker } from './IndicatorPicker';

export interface IndicatorButtonProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
}

/** TopBar "Indicators" button: opens the indicator picker; picked indicators are appended to the layout
 * (never beyond MAX_INDICATORS, which the server's layout schema enforces). */
export function IndicatorButton({ layout, setLayout }: IndicatorButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>Indicators</button>
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
