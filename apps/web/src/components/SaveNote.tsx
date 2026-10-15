import type { JSX } from 'react';

export type SaveNoteState = 'retrying' | 'stalled' | 'failed';

export interface SaveNoteProps {
  /** What was not saved, capitalized: "Layout", "Watchlist", "AAPL drawings". */
  thing: string;
  /** `retrying`: retried with backoff; `stalled`: retries gave up (Retry button); `failed`: permanent (e.g. 400). */
  state: SaveNoteState;
  /** The raw error (tooltip, or the reason of a permanent failure). */
  detail: string;
  /** Accessible name of the Retry button ("Retry saving the layout"). */
  retryLabel: string;
  onRetry: () => void;
  className?: string;
}

/**
 * The one treatment for a save that has not reached the server (layout pill, watchlist, drawings on the chart): a calm
 * warn pill while it is retried or after the retries gave up ("<Thing> not saved. Retrying…" / "<Thing> not saved."
 * with Retry), the error color only for a permanent failure.
 */
export function SaveNote({ thing, state, detail, retryLabel, onRetry, className }: SaveNoteProps): JSX.Element {
  const classes = ['save-note', state === 'failed' ? 'is-error' : 'is-warn'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role={state === 'failed' ? 'alert' : 'status'} title={detail}>
      {state === 'retrying' && <span className="save-note-dot" aria-hidden="true" />}
      <span className="save-note-text">
        {state === 'retrying' ? `${thing} not saved. Retrying…` : state === 'stalled' ? `${thing} not saved.` : `${thing} not saved: ${detail}`}
      </span>
      {state === 'stalled' && <button type="button" className="save-note-retry" aria-label={retryLabel} onClick={onRetry}>Retry</button>}
    </div>
  );
}
