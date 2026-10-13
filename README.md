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

Fetched history is cached in the database and not re-downloaded. Yahoo's bars are split- and
dividend-adjusted *as of the day they were fetched*, so the server checks each stock for splits at most
once a day when serving its bars (a lightweight Yahoo chart call with split events since the last check,
stamped in `symbols.splits_checked_at`). When a split occurred since the last check, that symbol's daily
bars and the intraday bars still within Yahoo's lookback are dropped and refetched on demand; older intraday
bars (no longer downloadable) are kept and rescaled by the split ratio. Baskets holding the stock recompute
their units. Note for upgrades: the first check after upgrading looks for splits since each symbol's last
metadata refresh (`symbols.updated_at`) minus 7 days, so older splits (already reflected in the cache) change
nothing; a split between an older cached fetch and that baseline is not detected (delete the symbol's cache as
in Troubleshooting if a chart shows such a jump). Split events dated in the future are applied only once they
have happened. A failed check
never fails a request; it is retried after an hour. Dividends are not detected: after one, older cached
bars stay adjusted as of their fetch day (see [Troubleshooting](#troubleshooting) to refetch a symbol).

## Charts

- **Timeframes** 1m … 1M, chart types candles / bars / line / area, light and dark themes.
- **RTH / ETH toggle** for stocks (and baskets containing a stock): RTH shows regular-hours bars only,
  ETH adds pre- and post-market bars, shaded on intraday stock charts (basket charts are not shaded).
  It is hidden for crypto, which trades around the clock.
- **Indicators**: up to **30** per chart (the picker stops adding beyond that and the server rejects
  larger layouts). Indicators are a **single global set**, configured once and shown on every ticker;
  timeframe, session, chart type and appearance are global too (all stored in the `default` layout).
  Older per-symbol `sym:<id>` layouts from earlier versions are ignored.
- **Drawings** are saved per symbol on the server (debounced ~1 s after each change). Points are stored in
  time/price coordinates (bar timestamp + price), not pixels, so they stay anchored to the same price and
  time across timeframes, zoom levels and window sizes.
- **Chart appearance** (gear icon in the top bar): candle up/down colours, body style (filled, hollow,
  hollow up, hollow down; OHLC bars use the colours only), line/area colour and width, and the default
  style (colour, width, solid/dashed/dotted) of new drawings. It is global (stored in the `default` layout, not
  per symbol) and applies live. Appearance is **per theme**: the dialog edits the active theme ("Dark
  theme" / "Light theme"), toggling the theme switches to the other theme's settings, and "Reset to
  defaults" resets only the active theme. A colour that barely shows on the theme background (contrast
  ratio below 1.5) gets an inline "Low contrast" warning. Layouts saved before appearance was per theme
  (one flat appearance) still load: their settings become the dark theme's.
- **Default candle colours** follow the theme's `--up` / `--down` CSS tokens (dark `#26a69a` / `#ef5350`,
  light `#089981` / `#f23645`), so candles and the watchlist agree. Histogram indicators (VOL, MACD, AO)
  default to the same up / down colours.
- **Readable labels**: the last-price label, text annotations and crosshair labels keep white text while it
  reaches about 3:1 (2.99, so the default teal keeps white text) contrast with the label colour; otherwise
  they use white or near-black, whichever contrasts more. KLineChart draws the last-price text in one colour
  for up, down and unchanged labels, so the rule uses the worst case over the three colours. Start/version
  marker labels keep their muted colour on the chart background under the same rule.
- **Indicator settings** also set each line's width (1–4 px) and solid/dashed/dotted style, and the up/down bar
  colours of histogram indicators (VOL, MACD, AO); unchanged bar colours follow the theme.
- **Drawing styles**: selecting a drawing shows a small style bar at the top of the chart (colour, width,
  solid/dashed/dotted; text annotations: colour and font size). Styles are saved with the drawing; drawings
  without their own style follow the default drawing style. Legacy drawings with non-hex colours (or other
  unsupported style values) fall back to the default style on their next save.
- **⌘ magnet**: hold **⌘** (macOS) or **Ctrl** (other systems) while placing or dragging a drawing to snap
  it to the nearest open/high/low/close (strong magnet); releasing the key returns to the toolbar's magnet
  setting.
- **Shortcuts**: **⌥T** / **Alt+T** starts a trend line and **⌥H** / **Alt+H** a horizontal line (same as
  clicking the toolbar button; pressing it again cancels). They (and Delete/Backspace) are ignored while any form
  control (field, checkbox, select, button) has the focus or inside a dialog, and are shown in the buttons' tooltips.
- **Shift (horizontal)**: hold **Shift** while placing or dragging a trend line, ray, extended line or parallel
  channel to keep it perfectly horizontal: every point takes the anchor's price (the first point while drawing,
  the fixed end while dragging one end), rounded to the symbol's price precision. A channel's width point stays
  free. Combined with ⌘/Ctrl, the snap picks the anchor price and Shift keeps the line flat.
