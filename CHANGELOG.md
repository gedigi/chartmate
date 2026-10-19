# Changelog

What changed in each release of Chartmate. Versions follow [semantic versioning](https://semver.org); the desktop
app, the Docker image and the release tag share one version number.

## Unreleased

## [1.1.2] - 2026-10-19

### Everywhere

- Indicator line and histogram bar colors are picked from the theme swatches, like drawing colors, instead of a
  free color wheel. A picked color follows the theme: it recolors when you switch between dark and light (up /
  down follow your own candle colors). Colors saved before keep showing exactly, as a **Custom** swatch.
- MACD, AO and PPO histograms swap their two tones: a bar that grows over the previous one (green growing, red
  recovering toward zero) is drawn in the full color, and a bar that falls (green shrinking, red growing downward)
  in the soft, darker tone.
- The span next to the date range buttons no longer sometimes starts one bar late (for example 1D reading 09:35
  instead of 09:30): at some chart widths and bar counts the first bar was left out of the count.
- The 1M date range now shows 2-hour bars (was 1-hour) and 3M shows 4-hour bars (was daily); 6M, YTD and 1Y keep
  daily bars.
- Charts, live updates, baskets, the watchlist and symbol search reuse data fetched moments ago instead of asking
  Yahoo, Binance or Coinbase again, and make no new requests for stocks while the market is closed (nights and
  weekends; at most one every 6 hours), so the free data sources are asked far less often.

### Desktop app

- macOS: About Chartmate says where updates are (**Chartmate** menu → **Check for Updates…**).

## [1.1.1] - 2026-10-16

### Everywhere

- **Date ranges**: 1D, 5D, 1M, 3M, 6M, YTD, 1Y and All under the chart show that period, ending at the latest
  bar, at a fitting interval (1D on 5-minute bars, 1Y on daily bars, All on weekly or monthly bars), with the
  span it covers next to the buttons. Stocks count trading sessions and New York dates, crypto the clock in UTC.
  Zooming, scrolling or changing the interval deselects the range.
- Time axis ticks and grid lines fall on calendar boundaries (months, quarters, years, days, hours…), evenly spaced
  and never crowded, instead of every so many bars: month labels no longer skip unevenly.
- An intraday chart left in a background tab, or on a computer that slept, across the market close now loads the
  last bars of the session when you come back, instead of showing a stale close until the next session opens.
- A charted basket deleted from another window shows "Couldn't load" with Retry instead of retrying forever under
  "Connection lost". Loads that cannot succeed (a refused layout or drawings request) stop retrying, a basket
  lookup that fails for a moment is retried, and Retry after a symbol error shows the chart loading right away.

- **About Chartmate**: click the Chartmate mark in the top bar to see the version (self-hosted: also the
  server's, when it differs) and get the source code of that version and the license, as the AGPL-3.0 asks of
  software used over a network. The desktop app shows the source address as text to copy, since it opens no
  links. The Docker image is built with its repository, so its dialog links the source too. A release build links
  its release tag, and any other build the exact commit it was built from.

### Desktop app

- Automatic updates for signed builds: the app checks 15 seconds after it starts and every 6 hours, downloads
  new versions in the background and asks to restart now or later (later installs on quit), with a short summary
  of the release notes. A failed check, download or install you asked for is reported in a dialog.
- macOS: **Check for Updates…** in the Chartmate menu checks right away, and **Check for Updates Automatically**
  next to it turns the background checks off. An unsigned build says it cannot update itself and offers to open
  the releases page. While a downloaded update is still being prepared for installation, it says so, and gives
  up on that update after 10 minutes without an answer from macOS.
- Windows has no update menu (the window has no menu bar): signed builds update in the background. Windows builds
  are unsigned for now and keep updating by hand from the releases page.
- `CHARTMATE_DISABLE_UPDATES=1` turns updates off entirely.
- Updates are verified before they install: the downloaded app (macOS) or installer (Windows) must carry the
  advertised, newer version; on macOS it must be signed by the same developer, and on Windows validly signed by
  the pinned publisher, with any failure to check refusing it. On macOS the restart prompt appears only once the
  update is ready to install.
- Chartmate 1.0.0 shipped with updates turned off: install this version by hand once, and later versions arrive
  automatically.
- The released app keeps all of its startup and window protections even when its executable is renamed (for
  example a copy renamed to `electron.exe`): it still refuses debugging switches, keeps DevTools off and ignores
  `CHARTMATE_USER_DATA_DIR`.
- `BINANCE_BASE_URL` accepts only the Binance API hosts (`data-api.binance.vision`, `api.binance.com`,
  `api.binance.us`); any other value is ignored with a warning in the log instead of being allowed through.
- An invalid `CHARTMATE_PROVIDERS` or `CRYPTO_PROVIDER` now shows a short error naming the variable instead of
  crashing at startup.
- The window reopens no larger than the screen it lands on (after a larger display is disconnected), centered on
  a screen narrower than its minimum size and with its title bar on screen when the screen is too short, keeps
  the light theme's background when the page is slow to answer at close, and launching the app again on macOS
  with no window open now opens one.
- The app now includes the AGPL-3.0 license and the licenses of the third-party software it contains
  (`LICENSE` and `THIRD_PARTY_NOTICES.txt` next to the app's resources); on macOS also Electron's license and the
  Chromium credits (`LICENSE.electron.txt`, `LICENSES.chromium.html`), which Windows already had.

### Self-hosting

- `compose.yaml` runs the published image by default: download it and `docker compose up -d`, no `.env` needed
  (create one only to set a password, change the port or use Postgres).
- A simpler install guide: a one-line quick try, a two-command Compose install, and how to pin the image by
  version and digest and verify its build provenance.
- Each GitHub Release now carries its `compose.yaml` and `.env.example` (as `env.example`).
- Without a password, the server answers only to `localhost`, `127.0.0.1` and `[::1]` (any port) and refuses
  any other `Host` with a 403, so a web page cannot reach it through DNS rebinding. Add the names you use to the
  new `CHARTMATE_ALLOWED_HOSTS`, or set a password. Behind a trusted reverse proxy the `Host` header and every
  `X-Forwarded-Host` must be allowed; the proxy must pass the real host, and an exposed instance still needs a
  password.
- State-changing API requests (with or without a password) are refused when their `Origin` is not the page's
  own origin.
- The image runs as the numeric user `1000:1000` (the same `node` user as before), so Kubernetes'
  `runAsNonRoot` can verify it, and carries `LICENSE` and `THIRD_PARTY_NOTICES.txt` in `/app`.
- `latest`, `X` and `X.Y` move only to the highest release in their range: a fix for an older line no longer
  moves them backward. The GitHub Release marked Latest follows the same rule.
- Running from source now needs Node 26 and pnpm 12 (`corepack enable`; Node 26 no longer bundles corepack, so
  install it first with `npm install --global corepack@0.36.0`).
- The image moves to Node.js 26 on Debian 13 (trixie) slim, applies Debian's security updates when it is built,
  and pulls the newest base image on every build. Every image is scanned before it is published: a high or
  critical vulnerability with a fix available stops it. Each Monday the latest release's image is rebuilt and
  re-pushed under its tags and `latest`, so OS and Node.js fixes arrive between releases.
- `docker compose up` now pulls newer images itself (`pull_policy: always`); `CHARTMATE_PULL_POLICY=never` keeps
  a local build, and `CHARTMATE_POSTGRES_PULL_POLICY=missing` keeps the Postgres image you have.
- The image's base must be a digest Docker's official-images project recorded, and is named in the image's
  `org.opencontainers.image.base.*` labels. Each image is pushed by digest, scanned and smoke-tested, and only then
  tagged, so the tags point at exactly the image that was checked. The weekly rebuild's attestations name
  `docker-refresh.yml` and `main` (README, Security, shows how to accept only one workflow).
- The bundled Postgres is now Postgres 18 on trixie, kept at its newest 18.x. See the upgrade note below.

### Upgrade notes

- **Bundled Postgres (the `postgres` Compose profile): move your data before upgrading.** Postgres 18 cannot open
  the Postgres 17 data of the previous `compose.yaml`; with the new file the `postgres` container refuses to
  start (it never touches the old data) and Chartmate cannot reach its database. Follow "Upgrading from Postgres
  17" in the README: dump with a temporary Postgres 17 container, archive and remove the old volume, restore into
  Postgres 18. SQLite installs and external Postgres servers are not affected.

### Data and security

- Symbol ids are validated and normalized: `crypto:btc` and `crypto:BTC` are one symbol with one cache
  (surrounding whitespace, tabs and line breaks included, is trimmed), and a ticker that does not look like one
  is refused before any request goes to the data provider. Saved watchlists, layouts, drawings and baskets are
  rewritten to the normalized ids on upgrade (case variants merged). A basket version holding an id that is not
  valid loses that constituent and is reweighted (the server logs which).
- The self-hosted web app is served with a strict Content Security Policy and the usual hardening headers
  (no framing, no MIME sniffing, no referrer). Hashed bundles are cached for a year, `index.html` is always
  revalidated, dotfiles are never served, and a missing asset is a 404 instead of the app page.
- A recent range the data provider briefly answered with no bars is asked again later instead of staying empty
  for good; cached bars and their coverage are written together, so a split check can no longer slip between
  them.
- Sessions are no longer signed with a secret derived from the password: without `CHARTMATE_SESSION_SECRET`
  a random secret is generated once and kept in the database. Changing the password now signs every session
  out, and over HTTPS the cookie is named `__Host-chartmate_session`. **After upgrading you have to log in
  again** (sessions from earlier versions are no longer accepted).
- The server refuses to start when `CHARTMATE_PASSWORD` is only whitespace (it used to turn the login off), and
  warns about a password shorter than 12 characters, or about being reachable beyond loopback without a password
  (the default Compose setup, published on 127.0.0.1, does not warn).
- API requests another site's page triggers (the browser marks them cross-site) are refused, so a web page can
  no longer make an open instance spend its data-provider quota. A symbol the provider just reported unknown is
  not asked for bars again for 10 minutes.
- A basket may hold at most 100 versions and 100 different symbols across them. Two versions appended at the
  same time can no longer overwrite each other.
- Watchlist quotes go easier on the data providers: a crypto pair Binance does not know is left out of quote
  requests for 10 minutes (it used to turn every poll into one request per symbol), and a rate limit or outage
  pauses quote requests for 30 seconds.
- An unknown symbol is answered with a plain "Unknown symbol" message; the data provider's own error text is only
  logged by the server.
- `BINANCE_BASE_URL` must be an `https://` URL (as in the desktop app); the server refuses to start otherwise.
- Postgres: the migration bookkeeping and column checks use the connection's current schema only, so another
  schema in the same database (e.g. one with an older copy of the tables) is no longer mistaken for Chartmate's.
  Appending basket versions concurrently on Postgres no longer fails with an internal error.
- Rolling back to 1.0.0 now means deleting the records of migrations 004–007 first; see Troubleshooting in the
  README (migration 004 cannot be undone).
- A stock split the data provider reports a few days late is now still applied to cached history (and never
  twice, even when the provider moves its date by a day, e.g. to the evening before in New York time).

### Charts and baskets

- **Rectangle** drawing tool (toolbar, or **⌥R** / **Alt+R**): click two opposite corners to mark a zone in time
  and price. Drag any corner or edge midpoint to resize it, or the inside to move it. It has a crisp border in
  the drawing colors, widths and line styles, and a calm tint of its own color on the chart background, which
  **Fill** in the style bar turns off. Locking, copy and paste, the magnet and theme recoloring work as for other
  drawings. Two clicks in the same bar or at the same price draw nothing.
- A selected rectangle or long / short position shows its start and end times on the time axis without overlap:
  the two labels point away from each other, stay inside the axis, and merge into one "start – end" label when
  they are close. A position's time labels now show only while it is selected, no longer on hover.
- A daily chart of a stock or a stock-only basket keeps updating its last bar over the weekend instead of
  getting no latest bar until the next session.
- On intraday charts and live quotes of a stock-only basket, a new version now takes effect at the start of
  its date's New York session (04:00, pre-market) instead of at midnight UTC, which in winter fell inside the
  previous evening's post-market and valued it with the new holdings. 2h and 4h extended-hours bars no longer
  mix two versions, and the version markers move to that time. Daily charts are unchanged.
- A basket version dated tomorrow is no longer sized for hours at a price from the middle of today's
  session: its holdings are re-sized every few minutes until today closes, then fixed at the final close.
- A basket no longer fails to load when a constituent's daily close is zero or negative where a version is
  sized: the last valid close up to 5 bars and 10 days earlier is used, and a notice names the dates skipped.
- A single bad constituent bar from the data provider (a zero, negative or non-numeric price) no longer draws a
  gap or a spike in a basket: the constituent keeps its previous close for that bar.

### Fixes

- A watchlist you emptied is no longer refilled with the default symbols when you open Chartmate in another
  browser or on another device: the server now says whether a list was ever saved, and only a server that
  never had one gets the defaults. A list emptied before this version stays empty in the browsers that already
  had it (the first one to open records it on the server); a brand-new browser gets the defaults once until then.
- Indicator settings store only the colors you change: the other lines (and the untouched up or down bar
  color) keep following the theme instead of freezing to the palette of the theme they were edited in. A
  color equal to that line's default in the other theme counts as a default too, so it follows the theme.
- Failed drawing and watchlist saves are retried with backoff instead of being dropped, and a failed watchlist
  load is retried too. Until the watchlist has loaded it shows placeholder rows and cannot be edited, so an
  early edit is no longer lost. Watchlist trouble shows as one quiet line ("Can't reach the server.
  Retrying…"); a load refused for good is not retried.
- Layout, drawing and watchlist saves stop retrying after about 4 minutes and say "not saved" with a Retry
  button, so a tab left open offline cannot keep writing old data over changes made in another tab. All three
  use the same small amber note ("Layout not saved. Retrying…"); red is kept for saves refused for good.
- Unsaved drawings stay with their symbol: switching symbols or opening the Baskets page keeps retrying them,
  one note names every symbol still waiting, and an edit on another symbol no longer drops them. A save refused
  for good keeps them until you discard them.
- Deleting a basket removes it from the watchlist, clears its drawings and moves the chart to another symbol.
  A stale reference to a deleted basket shows as "Deleted basket" instead of retrying forever, and symbol
  lookups that fail for good (such as an unknown symbol) are no longer retried every 30 seconds.
- Parallel channel fills are a tint of the channel's own hue on the chart background (like position zones)
  instead of a plain translucent color, and the extended-hours shade uses a color tuned for each theme.
- Removing an indicator no longer re-creates the indicators after it, so their panes keep their heights and
  the chart does not flicker.
- A stored drawing without points is skipped when drawings load (it used to leave the chart in drawing mode),
  and the server drops such a drawing on save instead of rejecting the whole list.
- The price field of horizontal drawings rejects exponent notation (such as `1e-9`) and prices that round to
  zero at 8 decimals.
- Basket changes that round to zero read "0.00%" in the neutral color, as in the watchlist (no more "-0.00%"
  in the down color or "+0.00%" in the up color), and the basket preview formats numbers like the rest of the app.
- VWAP on a basket holding crypto resets at midnight UTC, like its bars, instead of midnight New York time.
- Stored indicator settings are checked when the layout loads: a period or other param outside its allowed
  range falls back to its default, and an invalid line color follows the theme again.
- Indicator names and settings labels are in sentence case ("Relative strength index", "RSI length").

## [1.1.0] - 2026-10-16

Published as a Docker image only (the desktop build did not complete); 1.1.1 has the same changes for every
platform.

## [1.0.0] - 2026-10-14

The first stable release: a charting app for US stocks and ETFs, crypto and your own baskets, as a desktop app
for macOS and Windows and as a self-hosted server with a Docker image.

### Charts

- Candlestick, OHLC bar, line and area charts from 1 minute to 1 month, in a dark and a light theme.
- US stocks and ETFs with pre- and post-market data (a regular / extended hours toggle, extended hours shaded),
  and crypto priced in USD. Free market data from Yahoo Finance and Binance or Coinbase, cached locally.
- A last price capsule on the price axis that counts down to the bar close.
- Chart appearance per theme: candle colors and body style, last price line, line and area color, and the
  default style of new drawings.

### Indicators

- Moving averages, Bollinger Bands, VWAP, Parabolic SAR, volume, MACD, RSI, stochastic, CCI, ATR, PPO,
  Wyckoff accumulation and distribution, and more; up to 30 on a chart, the same set on every symbol.
- Line colors from a palette tuned for each theme, editable widths, styles and histogram colors.
- Dashed reference levels on oscillators (RSI 70 / 30, MACD at 0, …), editable or hidden per indicator.

### Drawing tools

- Trend line, ray, extended line, horizontal and vertical lines, price line, parallel channel, Fibonacci
  retracement, text, and long and short positions with target, stop, risk / reward and the trade's outcome.
- Saved per symbol and anchored to time and price, so they stay put across timeframes and zoom levels.
- Color swatches that follow the theme, with the last picked color used for new drawings; widths, line styles
  and exact prices.
- Copy and paste drawings, lock a single drawing or all of them, snap to prices with ⌘ or Ctrl, keep lines
  horizontal with Shift, and measure price, bars and time with a Shift-drag.

### Watchlist and baskets

- A watchlist with live quotes, pre- and post-market prices, 30-day sparklines and sections you can rename,
  collapse and reorder.
- A detail panel for the open symbol: market status, day range, volume and 52-week range.
- A resizable sidebar.
- Baskets: weighted sets of stocks and crypto charted like any symbol, with rebalancing versions and history
  before the basket's start.

### Desktop app

- Native installers for macOS (Apple silicon and Intel) and Windows (x64 and Arm), with a frameless window whose
  title bar is the app's own top bar.
- Your data stays on your computer: no account, no server and no network listener. The app runs sandboxed and
  connects only to the market data providers.
- The release notes say how each platform's build is signed. A notarized macOS release has its disk image
  notarized too, so macOS accepts the download as well as the app.

### Self-hosting

- A Docker image for `linux/amd64` and `linux/arm64` on GitHub Container Registry, with a Compose file, SQLite or
  Postgres, an optional password login, and a hardened container (read-only, non-root, no capabilities).

### Licensing

- Chartmate is free software under the GNU AGPL-3.0.

[1.0.0]: ../../releases/tag/v1.0.0
