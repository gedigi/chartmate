import type { SymbolId, SymbolInfo } from '@altv/shared';
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api/client';

const DEBOUNCE_MS = 200;

export interface SymbolSearchProps {
  onSelect: (id: SymbolId) => void;
  placeholder?: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; items: SymbolInfo[] }
  | { kind: 'error'; message: string };

/** Debounced symbol search combobox (stocks, crypto and baskets). */
export function SymbolSearch({ onSelect, placeholder = 'Search symbol…' }: SymbolSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setState({ kind: 'idle' });
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setState({ kind: 'loading' });
      api.search(q, ctl.signal).then(
        (items) => {
          if (ctl.signal.aborted) return;
          setState({ kind: 'results', items });
          setActive(-1);
        },
        (err: unknown) => {
          if (ctl.signal.aborted) return;
          setState({ kind: 'error', message: errorMessage(err) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query]);

  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

  const items = state.kind === 'results' ? state.items : [];
  const expanded = open && state.kind !== 'idle';

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
      const item = items[active] ?? (items.length === 1 ? items[0] : undefined);
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
        aria-label="Search symbol"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        placeholder={placeholder}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
      />
      {expanded && (
        <div className="search-dropdown">
          {state.kind === 'loading' && <div className="search-status">Searching…</div>}
          {state.kind === 'error' && <div className="search-status error" role="alert">{state.message}</div>}
          {state.kind === 'results' && items.length === 0 && <div className="search-status">No results</div>}
          {items.length > 0 && (
            <ul role="listbox" id={listId} aria-label="Search results">
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
