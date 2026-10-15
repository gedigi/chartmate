import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isPermanentError } from '../api/client';
import { retryDelayMs } from './retry';

/**
 * Persists `value` via `save` once it has stopped changing for `delayMs`.
 *
 * - The value present on mount, or at the moment `enabled` turns true, is the baseline and is not saved.
 * - While disabled, changes are ignored; disabling first flushes any pending save.
 * - A pending save is flushed (best-effort, not awaited) on unmount, `beforeunload` and `pagehide`. Only bodies up to
 *   KEEPALIVE_MAX_BODY (api/client.ts) outlive the page: a larger layout or drawing list flushed while the page
 *   closes may not reach the server (it was saved ~1 s after its last change unless that change came just before).
 * - With `retry`, a failed save of the latest value is retried with backoff (2 s, 5 s, 10 s, then every 30 s)
 *   until it succeeds or a newer value replaces it; `error` stays set meanwhile. After MAX_SAVE_RETRIES failed
 *   retries (about 4 minutes) it stops and reports `stalled`: a tab left open with an old value (e.g. offline, in the
 *   background) must not keep re-saving it over newer changes made elsewhere. `retryNow()` tries again at once
 *   (with a fresh backoff); a newer value is saved as usual.
 * Values are compared by reference (`Object.is`), so pass immutable values.
 */
/** Automatic retries of one failed value before the save is reported `stalled` (2 + 5 + 10 + 7 × 30 s ≈ 4 min). */
export const MAX_SAVE_RETRIES = 10;

export function useDebouncedSave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  delayMs = 1000,
  enabled = true,
  options: { retry?: boolean } = {},
): { saving: boolean; error: string | null; permanent: boolean; stalled: boolean; retryNow: () => void } {
  const retry = options.retry === true;
  const [scheduled, setScheduled] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  /** The error is permanent (e.g. 400): retrying cannot help. */
  const [permanent, setPermanent] = useState(false);
  const permanentRef = useRef(false);
  /** The value whose retries were given up (stalled), for retryNow. */
  const stalledValue = useRef<{ value: T } | null>(null);

  const saveRef = useRef(save);
  // Assigned after commit (not during render), so a discarded render never swaps the save function.
  useLayoutEffect(() => { saveRef.current = save; });
  const retryRef = useRef(retry);
  useLayoutEffect(() => { retryRef.current = retry; });
  /** Sequence of the latest flushed value: only its failure may be retried. */
  const seq = useRef(0);
  const attempts = useRef(0);
  const baseline = useRef(value);
  const wasEnabled = useRef(enabled);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const live = mounted.current;
    const mySeq = ++seq.current;
    if (live) {
      setScheduled(false);
      setInFlight((n) => n + 1);
    }
    let result: Promise<void>;
    try {
      result = saveRef.current(p.value);
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      () => {
        // Only the latest save's outcome is shown: an older response arriving late changes nothing.
        if (mySeq !== seq.current) return;
        attempts.current = 0;
        permanentRef.current = false;
        if (mounted.current) { setError(null); setStalled(false); setPermanent(false); }
      },
      (err: unknown) => {
        if (!mounted.current || mySeq !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        // A permanent client error (e.g. 400) cannot succeed by retrying: keep it shown, do not retry.
        permanentRef.current = isPermanentError(err);
        setPermanent(permanentRef.current);
        if (isPermanentError(err)) return;
        // Retry only if nothing newer is already queued.
        if (retryRef.current && pending.current === null && timer.current === null) {
          if (attempts.current >= MAX_SAVE_RETRIES) {
            stalledValue.current = p;
            setStalled(true);
            return;
          }
          pending.current = p;
          timer.current = setTimeout(flush, retryDelayMs(attempts.current++));
        }
      },
    ).finally(() => { if (live && mounted.current) setInFlight((n) => n - 1); });
  }, []);

  useEffect(() => {
    const justEnabled = enabled && !wasEnabled.current;
    wasEnabled.current = enabled;
    if (!enabled) {
      flush();
      baseline.current = value;
      return;
    }
    if (justEnabled) {
      baseline.current = value;
      return;
    }
    if (pending.current === null && Object.is(value, baseline.current)) return;
    baseline.current = value;
    // A newer value supersedes a stalled one (and gets a fresh backoff), and a permanent error is no longer current.
    stalledValue.current = null;
    attempts.current = 0;
    setStalled(false);
    if (permanentRef.current) {
      permanentRef.current = false;
      setPermanent(false);
      setError(null);
    }
    pending.current = { value };
    setScheduled(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [value, enabled, delayMs, flush]);

  useEffect(() => {
    mounted.current = true;
    const onUnload = () => flush();
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload); // also fires where beforeunload does not (mobile, bfcache)
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      mounted.current = false;
      flush();
    };
  }, [flush]);

  const retryNow = useCallback(() => {
    const p = stalledValue.current;
    if (!p || pending.current !== null || timer.current !== null) return;
    stalledValue.current = null;
    attempts.current = 0;
    setStalled(false);
    pending.current = p;
    flush();
  }, [flush]);

  return { saving: scheduled || inFlight > 0, error, permanent, stalled, retryNow };
}
