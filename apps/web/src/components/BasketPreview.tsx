import {
  buildBasketBars, computeVersionUnits, parseDateString, utcDateString, versionMarkers,
  type Bar, type BasketVersion, type SymbolId,
} from '@chartmate/shared';
import { useEffect, useRef, useState, type JSX } from 'react';
import { api, errorMessage } from '../api/client';

const DAY = 86_400_000;
/** Server cap is 4000 bars per request; stay a little under it for 1D. */
const MAX_SPAN = 3990 * DAY;
/**
 * History fetched before T0: covers the prior close of the start date and a year of simulated pre-start history
 * (version 0's holdings applied to earlier prices, as the server does).
 */
export const PREVIEW_HISTORY_MS = 365 * DAY;
export const PREVIEW_DEBOUNCE_MS = 600;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Fetches 1D RTH bars for [from, to), split into chunks under the server's span cap; ascending, de-duplicated. */
export async function fetchDailyRange(symbol: SymbolId, from: number, to: number, signal?: AbortSignal): Promise<Bar[]> {
  const chunks: Promise<Bar[]>[] = [];
  for (let a = from; a < to; a += MAX_SPAN) {
    const b = Math.min(a + MAX_SPAN, to);
    chunks.push(api.bars({ symbol, tf: '1D', session: 'rth', from: a, to: b }, signal).then((r) => r.bars));
  }
  const out: Bar[] = [];
  for (const bars of await Promise.all(chunks)) {
    for (const bar of bars) {
      const prev = out[out.length - 1];
      if (prev && bar.ts <= prev.ts) continue;
      out.push(bar);
    }
  }
  return out;
}

interface CacheEntry { from: number; to: number; bars: Bar[] }
type Cache = Map<SymbolId, CacheEntry>;

async function loadDaily(cache: Cache, symbol: SymbolId, from: number, to: number, signal: AbortSignal): Promise<Bar[]> {
  const hit = cache.get(symbol);
  if (hit && hit.from <= from && hit.to >= to - DAY) return hit.bars;
  const bars = await fetchDailyRange(symbol, from, to, signal);
  cache.set(symbol, { from, to, bars });
  return bars;
}

interface PreviewResult { bars: Bar[]; notices: string[]; markers: number[]; startTs: number }
type State =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: PreviewResult };

export interface BasketPreviewProps {
  /** Versions to preview (ascending); null when the form is not valid yet. */
  versions: BasketVersion[] | null;
  baseValue: number;
}

/**
 * Client-side preview of an unsaved basket: fetches each constituent's 1D bars and runs the same shared engine
 * the server uses (computeVersionUnits + buildBasketBars). Debounced; stale fetches are aborted; bars are cached
 * per symbol for the lifetime of the component.
 */
