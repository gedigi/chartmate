# Chartmate — Design Spec

> **Historical document.** The original design spec as written on 2026-10-11, before implementation; it is not maintained. The code, `README.md` and `AGENTS.md` describe the current state.

Date: 2026-10-11
Status: Draft, awaiting review

## 1. Purpose

A personal TradingView alternative: fast candlestick charts for US stocks/ETFs and crypto, a library of
configurable indicators, drawing tools, a watchlist, and — the differentiating feature — **custom
baskets/indices** whose price is tracked and charted like any other symbol.

Runs locally on a laptop and can also be deployed as a hosted single-user web app.

### Success criteria

- Search any US stock/ETF or major crypto pair and chart it on any of the 10 supported timeframes.
- Add/configure/remove indicators; draw on the chart; everything persists across reloads.
- Create a basket with % weights at a (possibly past) start date, see its full chained history immediately,
  edit its weights later and see the chart continue without a jump.
- The same Docker image runs locally and hosted.

## 2. Scope

### In v1

- Markets: US stocks/ETFs (incl. pre-market and after-hours), crypto (USDT pairs).
- Timeframes: 1M, 1W, 1D, 4h, 2h, 1h, 30m, 15m, 5m, 1m.
- Polling refresh of the last bar (not streaming).
- Built-in indicators with parameter editing; custom indicators added as TypeScript files in the repo.
- Drawing tools.
- Watchlist.
- Custom baskets (target-% weights, buy-and-hold per version, chained versions, backdated start).
- RTH / ETH session toggle for stocks.
- Optional single-user password for hosted mode.

### Deferred to v2

- Compare overlay (other symbols/baskets as % change on the same chart)
- Price alerts
- FX data
- Multi-chart grid layouts
- Multi-user accounts
- In-app indicator scripting

## 3. Architecture

TypeScript pnpm monorepo:

```
packages/shared   types (Bar, SymbolId, Timeframe, Session, Basket, BasketVersion) + pure functions:
                  basket math, resampling, session filtering
apps/server       Fastify API, provider adapters, bar cache, basket service, persistence (Drizzle)
apps/web          React + Vite UI; KLineChart (klinecharts) behind a ChartAdapter
```

Single Docker image: the server serves the built web app as static files.

### 3.1 Symbols

Symbols are source-prefixed strings: `stock:AAPL`, `crypto:BTCUSDT`, `basket:<id>`. The prefix routes to a
provider (or to the basket service). Adding FX or a paid stock provider later means adding one adapter.

### 3.2 Provider interface

```ts
interface MarketDataProvider {
  id: string;                                   // 'yahoo' | 'binance' | 'coinbase'
  searchSymbols(q: string): Promise<SymbolInfo[]>;
  getBars(symbol: string, tf: NativeTimeframe, from: number, to: number, opts: { extended: boolean }): Promise<Bar[]>;
  getLatest(symbol: string, tf: NativeTimeframe, opts: { extended: boolean }): Promise<Bar | null>;
}

type Bar = { ts: number; open: number; high: number; low: number; close: number; volume: number;
             session?: 'pre' | 'regular' | 'post' };
```

- **yahoo** (stocks/ETFs) via `yahoo-finance2`. Intraday requests always fetch with pre/post included; each bar
  is tagged with its session based on NYSE hours (America/New_York, DST-aware).
- **binance** (crypto) via public REST klines. **coinbase** as fallback where Binance is geo-blocked; the active
  crypto provider is chosen by config.
- Free-source intraday history limits (approx., Yahoo): 1m ≈ 7–30 days, 5m–30m ≈ 60 days, 1h ≈ 730 days.
  These are surfaced in the UI rather than hidden.

### 3.3 Timeframes

- Native (fetched): 1m, 5m, 15m, 30m, 1h, 1D, 1W, 1M.
- Derived (server-side resample from 1h): 2h, 4h. Session filter is applied **before** resampling.
- 1D and above always use official regular-session OHLC regardless of the RTH/ETH toggle.

