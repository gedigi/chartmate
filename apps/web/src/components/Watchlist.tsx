import type { Quote, SymbolId, SymbolInfo } from '@altv/shared';
import { useEffect, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import { useWatchlist } from '../state/useWatchlist';
import { Sparkline } from './Sparkline';
import { SymbolSearch } from './SymbolSearch';
import './Watchlist.css';

export interface WatchlistProps {
  currentSymbol: SymbolId;
  onSelect: (id: SymbolId) => void;
}

const QUOTE_POLL_MS = 15_000;
const SPARK_POLL_MS = 10 * 60_000;

function fmtPrice(price: number, precision: number): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

/** Rounds first so a tiny move never shows "-0.00%"; returns text and direction ('' = neutral). */
function fmtChange(pct: number): { text: string; dir: 'up' | 'down' | '' } {
  const r = Math.round(pct * 100) / 100;
  if (r === 0) return { text: '0.00%', dir: '' };
  return { text: `${r > 0 ? '+' : ''}${r.toFixed(2)}%`, dir: r > 0 ? 'up' : 'down' };
}

function fallbackTicker(id: SymbolId): string {
  return id.slice(id.indexOf(':') + 1);
}

/** Right-sidebar watchlist with live quotes, sparklines, add/remove and reordering. */
export function Watchlist({ currentSymbol, onSelect }: WatchlistProps): JSX.Element {
  const { ids, loaded, error, add, remove, move } = useWatchlist();
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [infos, setInfos] = useState<Record<string, SymbolInfo>>({});
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const requestedInfo = useRef(new Set<string>());
  const focusId = useRef<SymbolId | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const key = ids.join(',');
  const setKey = ids.slice().sort().join(',');

  // Symbol info (names, price precision), cached per id.
  useEffect(() => {
    for (const id of ids) {
      if (requestedInfo.current.has(id)) continue;
      requestedInfo.current.add(id);
      api.symbol(id).then(
        (info) => setInfos((cur) => ({ ...cur, [id]: info })),
        () => { requestedInfo.current.delete(id); },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Quote + sparkline polling. Keyed on the id *set* so reordering does not refetch.
  useEffect(() => {
    if (setKey === '') return;
    const list = setKey.split(',');
    let cancelled = false;
    const pollQuotes = () => {
      if (document.hidden) return;
      api.quotes(list).then(
        (res) => {
          if (cancelled) return;
          setQuotes((cur) => {
            const next = { ...cur };
            for (const q of res) next[q.id] = q;
            return next;
          });
        },
        () => { /* keep previous quotes */ },
      );
    };
    const pollSparks = () => {
      if (document.hidden) return;
      api.sparklines(list).then(
        (map) => { if (!cancelled) setSparks((cur) => ({ ...cur, ...map })); },
        () => { /* keep previous sparklines */ },
      );
    };
    pollQuotes();
    pollSparks();
    const qt = setInterval(pollQuotes, QUOTE_POLL_MS);
    const st = setInterval(pollSparks, SPARK_POLL_MS);
    const onVis = () => { if (!document.hidden) { pollQuotes(); pollSparks(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      clearInterval(qt);
      clearInterval(st);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [setKey]);

  // Restore focus to the moved row after a keyboard reorder.
  useEffect(() => {
    const id = focusId.current;
    if (!id) return;
    focusId.current = null;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-symbol]') ?? []) {
      if (el.dataset['symbol'] === id) el.focus();
    }
  }, [key]);

  function onKeyDown(e: KeyboardEvent<HTMLLIElement>, id: SymbolId, index: number) {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const to = e.key === 'ArrowUp' ? index - 1 : index + 1;
      if (to < 0 || to >= ids.length) return;
      focusId.current = id;
      move(index, to);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    } else if (e.key === 'Delete') {
      focusId.current = ids[index + 1] ?? ids[index - 1] ?? null;
      remove(id);
    }
  }

  function onDrop(e: DragEvent<HTMLLIElement>, index: number) {
    e.preventDefault();
    if (dragFrom !== null) move(dragFrom, index);
    setDragFrom(null);
    setDragOver(null);
  }

  return (
    <section className="watchlist" data-testid="watchlist" aria-label="Watchlist">
      <h2 className="panel-title">Watchlist</h2>
      <SymbolSearch onSelect={add} placeholder="Add symbol…" />
      {error && <div className="watchlist-error" role="alert">{error}</div>}
      <ul className="watchlist-list" ref={listRef}>
        {ids.map((id, i) => {
          const info = infos[id];
          const q = quotes[id];
          const label = info ? (info.assetClass === 'basket' ? info.name : info.ticker) : fallbackTicker(id);
          const chg = q?.changePct == null ? null : fmtChange(q.changePct);
          const classes = ['watchlist-row'];
          if (id === currentSymbol) classes.push('current');
          if (dragFrom === i) classes.push('dragging');
          if (dragOver === i && dragFrom !== null && dragFrom !== i) classes.push('drag-over');
          return (
            <li
              key={id}
              data-symbol={id}
              className={classes.join(' ')}
              tabIndex={0}
              draggable
              aria-current={id === currentSymbol ? 'true' : undefined}
              onClick={() => onSelect(id)}
              onKeyDown={(e) => onKeyDown(e, id, i)}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', id);
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(i); }}
              onDrop={(e) => onDrop(e, i)}
              onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
            >
              <span className="wl-symbol" title={info?.name}>{label}</span>
              <span className="wl-spark"><Sparkline values={sparks[id] ?? []} /></span>
              <span className="wl-quote">
                <span className="wl-price">{q && info ? fmtPrice(q.price, info.pricePrecision) : '—'}</span>
                <span className={`wl-change ${chg?.dir ?? ''}`}>{chg ? chg.text : '—'}</span>
              </span>
              <button
                type="button"
                className="wl-remove"
                aria-label={`Remove ${label}`}
                onClick={(e) => { e.stopPropagation(); remove(id); }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {loaded && ids.length === 0 && <div className="watchlist-empty">No symbols. Search above to add one.</div>}
    </section>
  );
}
