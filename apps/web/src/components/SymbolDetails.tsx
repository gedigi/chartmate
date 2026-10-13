import type { Bar, Quote, SymbolId, SymbolInfo } from '@chartmate/shared';
import { useEffect, useState, type JSX } from 'react';
import { api } from '../api/client';
import { compactNumber, MARKET_STATUS_LABEL, marketStatus, symbolStats } from '../state/symbolStats';
import { DayRangeGauge } from './RangeGauge';

export interface SymbolDetailsProps {
  symbol: SymbolId;
  info: SymbolInfo | null;
}

const DAY = 86_400_000;
const QUOTE_POLL_MS = 15_000;
const BARS_POLL_MS = 5 * 60_000;

const fmt = (v: number, precision: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });

/**
 * The detail panel at the bottom of the watchlist rail for the open symbol: name, market status, the day range (a
 * ruled gauge with the open → now move), and open / previous close / volume / 30-day average volume / 52-week high and
 * low. Everything comes from the existing daily bars and quote endpoints; nothing is shown until they answer.
 */
export function SymbolDetails({ symbol, info }: SymbolDetailsProps): JSX.Element | null {
  const [data, setData] = useState<{ symbol: SymbolId; bars: Bar[] } | null>(null);
  const [quote, setQuote] = useState<{ symbol: SymbolId; quote: Quote } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let canceled = false;
    const ctl = new AbortController();
    const load = () => {
      const t = Date.now();
      api.bars({ symbol, tf: '1D', session: 'rth', from: t - 370 * DAY, to: t + DAY }, ctl.signal).then(
        (r) => { if (!canceled) setData({ symbol, bars: r.bars }); },
        () => { /* keep what is shown */ },
      );
    };
    const poll = () => {
      if (document.hidden) return;
      api.quotes([symbol]).then(
        (qs) => {
          if (canceled) return;
          const q = qs.find((x) => x.id === symbol);
          if (q) setQuote({ symbol, quote: q });
          setNow(Date.now());
        },
        () => { /* keep the previous quote */ },
      );
    };
    load();
    poll();
    const bt = setInterval(load, BARS_POLL_MS);
    const qt = setInterval(poll, QUOTE_POLL_MS);
    return () => {
      canceled = true;
      ctl.abort();
      clearInterval(bt);
      clearInterval(qt);
    };
  }, [symbol]);

  if (!info || info.id !== symbol) return null;
  const q = quote?.symbol === symbol ? quote.quote : undefined;
  const stats = data?.symbol === symbol ? symbolStats(data.bars, q, now) : null;
  const status = marketStatus(info.assetClass, q, now);
  const p = info.pricePrecision;
  const dir = !stats ? '' : stats.price > stats.open ? 'up' : stats.price < stats.open ? 'down' : '';
  const title = info.assetClass === 'basket' ? info.name : info.ticker;
  const name = info.assetClass === 'basket' ? 'Basket' : info.name;

  return (
    <section className="symbol-details" aria-label={`${title} details`}>
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