### 3.4 Bar cache

- Table `bars(symbol, tf, ts, open, high, low, close, volume, session)` with PK `(symbol, tf, ts)`.
- Stocks' intraday bars are cached with extended hours included; RTH views filter `session = 'regular'`.
- On request, compute missing ranges against the cache and fetch only gaps.
- Closed bars are immutable once cached; the currently-forming bar is always re-fetched.
- One request queue per provider with rate limiting and exponential backoff.

### 3.5 Persistence

Drizzle ORM. SQLite by default (local); Postgres when `DATABASE_URL` is a postgres URL (hosted).

Tables: `bars`, `baskets`, `basket_versions`, `watchlist_items`, `layouts`, `drawings`.

### 3.6 API

```
GET  /api/symbols/search?q=
GET  /api/bars?symbol=&tf=&from=&to=&session=rth|eth
GET  /api/latest?symbol=&tf=&session=
GET/POST/PUT/DELETE /api/baskets[/:id]
POST /api/baskets/:id/versions          (append a version)
GET/PUT /api/watchlist
GET/PUT /api/layouts/:symbol            (indicators + chart settings)
GET/PUT /api/drawings/:symbol
```

Baskets are served from `/api/bars` with `symbol=basket:<id>`; the client does not special-case them for
charting. Errors use a uniform `{ code, message }` body. Responses for stale data include a `stale: true` flag.

Hosted auth: if `CHARTMATE_PASSWORD` is set, a login page issues an HTTP-only session cookie; all `/api` routes require
it. Unset → no auth (local mode).

## 4. Basket engine

### 4.1 Model

```ts
type Basket = { id: string; name: string; baseValue: number /* default 100 */; versions: BasketVersion[] };
type BasketVersion = { effectiveFrom: number /* ts */; weights: Record<SymbolId, number> /* sums to 1 */ };
```

- Versions are append-only and strictly increasing in `effectiveFrom`.
- The first version's `effectiveFrom` is T0 and may be any past date.
- A new version's `effectiveFrom` defaults to now and may be backdated, but must be after the previous version.
- Weights must be positive and sum to 1 (UI offers normalize). Baskets cannot contain other baskets in v1.

### 4.2 Math (buy-and-hold per version, chained)

For version k starting at time Tk, with index level `L(Tk)`:

```
units_i^k = w_i^k × L(Tk) / P_i(Tk)       where L(T0) = baseValue
Index(t)  = Σ_i units_i^k × P_i(t)         for t in [Tk, Tk+1)
```

