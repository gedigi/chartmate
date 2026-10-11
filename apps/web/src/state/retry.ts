/** Backoff between automatic retries of a failed load: 2 s, 5 s, 10 s, then every 30 s. */
const RETRY_DELAYS_MS = [2000, 5000, 10_000] as const;
const RETRY_DELAY_MAX_MS = 30_000;

/** Delay before retry number `attempt` (0-based). */
export function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[attempt] ?? RETRY_DELAY_MAX_MS;
}