export function BasketPreview({ versions, baseValue }: BasketPreviewProps): JSX.Element {
  const cache = useRef<Cache>(new Map());
  const [state, setState] = useState<State>({ kind: 'empty' });
  const [pending, setPending] = useState(false);
  const key = versions ? JSON.stringify(versions) : '';

  useEffect(() => {
    if (!key) {
      setState({ kind: 'empty' });
      setPending(false);
      return;
    }
    const vs = JSON.parse(key) as BasketVersion[];
    const ctl = new AbortController();
    setPending(true);
    const timer = setTimeout(() => {
      run(vs, baseValue, cache.current, ctl.signal).then(
        (result) => {
          if (ctl.signal.aborted) return;
          setState({ kind: 'ready', result });
          setPending(false);
        },
        (err: unknown) => {
          if (ctl.signal.aborted || isAbort(err)) return;
          setState({ kind: 'error', message: errorMessage(err) });
          setPending(false);
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [key, baseValue]);

  return (
    <div className={`basket-preview${pending ? ' pending' : ''}`} data-testid="basket-preview" aria-busy={pending}>
      <h3 className="panel-title">Preview {pending && <span className="muted">· updating…</span>}</h3>
      {!key && <p className="muted">Enter a valid basket to see a preview.</p>}
      {key && state.kind === 'empty' && <p className="muted">Computing preview…</p>}
      {key && state.kind === 'error' && <p className="form-error">{state.message}</p>}
      {key && state.kind === 'ready' && <PreviewChart result={state.result} baseValue={baseValue} />}
    </div>
  );
}

async function run(versions: BasketVersion[], baseValue: number, cache: Cache, signal: AbortSignal): Promise<PreviewResult> {
  const t0 = parseDateString(versions[0]!.effectiveFrom);
  const from = t0 - PREVIEW_HISTORY_MS;
  const to = Math.ceil((Date.now() + DAY) / DAY) * DAY;
  const ids = [...new Set(versions.flatMap((v) => Object.keys(v.weights)))];
  const loaded = await Promise.all(ids.map((id) => loadDaily(cache, id, from, to, signal)));
  const daily: Record<SymbolId, Bar[]> = {};
  ids.forEach((id, i) => { daily[id] = loaded[i]!; });
  const units = computeVersionUnits(versions, daily, baseValue);
  const bars = buildBasketBars(units, ids.map((id) => ({ id, bars: daily[id]! })), { simulate: true });
  const notices = [...units.notices];
  if (bars.some((b) => b.simulated)) notices.push(`Before ${utcDateString(units.startTs)}: simulated with the starting holdings.`);
  return { bars, notices, markers: versionMarkers(units).map((m) => m.ts), startTs: units.startTs };
}

const W = 600;
const H = 160;
const PAD_Y = 8;

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function PreviewChart({ result, baseValue }: { result: PreviewResult; baseValue: number }): JSX.Element {
  const { bars, notices, markers } = result;
  const noticeList = notices.length > 0 && (
    <ul className="preview-notices">{notices.map((n) => <li key={n}>{n}</li>)}</ul>
  );
  if (bars.length < 2) {
    return (
      <>
        {noticeList}
        <p className="muted">Not enough history yet to draw a line (starts {utcDateString(result.startTs)}).</p>
      </>
    );
  }
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const t0 = first.ts;
  const span = last.ts - t0 || 1;
  const range = max - min || 1;
  const x = (ts: number) => ((ts - t0) / span) * W;
  const y = (v: number) => PAD_Y + (1 - (v - min) / range) * (H - 2 * PAD_Y);
  const pt = (b: Bar) => `${x(b.ts).toFixed(1)},${y(b.close).toFixed(1)}`;
  // One line throughout: simulated pre-start history is marked only by the Start line and the notice.
  const simulated = bars.some((b) => b.simulated);
  const startTs = result.startTs;
  const showStart = startTs > t0 && startTs <= last.ts;
  const change = (last.close / baseValue - 1) * 100;
  const up = last.close >= baseValue; // performance since the start (simulated history excluded)

  return (
    <>
      {noticeList}
      <div className="preview-summary">
        <span>{fmt(baseValue)} → <strong>{fmt(last.close)}</strong></span>
        <span className={up ? 'up' : 'down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span>
      </div>
      <div className="preview-chart-wrap">
        <div className="preview-axis">
          <span>{fmt(max)}</span>
          <span>{fmt(min)}</span>
        </div>
        <div className="preview-plot">
        <svg
          data-testid="basket-preview-chart"
          className={`preview-chart ${up ? 'up' : 'down'}`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Basket preview from ${utcDateString(first.ts)} to ${utcDateString(last.ts)} (starts ${utcDateString(startTs)}${simulated ? ', simulated before' : ''}): low ${fmt(min)}, high ${fmt(max)}`}
        >
          {markers.filter((m) => m >= t0 && m <= last.ts).map((m) => (
            <line key={m} className="preview-marker" x1={x(m)} x2={x(m)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
          ))}
          {showStart && (
            <line className="preview-start-marker" x1={x(startTs)} x2={x(startTs)} y1={0} y2={H} strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke">
              <title>Start {utcDateString(startTs)}</title>
            </line>
          )}
          <polyline className="preview-line" points={bars.map(pt).join(' ')} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* HTML, not SVG text: the SVG is stretched (preserveAspectRatio="none"). */}
        {showStart && (
          <span className="preview-start-label" data-testid="basket-preview-start-label" aria-hidden="true"
            style={{ left: `${(x(startTs) / W) * 100}%` }}>Start</span>
        )}
        </div>
      </div>
      <div className="preview-dates">
        <span>{utcDateString(first.ts)}</span>
        <span>{utcDateString(last.ts)}</span>
      </div>
    </>
  );
}
