# altv

A self-hosted, single-user alternative to TradingView: candlestick charts for stocks and crypto,
indicators, drawing tools, watchlists, and custom **baskets** (weighted synthetic instruments).
Free data sources only (Yahoo Finance for stocks, Binance or Coinbase for crypto), cached in
SQLite or Postgres.

Monorepo (pnpm): `packages/shared` (types, resampling, basket math), `apps/server` (Fastify API),
`apps/web` (React + KLineChart).

## Quick start (development)

Requires Node >= 22 and pnpm 8.

```sh
pnpm i && pnpm dev
```

This starts the API server (`tsx watch`, port 8787) and the Vite dev server in parallel. Open
http://localhost:5173 (Vite's default port); Vite proxies `/api/*` to `http://localhost:8787`
(see `apps/web/vite.config.ts`). If you change the server's `PORT`, update that proxy target too.

The SQLite default `sqlite:./data/altv.db` is resolved against the **server's working directory**, which
for `pnpm dev` is `apps/server/`, so dev data ends up in `apps/server/data/altv.db`.

## Production, locally

```sh
pnpm build && pnpm --filter @altv/server start
```

Open http://localhost:8787. The server also serves the built web app. It listens on `127.0.0.1` by
default; set `HOST=0.0.0.0` to reach it from other machines (the Docker image already does).

`pnpm --filter @altv/server start` runs with `apps/server/` as its working directory, so the default
`sqlite:./data/altv.db` is `apps/server/data/altv.db`. The path is relative to wherever the server is
started, so for anything you care about use an absolute path, e.g.
`DATABASE_URL=sqlite:/home/me/altv/altv.db pnpm --filter @altv/server start` (the directory is created
if missing).

## Docker

```sh
docker build -t altv .
docker run -p 8787:8787 -v altv-data:/data altv
```

The image sets `HOST=0.0.0.0` so the published port is reachable. It runs as the non-root `node` user (uid/gid 1000), stores SQLite at `/data/altv.db` (mount a
volume on `/data`) and has a built-in healthcheck on `/api/health` (it honours `PORT`).

A named volume (as above) just works. If you bind-mount a host directory instead, it must be writable by
uid 1000, otherwise the server cannot create the database:

```sh
mkdir -p ./altv-data && sudo chown 1000:1000 ./altv-data
docker run -p 8787:8787 -v "$PWD/altv-data:/data" altv
```

## Hosted setup (Postgres + password)

```sh
docker run -d -p 8787:8787 \
  -e DATABASE_URL=postgres://user:pass@db-host:5432/altv \
  -e ALTV_PASSWORD='a-long-random-passphrase' \
  -e ALTV_SESSION_SECRET="$(openssl rand -hex 32)" \
  -e ALTV_TRUST_PROXY=1 \
  altv
```

Put it behind an HTTPS reverse proxy. Notes on login security:

- Setting `ALTV_PASSWORD` turns on a login page. Use a strong password.
- Set `ALTV_SESSION_SECRET` to a random value (as above). If unset, the secret is derived from the
  password, so a leaked session cookie would let someone guess the password offline.
- Login attempts are rate limited: 10 failures per IP per 15 minutes, plus a global limit of 100
  failures per 15 minutes. The global limit means a determined attacker can lock *you* out for a while.
- Behind a reverse proxy set `ALTV_TRUST_PROXY`, otherwise every client appears to come from the
  proxy's IP and they all share one rate-limit budget.
- The session cookie lasts 30 days. Changing `ALTV_SESSION_SECRET` (or the password, if the secret
  is derived from it) revokes all existing sessions.
- Serve over HTTPS only.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address. Use `0.0.0.0` (or `::`) to accept connections from other hosts. |
| `DATABASE_URL` | `sqlite:./data/altv.db` (Docker: `sqlite:/data/altv.db`) | `sqlite:<path>` or `postgres://…`. An empty SQLite path (`sqlite:`) is rejected. |
| `ALTV_PASSWORD` | unset (no auth) | Enables password login. |
| `ALTV_SESSION_SECRET` | derived from the password | Cookie signing secret, min 16 chars. Set explicitly in production. |
| `ALTV_TRUST_PROXY` | unset (`false`) | `true`, a hop count (e.g. `1`), or an IP/CIDR list of trusted proxies. |
| `CRYPTO_PROVIDER` | `binance` | `binance` or `coinbase`. |
| `BINANCE_BASE_URL` | `https://data-api.binance.vision` | Alternate Binance-compatible endpoint. |
| `ALTV_PROVIDERS` | `live` | `fixture` serves deterministic synthetic data (tests/demos, no network). |
| `ALTV_WEB_DIST` | `apps/web/dist` (Docker: `/app/web`) | Directory of the built web app. |

