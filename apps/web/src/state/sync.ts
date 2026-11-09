import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

/**
 * Sync, as the page sees it: a full sync as the app loads (before it reads any data), then a check whenever the
 * window comes back to the front. Newer data from another device is never applied under an open page (its next save
 * would write the old view back); the page offers a reload instead. The server pushes this device's edits itself.
 */

/** How long the app waits for the load-time sync before it shows the (local) data anyway. */
export const STARTUP_SYNC_WAIT_MS = 5_000;
/** At most one check this often (window focus can fire in bursts). */
export const CHECK_INTERVAL_MS = 60_000;

const listeners = new Set<() => void>();
const notifyRemoteNewer = () => { for (const fn of listeners) fn(); };

/**
 * The load-time sync. Resolves when it is done, or after `waitMs`; a slower sync still finishes on the server, and
 * if it brought anything in, the page is told (it offers a reload). Never rejects: the app works without sync.
 */
export function startupSync(waitMs = STARTUP_SYNC_WAIT_MS): Promise<void> {
  let waited = false;
  const run = api.sync.run().then(
    (r) => { if (waited && r !== null && r.applied > 0) notifyRemoteNewer(); },
    () => { /* off, unreachable, or an older server: the status in the Sync dialog says why */ },
  );
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { waited = true; resolve(); }, waitMs);
    void run.then(() => { clearTimeout(timer); resolve(); });
  });
}

/** True once another device saved newer data than this page shows; `dismiss` hides the offer until the next one. */
export function useRemoteNewer(intervalMs = CHECK_INTERVAL_MS): { newer: boolean; dismiss: () => void } {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const show = () => setNewer(true);
    listeners.add(show);
    let last = Date.now(); // the load-time sync just ran
    let stopped = false;
    const check = () => {
      if (stopped || document.visibilityState === 'hidden' || Date.now() - last < intervalMs) return;
      last = Date.now();
      api.sync.check().then(
        (r) => { if (r?.remoteNewer) show(); },
        (err: unknown) => { if (err instanceof ApiError && err.status === 404) stopped = true; /* an older server */ },
      );
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      listeners.delete(show);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  const dismiss = useCallback(() => setNewer(false), []);
  return { newer, dismiss };
}

/** Reloads the page; the load-time sync brings the newer data in first. */
export function reloadPage(): void {
  window.location.reload();
}
