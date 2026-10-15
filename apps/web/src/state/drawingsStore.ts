import type { DrawingState, SymbolId } from '@chartmate/shared';
import { useSyncExternalStore } from 'react';
import type { SaveNoteState } from '../components/SaveNote';

/** A symbol's save that has not reached the server (published by its DrawingsSave). */
export interface DrawingsSaveStatus {
  state: SaveNoteState;
  /** The raw error. */
  detail: string;
  /** Saves again at once (stalled). */
  retry: () => void;
}

export interface DrawingsSnapshot {
  /** Latest serialized drawings per symbol not yet confirmed saved (the active symbol's stays while it is active). */
  values: ReadonlyMap<SymbolId, DrawingState[]>;
  /** Symbols whose save has not reached the server. */
  statuses: ReadonlyMap<SymbolId, DrawingsSaveStatus>;
  /** The charted symbol whose drawings are loaded: the only one taking new values (saving enabled). */
  active: SymbolId | null;
  /** Tickers to name symbols in notes. */
  tickers: ReadonlyMap<SymbolId, string>;
}

/**
 * Drawings waiting to be saved, per symbol, outside the chart view: they survive symbol switches and leaving the chart
 * (Baskets page), where the savers (DrawingsSavers, mounted by the app shell) keep retrying them. A symbol's entry is
 * dropped once its save succeeded and it is no longer active, or when the user discards it (a permanent failure).
 */
let snapshot: DrawingsSnapshot = { values: new Map(), statuses: new Map(), active: null, tickers: new Map() };
const listeners = new Set<() => void>();
const discardListeners = new Set<(symbol: SymbolId) => void>();

function update(next: Partial<DrawingsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of [...listeners]) l();
}

function drop(symbol: SymbolId, deactivate = false): void {
  const values = new Map(snapshot.values);
  values.delete(symbol);
  const statuses = new Map(snapshot.statuses);
  statuses.delete(symbol);
  update(deactivate && snapshot.active === symbol ? { values, statuses, active: null } : { values, statuses });
}

export const drawingsStore = {
  getSnapshot: (): DrawingsSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  setValue(symbol: SymbolId, drawings: DrawingState[]): void {
    update({ values: new Map(snapshot.values).set(symbol, drawings) });
  },
  setActive(symbol: SymbolId | null): void {
    if (snapshot.active !== symbol) update({ active: symbol });
  },
  setTicker(symbol: SymbolId, ticker: string): void {
    if (snapshot.tickers.get(symbol) !== ticker) update({ tickers: new Map(snapshot.tickers).set(symbol, ticker) });
  },
  setStatus(symbol: SymbolId, status: DrawingsSaveStatus | null): void {
    const cur = snapshot.statuses.get(symbol);
    if (status === null && cur === undefined) return;
    if (status && cur && cur.state === status.state && cur.detail === status.detail && cur.retry === status.retry) return;
    const statuses = new Map(snapshot.statuses);
    if (status) statuses.set(symbol, status);
    else statuses.delete(symbol);
    update({ statuses });
  },
  /** `symbol`'s save succeeded and it is not active: nothing is left to save. */
  settle(symbol: SymbolId): void {
    if (snapshot.active === symbol || !snapshot.values.has(symbol)) return;
    const values = new Map(snapshot.values);
    values.delete(symbol);
    const statuses = new Map(snapshot.statuses);
    statuses.delete(symbol);
    update({ values, statuses });
  },
  /**
   * Explicitly drops `symbol`'s unsaved drawings (the user discarded them after a permanent failure). Its saver sends
   * nothing more (saves skip symbols without a value). Discard listeners hear about it (a charted symbol reloads the
   * server's drawings).
   */
  discard(symbol: SymbolId): void {
    drop(symbol);
    for (const l of [...discardListeners]) l(symbol);
  },
  /**
   * Cancels `symbol`'s pending drawings without saving them (its basket was deleted): no retry, no flush, no note.
   * It also stops being the active symbol.
   */
  cancel(symbol: SymbolId): void {
    drop(symbol, true);
  },
  /** Whether `symbol` still has drawings to save (a saver whose symbol was discarded or canceled sends nothing). */
  hasValue(symbol: SymbolId): boolean {
    return snapshot.values.has(symbol);
  },
  /** Subscribes to "the user discarded `symbol`'s unsaved drawings". */
  onDiscard(listener: (symbol: SymbolId) => void): () => void {
    discardListeners.add(listener);
    return () => { discardListeners.delete(listener); };
  },
  /** Tests only. */
  reset(): void {
    snapshot = { values: new Map(), statuses: new Map(), active: null, tickers: new Map() };
    for (const l of [...listeners]) l();
  },
};

export function useDrawingsStore(): DrawingsSnapshot {
  return useSyncExternalStore(drawingsStore.subscribe, drawingsStore.getSnapshot);
}

/** The ticker naming `symbol` in notes (the id's code until its info is known). */
export function drawingsTicker(s: DrawingsSnapshot, symbol: SymbolId): string {
  return s.tickers.get(symbol) ?? symbol.slice(symbol.indexOf(':') + 1);
}

/** "AAPL", "AAPL and MSFT", "AAPL, MSFT and 3 more". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
