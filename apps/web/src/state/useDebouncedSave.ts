import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isPermanentError } from '../api/client';
import { retryDelayMs } from './retry';

/**
 * Persists `value` via `save` once it has stopped changing for `delayMs`.
 *
 * - The value present on mount, or at the moment `enabled` turns true, is the baseline and is not saved.
 * - While disabled, changes are ignored; disabling first flushes any pending save.
 * - A pending save is flushed (best-effort, not awaited) on unmount and on `beforeunload`.
 * - With `retry`, a failed save of the latest value is retried with backoff (2 s, 5 s, 10 s, then every 30 s)
 *   until it succeeds or a newer value replaces it; `error` stays set meanwhile.
 * Values are compared by reference (`Object.is`), so pass immutable values.
 */
export function useDebouncedSave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  delayMs = 1000,
  enabled = true,
  options: { retry?: boolean } = {},
): { saving: boolean; error: string | null } {
  const retry = options.retry === true;
  const [scheduled, setScheduled] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
        if (mounted.current) setError(null);
      },
      (err: unknown) => {
        if (!mounted.current || mySeq !== seq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        // A permanent client error (e.g. 400) cannot succeed by retrying: keep it shown, do not retry.
        if (isPermanentError(err)) return;
        // Retry only if nothing newer is already queued.
        if (retryRef.current && pending.current === null && timer.current === null) {
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
    pending.current = { value };
    setScheduled(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [value, enabled, delayMs, flush]);

  useEffect(() => {
    mounted.current = true;
    const onUnload = () => flush();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      mounted.current = false;
      flush();
    };
  }, [flush]);

  return { saving: scheduled || inFlight > 0, error };
}
