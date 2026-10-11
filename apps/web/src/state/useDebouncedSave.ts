import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Persists `value` via `save` once it has stopped changing for `delayMs`.
 *
 * - The value present on mount, or at the moment `enabled` turns true, is the baseline and is not saved.
 * - While disabled, changes are ignored; disabling first flushes any pending save.
 * - A pending save is flushed (best-effort, not awaited) on unmount and on `beforeunload`.
 * Values are compared by reference (`Object.is`), so pass immutable values.
 */
export function useDebouncedSave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  delayMs = 1000,
  enabled = true,
): { saving: boolean; error: string | null } {
  const [scheduled, setScheduled] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const saveRef = useRef(save);
  saveRef.current = save;
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
      () => { if (mounted.current) setError(null); },
      (err: unknown) => { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); },
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
