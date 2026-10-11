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

Open http://localhost:5173 (the Vite dev server proxies the API on port 8787).

## Production, locally

```sh
pnpm build && pnpm --filter @altv/server start
```

Open http://localhost:8787. The server also serves the built web app. Data lives in
`./data/altv.db` (SQLite) unless `DATABASE_URL` says otherwise.

## Docker

```sh
docker build -t altv .
docker run -p 8787:8787 -v altv-data:/data altv
```

The image runs as the non-root `node` user, stores SQLite at `/data/altv.db` (mount a volume on
`/data`) and has a built-in healthcheck on `/api/health`.

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
| `DATABASE_URL` | `sqlite:./data/altv.db` (Docker: `sqlite:/data/altv.db`) | `sqlite:<path>` or `postgres://…`. |
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

## Custom indicators

Indicators live in `apps/web/src/chart/indicators/`. Add a TypeScript file there that exports a
KLineChart indicator template (the object you would pass to `registerIndicator`); files in that
folder are registered automatically at startup and appear in the indicator picker.

```ts
import type { IndicatorTemplate } from 'klinecharts';

export const myRange: IndicatorTemplate = {
  name: 'MY_RANGE',
  shortName: 'Range',
  calcParams: [],
  figures: [{ key: 'range', title: 'Range: ', type: 'line' }],
  calc: (bars) => bars.map((b) => ({ range: b.high - b.low })),
};
```

Only files under `apps/web/src/chart/` may import `klinecharts`.

## Tests

```sh
pnpm test        # unit + route tests, no network
pnpm typecheck
```

## Roadmap (v2 backlog)

- Compare/overlay another symbol on the same chart
- Price alerts
- FX (currency pair) data
