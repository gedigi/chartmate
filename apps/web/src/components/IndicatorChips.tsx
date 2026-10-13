import type { IndicatorState, Layout } from '@chartmate/shared';
import { useState, type JSX } from 'react';
import { catalogEntry, indicatorLabel } from '../chart/indicators/catalog';
import type { ThemeName } from '../chart/theme';
import { IndicatorSettings } from './IndicatorSettings';
import './Indicators.css';

export interface IndicatorChipsProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  /** Active theme (indicator settings show its default bar colors). */
  theme?: ThemeName;
}

const svg = { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true } as const;

const EyeIcon = ({ open }: { open: boolean }) => (
  <svg {...svg}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
    {!open && <path d="M2.5 13.5l11-11" />}
  </svg>
);

const GearIcon = () => (
  <svg {...svg}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);

const chipTitle = (name: string) => {
  const e = catalogEntry(name);
  return e ? (e.description ? `${e.label} — ${e.description}` : e.label) : name;
};

/**
 * Active-indicator chips: a wrapping strip above the chart canvas (no space when empty) — label(params) with
 * show/hide, settings and remove buttons.
 */
export function IndicatorChips({ layout, setLayout, theme = 'dark' }: IndicatorChipsProps): JSX.Element | null {
  const [editing, setEditing] = useState<{ index: number; state: IndicatorState } | null>(null);
  const { indicators } = layout;

  /** Updates indicator `index` only if it is still the one the action was taken on. */
  const update = (index: number, expected: IndicatorState, fn: (s: IndicatorState) => IndicatorState | null) =>
    setLayout((l) => {
      const cur = l.indicators[index];
      if (!cur || cur.name !== expected.name || cur.pane !== expected.pane) return l;
      const next = fn(cur);
      return { ...l, indicators: next ? l.indicators.map((s, j) => (j === index ? next : s)) : l.indicators.filter((_, j) => j !== index) };
    });

  return (
    <>
      {indicators.length > 0 && (
        <ul className="indicator-chips" aria-label="Active indicators">
          {indicators.map((s, i) => {
            const label = indicatorLabel(s);
            return (
              // Index keys match ChartView's index-based indicator diff.
              <li key={i} className={`indicator-chip${s.visible ? '' : ' is-hidden'}`} title={chipTitle(s.name)}>
                <span className="indicator-chip-label">{label}</span>
                <button
                  type="button"
                  className="indicator-chip-button"
                  aria-label={`${s.visible ? 'Hide' : 'Show'} ${label}`}
                  onClick={() => update(i, s, (c) => ({ ...c, visible: !c.visible }))}
                >
                  <EyeIcon open={s.visible} />
                </button>
                <button
                  type="button"
                  className="indicator-chip-button"
                  aria-label={`Settings for ${label}`}
                  onClick={() => setEditing({ index: i, state: s })}
                >
                  <GearIcon />
                </button>
                <button
                  type="button"
                  className="indicator-chip-button indicator-chip-remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => update(i, s, () => null)}
                >×</button>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <IndicatorSettings
          state={editing.state}
          onSave={(next) => update(editing.index, editing.state, () => next)}
          onClose={() => setEditing(null)}
          theme={theme}
        />
      )}
    </>
  );
}
