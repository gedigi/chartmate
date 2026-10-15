import type { DrawingState, SymbolId } from '@chartmate/shared';
import { useCallback, useEffect, type JSX } from 'react';
import { api } from '../api/client';
import { drawingsStore, drawingsTicker, namesList, useDrawingsStore, type DrawingsSaveStatus } from '../state/drawingsStore';
import { useDebouncedSave } from '../state/useDebouncedSave';
import { SaveNote } from './SaveNote';

/** Debounce of drawings saves after the last change. */
export const DRAWINGS_SAVE_MS = 1000;

interface DrawingsSaveProps {
  symbol: SymbolId;
  value: DrawingState[] | undefined;
  /** Saving new values: only while this symbol is charted and its drawings are loaded. */
  enabled: boolean;
}

/**
 * Saves ONE symbol's drawings (debounced, retried with backoff, stalled after the retry limit; see useDebouncedSave) and
 * publishes its status to the drawings store; renders nothing. One saver per symbol, so an unsaved value is never
 * superseded by another symbol's drawings: a disabled saver flushes its pending save at once and keeps retrying it.
 * It is dropped only once its save succeeded (or the user discards it): a permanent failure keeps the value.
 */
function DrawingsSave({ symbol, value, enabled }: DrawingsSaveProps): null {
  const save = useCallback((d: DrawingState[] | undefined) => (d ? api.drawings.put(symbol, d) : Promise.resolve()), [symbol]);
  const { saving, error, permanent, stalled, retryNow } = useDebouncedSave(value, save, DRAWINGS_SAVE_MS, enabled, { retry: true });
  useEffect(() => {
    const status: DrawingsSaveStatus | null = error === null ? null
      : { state: permanent ? 'failed' : stalled ? 'stalled' : 'retrying', detail: error, retry: retryNow };
    drawingsStore.setStatus(symbol, status);
  }, [symbol, error, permanent, stalled, retryNow]);
  useEffect(() => {
    if (!enabled && !saving && error === null) drawingsStore.settle(symbol);
  }, [enabled, saving, error, symbol]);
  useEffect(() => () => drawingsStore.setStatus(symbol, null), [symbol]);
  return null;
}

/**
 * The drawings savers, one per symbol with unsaved drawings plus the active one. Mounted by the app shell (outside the
 * chart view), so unsaved drawings keep being retried across symbol switches and while the Baskets page is shown.
 */
export function DrawingsSavers(): JSX.Element {
  const s = useDrawingsStore();
  const symbols = new Set(s.values.keys());
  if (s.active) symbols.add(s.active);
  return (
    <>
      {[...symbols].map((sym) => <DrawingsSave key={sym} symbol={sym} value={s.values.get(sym)} enabled={s.active === sym} />)}
    </>
  );
}

/**
 * One note for every symbol whose drawings have not reached the server: "Drawings not saved for AAPL, MSFT and 3 more."
 * Retry (any stalled) retries all of them; Discard (any permanent failure) drops those explicitly. Warn tone unless
 * every one failed permanently. The raw errors are in the title.
 */
export function DrawingsNote(): JSX.Element | null {
  const s = useDrawingsStore();
  const entries = [...s.statuses.entries()];
  if (entries.length === 0) return null;
  const has = (state: string) => entries.some(([, st]) => st.state === state);
  const state = has('stalled') ? 'stalled' : has('retrying') ? 'retrying' : 'failed';
  const failed = entries.filter(([, st]) => st.state === 'failed').map(([sym]) => sym);
  return (
    <SaveNote
      thing="Drawings"
      message={`Drawings not saved for ${namesList(entries.map(([sym]) => drawingsTicker(s, sym)))}`}
      state={state}
      detail={entries.map(([sym, st]) => `${drawingsTicker(s, sym)}: ${st.detail}`).join('\n')}
      retryLabel="Retry saving the drawings"
      onRetry={() => { for (const [, st] of entries) if (st.state === 'stalled') st.retry(); }}
      discardLabel="Discard the drawings that could not be saved"
      onDiscard={failed.length > 0 ? () => { for (const sym of failed) drawingsStore.discard(sym); } : undefined}
    />
  );
}
