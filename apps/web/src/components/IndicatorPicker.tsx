import { MAX_INDICATORS, type IndicatorState } from '@altv/shared';
import { useId, useState, type JSX } from 'react';
import { CATALOG, indicatorLabel, type CatalogEntry } from '../chart/indicators/catalog';
import { Modal } from './Modal';
import './Indicators.css';

export interface IndicatorPickerProps {
  onAdd: (s: IndicatorState) => void;
  onClose: () => void;
  /** Indicators already on the layout; at MAX_INDICATORS the options are disabled. */
  count: number;
}

const GROUPS: Array<{ pane: CatalogEntry['pane']; title: string }> = [
  { pane: 'main', title: 'Overlays' },
  { pane: 'sub', title: 'Oscillators' },
];

const matches = (e: CatalogEntry, q: string) => !q || e.name.toLowerCase().includes(q) || e.label.toLowerCase().includes(q);

/** Modal list of the indicator catalog with a search filter. Stays open so several can be added. */
export function IndicatorPicker({ onAdd, onClose, count }: IndicatorPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const idBase = useId();
  const q = query.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({ ...g, items: CATALOG.filter((e) => e.pane === g.pane && matches(e, q)) }));
  const empty = groups.every((g) => g.items.length === 0);
  const full = count >= MAX_INDICATORS;

  const add = (e: CatalogEntry) => {
    if (full) return;
    const s: IndicatorState = { name: e.name, pane: e.pane, calcParams: [...e.defaultParams], visible: true };
    onAdd(s);
    setAdded(`Added ${indicatorLabel(s)}`);
  };

  return (
    <Modal title="Indicators" onClose={onClose} className="indicator-picker">
      <input
        type="search"
        className="indicator-search"
        aria-label="Search indicators"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-autofocus
      />
      {full && (
        <p className="indicator-limit" role="alert">
          Limit reached: a chart can have at most {MAX_INDICATORS} indicators. Remove one to add another.
        </p>
      )}
      <div className="indicator-groups">
        {groups.map((g) => g.items.length > 0 && (
          <section key={g.pane} className="indicator-group">
            <h3 id={`${idBase}-${g.pane}`} className="indicator-group-title">{g.title}</h3>
            <ul aria-labelledby={`${idBase}-${g.pane}`}>
              {g.items.map((e) => (
                <li key={e.name}>
                  <button type="button" className="indicator-option" disabled={full} title={e.description} onClick={() => add(e)}>
                    <span className="indicator-option-name">{e.name}</span>
                    <span className="indicator-option-label">{e.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {empty && <p className="indicator-empty">No indicators match “{query.trim()}”.</p>}
      </div>
      <div className="indicator-picker-status" role="status">{added}</div>
    </Modal>
  );
}
