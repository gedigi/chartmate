import { CORPORATE_EVENT_KINDS, MAX_INDICATORS, type CorporateEventKind, type Layout } from '@chartmate/shared';
import { useState, type JSX } from 'react';
import { IndicatorPicker } from './IndicatorPicker';

export interface IndicatorButtonProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  disabled?: boolean;
  /** Phone width: the icon only (the name stays its accessible label). */
  iconOnly?: boolean;
}

/** TopBar "Indicators" button: opens the indicator picker; picked indicators are appended to the layout
 * (never beyond MAX_INDICATORS, which the server's layout schema enforces). */
export function IndicatorButton({ layout, setLayout, disabled, iconOnly }: IndicatorButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={iconOnly ? 'icon-button indicators-button-icon' : 'indicators-button'} aria-haspopup="dialog"
        aria-expanded={open} aria-label={iconOnly ? 'Indicators' : undefined} disabled={disabled} onClick={() => setOpen(true)}>
        <svg width={iconOnly ? 18 : 15} height={iconOnly ? 18 : 15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M1.5 11.5c2-5 3.5-7 5-7s2 4 3.5 4 2.5-3 4.5-6" />
        </svg>
        {!iconOnly && 'Indicators'}
      </button>
      {open && (
        <IndicatorPicker
          count={layout.indicators.length}
          onAdd={(s) => setLayout((l) => (l.indicators.length >= MAX_INDICATORS ? l : { ...l, indicators: [...l.indicators, s] }))}
          onClose={() => setOpen(false)}
          hiddenEvents={layout.hiddenEvents}
          onToggleEvent={(kind) => setLayout((l) => withEventToggled(l, kind))}
        />
      )}
    </>
  );
}

/** `l` with `kind` shown if it was hidden, hidden if it was shown (kinds kept in their canonical order; none hidden: no field). */
function withEventToggled(l: Layout, kind: CorporateEventKind): Layout {
  const hidden = new Set(l.hiddenEvents ?? []);
  if (hidden.has(kind)) hidden.delete(kind);
  else hidden.add(kind);
  const { hiddenEvents: _old, ...rest } = l;
  return hidden.size > 0 ? { ...rest, hiddenEvents: CORPORATE_EVENT_KINDS.filter((k) => hidden.has(k)) } : rest;
}
