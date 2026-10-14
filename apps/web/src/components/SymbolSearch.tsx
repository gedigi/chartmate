import type { SymbolId, SymbolInfo } from '@chartmate/shared';
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api/client';
import { exchangeName } from '../exchanges';
import { hasCommandModifier, isApplePlatform, isInPopup, isModalOpen } from '../keyboard';

const DEBOUNCE_MS = 200;

export interface SymbolSearchProps {
  onSelect: (id: SymbolId) => void;
  placeholder?: string;
  /** Keeps only matching results (e.g. stock/crypto for basket constituents). Default: keep all. */
  filter?: (s: SymbolInfo) => boolean;
  /** Accessible label of the input. Default: "Search symbol". */
  ariaLabel?: string;
  disabled?: boolean;
  /**
   * Cmd+K (Apple platforms) / Ctrl+K (others) focuses this field from anywhere in the page (not behind a modal dialog,
   * not from inside a popup, not when another handler took the key); a key hint shows inside it.
   */
  shortcut?: boolean;
}

interface State {
  /** Results of the last completed search; kept on screen while the next one loads. Null = none yet. */
  items: SymbolInfo[] | null;
  /** Trimmed query the items belong to. */
  forQuery: string;
  loading: boolean;
  error: string | null;
}

const IDLE: State = { items: null, forQuery: '', loading: false, error: null };

/** Debounced symbol search combobox (stocks, crypto and baskets). */
const ASSET_LABEL = { stock: 'Stock', crypto: 'Crypto', basket: 'Basket' } as const;

/** "Apple Inc. · Nasdaq": the name (none when it repeats the ticker, e.g. a basket) and a known exchange's name. */
function searchName(item: SymbolInfo): string {
  const name = item.name === item.ticker ? '' : item.name;
  const exchange = exchangeName(item.exchange);
  return exchange && name ? `${name} · ${exchange}` : name;
}

export function SymbolSearch({ onSelect, placeholder = 'Search symbol…', filter, ariaLabel = 'Search symbol', disabled, shortcut }: SymbolSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>(IDLE);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k' || !hasCommandModifier(e)) return;
      // Not behind a modal dialog, nor from inside a popup (its keys are its own).
      if (isModalOpen() || isInPopup(e.target)) return;
      const input = inputRef.current;
      if (!input || input.disabled) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);

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
          setState({ items, forQuery: q, loading: false, error: null });
          setActive(-1);
        },
        (err: unknown) => {
          if (ctl.signal.aborted) return;
          setState({ items: null, forQuery: q, loading: false, error: errorMessage(err) });
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
      // An explicitly highlighted (visible) result, else the first result — but only if the results are for
      // what is typed now and no newer search is pending (never pick a stale result).
      const current = !state.loading && state.forQuery === query.trim();
      const item = listShown ? (items[active] ?? (current ? items[0] : undefined)) : undefined;
      if (item) {
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
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listShown ? listId : undefined}
        aria-activedescendant={listShown && active >= 0 && active < items.length ? optionId(active) : undefined}
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
      {shortcut && <kbd className="symbol-search-kbd" aria-hidden="true">{isApplePlatform() ? '⌘K' : 'Ctrl K'}</kbd>}
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
                  <span className="search-name">{searchName(item)}</span>
                  <span className={`badge badge-${item.assetClass}`}>{ASSET_LABEL[item.assetClass]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
