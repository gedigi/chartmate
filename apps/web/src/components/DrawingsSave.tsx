import type { DrawingState, SymbolId } from '@chartmate/shared';
import { useCallback, useEffect, type JSX } from 'react';
import { api } from '../api/client';
import { useDebouncedSave } from '../state/useDebouncedSave';
import { SaveNote } from './SaveNote';

export interface DrawingsSaveProps {
  symbol: SymbolId;
  /** Ticker shown in the note ("AAPL drawings not saved."). */
  ticker: string;
  /** The symbol's latest serialized drawings (undefined until the first edit). */
  value: DrawingState[] | undefined;
  /** Saving new values: only while this symbol is charted and its drawings are loaded. */
  enabled: boolean;
  delayMs: number;
  /** Nothing is left to save and no new values can come (not enabled): the parent may unmount this saver. */
  onSettled: (symbol: SymbolId) => void;
}

/**
 * Saves ONE symbol's drawings (debounced, retried with backoff, stalled after the retry limit; see useDebouncedSave).
 * One saver per symbol, so an unsaved save is never superseded by another symbol's drawings: after a symbol switch the
 * old symbol's saver stays mounted (disabled: its pending save is flushed and keeps retrying) until it has saved. It
 * renders its own note, named by the ticker.
 */
export function DrawingsSave({ symbol, ticker, value, enabled, delayMs, onSettled }: DrawingsSaveProps): JSX.Element | null {
  const save = useCallback((d: DrawingState[] | undefined) => (d ? api.drawings.put(symbol, d) : Promise.resolve()), [symbol]);
  const { saving, error, permanent, stalled, retryNow } = useDebouncedSave(value, save, delayMs, enabled, { retry: true });
  useEffect(() => {
    if (!enabled && !saving && (error === null || permanent)) onSettled(symbol);
  }, [enabled, saving, error, permanent, onSettled, symbol]);
  if (error === null) return null;
  return (
    <SaveNote thing={`${ticker} drawings`} state={permanent ? 'failed' : stalled ? 'stalled' : 'retrying'} detail={error}
      retryLabel={`Retry saving the ${ticker} drawings`} onRetry={retryNow} />
  );
}
