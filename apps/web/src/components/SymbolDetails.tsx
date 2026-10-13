import type { Bar, SymbolId, SymbolInfo } from '@chartmate/shared';
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import { api } from '../api/client';
import { cachedQuote, lastQuote, publishQuotes, subscribeQuotes } from '../state/quoteStore';
import { compactNumber, MARKET_STATUS_LABEL, marketStatus, symbolStats } from '../state/symbolStats';
import { DayRangeGauge } from './RangeGauge';

export interface SymbolDetailsProps {
  symbol: SymbolId;
  info: SymbolInfo | null;
}

const DAY = 86_400_000;
export const QUOTE_POLL_MS = 15_000;
export const BARS_POLL_MS = 5 * 60_000;
/** A quote the watchlist fetched this recently is reused instead of fetching it again. */
const QUOTE_FRESH_MS = QUOTE_POLL_MS + 5_000;

const fmt = (v: number, precision: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });

type BarsState = { symbol: SymbolId; status: 'ready'; bars: Bar[] } | { symbol: SymbolId; status: 'error' };

/**
 * The detail panel at the bottom of the watchlist rail for the open symbol: name, market status, the day range (a
 * ruled gauge with the open → now move), and open / previous close / volume / 30-day average volume / 52-week high and
 * low. Everything comes from the existing daily bars and quote endpoints: the quote is the watchlist's when it has
 * a fresh one (shared quote store), else polled here; polling pauses while the page is hidden.
 */
export function SymbolDetails({ symbol, info }: SymbolDetailsProps): JSX.Element | null {
  const [bars, setBars] = useState<BarsState | null>(null);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const quote = useSyncExternalStore(subscribeQuotes, () => lastQuote(symbol));

  // Daily bars: on symbol change / retry, then every 5 min while visible.
  useEffect(() => {
    let canceled = false;
    const ctl = new AbortController();
    const load = () => {
      const t = Date.now();
      api.bars({ symbol, tf: '1D', session: 'rth', from: t - 370 * DAY, to: t + DAY }, ctl.signal).then(
        (r) => { if (!canceled) setBars({ symbol, status: 'ready', bars: r.bars }); },
        () => { if (!canceled) setBars((cur) => (cur?.symbol === symbol && cur.status === 'ready' ? cur : { symbol, status: 'error' })); },
      );
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, BARS_POLL_MS);
    return () => {
      canceled = true;
      ctl.abort();
      clearInterval(t);
    };
  }, [symbol, reload]);

  // Quote: the watchlist's when fresh, else fetched here (published for everyone); also ticks the status clock.
  useEffect(() => {
    let canceled = false;
    const poll = () => {
      if (document.hidden) return;
      setNow(Date.now());
      if (cachedQuote(symbol, QUOTE_FRESH_MS)) return;
      api.quotes([symbol]).then((qs) => { if (!canceled) publishQuotes(qs); }, () => { /* keep the previous quote */ });
    };
    poll();
    const t = setInterval(poll, QUOTE_POLL_MS);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      canceled = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [symbol]);

  if (!info || info.id !== symbol) return null;
  const q = quote?.id === symbol ? quote : undefined;
  const current = bars?.symbol === symbol ? bars : null;
  const stats = current?.status === 'ready' ? symbolStats(current.bars, q, now) : null;
  const status = marketStatus(info.assetClass, q, now);
  const p = info.pricePrecision;
  // Direction vs the previous close, like the watchlist row's change pill (the open when there is no previous bar).
  const ref = stats ? stats.prevClose ?? stats.open : 0;
  const dir = !stats ? '' : stats.price > ref ? 'up' : stats.price < ref ? 'down' : '';
  const title = info.assetClass === 'basket' ? info.name : info.ticker;
  const name = info.assetClass === 'basket' ? 'Basket' : info.name;

  return (
    <section className="symbol-details" aria-label={`${title} details`} aria-busy={current === null}>
      <div className="sd-head">
        <span className="sd-ticker">{title}</span>
        {name !== title && <span className="sd-name" title={name}>{name}</span>}
      </div>
      {status && (
        <div className="sd-status">
          <span className={`sd-dot${status === 'open' || status === 'always' ? ' live' : ''}`} aria-hidden="true" />
          {MARKET_STATUS_LABEL[status]}
        </div>
      )}
      {current === null && <p className="sd-note">Loading details…</p>}
      {current?.status === 'error' && (
        <p className="sd-note">
          Couldn&apos;t load details.{' '}
          <button type="button" className="sd-retry" onClick={() => { setBars(null); setReload((r) => r + 1); }}>Retry</button>
        </p>
      )}
      {stats && (
        <>
          <div className="sd-range">
            <div className="sd-range-label"><span>Day range</span><span className="num">{fmt(stats.price, p)}</span></div>
            <DayRangeGauge open={stats.open} value={stats.price} low={stats.dayLow} high={stats.dayHigh} dir={dir} />
            <div className="sd-range-ends"><span>{fmt(stats.dayLow, p)}</span><span>{fmt(stats.dayHigh, p)}</span></div>
          </div>
          <dl className="sd-stats">
            <div className="sd-stat"><dt>Open</dt><dd>{fmt(stats.open, p)}</dd></div>
            <div className="sd-stat"><dt>Prev close</dt><dd>{stats.prevClose === null ? '—' : fmt(stats.prevClose, p)}</dd></div>
            <div className="sd-stat"><dt>Volume</dt><dd>{compactNumber(stats.volume)}</dd></div>
            <div className="sd-stat"><dt>Avg vol 30d</dt><dd>{stats.avgVolume30 === null ? '—' : compactNumber(stats.avgVolume30)}</dd></div>
            <div className="sd-stat"><dt>52w high</dt><dd>{fmt(stats.high52, p)}</dd></div>
            <div className="sd-stat"><dt>52w low</dt><dd>{fmt(stats.low52, p)}</dd></div>
          </dl>
        </>
      )}
    </section>
  );
}