## Data sources and caveats

Stocks come from Yahoo Finance's free endpoints, which limit how far back intraday data goes:

| Timeframe | Approximate history |
| --- | --- |
| 1m | ~29 days |
| 5m, 15m, 30m | ~59 days |
| 1h (and 2h/4h, built from 1h) | ~729 days |
| 1D, 1W, 1M | unlimited |

Requests beyond the limit return what exists (no error). Intraday stock data includes pre- and
post-market bars; use the RTH/ETH toggle to filter. 1W/1M are resampled from daily bars, and 2h/4h
from 1h.

Crypto symbols are `crypto:<BASE>` priced in USD (Binance `BTCUSDT`, Coinbase `BTC-USD`). Binance
blocks some regions (e.g. the US): set `CRYPTO_PROVIDER=coinbase`, or point `BINANCE_BASE_URL` at an
endpoint reachable from your host. Switching providers does not invalidate saved baskets, watchlists
or drawings. If a provider is down or rate limiting, cached bars are served marked `stale`.

Fetched history is cached in the database and not re-downloaded. Yahoo's daily bars are split- and
dividend-adjusted *as of the day they were fetched*, so after a stock split (or dividend) the cached
history before it is not refreshed: the chart shows a jump at the split, and baskets holding that stock
size its units off by the split factor. To refetch a symbol, delete its cache (see
[Troubleshooting](#troubleshooting)).

## Charts

- **Timeframes** 1m … 1M, chart types candles / bars / line / area, light and dark themes.
- **RTH / ETH toggle** for stocks (and baskets containing a stock): RTH shows regular-hours bars only,
  ETH adds pre- and post-market bars, shaded on intraday stock charts (basket charts are not shaded).
  It is hidden for crypto, which trades around the clock.
- **Indicators**: up to **30** per chart (the picker stops adding beyond that and the server rejects
  larger layouts). The indicator set is remembered per symbol; timeframe, session and chart type are
  global.
- **Drawings** are saved per symbol on the server (debounced ~1 s after each change). Points are stored in
  time/price coordinates (bar timestamp + price), not pixels, so they stay anchored to the same price and
  time across timeframes, zoom levels and window sizes.
- **Chart appearance** (gear icon in the top bar): candle up/down colours, body style (filled, hollow,
  hollow up, hollow down; OHLC bars use the colours only), line/area colour and width, and the default
  style (colour, width, solid/dashed) of new drawings. It is global (stored in the `default` layout, not
  per symbol), applies live, survives theme switches, and "Reset to defaults" returns to the theme colours.
- **Indicator settings** also set each line's width (1–4 px) and solid/dashed style, and the up/down bar
  colours of histogram indicators (VOL, MACD, AO).
- **Drawing styles**: selecting a drawing shows a small style bar at the top of the chart (colour, width,
  solid/dashed; text annotations: colour and font size). Styles are saved with the drawing; drawings
  without their own style follow the default drawing style. Legacy drawings with non-hex colours (or other
  unsupported style values) fall back to the default style on their next save.
- **⌘ magnet**: hold **⌘** (macOS) or **Ctrl** (other systems) while placing or dragging a drawing to snap
  it to the nearest open/high/low/close (strong magnet); releasing the key returns to the toolbar's magnet
  setting.

## Baskets

A basket is a weighted set of stocks/crypto charted as one synthetic instrument.

- A basket has one or more **versions**; each has weights and an `effective from` calendar date.
  A version applies from 00:00 UTC of that date, on every timeframe.
- When a version starts, each constituent is sized in units at the **prior trading close**, so the
  basket value is continuous across a rebalance (no jump).
- Versions are **chained**: the series continues from the previous version's last value, giving one
  continuous index.
- On intraday timeframes, the basket bar's high/low is an **approximation** (derived from
  constituent highs/lows, which need not occur at the same time); open/close are exact.
- The basket starts at the first date on which *all* constituents have data (a prior close). If a
  constituent lists after the requested start, the chart starts later and a notice names the
  limiting symbol.
- **Simulated history before the start**: bars before the basket's start are computed with the
  *starting* holdings (version 0's units) held fixed backwards, so a basket created today still shows
  history. They begin once every starting constituent has data, reach the base value at the start (no
  jump), are shaded on the chart, and a `Start` marker plus a notice ("Before <date>: simulated with the
  starting holdings.") make the boundary explicit. Resampled bars (weekly, monthly, 2h/4h) count as
  simulated only when all their input bars are. Quotes and sparklines include this history.
- A basket with a single version can change its start date in the editor.
- Intraday basket bars use the NYSE session grid when every constituent is a stock, and the UTC grid
  as soon as any version holds crypto. Appending a crypto version to a stock-only basket therefore
  re-grids its **whole** intraday history to UTC buckets (daily and above are unaffected).
- A version holds at most 50 constituents, and its effective date must lie between 1970-01-01 and
  tomorrow (UTC).

## Troubleshooting

**Missing days in daily/weekly/monthly history (caches created before this fix).** Earlier builds could
drop a stock's daily bar when a chart requested a range starting between midnight UTC and the US open,
and then never refetch it (the range was recorded as cached). Fresh installs are not affected. To repair
an existing database, clear the fetch log so missing ranges are fetched again (bars already stored are
kept and simply re-upserted):

```sql
DELETE FROM coverage;
```

**Stale history after a stock split or dividend.** Delete that symbol's cache, then reload the chart:

```sql
DELETE FROM bars WHERE symbol = 'stock:NVDA';
DELETE FROM coverage WHERE symbol = 'stock:NVDA';
```

For SQLite stop the server first and run these with `sqlite3 <path-to-altv.db>`; for Postgres use `psql`
against `DATABASE_URL`. Restart the server afterwards so baskets recompute their (cached) units from the
corrected history.

## Custom indicators

Every file in `apps/web/src/chart/indicators/custom/*.ts` is a custom indicator. Each one must
`export default` an object `{ template, catalog }` (type `CustomIndicator` from
`apps/web/src/chart/indicators/types.ts`):

- `template`: a KLineChart indicator template (what you would pass to `registerIndicator`).
- `catalog`: how it appears in the indicator picker and settings dialog (label, pane, default params and
  their labels, one name per line). `catalog.name` must equal `template.name`.
- `usePricePrecision` (optional): format values with the charted symbol's price precision.

The files are picked up at build time with `import.meta.glob` (eager), registered with KLineChart, and
listed in the picker; no other file needs editing. `custom/vwap.ts` and `custom/atr.ts` are the built-in
examples. Restart `pnpm dev` (or rebuild) after adding a file.

Example: `apps/web/src/chart/indicators/custom/range.ts`

```ts
import type { CustomIndicator } from '../types';

/** Average bar range (high − low) over the last N bars, in its own pane. */
const indicator: CustomIndicator = {
  template: {
    name: 'RANGE',
    shortName: 'Range',
    calcParams: [10],
    figures: [{ key: 'range', title: 'Range: ', type: 'line' }],
    calc: (dataList, ind) => {
      const n = Math.max(1, Math.floor(ind.calcParams[0] ?? 10));
      let sum = 0;
      return dataList.map((bar, i) => {
        sum += bar.high - bar.low;
        const dropped = dataList[i - n];
        if (dropped) sum -= dropped.high - dropped.low;
        return { range: i >= n - 1 ? sum / n : null };
      });
    },
  },
  usePricePrecision: true, // format values like prices of the charted symbol
  catalog: {
    name: 'RANGE', label: 'Average Bar Range', pane: 'sub', defaultParams: [10], paramLabels: ['Period'], lines: ['Range'],
  },
};

export default indicator;
```

Error handling:

- A default export with the wrong shape (missing `calc`, `catalog.name` ≠ `template.name`, …) is
  **skipped** with a `[indicators] … skipped` warning in the browser console; the app still starts.
- A module that **throws while being imported** (top-level code) is **fatal**: the app fails to start.
  Keep top-level code free of side effects and do the work inside `calc`.

By convention only files under `apps/web/src/chart/` import `klinecharts` (there is no lint rule
enforcing it); custom indicators normally need only the types from `../types`.

## Tests

```sh
pnpm test        # unit + route tests, no network
pnpm typecheck   # all packages + the e2e suite
pnpm e2e         # Playwright end-to-end test (Chromium)
```

`pnpm e2e` builds everything, starts the built server on port 8799 in fixture mode (`ALTV_PROVIDERS=fixture`,
no network) with a fresh SQLite file under `test-results/`, and runs `e2e/tests/`. The first time, install
the browser with `pnpm exec playwright install chromium`.

## Roadmap (v2 backlog)

- Compare/overlay another symbol on the same chart
- Price alerts
- FX (currency pair) data
