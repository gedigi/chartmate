import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Whether this app checks alerts on drawings (the desktop app, which notifies; a self-hosted server does not yet).
 * Asked once per page; false until known, and on any error (the alert controls stay hidden).
 */
let supported: Promise<boolean> | null = null;

export function alertsSupported(): Promise<boolean> {
  supported ??= api.alerts.get().then((r) => r?.supported === true, () => false);
  return supported;
}

/** Tests: forget the answer. */
export function resetAlertsSupported(): void {
  supported = null;
}

export function useAlertsSupported(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void alertsSupported().then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, []);
  return on;
}