- **Exact price**: selecting a horizontal line or price line shows a **Price** field in the style bar
  (double-clicking the line focuses it). Type a price (the symbol's precision, or up to 8 decimals) and press
  Enter or leave the field to move the line there; Escape reverts; invalid prices show an error; locked
  drawings are read-only. Only the price changes (the time anchor is kept). Horizontal lines placed or dragged
  with the mouse are rounded to the symbol's price precision.
- **Price labels**: price lines and horizontal lines have **On line** (price text on the line) and **On axis**
  (price label on the right axis) toggles in the style bar; defaults: price line both on, horizontal line
  axis only. Saved with the drawing.
- **Long / short positions** (toolbar: "Long position", "Short position"), like TradingView's:
  - **Placing**: one click sets the entry at the clicked time and price (rounded to the symbol's precision;
    ⌘/Ctrl snaps it to OHLC). Target and stop start at ±2 % (long: target above, stop below; short inverted) and
    the box is about 20 bars wide (counted on the loaded bars, extrapolated with the timeframe past the last bar).
  - **Chart**: a green profit zone (entry → target) and a red loss zone (entry → stop) in the candle up / down
    colours at 20 % opacity, the entry line, and labels `Target: <price> (<±%>) <±amount>`,
    `Stop: <price> (<±%>) <±amount>` and `<Long|Short> · Qty <q> · R:R <ratio>` (% and amounts are the
    position's gain / loss at that level; label text is white or dark, whichever reads on its colour). Labels
    are centred on the visible part of the box and stay inside the chart (a box wider than the screen still shows
    them); the centre / outcome labels move to the right of a box narrower than them, the outcome label moves
    beyond the stop label when the stop zone is too short, and labels wider than the chart are cut with "…".
  - **Editing**: drag the target handle (top/bottom left corner) or the stop handle to change only that price
    (it stays on its side of the entry, at least 12 px away on screen so the entry handle stays reachable, and
    above zero); drag the entry handle, the entry line or a zone to move the whole position (prices, and time by
    whole bars: the end moves by as many bars as the start); a move that would take a price to zero or below is
    refused. Drag the right-edge handle to change the end time (at least up to the next bar, so weekends never give
    a zero-width box). ⌘/Ctrl snaps like other drawings. Prices are rounded to the symbol precision.
    When a target / stop handle sits exactly on the entry handle (e.g. typed prices one tick apart when zoomed
    out) the target / stop handle is on top, so the two can always be separated; the entry line and the zones
    still move the whole position.
  - **Settings bar** (select the position): precise Entry / Target / Stop fields (Enter or leave the field to
    apply, Escape reverts; long needs stop < entry < target, short target < entry < stop, otherwise an inline
    error), target / stop distance as % of the entry and in ticks (1 tick = 10^-precision), kept in sync; risk:
    account size, risk mode (% of account or fixed amount), risk value and currency label (≤ 8 characters);
    amounts are at most 10^15 and a percentage at most 100 (the server enforces the same limits). Switching the
    risk mode converts the value so the money at risk stays the same (e.g. 500 USD of 10 000 → 5 %), capped at
    100 %; "Use as default" is disabled while the settings are invalid, and invalid defaults sent to the server
    are dropped on their own (the rest of the layout is still saved).
    It shows Qty = risk / |entry − stop| (whole shares for stocks and baskets, up to 6 decimals for crypto,
    always rounded down; a risk below one unit shows "Qty 0 (Risk is below 1 unit)"), the risk and reward amounts at that quantity and R:R = |target − entry| / |entry − stop|.
    **Use as default** stores the risk settings as the defaults of new positions (`positionDefaults` in the
    `default` layout; unset → 10 000 account, 1 %, USD). A new position copies the defaults at placement, so
    later default changes do not alter existing positions. Locked positions are read-only.
  - **Outcome** (TradingView rules, on the bars of the displayed timeframe):
    - **Fill**: the position opens on the first bar that starts at or after the start time and whose range
      touches the entry (low ≤ entry ≤ high); a bar that only contains the start (it began earlier) does not count.
      Until then the label reads "Waiting for entry" (neutral, no P&L); "Entry not reached" once the range is over.
    - **Hits**: checked from the bar after the fill bar up to the end time (the order of prices inside the fill bar
      is unknown, so a target or stop also touched there counts only on later bars): the first bar reaching the
      target (long: high ≥ target, short: low ≤ target) or the stop (long: low ≤ stop, short: high ≥ stop) gives
      "Target hit" / "Stop hit" with the realised P&L (amount and %) and the bar's date, and the traversed part of
      that zone (from the fill bar) is shaded more strongly. A bar reaching both counts as a stop hit (conservative).
    - **Gaps**: a bar opening beyond the stop (long: open < stop, short: open > stop) books the loss at its open;
      a bar opening beyond the target still books the gain at the target (never flattering).
    - No hit: "Open" with the P&L at the last close while the last bar lies in the range, else "Ended, no hit"
      with the P&L at the last close in range.
    - **Earlier data**: when the position starts before the first loaded bar, older bars are requested
      automatically (up to 40 pages per chart load, as far as the provider has data); meanwhile the label reads
      "Outcome needs earlier data". Recomputed when bars arrive (polling / backfill / older pages) and when the
      position changes; since it uses the displayed bars, the hit bar can differ between timeframes.
  - **Stored** as `longPosition` / `shortPosition` drawings with four points: `[0]` entry (start time, entry
    price), `[1]` (start time, target), `[2]` (start time, stop), `[3]` (end time, entry price), plus optional
    `styles.position` (`accountSize`, `riskMode`, `riskValue`, `currency`). Daily anchoring works as for
    other drawings.
- **Parallel channels** show a dashed midline halfway between the two lines, in the channel's colour and width
  (longer dashes when the channel itself is dashed or dotted); it is not a stored point.

## Watchlist and sections

The right sidebar lists symbols with live quotes (every 15 s) and a sparkline. Click a row (or Enter) to open
its chart; Delete removes the focused row; drag rows or press **Alt+↑/↓** to reorder.

**Sections** group symbols under a header, TradingView-style. The watchlist is one ordered list of symbols and
section headers: the symbols below a header belong to it until the next header; symbols above the first header
form an untitled top group.

- **+ Section** (top of the watchlist) adds a section at the end, named "New section" and ready to rename.
  Up to 50 sections and 200 symbols.
- **Rename**: double-click the title (or F2 on the header, or the **…** menu → Rename). Enter saves, Escape
  cancels, an empty title keeps the old one; at most 40 characters.
- **Collapse / expand**: click the header. A collapsed header shows how many symbols it hides; the state is saved.
- **… menu**: Rename, Add section above, Delete section (only the header goes: its symbols move to the previous
  section).
- **Adding a symbol** puts it at the end of the *active* section — the last header or symbol you clicked or
  focused inside a section — or at the end of the list when none is active (e.g. after clicking a symbol of the
  top group). A symbol is listed once; adding it again does nothing.
- **Moving**: drag any row, or Alt+↑/↓ on the focused row. Moving a header moves only that header row, so the
  symbols below it change section. Dropping a symbol onto a collapsed header appends it to that section; moving
  a row with the keyboard into a collapsed section, or moving a collapsed header, expands it so the row stays in
  view.

The API is `GET /api/watchlist` → `WatchlistEntry[]` (`{ type: 'symbol', id }` or
`{ type: 'section', id: <uuid>, title, collapsed }`) and `PUT /api/watchlist` with the same array; `PUT` still
accepts the older plain symbol id array. Migration 003 copies an existing watchlist into the new storage (the old
table is kept in sync with the symbols, so rolling back to an older version keeps them).

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
  jump) and are drawn like any other bars (no background shading). A dashed vertical `Start` line (in the
  chart and the editor preview) plus a notice ("Before <date>: simulated with the starting holdings.") make
  the boundary explicit. Start and version markers use a fixed, muted theme style, independent of the
  default drawing style. Resampled bars (weekly, monthly, 2h/4h) count as
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

**Stale history after a dividend** (splits are detected automatically, see above). Delete that
symbol's cache, then reload the chart:

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

`catalog.paramMin` / `catalog.paramMax` (optional, one entry per param) set the accepted range of integer
params in the settings dialog (default 1…1000).

`custom/wyckoff.ts` (with its calculation in `wyckoffCalc.ts`) is a port of the TradingView script
'Wyckoff Accumulation Distribution' by faytterro and draws its boxes, labels and bar colours in a `draw`
callback. **Licence:** these two files (and their tests) are covered by the
[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/), not by the rest of the project's terms; keep
their MPL-2.0 headers and attribution when modifying or redistributing them.

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

Set `E2E_PORT` to run on another port, e.g. `E2E_PORT=8873 pnpm e2e`. The database
(`test-results/e2e-<port>.db`) and the results folder (`test-results/e2e-<port>/`) are named after the port.
Runs that happen at the same time (several worktrees or checkouts) therefore cannot collide as long as each
uses its own port. The run fails if the port is already in use.

## Roadmap (v2 backlog)

- Compare/overlay another symbol on the same chart
- Price alerts
- FX (currency pair) data
