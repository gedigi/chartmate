import { MAX_SECTION_TITLE, MAX_WATCHLIST_SECTIONS, type Quote, type QuoteExt, type SymbolId, type SymbolInfo, type WatchlistSection } from '@chartmate/shared';
import { memo, useEffect, useId, useRef, useState, type CSSProperties, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import { api, ApiError, isPermanentError } from '../api/client';
import { publishQuotes } from '../state/quoteStore';
import { retryDelayMs } from '../state/retry';
import { useElementWidth } from '../state/useElementWidth';
import { useWatchlist } from '../state/useWatchlist';
import {
  deleteSection, dropEntry, insertSection, moveByKey, newSectionId, renameSection, setCollapsed, visibleRows, type WatchlistRow,
} from '../state/watchlistModel';
import { RangeGauge } from './RangeGauge';
import { Sparkline } from './Sparkline';
import { SymbolSearch } from './SymbolSearch';
import './Watchlist.css';

export interface WatchlistProps {
  currentSymbol: SymbolId;
  onSelect: (id: SymbolId) => void;
}

const QUOTE_POLL_MS = 15_000;
const SPARK_POLL_MS = 10 * 60_000;
const NEW_SECTION_TITLE = 'New section';
/** Symbol widths (px) of the placeholder rows shown while the list loads. */
const PLACEHOLDER_ROWS = [38, 46, 30, 42];

function fmtPrice(price: number, precision: number): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

/** Rounds first so a tiny move never shows "-0.00%"; returns text and direction ('' = neutral). */
function fmtChange(pct: number): { text: string; dir: 'up' | 'down' | '' } {
  const r = Math.round(pct * 100) / 100;
  if (r === 0) return { text: '0.00%', dir: '' };
  return { text: `${r > 0 ? '+' : ''}${r.toFixed(2)}%`, dir: r > 0 ? 'up' : 'down' };
}

const EXT_LABEL = { pre: 'Pre', post: 'Post' } as const;
const EXT_NAME = { pre: 'Pre-market', post: 'Post-market' } as const;
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** Compact second line for a pre/post-market price: "Pre 231.40 +0.82%" (the change is vs the regular close). */
function ExtLine({ ext, precision }: { ext: QuoteExt; precision: number }): JSX.Element {
  const chg = fmtChange(ext.changePct);
  const name = EXT_NAME[ext.session];
  return (
    <span className="wl-ext" title={`${name} price, ${ET_TIME.format(ext.ts)} ET; change vs the last regular close`}>
      <span className="wl-ext-label" aria-hidden="true">{EXT_LABEL[ext.session]}</span>
      <span className="sr-only">{name}</span>{' '}
      <span className="wl-ext-price">{fmtPrice(ext.price, precision)}</span>{' '}
      <span className={`wl-ext-change ${chg.dir}`}>{chg.text}</span>
    </span>
  );
}

function fallbackTicker(id: SymbolId): string {
  return id.slice(id.indexOf(':') + 1);
}

/** Focus target that survives a re-render: a symbol row or a section header toggle. */
type FocusKey = { kind: 'symbol' | 'section'; id: string };
function rowKey(row: WatchlistRow): FocusKey {
  return { kind: row.entry.type, id: row.entry.id };
}

const SPARK_WIDTH = 52;
const SPARK_MAX_WIDTH = 104;
/** Rail width (px) up to which the sparkline keeps its compact size. */
const SPARK_GROW_FROM = 380;

/**
 * Sparkline width for a rail `railWidth` px wide: compact up to the default width, then growing with a share of the
 * extra room (in 8 px steps, so a live resize rarely re-renders the rows; capped) so a wide rail fills with chart instead of a gap. Narrow rails hide it in CSS.
 */
export function watchlistSparkWidth(railWidth: number): number {
  if (!(railWidth > SPARK_GROW_FROM)) return SPARK_WIDTH;
  const w = SPARK_WIDTH + Math.round(((railWidth - SPARK_GROW_FROM) * 0.3) / 8) * 8;
  return Math.min(SPARK_MAX_WIDTH, w);
}

/**
 * Right-sidebar watchlist with live quotes, sparklines, add/remove, reordering and sections. Sections are header
 * rows in the same ordered list: the symbols below a header belong to it until the next header.
 */
function WatchlistPanel({ currentSymbol, onSelect }: WatchlistProps): JSX.Element {
  const { entries, ids, loaded, error, add, remove, update } = useWatchlist();
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const [infos, setInfos] = useState<Record<string, SymbolInfo>>({});
  /** Baskets whose info load failed with 404: deleted (shown as "Deleted basket", never retried). */
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  /** Entry indexes of the dragged row and the row under the pointer. */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  /** Section new symbols are added to: the last focused header, or the section of the last focused symbol. */
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requestedInfo = useRef(new Set<string>());
  const focusKey = useRef<FocusKey | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [railRef, measuredSpark] = useElementWidth(watchlistSparkWidth);
  const sparkWidth = measuredSpark ?? SPARK_WIDTH;
  const hintId = useId();
  const sectionHintId = useId();
  const headerIdBase = useId();

  const key = ids.join(',');
  const setKey = ids.slice().sort().join(',');
  const rows = visibleRows(entries);
  const sectionCount = entries.length - ids.length;

  // Symbol info (names, price precision), cached per id; failures are retried with backoff, except permanent ones
  // (e.g. 404: a deleted basket or an unknown symbol), which keep the fallback label.
  // Each pending id owns a load chain; canceling it (id removed, or unmount) stops any further retry,
  // including one a request still in flight would otherwise schedule.
  const infoLoads = useRef(new Map<string, { canceled: boolean; timer?: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    const loads = infoLoads.current;
    const current = new Set(key === '' ? [] : key.split(','));
    for (const [id, chain] of loads) {
      if (current.has(id)) continue;
      chain.canceled = true;
      clearTimeout(chain.timer);
      loads.delete(id);
      requestedInfo.current.delete(id); // re-adding the id later starts a fresh chain
    }
    const load = (id: SymbolId, chain: { canceled: boolean; timer?: ReturnType<typeof setTimeout> }, attempt: number) => {
      api.symbol(id).then(
        (info) => {
          if (chain.canceled) return;
          loads.delete(id);
          setInfos((cur) => ({ ...cur, [id]: info }));
        },
        (err: unknown) => {
          if (chain.canceled) return;
          if (isPermanentError(err)) {
            loads.delete(id);
            if (id.startsWith('basket:') && err instanceof ApiError && err.status === 404) setDeleted((cur) => new Set(cur).add(id));
            return;
          }
          chain.timer = setTimeout(() => load(id, chain, attempt + 1), retryDelayMs(attempt));
        },
      );
    };
    for (const id of current) {
      if (requestedInfo.current.has(id)) continue;
      requestedInfo.current.add(id);
      const chain = { canceled: false };
      loads.set(id, chain);
      load(id, chain, 0);
    }
  }, [key]);
  useEffect(() => {
    const loads = infoLoads.current;
    const requested = requestedInfo.current;
    return () => {
      for (const [id, chain] of loads) {
        chain.canceled = true;
        clearTimeout(chain.timer);
        requested.delete(id);
      }
      loads.clear();
    };
  }, []);

  // Quote + sparkline polling (symbols only, headers excluded). Keyed on the id *set* so reordering does not refetch.
  useEffect(() => {
    if (setKey === '') return;
    const list = setKey.split(',');
    let canceled = false;
    const pollQuotes = () => {
      if (document.hidden) return;
      api.quotes(list).then(
        (res) => {
          if (canceled) return;
          publishQuotes(res); // shared with the detail panel
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
        (map) => { if (!canceled) setSparks((cur) => ({ ...cur, ...map })); },
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
      canceled = true;
      clearInterval(qt);
      clearInterval(st);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [setKey]);

  // Restore focus to a row after it moved, was renamed, or its neighbor was removed.
  useEffect(() => {
    const k = focusKey.current;
    if (!k) return;
    focusKey.current = null;
    const attr = k.kind === 'symbol' ? 'symbol' : 'section';
    for (const el of listRef.current?.querySelectorAll<HTMLElement>(`[data-${attr}]`) ?? []) {
      if (el.dataset[attr] === k.id) el.focus();
    }
  });

  // The open section menu closes on a pointer press outside it; its first item gets the focus.
  useEffect(() => {
    if (menuFor === null) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !menuRef.current?.parentElement?.contains(e.target)) setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuFor]);

  // Forget an active section that no longer exists.
  useEffect(() => {
    if (activeSection !== null && !entries.some((e) => e.type === 'section' && e.id === activeSection)) setActiveSection(null);
  }, [entries, activeSection]);

  function startRename(s: WatchlistSection) {
    setMenuFor(null);
    setRenaming({ id: s.id, draft: s.title });
  }

  /** Ends inline renaming: an empty title (or a cancel) keeps the previous one. */
  function finishRename(save: boolean) {
    const r = renamingRef.current;
    if (!r) return;
    renamingRef.current = null;
    setRenaming(null);
    const title = r.draft.trim().slice(0, MAX_SECTION_TITLE);
    if (save && title !== '') update((cur) => renameSection(cur, r.id, title));
    focusKey.current = { kind: 'section', id: r.id };
  }

  /** Inserts a new section header at entry index `at` (default: the end) and starts renaming it. */
  function addSection(at?: number) {
    if (sectionCount >= MAX_WATCHLIST_SECTIONS) return;
    const section: WatchlistSection = { type: 'section', id: newSectionId(), title: NEW_SECTION_TITLE, collapsed: false };
    update((cur) => insertSection(cur, at ?? cur.length, section));
    setActiveSection(section.id);
    setMenuFor(null);
    setRenaming({ id: section.id, draft: section.title });
  }

  function moveRow(e: KeyboardEvent, row: WatchlistRow): boolean {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false;
    e.preventDefault();
    focusKey.current = rowKey(row);
    update((cur) => moveByKey(cur, row.index, e.key === 'ArrowUp' ? -1 : 1));
    return true;
  }

  function onSymbolKeyDown(e: KeyboardEvent<HTMLDivElement>, id: SymbolId, row: WatchlistRow, pos: number) {
    if (e.target !== e.currentTarget) return;
    if (moveRow(e, row)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Handled here: must not also reach the chart's "delete selected drawing" shortcut.
      e.preventDefault();
      e.stopPropagation();
      const neighbor = rows[pos + 1] ?? rows[pos - 1];
      focusKey.current = neighbor ? rowKey(neighbor) : null;
      remove(id);
    }
  }

  function onHeaderKeyDown(e: KeyboardEvent<HTMLButtonElement>, s: WatchlistSection, row: WatchlistRow) {
    if (moveRow(e, row)) return;
    if (e.key === 'F2') {
      e.preventDefault();
      startRename(s);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>, sectionId: string) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMenuFor(null);
      menuRef.current?.parentElement?.querySelector<HTMLElement>(`[data-menu-for="${sectionId}"]`)?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      items[(at + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n]?.focus();
    } else if (e.key === 'Tab') {
      setMenuFor(null);
    }
  }

  function onDrop(e: DragEvent<HTMLLIElement>, index: number) {
    e.preventDefault();
    if (dragFrom !== null) {
      const from = dragFrom;
      update((cur) => dropEntry(cur, from, index));
    }
    setDragFrom(null);
    setDragOver(null);
  }

  function dragProps(row: WatchlistRow) {
    const i = row.index;
    return {
      draggable: renaming?.id !== row.entry.id,
      onDragStart: (e: DragEvent<HTMLLIElement>) => {
        setDragFrom(i);
        setMenuFor(null);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.entry.id);
      },
      onDragOver: (e: DragEvent<HTMLLIElement>) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(i); },
      onDrop: (e: DragEvent<HTMLLIElement>) => onDrop(e, i),
      onDragEnd: () => { setDragFrom(null); setDragOver(null); },
    };
  }

  function dragClasses(row: WatchlistRow, classes: string[]) {
    if (dragFrom === row.index) classes.push('dragging');
    if (dragOver !== row.index || dragFrom === null || dragFrom === row.index) return;
    const e = row.entry;
    if (e.type === 'section' && e.collapsed && entries[dragFrom]?.type === 'symbol') classes.push('drop-into');
    else classes.push(dragFrom < row.index ? 'drag-over-after' : 'drag-over');
  }

  function renderSection(row: WatchlistRow, s: WatchlistSection) {
    const classes = ['watchlist-section'];
    if (s.collapsed) classes.push('collapsed');
    if (s.id === activeSection) classes.push('active');
    dragClasses(row, classes);
    const isRenaming = renaming?.id === s.id;
    const titleId = `${headerIdBase}-${s.id}-title`;
    const countId = `${headerIdBase}-${s.id}-count`;
    return (
      <li key={`section:${s.id}`} className={classes.join(' ')} {...dragProps(row)}>
        <div role="heading" aria-level={3} className="wl-section-head">
          {isRenaming ? (
            <input
              className="wl-section-input"
              aria-label="Section title"
              maxLength={MAX_SECTION_TITLE}
              value={renaming.draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenaming({ id: s.id, draft: e.currentTarget.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
              }}
              onBlur={() => finishRename(true)}
            />
          ) : (
            <>
              {/* The toggle holds only the chevron (named by the title and count), so double-clicking the title to
                  rename never toggles the section. */}
              <button
                type="button"
                className="wl-section-toggle"
                data-section={s.id}
                aria-expanded={!s.collapsed}
                aria-labelledby={s.collapsed ? `${titleId} ${countId}` : titleId}
                aria-describedby={sectionHintId}
                onFocus={() => setActiveSection(s.id)}
                onClick={() => update((cur) => setCollapsed(cur, s.id, !s.collapsed))}
                onKeyDown={(e) => onHeaderKeyDown(e, s, row)}
              >
                <svg className="wl-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d={s.collapsed ? 'M5.5 3.5 9 7l-3.5 3.5' : 'M3.5 5.5 7 9l3.5-3.5'} />
                </svg>
              </button>
              <span
                id={titleId}
                className="wl-section-title"
                onClick={(e) => e.currentTarget.parentElement?.querySelector<HTMLElement>('.wl-section-toggle')?.focus()}
                onDoubleClick={() => startRename(s)}
              >
                {s.title}
              </span>
              {/* The count always shows; screen readers hear it in the toggle's name while the section is collapsed. */}
              <span className="wl-section-count" aria-hidden="true">{row.count}</span>
              {s.collapsed && <span id={countId} hidden>{`${row.count} symbols`}</span>}
            </>
          )}
        </div>
        <button
          type="button"
          className="wl-section-menu"
          data-menu-for={s.id}
          aria-label={`Section actions: ${s.title}`}
          aria-haspopup="menu"
          aria-expanded={menuFor === s.id}
          onClick={() => setMenuFor((cur) => (cur === s.id ? null : s.id))}
        >
          …
        </button>
        {menuFor === s.id && (
          <div className="wl-section-popup" role="menu" aria-label={`${s.title} actions`} ref={menuRef} onKeyDown={(e) => onMenuKeyDown(e, s.id)}>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => startRename(s)}>Rename</button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={sectionCount >= MAX_WATCHLIST_SECTIONS}
              onClick={() => addSection(row.index)}
            >
              Add section above
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              title="Symbols move to the previous section"
              onClick={() => {
                setMenuFor(null);
                const pos = rows.indexOf(row);
                const neighbor = rows[pos - 1] ?? rows[pos + 1];
                focusKey.current = neighbor ? rowKey(neighbor) : null;
                update((cur) => deleteSection(cur, s.id));
              }}
            >
              Delete section
            </button>
          </div>
        )}
      </li>
    );
  }

  function renderSymbol(row: WatchlistRow, id: SymbolId, pos: number) {
    const info = infos[id];
    const q = quotes[id];
    const gone = !info && deleted.has(id);
    const label = info ? (info.assetClass === 'basket' ? info.name : info.ticker) : gone ? 'Deleted basket' : fallbackTicker(id);
    const chg = q?.changePct == null ? null : fmtChange(q.changePct);
    const spark = sparks[id] ?? [];
    // 30-day closing range: the sparkline's daily closes and the live price.
    const range = q && spark.length > 1 ? { lo: Math.min(q.price, ...spark), hi: Math.max(q.price, ...spark) } : null;
    // Second line when there is no pre / post price: the full name (a basket's name is already its label).
    const name = info && info.assetClass !== 'basket' && info.name !== info.ticker ? info.name : info?.assetClass === 'basket' ? 'Basket' : null;
    const classes = ['watchlist-row'];
    if (row.sectionId !== null) classes.push('in-section');
    if (id === currentSymbol) classes.push('current');
    if (gone) classes.push('deleted');
    dragClasses(row, classes);
    return (
      <li key={id} className={classes.join(' ')} {...dragProps(row)}>
        <div
          className="wl-select"
          data-symbol={id}
          role="button"
          tabIndex={0}
          aria-current={id === currentSymbol ? 'true' : undefined}
          aria-describedby={hintId}
          onFocus={() => setActiveSection(row.sectionId)}
          onClick={() => onSelect(id)}
          onKeyDown={(e) => onSymbolKeyDown(e, id, row, pos)}
        >
          <span className="wl-symbol" title={info?.name}>{label}</span>
          <span className="wl-spark"><Sparkline values={spark} width={sparkWidth} height={20} /></span>
          <span className="wl-price">{q && info ? fmtPrice(q.price, info.pricePrecision) : '—'}</span>
          <span className={`wl-change ${chg?.dir ?? ''}`}>{chg ? chg.text : '—'}</span>
          {/* Always present, so rows keep their height when the extended line comes and goes at 09:30/16:00. */}
          {q?.ext && info ? (
            <span className="wl-ext-slot"><ExtLine ext={q.ext} precision={info.pricePrecision} /></span>
          ) : (
            <span className="wl-ext-slot" aria-hidden="true" />
          )}
          {!(q?.ext && info) && name && <span className="wl-name">{name}</span>}
          {/* Decorative for screen readers (the row's name stays short); the tooltip says what it measures. */}
          <span
            className="wl-gauge"
            aria-hidden="true"
            title={range && info
              ? `30-day closing range ${fmtPrice(range.lo, info.pricePrecision)} – ${fmtPrice(range.hi, info.pricePrecision)} (with the live price)`
              : undefined}
          >
            {range && <RangeGauge value={q!.price} low={range.lo} high={range.hi} dir={chg?.dir ?? ''} />}
          </span>
        </div>
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
  }

  return (
    <section className="watchlist" data-testid="watchlist" aria-label="Watchlist" ref={railRef}
      style={{ '--wl-spark-w': `${sparkWidth}px` } as CSSProperties}>
      <div className="watchlist-head">
        <h2 className="panel-title">Watchlist</h2>
        <button
          type="button"
          className="wl-add-section"
          aria-label="Add section"
          title="Add section"
          disabled={!loaded || sectionCount >= MAX_WATCHLIST_SECTIONS}
          onClick={() => addSection()}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M7 2v10M2 7h10" />
          </svg>
          Section
        </button>
      </div>
      <SymbolSearch onSelect={(id) => add(id, activeSection)} placeholder="Add symbol…" disabled={!loaded} />
      {error && <div className="watchlist-error" role="alert">{error}</div>}
      {/* A plain list: each symbol row has a focusable "select" control (aria-current marks the open chart) and a
          sibling remove button; each section row a heading with a collapse toggle and a sibling actions button.
          No interactive element is nested inside another. */}
      <ul className="watchlist-list" ref={listRef} aria-label="Watchlist symbols" aria-busy={loaded ? undefined : true}>
        {rows.map((row, pos) => (row.entry.type === 'section' ? renderSection(row, row.entry) : renderSymbol(row, row.entry.id, pos)))}
        {/* Until the list loads (retried with backoff on failure): quiet placeholder rows in the rows' own rhythm. */}
        {!loaded && PLACEHOLDER_ROWS.map((w) => (
          <li key={w} className="watchlist-row wl-placeholder" aria-hidden="true">
            <span className="wl-ph-symbol" style={{ width: w }} />
            <span className="wl-ph-price" />
            <span className="wl-ph-name" style={{ width: w + 22 }} />
          </li>
        ))}
      </ul>
      {!loaded && <p className="sr-only" role="status">Loading watchlist…</p>}
      <p id={hintId} className="sr-only">Enter opens the chart, Delete removes, Alt+Arrow keys reorder.</p>
      <p id={sectionHintId} className="sr-only">Enter collapses or expands, F2 or double-click renames, Alt+Arrow keys move the section header.</p>
      {loaded && entries.length === 0 && <div className="watchlist-empty">No symbols. Search above to add one.</div>}
    </section>
  );
}

/** Memoized: resizing the sidebar re-renders the shell, not this. */
export const Watchlist = memo(WatchlistPanel);
