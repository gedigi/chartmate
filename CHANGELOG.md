# Changelog

What changed in each release of Chartmate. Versions follow [semantic versioning](https://semver.org); the desktop
app, the Docker image and the release tag share one version number.

## Unreleased

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

### Data and security

- Symbol ids are validated and normalized: `crypto:btc` and `crypto:BTC` are one symbol with one cache, and a
  ticker that does not look like one is refused before any request goes to the data provider. Saved watchlists,
  layouts, drawings and baskets are rewritten to the normalized ids on upgrade (case variants merged). A basket
  version holding an id that is not valid loses that constituent and is reweighted (the server logs which).
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
- A stock split the data provider reports a few days late is now still applied to cached history (and never
  twice).

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
