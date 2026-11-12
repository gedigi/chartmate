import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { alertBadgeSettings } from '../chart/alertBadge';

/**
 * Whether this app checks alerts on drawings (the desktop app, which notifies; a self-hosted server does not yet).
 * Asked once per page; false until known, and on any error (the alert controls stay hidden).
 */
let supported: Promise<boolean> | null = null;

export function alertsSupported(): Promise<boolean> {
  supported ??= api.alerts.get().then((r) => {
    const on = r?.supported === true;
    alertBadgeSettings.enabled = on; // the bells on drawings show from the chart's next repaint
    return on;
  }, () => false);
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

export type AlertChange = { on: boolean } | null;
type Editor = (id: string, change: AlertChange) => boolean;
const editors = new Set<Editor>();
const changeListeners = new Set<() => void>();

/**
 * The chart registers here: an alert on a drawing it shows is changed through it (its next save keeps the change);
 * otherwise the change goes to the server, where the drawing is stored. Returns an unsubscribe.
 */
export function registerAlertEditor(editor: Editor): () => void {
  editors.add(editor);
  return () => { editors.delete(editor); };
}

/** Switches an alert on or off, or removes it (null): on the chart when it shows the drawing, else on the server. */
export async function changeAlert(id: string, change: AlertChange): Promise<void> {
  let done = false;
  for (const e of editors) if (e(id, change)) done = true;
  if (!done) {
    if (change === null) await api.alerts.remove(id);
    else await api.alerts.setOn(id, change.on);
  }
  for (const l of [...changeListeners]) l();
}

/** Subscribes to "an alert was changed from the Alerts panel" (the top bar refreshes its badge). */
export function onAlertsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/**
 * The alerts as the top bar needs them: whether this app checks them, and how many have triggered (shown as a dot).
 * Refreshed every minute, when the window comes back to the front, and after a change from the Alerts panel.
 */
export function useAlertsOverview(intervalMs = 60_000): { supported: boolean; fired: number; refresh: () => void } {
  const supported = useAlertsSupported();
  const [fired, setFired] = useState(0);
  const refresh = useCallback(() => {
    api.alerts.get().then(
      (r) => setFired((r?.list ?? []).filter((e) => e.alert.on && e.status === 'fired').length),
      () => { /* keep the last count */ },
    );
  }, []);
  useEffect(() => {
    if (!supported) return;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    window.addEventListener('focus', refresh);
    const off = onAlertsChanged(refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); off(); };
  }, [supported, refresh, intervalMs]);
  return { supported, fired, refresh };
}
