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
  /** The sentence without its ending (default "<thing> not saved"), e.g. "Drawings not saved for AAPL and MSFT". */
  message?: string;
  /** A shorter sentence (same form) shown instead when the note's row is narrow, e.g. "Drawings not saved (3)". */
  shortMessage?: string;
  /** Shown with a Discard button: explicitly drops what could not be saved (e.g. after a permanent failure). */
  onDiscard?: () => void;
  discardLabel?: string;
  /** Retry is offered for `stalled`; `showRetry` offers it in other states too (e.g. a combined note). */
  showRetry?: boolean;
  className?: string;
}

/**
 * The one treatment for a save that has not reached the server (layout pill, watchlist, drawings on the chart): a calm
 * warn pill while it is retried or after the retries gave up ("<Thing> not saved. Retrying…" / "<Thing> not saved."
 * with Retry), the error color only for a permanent failure ("<Thing> not saved.", the reason in the title).
 */
export function SaveNote({ thing, state, detail, retryLabel, onRetry, message, shortMessage, onDiscard, discardLabel = 'Discard', showRetry, className }: SaveNoteProps): JSX.Element {
  const base = message ?? `${thing} not saved`;
  const sentence = (b: string) => (state === 'retrying' ? `${b}. Retrying…` : `${b}.`);
  const classes = ['save-note', state === 'failed' ? 'is-error' : 'is-warn'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role={state === 'failed' ? 'alert' : 'status'} title={detail}>
      {state === 'retrying' && <span className="save-note-dot" aria-hidden="true" />}
      <span className="save-note-text">
        {/* A short fixed sentence; the raw error is in the title. With a short form, CSS shows one of the two (a
            container query on the note's row); the short one is hidden from screen readers. */}
        {shortMessage === undefined ? sentence(base) : (
          <>
            <span className="save-note-long">{sentence(base)}</span>
            <span className="save-note-short" aria-hidden="true">{sentence(shortMessage)}</span>
          </>
        )}
      </span>
      {(state === 'stalled' || showRetry) && <button type="button" className="save-note-retry" aria-label={retryLabel} onClick={onRetry}>Retry</button>}
      {onDiscard && <button type="button" className="save-note-discard" aria-label={discardLabel} onClick={onDiscard}>Discard</button>}
    </div>
  );
}
