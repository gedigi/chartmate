import {
  alertExtends, alertKind, FIB_LEVELS,
  type CrossDirection, type DrawingAlert, type PositionEvent, type ZoneEvent,
} from '@chartmate/shared';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { api, type AlertStatus } from '../api/client';
import type { ChartAdapter } from '../chart/ChartAdapter';
import { useAlertsSupported } from '../state/alerts';

export type AlertControls = Pick<ChartAdapter, 'setSelectedAlert'>;

const BELL = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M5.2 13.6V9a4.8 4.8 0 0 1 9.6 0v4.6l1.4 1.6H3.8z" />
    <path d="M8.3 17.2a1.9 1.9 0 0 0 3.4 0" />
  </svg>
);

type Choice<T extends string> = { value: T; label: string };
const CROSS: Choice<CrossDirection>[] = [{ value: 'up', label: 'Crosses up' }, { value: 'down', label: 'Crosses down' }];
const CHANNEL: Choice<ZoneEvent>[] = [{ value: 'exitUp', label: 'Breaks above' }, { value: 'exitDown', label: 'Breaks below' }, { value: 'enter', label: 'Re-enters' }];
const RECTANGLE: Choice<ZoneEvent>[] = [{ value: 'enter', label: 'Enters' }, { value: 'exitUp', label: 'Leaves above' }, { value: 'exitDown', label: 'Leaves below' }];
const POSITION: Choice<PositionEvent>[] = [{ value: 'entry', label: 'Entry reached' }, { value: 'target', label: 'Target hit' }, { value: 'stop', label: 'Stop hit' }];

const pct = (level: number) => `${(level * 100).toFixed(1).replace(/\.0$/, '')}%`;
const timeOf = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The alert's status line (as the desktop app last saw it). */
function statusText(alert: DrawingAlert, s: AlertStatus | undefined): string {
  if (!alert.on) return 'Off.';
  if (s?.status === 'fired') return `Triggered ${s.at ? timeOf(s.at) : ''}: ${s.message ?? ''}.`;
  if (s?.status === 'open') return `Entry reached ${s.at ? timeOf(s.at) : ''}; watching the target and stop.`;
  return `Watching on the ${alert.tf} chart${alert.session === 'eth' ? ', extended hours included' : ''}.`;
}

/**
 * "Alert" in a drawing's style bar (desktop app only: it checks alerts and shows a native notification). A bell that
 * opens a small panel: the alert on or off, what it watches for this kind of drawing (crossings, channel breaks, a
 * rectangle entered or left, Fibonacci levels, a position's entry, target and stop, a time arriving), whether it
 * keeps watching past the drawing's end, and how it stands (watching, or triggered with Re-arm). The settings are
 * saved with the drawing; any change re-arms it.
 */
export function AlertButton({ controls, name, alert }: { controls: Partial<AlertControls>; name: string; alert: DrawingAlert | null }): JSX.Element | null {
  const supported = useAlertsSupported();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AlertStatus | undefined>(undefined);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const kind = alertKind(name);
  const alertId = alert?.id;

  // The status, each time the panel opens (and after a re-arm).
  const refresh = () => {
    if (!alertId) { setStatus(undefined); return; }
    api.alerts.get().then((r) => setStatus(r?.alerts[alertId]), () => setStatus(undefined));
  };
  useEffect(() => { if (open) refresh(); }, [open, alertId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) panelRef.current?.querySelector<HTMLElement>('input')?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node && rootRef.current?.contains(e.target))) setOpen(false);
    };
    // Escape closes it wherever the focus is (re-arming removes the focused button).
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const setAlert = controls.setSelectedAlert?.bind(controls);
  if (!supported || !kind || !setAlert) return null;

  const set = (patch: Partial<DrawingAlert>) => { if (alert) setAlert({ ...alert, ...patch }); };
  const toggleIn = <T extends string>(list: readonly T[] | undefined, v: T, on: boolean): T[] => {
    const cur = new Set(list ?? []);
    if (on) cur.add(v); else cur.delete(v);
    return [...cur];
  };
  const checks = <T extends string>(choices: Choice<T>[], list: readonly T[] | undefined, key: 'cross' | 'zone' | 'position') => choices.map((c) => (
    <label key={c.value} className="alert-option">
      <input type="checkbox" checked={(list ?? []).includes(c.value)} disabled={!alert?.on}
        onChange={(e) => set({ [key]: toggleIn(list, c.value, e.target.checked) } as Partial<DrawingAlert>)} />
      {c.label}
    </label>
  ));

  let options: JSX.Element[] | JSX.Element | null = null;
  if (alert) {
    if (kind === 'line') options = checks(CROSS, alert.cross, 'cross');
    else if (kind === 'zone') options = checks(name === 'rectangle' ? RECTANGLE : CHANNEL, alert.zone, 'zone');
    else if (kind === 'position') options = checks(POSITION, alert.position, 'position');
    else if (kind === 'time') options = <p className="alert-note">Notifies when this time arrives.</p>;
    else {
      options = (
        <div className="alert-levels" role="group" aria-label="Levels">
          {FIB_LEVELS.map((l) => (
            <label key={l} className="alert-option">
              <input type="checkbox" checked={(alert.levels ?? []).includes(l)} disabled={!alert.on}
                onChange={(e) => set({ levels: e.target.checked ? [...new Set([...(alert.levels ?? []), l])] : (alert.levels ?? []).filter((x) => x !== l) })} />
              {pct(l)}
            </label>
          ))}
        </div>
      );
    }
  }

  const armed = alert?.on === true;

  return (
    <span className="alert-control" ref={rootRef}>
      <button
        ref={buttonRef} type="button" className="alert-button" aria-label="Alert" title={armed ? 'Alert (on)' : 'Alert'}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} data-armed={armed || undefined}
        onClick={() => setOpen((o) => !o)}
      >{BELL}{armed && <span className="alert-dot" aria-hidden="true" />}</button>
      {open && (
        <div className="alert-panel" role="dialog" id={panelId} aria-label="Alert" ref={panelRef} tabIndex={-1}>
          <label className="alert-option alert-switch">
            <input type="checkbox" checked={armed}
              onChange={(e) => {
                if (!alert) setAlert('new');
                else set({ on: e.target.checked });
              }} />
            Notify me
          </label>
          {alert && <div className="alert-options">{options}</div>}
          {alert && alertExtends(name) && (
            <label className="alert-option">
              <input type="checkbox" checked={alert.extend === true} disabled={!alert.on} onChange={(e) => set({ extend: e.target.checked })} />
              Keep watching past its end
            </label>
          )}
          {alert && (
            <div className="alert-status" role="status">
              <span>{statusText(alert, status)}</span>
              {alert.on && status?.status === 'fired' && (
                <button type="button" className="alert-rearm" onClick={() => {
                  panelRef.current?.focus(); // the button goes away once re-armed
                  void api.alerts.rearm(alert.id).then(refresh, refresh);
                }}>Re-arm</button>
              )}
            </div>
          )}
          <p className="alert-note">Checked every 30 seconds while Chartmate is running; a notification tells you once.</p>
        </div>
      )}
    </span>
  );
}
