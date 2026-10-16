import { isPermanentError } from '../api/client';

/** Backoff between automatic retries of a failed load: 2 s, 5 s, 10 s, then every 30 s. */
const RETRY_DELAYS_MS = [2000, 5000, 10_000] as const;
const RETRY_DELAY_MAX_MS = 30_000;

/** Delay before retry number `attempt` (0-based). */
export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAY_MAX_MS;
}

/**
 * Runs `load` until it succeeds, retrying a failure with retryDelayMs backoff unless it is permanent
 * (isPermanentError). `onError` sees every failure. Returns a function that cancels the pending retry and
 * drops any later result.
 */
export function loadWithRetry<T>(
  load: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (err: unknown) => void,
): () => void {
  let canceled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (attempt: number) => {
    load().then(
      (value) => { if (!canceled) onValue(value); },
      (err: unknown) => {
        if (canceled) return;
        onError(err);
        if (!isPermanentError(err)) timer = setTimeout(() => run(attempt + 1), retryDelayMs(attempt));
      },
    );
  };
  run(0);
  return () => {
    canceled = true;
    clearTimeout(timer);
  };
}
