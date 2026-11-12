import type { DrawingAlert, SymbolId } from '@chartmate/shared';
import { useEffect, useState, type JSX } from 'react';
import { api, errorMessage, type AlertEntry } from '../api/client';
import { changeAlert } from '../state/alerts';
import { Modal } from './Modal';
import './AlertsDialog.css';

/** What each drawing tool is called in the list. */
const TOOL_LABELS: Record<string, string> = {
  segment: 'Trend line', rayLine: 'Ray', straightLine: 'Extended line', horizontalStraightLine: 'Horizontal line',
  horizontalRayLine: 'Horizontal ray', horizontalSegment: 'Horizontal segment', priceLine: 'Price line',
  verticalStraightLine: 'Vertical line', parallelChannel: 'Parallel channel', parallelStraightLine: 'Parallel channel',
  rectangle: 'Rectangle', fibonacciLine: 'Fibonacci retracement', longPosition: 'Long position', shortPosition: 'Short position',
};

const pct = (level: number) => `${(level * 100).toFixed(1).replace(/\.0$/, '')}%`;
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);

/** What the alert watches, in a few words ("Crosses up or down · 1h"). */
export function alertSummary(name: string, a: DrawingAlert): string {
  let what = 'Its time arrives';
  if (a.cross) {
    const dirs = [a.cross.includes('up') && 'up', a.cross.includes('down') && 'down'].filter(Boolean) as string[];
    what = dirs.length ? `Crosses ${list(dirs)}` : 'Nothing chosen';
  } else if (a.zone) {
    const words = name === 'rectangle'
      ? { enter: 'Enters', exitUp: 'leaves above', exitDown: 'leaves below' }
      : { enter: 're-enters', exitUp: 'Breaks above', exitDown: 'breaks below' };
    const order = name === 'rectangle' ? ['enter', 'exitUp', 'exitDown'] as const : ['exitUp', 'exitDown', 'enter'] as const;
    const parts = order.filter((e) => a.zone!.includes(e)).map((e) => words[e]);
    what = parts.length ? list(parts.map((p, i) => (i === 0 ? p[0]!.toUpperCase() + p.slice(1) : p.toLowerCase()))) : 'Nothing chosen';
  } else if (a.levels) {
    what = a.levels.length ? `Crosses ${list([...a.levels].sort((x, y) => y - x).map(pct))}` : 'Nothing chosen';
  } else if (a.position) {
    const parts = (['entry', 'target', 'stop'] as const).filter((e) => a.position!.includes(e));
    what = parts.length ? list(parts.map((p, i) => (i === 0 ? p[0]!.toUpperCase() + p.slice(1) : p))) : 'Nothing chosen';
  }
  return `${what} · ${a.tf}`;
}

const timeOf = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function statusOf(e: AlertEntry): { tone: 'fired' | 'open' | 'armed' | 'off'; text: string } {
  if (!e.alert.on) return { tone: 'off', text: 'Off' };
  if (e.status === 'fired') return { tone: 'fired', text: `Triggered ${e.at ? timeOf(e.at) : ''}: ${e.message ?? ''}` };
  if (e.status === 'open') return { tone: 'open', text: `Entry reached ${e.at ? timeOf(e.at) : ''}` };
  return { tone: 'armed', text: 'Watching' };
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; list: AlertEntry[] };

export interface AlertsDialogProps {
  onClose: () => void;
  /** Shows a symbol on the chart (the dialog closes). */
  onShow: (symbol: SymbolId) => void;
}

/**
 * Every alert on every drawing, in one list: triggered ones first, then watching, then off. Each row says which symbol
 * and drawing, what it watches and how it stands; it can be switched on or off, re-armed once triggered, removed (the
 * drawing stays), or shown on the chart. Alerts are added from a drawing's bell.
 */
export function AlertsDialog({ onClose, onShow }: AlertsDialogProps): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.alerts.get().then(
    (r) => setLoad({ state: 'ready', list: r?.list ?? [] }),
    (err: unknown) => setLoad({ state: 'error', message: errorMessage(err) }),
  );
  useEffect(() => { void refresh(); }, []);

  /** Runs a change, updating the row at once (the chart may save it a moment later), then reloads the list. */
  async function act(id: string, fn: () => Promise<void>, optimistic: (l: AlertEntry[]) => AlertEntry[]) {
    setBusy(id);
    setError(null);
    if (load.state === 'ready') setLoad({ state: 'ready', list: optimistic(load.list) });
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(null);
    // The chart saves its drawings shortly after a change: reload once that had time to land.
    setTimeout(() => { void refresh(); }, 1500);
  }

  let body: JSX.Element;
  if (load.state === 'loading') body = <p className="alerts-empty">Loading…</p>;
  else if (load.state === 'error') body = <p className="form-error" role="alert">{load.message}</p>;
  else if (load.list.length === 0) {
    body = (
      <p className="alerts-empty">
        No alerts yet. Select a drawing on a chart and use the bell in its style bar to get notified when the price
        reaches it.
      </p>
    );
  } else {
    body = (
      <ul className="alerts-list">
        {load.list.map((e) => {
          const s = statusOf(e);
          const label = `${e.ticker} ${TOOL_LABELS[e.name] ?? 'drawing'}`;
          return (
            <li key={e.id} className="alerts-row" data-tone={s.tone}>
              <div className="alerts-main">
                <div className="alerts-title">
                  <strong>{e.ticker}</strong>
                  <span>{TOOL_LABELS[e.name] ?? 'Drawing'}</span>
                </div>
                <div className="alerts-summary">{alertSummary(e.name, e.alert)}</div>
                <div className="alerts-status"><span className="alerts-dot" aria-hidden="true" />{s.text}</div>
              </div>
              <div className="alerts-actions">
                <label className="alerts-switch" title={e.alert.on ? 'On' : 'Off'}>
                  <input type="checkbox" role="switch" aria-label={`${label} alert`} checked={e.alert.on} disabled={busy === e.id}
                    onChange={(ev) => {
                      const on = ev.target.checked;
                      void act(e.id, () => changeAlert(e.id, { on }), (l) => l.map((x) => (x.id === e.id ? { ...x, alert: { ...x.alert, on }, status: 'armed', at: null, message: null } : x)));
                    }} />
                  <span className="alerts-track" aria-hidden="true" />
                </label>
                {e.alert.on && e.status === 'fired' && (
                  <button type="button" disabled={busy === e.id}
                    onClick={() => void act(e.id, () => api.alerts.rearm(e.id), (l) => l.map((x) => (x.id === e.id ? { ...x, status: 'armed', at: null, message: null } : x)))}>
                    Re-arm
                  </button>
                )}
                <button type="button" onClick={() => onShow(e.symbol)} aria-label={`Show ${label} on the chart`}>Show</button>
                <button type="button" className="alerts-remove" disabled={busy === e.id} aria-label={`Remove ${label} alert`} title="Remove the alert (the drawing stays)"
                  onClick={() => void act(e.id, () => changeAlert(e.id, null), (l) => l.filter((x) => x.id !== e.id))}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                    <path d="M5 5l10 10M15 5L5 15" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Modal title="Alerts" onClose={onClose} className="alerts-dialog">
      {error && <p className="form-error" role="alert">{error}</p>}
      {body}
      <p className="alerts-note">Checked every 30 seconds while Chartmate is running. Add one from a drawing’s bell.</p>
    </Modal>
  );
}
