# Changelog

What changed in each release of Chartmate. Versions follow [semantic versioning](https://semver.org); the desktop
app, the Docker image and the release tag share one version number.

## Unreleased

### Desktop app

- Automatic updates for signed builds: the app checks 15 seconds after it starts and every 6 hours, downloads
  new versions in the background and asks to restart now or later (later installs on quit), with a short summary
  of the release notes. A failed check, download or install you asked for is reported in a dialog.
- macOS: **Check for Updates…** in the Chartmate menu checks right away, and **Check for Updates Automatically**
  next to it turns the background checks off. An unsigned build says it cannot update itself and offers to open
  the releases page.
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
