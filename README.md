# Chartmate

A single-user charting app for macOS, Windows or your own server: candlestick charts for stocks and crypto,
indicators, drawing tools, watchlists, and custom **baskets** (weighted synthetic instruments).
Free data sources only (Yahoo Finance for stocks, Binance or Coinbase for crypto), cached in
SQLite or Postgres.

Monorepo (pnpm): `packages/shared` (types, resampling, basket math), `apps/server` (Fastify API),
`apps/web` (React + KLineChart), `apps/desktop` (Electron app, see [Desktop app](#desktop-app)) and `e2e`
(Playwright). Contributors and coding agents: see [AGENTS.md](AGENTS.md).

## Quick start (development)

Requires Node >= 22 and pnpm 8.

```sh
pnpm install --ignore-scripts && pnpm dev
```

No dependency install script is needed (CI installs the same way), except Electron's binary download for
running the desktop app unpackaged: `node apps/desktop/node_modules/electron/install.js`.

This starts the API server (`tsx watch`, port 8787) and the Vite dev server in parallel. Open
http://localhost:5173 (Vite's default port); Vite proxies `/api/*` to `http://localhost:8787`
(see `apps/web/vite.config.ts`). If you change the server's `PORT`, update that proxy target too.

The SQLite default `sqlite:./data/chartmate.db` is resolved against the **server's working directory**, which
for `pnpm dev` is `apps/server/`, so dev data ends up in `apps/server/data/chartmate.db`.

## Production, locally

```sh
pnpm build && pnpm --filter @chartmate/server start
```

Open http://localhost:8787. The server also serves the built web app. It listens on `127.0.0.1` by
default; set `HOST=0.0.0.0` to reach it from other machines (the Docker image already does).

`pnpm --filter @chartmate/server start` runs with `apps/server/` as its working directory, so the default
`sqlite:./data/chartmate.db` is `apps/server/data/chartmate.db`. The path is relative to wherever the server is
started, so for anything you care about use an absolute path, e.g.
`DATABASE_URL=sqlite:/home/me/chartmate/chartmate.db pnpm --filter @chartmate/server start` (the directory is created
if missing).

## Docker

```sh
docker build -t chartmate .
docker run -p 8787:8787 -v chartmate-data:/data chartmate
```

The image sets `HOST=0.0.0.0` so the published port is reachable. It runs as the non-root `node` user (uid/gid 1000), stores SQLite at `/data/chartmate.db` (mount a
volume on `/data`) and has a built-in healthcheck on
`/api/health` (it honors `PORT`).

A named volume (as above) just works. If you bind-mount a host directory instead, it must be writable by
uid 1000, otherwise the server cannot create the database:

```sh
mkdir -p ./chartmate-data && sudo chown 1000:1000 ./chartmate-data
docker run -p 8787:8787 -v "$PWD/chartmate-data:/data" chartmate
```

## Hosted setup (Postgres + password)

```sh
docker run -d -p 8787:8787 \
  -e DATABASE_URL=postgres://user:pass@db-host:5432/chartmate \
  -e CHARTMATE_PASSWORD='a-long-random-passphrase' \
  -e CHARTMATE_SESSION_SECRET="$(openssl rand -hex 32)" \
  -e CHARTMATE_TRUST_PROXY=1 \
  chartmate
```

Put it behind an HTTPS reverse proxy. Notes on login security:

- Setting `CHARTMATE_PASSWORD` turns on a login page. Use a strong password.
- Set `CHARTMATE_SESSION_SECRET` to a random value (as above). If unset, the secret is derived from the
  password, so a leaked session cookie would let someone guess the password offline.
- Login attempts are rate limited: 10 failures per IP per 15 minutes, plus a global limit of 100
  failures per 15 minutes. The global limit means a determined attacker can lock *you* out for a while.
- Behind a reverse proxy set `CHARTMATE_TRUST_PROXY`, otherwise every client appears to come from the
  proxy's IP and they all share one rate-limit budget.
- The session cookie lasts 30 days. Changing `CHARTMATE_SESSION_SECRET` (or the password, if the secret
  is derived from it) revokes all existing sessions.
- Serve over HTTPS only.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address. Use `0.0.0.0` (or `::`) to accept connections from other hosts. |
| `DATABASE_URL` | `sqlite:./data/chartmate.db` (Docker: `sqlite:/data/chartmate.db`) | `sqlite:<path>` or `postgres://…`. An empty SQLite path (`sqlite:`) is rejected. |
| `CHARTMATE_PASSWORD` | unset (no auth) | Enables password login. |
| `CHARTMATE_SESSION_SECRET` | derived from the password | Cookie signing secret, min 16 chars. Set explicitly in production. |
| `CHARTMATE_TRUST_PROXY` | unset (`false`) | `true`, a hop count (e.g. `1`), or an IP/CIDR list of trusted proxies. |
| `CRYPTO_PROVIDER` | `binance` | `binance` or `coinbase`. |
| `BINANCE_BASE_URL` | `https://data-api.binance.vision` | Alternate Binance-compatible endpoint. |
| `CHARTMATE_PROVIDERS` | `live` | `fixture` serves deterministic synthetic data (tests/demos, no network). |
| `CHARTMATE_WEB_DIST` | `apps/web/dist` (Docker: `/app/web`) | Directory of the built web app. |

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

- **Timeframes** 1m … 1M, chart types candles / bars / line / area, light and dark themes. The look is flat:
  the chart sits on its own rounded sheet, chrome is solid panels with hairline edges (no glass, glow or drop
  shadows), and every font is the system sans-serif (no web fonts). The time axis labels read with context
  ("Sep 21", "22", "13:30"; daily: "Sep", "22"), the crosshair date chip reads "Wed Sep 30 '26 · 12:30".
- **Symbol search**: the top bar search field (**⌘K** on macOS, **Ctrl+K** elsewhere, focuses it from anywhere).
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
- **Chart appearance** ("Chart appearance" button in the top bar): candle up/down colors, body style (filled,
  hollow, hollow up, hollow down; OHLC bars use the colors only), **last price line** (neutral, the default:
  the theme's text color, near-white on dark and ink on light; or the candle up/down color). The last price
  sits in a capsule on the price axis with a fine dashed price line; on intraday charts (and daily crypto
  charts) the capsule also counts down to the bar close ("4:59", "1:04:59"; "Closed" once the bar ended; for stocks a
  bar ends at the session close, 16:00 New York for RTH and 20:00 for ETH, if that comes first), line/area color and width, and the
  default style (color, width, solid/dashed/dotted) of new drawings. It is global (stored in the `default`
  layout, not per symbol) and applies live. Appearance is **per theme**: the dialog edits the active theme
  ("Dark theme" / "Light theme"), toggling the theme switches to the other theme's settings, and "Reset to
  defaults" resets only the active theme. A color that barely shows on the theme background (contrast
  ratio below 1.5) gets an inline "Low contrast on the … background" warning. Layouts saved before
  appearance was per theme (one flat appearance) still load: their settings become the dark theme's.
- **Default market colors**: one up and one down color per theme (the `--up` / `--down` CSS tokens; dark
  `#3ccfd0` / `#e76a88`, light `#0b9da0` / `#c43d68`), used by candles, volume, MACD and AO bars, positions,
  the watchlist, baskets and sparklines. Volume / MACD / AO bars without their own colors follow the active
  theme's candle colors, custom ones included. Rising MACD / AO bars use an opaque soft tone of the same hue;
  the legend shows histogram values in the readable up / down text colors.
  Stored colors equal to the defaults of earlier versions are reset once, so they follow the current
  defaults (indicator line colors that are all the old palette too); colors you picked yourself are kept.
- **Readable labels**: labels drawn on a color (crosshair, text annotations, the last price label in candle
  color mode) keep white text while it reaches about 3:1 contrast with the label color, otherwise they use
  white or near-black, whichever contrasts more. KLineChart draws the last price text in one color for up,
  down and unchanged labels, so in candle color mode the rule uses the worst case over the three colors.
  Start/version marker labels keep their muted color on the chart background under the same rule.
- **Indicator settings** also set each line's width (1–4 px) and solid/dashed/dotted style, and the up/down bar
  colors of histogram indicators (VOL, MACD, AO); unchanged bar colors follow the theme.
- **Oscillator reference levels**: oscillator panes draw thin dashed lines in the theme's muted level color behind
  the indicator lines: MACD, AO, ROC, MTM and TRIX at 0; RSI at 70 / 30; KDJ at 80 / 20;
  CCI at ±100; WR at -20 / -80 (KLineChart's WR runs from -100 to 0); DMI at 25 (ADX trend threshold). The levels
  are part of the pane's auto-range, so RSI always shows its 30–70 band and
  MACD its zero line even when the values stay on one side. The settings dialog's **Levels** section hides
  them or edits the values (up to 5, separated by commas; empty = none); Reset restores the defaults. They
  are saved with the layout only when changed (older layouts use the defaults).
- **Drawing tools** (toolbar on the left of the chart): trend line, ray, extended line, horizontal line,
  vertical line, price line, parallel channel, Fibonacci retracement, text, long position and short
  position; plus magnet, lock all, delete selected (**Delete** / **Backspace**) and clear all. **Escape**
  cancels the active tool and deselects the drawing.
- **Locking drawings**: the lock button at the end of a selected drawing's style bar locks that drawing alone;
  **Lock all drawings** in the toolbar locks every drawing on top of that. A locked drawing
  can still be selected (so it can be unlocked) but cannot be moved, resized or removed (Delete / Backspace and a
  right click leave it; the toolbar's delete button is disabled while it is selected), and its style bar fields
  are disabled except the lock toggle; its handles show as hollow rings. A drawing's own lock is kept when "Lock all" is turned off, and is
  saved with it (`locked: true`; `lock` is the effective lock), so it survives reloads and timeframe switches.
  Drawings saved before per-drawing locks keep their lock: all locked → "Lock all", otherwise each locked one
  becomes locked on its own. **Clear all** removes only unlocked drawings: the confirmation says how many locked
  ones are kept, and when every drawing is locked it removes nothing and says so (with no drawings at all it does
  nothing).
- **Drawing styles**: selecting a drawing shows a small style bar at the top of the chart (color, width,
  solid/dashed/dotted; text annotations: color and font size). Styles are saved with the drawing; drawings
  without their own style follow the default drawing style. Legacy drawings with non-hex colors (or other
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
- **Long / short positions** (toolbar: "Long position", "Short position"), without a
  position size: they show prices, % distances, R:R and the outcome in %, no account, risk, quantity or money
  amounts (sizing needs an account balance, which will come with broker integration).
  - **Placing**: one click sets the entry at the clicked time and price (rounded to the symbol's precision;
    ⌘/Ctrl snaps it to OHLC). Target and stop start at the default distances, ±2 % unless changed with "Use as
    default" (long: target above, stop below; short inverted), and
    the box is about 20 bars wide (counted on the loaded bars, extrapolated with the timeframe past the last bar).
  - **Chart**: a profit zone (entry → target) and a loss zone (entry → stop) as translucent tints of the
    candle up / down colors, light enough that candles inside keep their colors (both zones equally strong on
    either theme, at most 12 % opacity; hue-locked where the background allows it), the entry line,
    and labels `Target: <price> (<±%>)`, `Stop: <price> (<±%>)` and `<Long|Short> · R:R <ratio>` (the % is the position's gain / loss at that level, in % of the entry; label
    text is white or dark, whichever reads on its color). Labels
    are centered on the visible part of the box and stay inside the chart (a box wider than the screen still shows
    them); the center / outcome labels move to the right of a box narrower than them, the outcome label moves
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
    error), target / stop distance as % of the entry and in ticks (1 tick = 10^-precision), kept in sync,
    R:R = |target − entry| / |entry − stop| and the outcome.
    **Use as default** stores the selected position's target / stop distances (% of the entry, 4 decimals) as
    the defaults of new positions (`positionDefaults: { targetPct, stopPct }` in the `default` layout; unset →
    2 % / 2 %). It is disabled while a distance is over 99 % (the limit the server enforces, so a short's target
    and a long's stop stay above zero); invalid defaults sent to the server are dropped on their own (the rest of
    the layout is still saved). Defaults only apply at placement: existing positions keep their prices. Locked
    positions are read-only.
  - **Outcome** (on the bars of the displayed timeframe):
    - **Fill**: the position opens on the first bar that starts at or after the start time and whose range
      touches the entry (low ≤ entry ≤ high); a bar that only contains the start (it began earlier) does not count.
      Until then the label reads "Waiting for entry" (neutral, no result); "Entry not reached" once the range is over.
    - **Hits**: checked from the bar after the fill bar up to the end time (the order of prices inside the fill bar
      is unknown, so a target or stop also touched there counts only on later bars): the first bar reaching the
      target (long: high ≥ target, short: low ≤ target) or the stop (long: low ≤ stop, short: high ≥ stop) gives
      "Target hit" / "Stop hit" with the result in % of the entry and the bar's date (e.g. `Target hit · +2.00% ·
      2026-10-03`), and the traversed part of
      that zone (from the fill bar) is shaded more strongly. A bar reaching both counts as a stop hit (conservative).
    - **Gaps**: a bar opening beyond the stop (long: open < stop, short: open > stop) books the loss at its open;
      a bar opening beyond the target still books the gain at the target (never flattering).
    - No hit: "Open" with the result at the last close while the last bar lies in the range, else "Ended, no
      hit" with the result at the last close in range.
    - **Earlier data**: when the position starts before the first loaded bar, older bars are requested
      automatically (up to 40 pages per chart load, as far as the provider has data); meanwhile the label reads
      "Outcome needs earlier data". Recomputed when bars arrive (polling / backfill / older pages) and when the
      position changes; since it uses the displayed bars, the hit bar can differ between timeframes.
  - **Stored** as `longPosition` / `shortPosition` drawings with four points: `[0]` entry (start time, entry
    price), `[1]` (start time, target), `[2]` (start time, stop), `[3]` (end time, entry price), no styles.
    Daily anchoring works as for other drawings. Positions and defaults saved when positions were sized still
    load: their `styles.position` / `accountSize`, `riskMode`, `riskValue`, `currency` are ignored and dropped on
    the next save.
- **Parallel channels** are finite by default: click the start and end of the base line, then a third point for
  the channel's width. Both lines span exactly from the first to the second point's time, with a dashed midline
  halfway between them (in the channel's color and width, longer dashes when the channel itself is dashed or
  dotted; not a stored point) and a subtle fill (the channel's color at 8% opacity). Clicking a line, the
  midline or the fill selects (and drags) the channel; clicking beyond its ends does not. A right click inside
  the fill is ignored (a right click on a line removes the channel, as for other unlocked drawings).
  - **Extend left / Extend right** (style bar) extend the lines, midline and fill to the
    chart's left / right edge; both on gives an infinite channel. Both are off for new channels.
  - **Stored** as `parallelChannel` drawings (three points) with optional `styles.extend` (`left` / `right`;
    only the sides that differ from the default are saved).
  - **Legacy channels** (`parallelStraightLine`, drawn by older versions as infinite channels) still look exactly
    as before (infinite, no fill): a missing `extend` means both sides extended. They get the same toggles (turning a side off is
    saved as `extend: { left: false }`).

## Watchlist and sections

The right sidebar lists symbols with live quotes (every 15 s) and a 30-day sparkline. Click a row (or Enter) to
open its chart; Delete removes the focused row; drag rows or press **Alt+↑/↓** to reorder. The open symbol's row
has a quiet highlight.
The row always shows the regular-session price and day change (a tinted pill); during pre/post-market a second
line ("Pre 231.40 +0.82%") shows the extended price and its change vs the last regular close (`Quote.ext`),
otherwise the name. A small gauge under the price places the price in its 30-day closing range (the sparkline's daily
closes and the live price).

Below the list, a **detail panel** shows the open symbol: market status (stocks: open / pre-market / after hours /
closed from the New York clock and the quote's freshness; crypto trades around the clock), the day range as a
gauge (open → now), and open, previous close, volume, 30-day average volume and the 52-week high / low, all from
the daily bars and the quote.

**Sections** group symbols under a header. The watchlist is one ordered list of symbols and
section headers: the symbols below a header belong to it until the next header; symbols above the first header
form an untitled top group.

- **+ Section** (top of the watchlist) adds a section at the end, named "New section" and ready to rename.
  Up to 50 sections and 200 symbols.
- **Rename**: double-click the title (or F2 on the header, or the **…** menu → Rename). Enter saves, Escape
  cancels, an empty title keeps the old one; at most 40 characters.
- **Collapse / expand**: click the header (the count of its symbols shows on the right); the state is saved.
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
`{ type: 'section', id: <uuid>, title, collapsed }`) and `PUT /api/watchlist` with the same array. `PUT` still
accepts the older plain symbol id array (e.g. from a tab opened before an upgrade): it is merged into the stored
list, so sections are kept — removed symbols are dropped, the rest follow the array's order, new ones are appended
(an empty array still empties the list). Migration 003 copies an existing watchlist, in order, into the new
`watchlist_entries` table; the old `watchlist` table is kept and mirrored with the symbols.

Downgrading is not automatic: an older server refuses to start once migration 003 is recorded (Kysely rejects
unknown applied migrations). To roll back anyway, stop the server, back up the database and delete that record —
`DELETE FROM kysely_migration WHERE name = '003_watchlist_sections';` — then start the older version: it reads the
mirrored `watchlist` table (symbols only; sections are not visible to it). Upgrading again re-runs 003, which keeps
the existing `watchlist_entries` rows, so watchlist edits made while downgraded are not carried over (empty that
table before upgrading to re-import the old list instead).

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

## HTTP API

JSON over `/api` (the web client uses nothing else). With `CHARTMATE_PASSWORD` set, every route except
`/api/health`, `/api/session`, `/api/login` and `/api/logout` needs the session cookie (else 401).

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness (`{ ok: true }`), used by the Docker healthcheck. |
| `GET /api/session`, `POST /api/login`, `POST /api/logout` | Auth state, login (`{ password }`), logout. |
| `GET /api/symbols/search?q=` | Symbol search (stocks, crypto and your baskets). |
| `GET /api/symbols/:id` | Symbol info (name, exchange, price precision). |
| `GET /api/bars?symbol=&tf=&session=rth\|eth&from=&to=` | Bars in a range (ms timestamps), with `stale`, notices and markers. |
| `GET /api/latest?symbol=&tf=&session=` | The latest bar. |
| `GET /api/quotes?symbols=` / `GET /api/sparklines?symbols=` | Watchlist quotes / sparklines (comma-separated ids, at most 50). |
| `GET`, `POST /api/baskets`; `GET`, `PUT`, `DELETE /api/baskets/:id`; `POST /api/baskets/:id/versions` | Baskets and their versions. |
| `GET`, `PUT /api/watchlist` | The watchlist (see [Watchlist and sections](#watchlist-and-sections)). |
| `GET`, `PUT /api/layouts/:key` | Chart layout; `default` is the one the app uses. |
| `GET`, `PUT /api/drawings/:symbol` | Drawings of a symbol. |

Symbol ids are `stock:<TICKER>`, `crypto:<BASE>` or `basket:<uuid>`; timeframes are `1m 5m 15m 30m 1h 2h 4h 1D
1W 1M`.

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

For SQLite stop the server first and run these with `sqlite3 <path-to-chartmate.db>`; for Postgres use `psql`
against `DATABASE_URL`. Restart the server afterwards so baskets recompute their (cached) units from the
corrected history.

## Custom indicators

Every file in `apps/web/src/chart/indicators/custom/*.ts` is a custom indicator. Each one must
`export default` an object `{ template, catalog }` (type `CustomIndicator` from
`apps/web/src/chart/indicators/types.ts`):

- `template`: a KLineChart indicator template (what you would pass to `registerIndicator`).
- `catalog`: how it appears in the indicator picker and settings dialog. `catalog.name` must equal
  `template.name`; a custom indicator with a built-in's name replaces that built-in.
- `usePricePrecision` (optional): format values with the charted symbol's price precision.

`catalog` fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name`, `label` | yes | Template name; name shown in the picker. |
| `pane` | yes | `'main'` (overlay on the candles) or `'sub'` (own pane). |
| `defaultParams`, `paramLabels` | yes | Default params and one label per param. |
| `lines` | yes | One name per line figure, in figure order (color, width and style inputs). |
| `lineSlots` | no | Palette slot of each line (index-aligned with `lines`); default: line i uses slot i. The palette has 6 slots per theme. |
| `bars` | no | Histogram with editable up/down colors; inferred when the template has a `bar` figure. |
| `decimalParams` | no | Indices of params that accept decimals (> 0); the others are integers. |
| `paramMin`, `paramMax` | no | Per-param range of integer params (default 1…1000). |
| `levels` | no | Default reference levels, at most 5 (dashed lines, editable in the settings dialog); sub-pane indicators only. A template's own `draw` callback still runs after the levels. |
| `description` | no | Longer explanation (picker and chip tooltip). |

The files are picked up at build time with `import.meta.glob` (eager), registered with KLineChart, and
listed in the picker; no other file needs editing. `custom/vwap.ts` and `custom/atr.ts` are the built-in
examples. Restart `pnpm dev` (or rebuild) after adding a file.

`custom/wyckoff.ts` (with its calculation in `wyckoffCalc.ts`) is a port of the Pine Script indicator
'Wyckoff Accumulation Distribution' by faytterro and draws its boxes, labels and bar colors in a `draw`
callback. **License:** these two files (and their tests) are covered by the
[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/), not by the project's AGPL-3.0; keep
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

## Desktop app

`apps/desktop` packages the same server and web UI as a desktop app (product name **Chartmate**) for macOS and
Windows, built with Electron 44. The self-hosted server is unchanged; the desktop app embeds it.

### How it works

- **No network listener.** The Fastify app (`buildApp` from `apps/server`) runs inside the Electron main process
  and never calls `listen()`. `net.Server.prototype.listen` is guarded (`src/lib/listenGuard.ts`) and throws for
  every call. The one exception is narrow and audited: during an auto-update install on macOS (signed builds
  only), electron-updater must hand the downloaded zip to Squirrel.Mac over a short-lived HTTP server. For that
  case only, the guard is armed once the download has **completed**, right as electron-updater starts that
  hand-over. The window lasts 60 s and allows a single listener, which must be on `127.0.0.1`/`::1` with an
  ephemeral port. Every allowed or refused listener is written to the log.
- **The app:// scheme.** The window loads `app://chartmate/`, a privileged custom scheme:
  - `/api/*` goes to `fastify.inject`, with the same 1 MB body limit as the server;
  - everything else is a read-only static file from the built web UI, with an SPA fallback for HTML navigations.

  The web client already uses relative `/api/...` URLs, so the same bundle works in the browser and on desktop.
- **SQLite without a native module.** The desktop build uses Node's built-in `node:sqlite` (Node 24.21 inside
  Electron 44, no flag needed) through a small adapter for Kysely's own `SqliteDialect`
  (`apps/desktop/src/lib/nodeSqlite.ts`). better-sqlite3 and pg are never bundled (the bundle script fails if
  they are). The server's DB-backed test suites also run against this dialect (`apps/desktop` `pnpm test`).
- **One file.** esbuild bundles the desktop main process and the whole server into a single minified
  `dist/main.cjs` (~2 MB). The package holds only that file, the web build and the icon, in an asar archive with
  maximum compression and English locales only. It has no `node_modules`.
- **Frameless window.** The web top bar is the title bar. On macOS the native traffic lights sit on it; on
  Windows the native caption buttons (minimize, maximize, close, snap layouts) are drawn over its right end in
  the top bar's colors, following the theme through the page's `<meta name="theme-color">` (no IPC). Linux
  keeps the native frame.

### Build and run

```sh
pnpm install --ignore-scripts
node apps/desktop/node_modules/electron/install.js   # Electron binary (skipped by --ignore-scripts); once
pnpm --filter @chartmate/desktop start      # build the web UI, bundle, run unpackaged (DevTools enabled)
pnpm --filter @chartmate/desktop pack:dir   # unpacked app only, e.g. release/mac-arm64/Chartmate.app
pnpm --filter @chartmate/desktop dist:mac   # release/Chartmate-<v>-mac-{arm64,x64}.{dmg,zip}
pnpm --filter @chartmate/desktop dist:win   # release/Chartmate-<v>-win-{x64,arm64}.{exe,zip}; needs Windows or CI
pnpm --filter @chartmate/desktop test       # unit + security tests (protocol, guards, allowlist, fuses, workflows …)
```

Building the NSIS installer on Apple-silicon Macs fails unless Rosetta is installed, because electron-builder's
`makensis` is an x86_64 binary. Build Windows installers in CI.

### Smoke tests

```sh
pnpm --filter @chartmate/desktop bundle && pnpm --filter @chartmate/desktop smoke     # unpackaged app

# packaged app: the shipped build + a TEST-ONLY inspectable copy of it
cd apps/desktop
node smoke/prepare-inspectable.mjs release/mac-arm64/Chartmate.app release/test-only
SMOKE_APP="$PWD/release/test-only/Chartmate TEST-ONLY.app" \
SMOKE_HARDENED_APP="$PWD/release/mac-arm64/Chartmate.app" \
SMOKE_EXPECT_UNSIGNED=1 \
SMOKE_ALLOW_REAL_USERDATA=1 pnpm smoke     # see below; EXPECT_UNSIGNED: 1 = unsigned build, 0 = signed
SMOKE_LIVE=1 pnpm smoke                                                       # + live providers (internet)
```

`app.spec.ts` uses the fixture providers unless `SMOKE_PROVIDERS=live`. The packaged example needs a packaged
app first (`pack:dir` or `dist:mac`).

A packaged build refuses to start with a debugging or weakening switch (see "Security model"), so no
test harness can attach to it. `smoke/prepare-inspectable.mjs` therefore builds a separate copy for the
functional tests:

- the copy is named `… TEST-ONLY` and carries a `TEST-ONLY-NOT-FOR-DISTRIBUTION.txt` marker;
- its only code difference is that the switch guard is compiled out (`bundle.mjs --test-inspectable`);
- on macOS, asar integrity stays on: the Info.plist hash is updated and the copy is re-signed ad hoc;
- on Windows, the copy turns asar integrity validation off, because the hash lives in a PE resource.

The functional tests (`app.spec.ts`) drive that copy over CDP. `packaged-hardening.spec.ts` checks the
**unmodified** artifact; CI runs it on macOS and on Windows, where it also covers the `/switch` syntax:

- it opens no listening socket;
- it refuses `--remote-debugging-port=0`, `--inspect` and the other refused switches, naming them on stderr and
  in an error box, with no CDP or debugger endpoint and no listener at all;
- it refuses the forbidden environment variables in the same way;
- `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` have no effect;
- it ignores `CHARTMATE_USER_DATA_DIR`;
- a tampered `app.asar` refuses to start (macOS);
- the updater is present only in signed builds (`SMOKE_EXPECT_UNSIGNED`).

Because packaged builds ignore `CHARTMATE_USER_DATA_DIR`, this spec runs against the real per-user data directories:
the current one, plus those of any `previousProductNames`. For that reason it only runs in CI (`CI=true`) or
locally with `SMOKE_ALLOW_REAL_USERDATA=1`.

- It moves the directories aside to `*.smoke-backup` first and moves them back afterwards, retrying while
  Windows still holds file handles.
- Nothing is deleted: the directory the run created is renamed to `*.smoke-trash-<timestamp>`.
- Don't run it while Chartmate is open.

### CI and releases

`.github/workflows/ci.yml` runs `pnpm audit` (any known vulnerability, in a runtime or build-time dependency,
fails the build), typecheck, tests, the web build, e2e and the Docker build on pull requests and on pushes to
`main`. Dependabot opens weekly update pull requests for npm packages and the pinned actions.
`.github/workflows/desktop.yml` runs on tags `v*` and on manual dispatch:

- **Permissions**: the workflows default to a read-only token, and every action is pinned to a commit SHA.
- **Installs**: dependencies are installed with `--ignore-scripts`; no install script is needed. The test job
  runs `pnpm audit` before anything is built.
- **`test` job**: runs without any secrets.
- **`package-mac` and `package-win` jobs**: build, sign and smoke-test on each OS. Signing secrets are visible only
  to the packaging step of their own OS.
- **`release` job** (tags only): the only job with `contents: write`. It creates the GitHub Release for the tag
  (a pre-release only for suffixed tags such as `v1.2.0-beta.1`) and attaches:
  - the dmg and zip for macOS arm64 and x64;
  - the NSIS installer and zip for Windows x64 and arm64.

  The release notes say whether each platform's build is signed.

Unsigned releases are allowed (no certificates yet). Expect Gatekeeper and SmartScreen warnings, and install
updates manually.

### Data location

| OS | Directory |
|---|---|
| macOS | `~/Library/Application Support/Chartmate/` |
| Windows | `%APPDATA%\Chartmate\` |

The directory holds:

- `chartmate.db` (SQLite with WAL), created with mode 0600 inside a
  0700 directory;
- `window-state.json`;
- `logs/main.log`, which rotates at 1 MB and keeps 2 old files.

What gets logged:

- **Main process**: lifecycle lines (start, window shown, quit) at INFO, plus warnings (blocked navigations,
  requests and listeners) and errors.
- **Embedded server**: warnings and errors only. Error objects are reduced to type, message and code, with no
  stack, request URLs drop their query strings, and headers are never logged.
- **Before writing any line**: absolute paths, URL credentials and secret-looking values are scrubbed.

`CHARTMATE_USER_DATA_DIR=/abs/path` overrides the directory in **development runs only**; packaged builds ignore it,
just as they refuse `--user-data-dir`. Migrations run before the window loads.

Environment overrides the desktop app honors:

- `CHARTMATE_PROVIDERS` (`live` (the default) or `fixture`);
- `CRYPTO_PROVIDER`;
- `BINANCE_BASE_URL` (https only);
- `CHARTMATE_DISABLE_UPDATES=1`.

A packaged build **refuses to start** (with an error dialog) if `NODE_USE_ENV_PROXY` or `SSLKEYLOGFILE` is set.
Node applies the first during pre-execution, before any app code runs, so the app cannot undo it, and the second
would let TLS session keys be logged. `NODE_USE_SYSTEM_CA` is allowed: provider requests ignore it (see below).

`NODE_EXTRA_CA_CERTS` is dropped by Electron itself: the `EnableNodeOptionsEnvironmentVariable` fuse covers it
along with `NODE_OPTIONS`. The guard still refuses it if it ever got through.

Independently of that, provider requests never use Node's global dispatcher. They go through an explicit undici
`Agent` (`src/lib/directFetch.ts`) that connects directly, ignoring `HTTP(S)_PROXY`, and trusts only Node's
bundled root CAs (`tls.rootCertificates`). Real Node and Electron child processes prove this
(`test/directFetch.test.ts`).

Provider traffic is therefore **direct-only**. Corporate HTTP proxies are not supported, and neither are
TLS-inspecting middleboxes, which need their own root certificate. On such networks the desktop app cannot reach
the market data providers; use the self-hosted server there instead.

Everything else that concerns the network surface or storage is fixed.

### Security model

The renderer is treated as untrusted web content, and the main process exposes nothing to it except `app://chartmate`.

- **Auth is disabled** on desktop. No port is listening, and the only client is the app's own sandboxed
  renderer. A password would only put a login screen in front of a single-user local app.
- **Window settings** (`src/lib/hardening.ts`, pinned by a snapshot test):
  - `sandbox`, `contextIsolation` and `webSecurity` are on;
  - Node is off everywhere, including workers and subframes;
  - there is no preload script and no `webview`;
  - spellcheck and experimental features are off;
  - DevTools are available only in unpackaged runs. In a packaged build, DevTools are also closed if they ever
    open, and the menu has no DevTools item.
- **Sandboxing and crashes**: `app.enableSandbox()` is called before ready, and only a single instance can run. A
  crashed renderer is reloaded at most 3 times per minute. After that, a static error page is shown once, and if
  that page crashes too, the window is closed with an error dialog. There is never a reload loop.
- **Command-line switches and environment** (`src/boot.ts`, the first module evaluated): a packaged build exits
  with code 1 if any of the environment variables listed under "Data location" is set, or any of these switches is present (`--x`, `-x`, and `/x`
  on Windows):

  | Group | Switches |
  |---|---|
  | Debugging and automation | `--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address`, `--remote-debugging-targets`, `--remote-allow-origins`, `--auto-open-devtools-for-tabs`, `--enable-automation` |
  | Node inspector and V8 | `--inspect*`, `--js-flags` |
  | Sandbox and process model | `--no-sandbox`, `--disable-gpu-sandbox`, `--disable-setuid-sandbox`, `--disable-seccomp-filter-sandbox`, `--disable-namespace-sandbox`, `--no-zygote`, `--single-process`, `--in-process-gpu` |
  | Web security and engine features | `--disable-web-security`, `--disable-site-isolation-trials`, `--allow-file-access(-from-files)`, `--allow-running-insecure-content`, `--reduce-security-for-testing`, `--unsafely-treat-insecure-origin-as-secure`, `--enable-features`, `--disable-features`, `--force-fieldtrials`, `--force-fieldtrial-params`, `--enable-blink-features`, `--disable-blink-features`, `--enable-experimental-web-platform-features`, `--enable-unsafe-webgpu`, `--enable-unsafe-swiftshader` |
  | TLS | `--ignore-certificate-errors(-spki-list)`, `--allow-insecure-localhost`, `--ssl-key-log-file`, `--ssl-version-min`, `--ssl-version-max`, `--cipher-suite-blacklist` |
  | Proxy, DNS and capture | `--proxy-server`, `--proxy-pac-url`, `--proxy-bypass-list`, `--proxy-auto-detect`, `--winhttp-proxy-resolver`, `--host-resolver-rules`, `--host-rules`, `--log-net-log` |
  | Foreign code | `--load-extension`, `--renderer-cmd-prefix`, `--utility-cmd-prefix`, `--gpu-launcher`, `--browser-subprocess-path` |
  | Profile relocation | `--user-data-dir`, `--disk-cache-dir` |

  Chromium switches have no fuse; the fuses below cover the Node equivalents.
- **CSP**: every `app://` response sets it as a header:

  ```
  default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
  connect-src 'self'; media-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none';
  manifest-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none';
  require-trusted-types-for 'script'; trusted-types 'none'
  ```

  There is no `'unsafe-inline'` or `'unsafe-eval'`. React `style` props and KLineChart set styles through the
  CSSOM, which CSP does not restrict. The pre-paint theme script is the external `/theme-init.js`. Trusted Types are
  enforced with no policy allowed: the app never writes HTML strings into the DOM, and the smoke test checks that
  the chart, the baskets view and the search render without a violation. Responses also carry `nosniff`,
  `X-Frame-Options: DENY`, `no-referrer`, COOP/CORP `same-origin` and a deny-all `Permissions-Policy`.
- **Navigation**: `will-navigate`, `will-frame-navigate` and `will-redirect` are canceled unless the target is
  `app://chartmate`. Every `window.open` is denied, and webviews cannot attach. These rules are applied to every
  `WebContents` through `web-contents-created`.
- **Permissions and devices** (permission request and check handlers, device permissions, display capture, the
  HID/serial/USB pickers): all denied, and downloads are blocked. These rules apply to **every** session, including
  ones created later, through `session-created`.
- **Renderer network**: `webRequest.onBeforeRequest` cancels every request that is not `app://chartmate`. `devtools:`
  is also allowed in development.
- **Main-process network**: `globalThis.fetch` is wrapped by an allowlist on top of the direct, CA-pinned undici
  transport described above. It allows HTTPS only, exact hosts and
  the default port, and it follows redirects itself so that every hop is checked. On a redirect to another
  origin it drops the `Authorization`, `Cookie` and `Proxy-Authorization` headers. The allowed hosts are:
  - `query1/query2.finance.yahoo.com` and `finance.yahoo.com`, found by observing live traffic;
  - `guce.yahoo.com` and `consent.yahoo.com`, for the EU consent flow (from the yahoo-finance2 source);
  - the configured Binance host, or `api.exchange.coinbase.com`.

  Fixture mode allows nothing.
- **Fuses** (flipped in the `afterPack` hook with `@electron/fuses`):
  - RunAsNode: off;
  - EnableCookieEncryption: on;
  - EnableNodeOptionsEnvironmentVariable: off;
  - EnableNodeCliInspectArguments: off;
  - EnableEmbeddedAsarIntegrityValidation: on;
  - OnlyLoadAppFromAsar: on;
  - LoadBrowserProcessSpecificV8Snapshot: off;
  - GrantFileProtocolExtraPrivileges: off.
- **Unused features**: the app never uses `remote`, `file://` or `shell.openExternal`.

### Signing, notarization, updates

Signing is configured only through environment variables or CI secrets. `build/signing.cjs` decides, per
platform, whether a build is signed. Without the secrets, the build is unsigned and still succeeds.

- **macOS**:
  - Signing: set `CSC_LINK` (a base64 `.p12`) and `CSC_KEY_PASSWORD`.
  - Notarization: also set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
  - The hardened runtime is on. The only entitlement is `com.apple.security.cs.allow-jit`, which V8 needs. Because
    there are no native modules, there is no `disable-library-validation`.
- **Windows**: use Azure Trusted Signing (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`,
  `AZURE_PUBLISHER_NAME`) or a certificate (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`).
- **Auto-update** (`electron-updater`, GitHub provider) is **off by default**.
  - **Unsigned builds**: the updater is compiled out entirely, whatever `product.json` says. There is no
    `updater.cjs` in the package and no updater code path in `main.cjs`.
  - **Signed builds**: the updater runs only when all of these hold:
    - `autoUpdate` is `true` in `product.json`;
    - the build ships an `app-update.yml`;
    - `CHARTMATE_DISABLE_UPDATES` is not set to `1`.
  - **How updates are verified**:
    - Windows: electron-updater checks the installer's Authenticode signature against the `publisherName` pinned
      in `app-update.yml`. The app refuses to update if that field is missing.
    - macOS: Squirrel.Mac checks that the new app's code signature satisfies the running app's designated
      requirement. This is also the only case that opens a listener (the loopback exception described under
      "How it works").
  - **Network**: the updater's own session may reach only the GitHub hosts.

### Renaming the product

Edit `apps/desktop/product.json` and nothing else:

- `productName` sets the window title, menu, `.app` and installer names, and the data directory name.
- `appId` is the bundle id or AppUserModelID.
- `executableName` names the Windows and Linux executable.

The data directory follows `productName`. To carry users' data over, add the old name to `previousProductNames`.
On first start the app then moves `chartmate.db` (and its WAL/SHM files) and `window-state.json` from the old directory.
It never overwrites existing data.

## Tests

```sh
pnpm test        # unit + route tests of every package (incl. desktop), no network
pnpm typecheck   # all packages + the e2e suite
pnpm e2e         # Playwright end-to-end test (Chromium)
pnpm --filter @chartmate/web test   # one package: shared, server, web or desktop
```

`pnpm e2e` builds everything, starts the built server on port 8799 in fixture mode (`CHARTMATE_PROVIDERS=fixture`,
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

## License

Chartmate is free software, licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). You may use, study, modify and share it. If you distribute it, or run a modified version as a
service that other people use over a network, you must make your version's complete source code available to
them under the same license.

Exceptions: the Wyckoff indicator files keep their own MPL-2.0 license (see "Custom indicators"), and
third-party dependencies keep their own licenses.