Each new version is sized off the current index level, so the series is continuous across edits.
`P_i(Tk)` is the close of the last bar at or before Tk on the timeframe being computed (so a version's units are
computed per timeframe from that timeframe's data).

### 4.3 Bar construction

- **Alignment:** union of all constituents' bar timestamps; a constituent with no bar at a timestamp
  forward-fills its last close (O=H=L=C=last close).
- **ETH mode:** stock legs use extended-hours bars where present; RTH mode filters them out first (and stock legs
  forward-fill outside the regular session).
- **OHLC:** `Open = Σ units × open_i`, `Close = Σ units × close_i` (exact).
  `High = Σ units × high_i`, `Low = Σ units × low_i` — an upper/lower bound, not the true intrabar extreme. The UI
  notes this on intraday basket charts.
- **Volume:** omitted (0) for baskets.
- **History start:** the basket series begins at the latest "first available bar" among constituents, if that is
  after T0; the UI shows a notice naming the limiting constituent.
- **Markers:** each version boundary is returned as a marker and rendered on the chart.

### 4.4 Implementation

Pure functions in `packages/shared/src/basket.ts`: `computeUnits`, `alignSeries`, `buildBasketBars`. The server's
basket service loads constituent bars through the same cache and memoizes results keyed by
`(basketId, versionCount, tf, session, range)`.

Currency: all prices treated as USD; USDT ≈ USD in v1.

## 5. Frontend

### 5.1 Layout

- **Top bar:** symbol search (stocks, crypto, baskets), timeframe buttons (10), chart type (candles/line/area),
  RTH/ETH toggle (stocks and baskets containing stocks), indicators button.
- **Left toolbar:** drawing tools.
- **Center:** chart with indicator panes beneath.
- **Right sidebar:** watchlist — last price, daily % change, sparkline; click to load.
- **Baskets page:** list + editor (symbol search, weight inputs, normalize-to-100%, T0 picker, live preview chart,
  "edit weights" → new version with effective date, version history).
- Dark theme default; light theme available.

### 5.2 ChartAdapter

Only `apps/web/src/chart/ChartAdapter.ts` imports `klinecharts`. Interface:

```ts
interface ChartAdapter {
  setData(bars: Bar[]): void;
  updateLast(bar: Bar): void;
  setMarkers(markers: Marker[]): void;
  setSessionShading(enabled: boolean): void;
  addIndicator(spec: IndicatorSpec): string;
  updateIndicator(id: string, params: Record<string, unknown>): void;
  removeIndicator(id: string): void;
  startDrawing(tool: DrawingTool): void;
  serializeDrawings(): DrawingState[];
  restoreDrawings(state: DrawingState[]): void;
  destroy(): void;
}
```

Allows a later swap to TradingView Advanced Charts or Lightweight Charts by replacing this one module.

### 5.3 Indicators

- KLineChart built-ins: MA, EMA, BOLL, SAR, VOL (overlay); MACD, RSI, KDJ, CCI, OBV, WR, DMI, and others (panes).
- Added via `registerIndicator`: VWAP (session-anchored), ATR, SMA.
- Per-indicator settings dialog (periods, source, colors).
- Custom indicators: one TS file each in `apps/web/src/indicators/`, auto-registered.
- Indicators compute on the displayed series (respecting RTH/ETH).

### 5.4 Drawings

KLineChart overlays: trendline (segment), ray, extended line, horizontal line, vertical line, price line, parallel
channel, Fibonacci retracement, text annotation. Select/drag/delete/lock, clear-all. Stored per symbol in
time/price coordinates so they survive timeframe changes.

### 5.5 Refresh

Poll `/api/latest` every 5 s for crypto and every 15 s for stocks during pre/regular/post sessions (ETH) or regular
session (RTH); idle otherwise. Baskets poll at the fastest interval among constituents.

### 5.6 Persistence

Server-side: layouts (indicators + settings, chart type, session mode), drawings, watchlist, baskets — debounced
autosave (~1 s). localStorage only for pure UI preferences (theme, panel widths).

## 6. Error handling

- Provider failure / rate-limit: serve cached data with `stale: true`; UI shows a stale badge; backoff retries.
- Unknown symbol: inline error in search.
- Basket constituent with no data for the range: basket still renders from available start; warning names the
  constituent. Constituent with no data at all: basket save is rejected with a clear message.
- Invalid basket input (weights ≠ 100%, non-increasing dates): rejected client- and server-side.

## 7. Testing

- **Unit (Vitest), `packages/shared`:** basket math (single version, chained versions continuity, backdated T0,
  mixed stock+crypto forward-fill, RTH vs ETH, late-starting constituent, weight validation); resampling 1h→2h/4h
  with session filtering; session tagging across DST transitions.
- **Server:** cache gap computation; provider adapters against recorded fixtures (no live network in tests); API
  route tests.
- **E2E (Playwright, one happy path):** search → chart → add RSI → draw a trendline → reload, drawing and RSI
  persist → create basket → basket chart renders with version marker after editing weights. Runs against fixture
  providers.

## 8. Open risks

- Free Yahoo access is unofficial and may break or throttle; mitigated by the provider interface and caching.
- Binance geo-restrictions for US users; mitigated by Coinbase fallback.
- KLineChart docs are partly Chinese and its community is smaller; mitigated by isolating it behind ChartAdapter.
