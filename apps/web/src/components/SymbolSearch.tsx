import type { SymbolId, SymbolInfo } from '@altv/shared';
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api/client';

const DEBOUNCE_MS = 200;

export interface SymbolSearchProps {
  onSelect: (id: SymbolId) => void;
  placeholder?: string;
  /** Keeps only matching results (e.g. stock/crypto for basket constituents). Default: keep all. */
  filter?: (s: SymbolInfo) => boolean;
  /** Accessible label of the input. Default: "Search symbol". */
  ariaLabel?: string;
  disabled?: boolean;
}

interface State {
  /** Results of the last completed search; kept on screen while the next one loads. Null = none yet. */
  items: SymbolInfo[] | null;
  loading: boolean;
  error: string | null;
}

const IDLE: State = { items: null, loading: false, error: null };

/** Debounced symbol search combobox (stocks, crypto and baskets). */
export function SymbolSearch({ onSelect, placeholder = 'Search symbol…', filter, ariaLabel = 'Search symbol', disabled }: SymbolSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>(IDLE);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setState(IDLE);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setState((s) => ({ ...s, loading: true }));
      api.search(q, ctl.signal).then(
        (items) => {
          if (ctl.signal.aborted) return;
          setState({ items, loading: false, error: null });
          setActive(-1);
        },
        (err: unknown) => {
          if (ctl.signal.aborted) return;
          setState({ items: null, loading: false, error: errorMessage(err) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query]);

  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

  const items = state.items ? (filter ? state.items.filter(filter) : state.items) : [];
  const expanded = open && (state.loading || state.items !== null || state.error !== null);
  const listShown = expanded && items.length > 0;

  function choose(item: SymbolInfo) {
    onSelect(item.id);
    setQuery('');
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (items.length > 0) setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      const item = items[active] ?? items[0];
      if (expanded && item) {
        e.preventDefault();
        choose(item);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className="symbol-search">
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listShown ? listId : undefined}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={placeholder}
        disabled={disabled}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
          setOpen(true);
        }}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
      />
      {expanded && (
        <div className="search-dropdown">
          {state.loading && (
            <div className={`search-status${listShown ? ' search-status-subtle' : ''}`} aria-live="polite">Searching…</div>
          )}
          {state.error !== null && !state.loading && <div className="search-status error" role="alert">{state.error}</div>}
          {state.items !== null && !state.loading && items.length === 0 && <div className="search-status">No results</div>}
          {listShown && (
            <ul role="listbox" id={listId} aria-label="Search results" aria-busy={state.loading}
              className={state.loading ? 'search-results-stale' : undefined}>
              {items.map((item, i) => (
                <li
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'active' : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                >
                  <span className="search-ticker">{item.ticker}</span>
                  <span className="search-name">{item.name}</span>
                  <span className={`badge badge-${item.assetClass}`}>{item.assetClass.toUpperCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
