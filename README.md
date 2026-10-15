# Chartmate

Beautiful charts for US stocks, crypto and baskets of your own, on your desktop or on your own server.

Chartmate charts US stocks and ETFs (pre- and post-market included) and crypto with indicators, drawing tools,
long / short position planning and a watchlist with sections. **Baskets** are weighted sets of symbols, charted
like any single one. Market data is free (Yahoo Finance for stocks, Binance or Coinbase for crypto) and cached
locally. There is no account: your charts, drawings, watchlist and baskets stay on your machine.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/chartmate-dark.png">
  <img alt="Chartmate showing a daily candlestick chart with moving averages, volume, MACD and RSI panes, a long position that hit its target, the watchlist with sections and the symbol details" src="docs/images/chartmate-light.png">
</picture>

- **[Download](#download)** the desktop app for macOS or Windows.
- **[Self-host](#self-host)** it with Docker and use it from any browser.
- **[Develop](#develop)** it: the code, the checks and how to add an indicator.

Contents: [Using Chartmate](#using-chartmate) · [Data sources and caveats](#data-sources-and-caveats) ·
[Troubleshooting](#troubleshooting) · [Desktop app](#desktop-app) · [HTTP API](#http-api) ·
[Custom indicators](#custom-indicators) · [License](#license) · [Changelog](CHANGELOG.md)

## Download

Get the latest version from [Releases](../../releases/latest):

| System | File |
| --- | --- |
| macOS 12 or later, Apple silicon | `Chartmate-<version>-mac-arm64.dmg` |
| macOS 12 or later, Intel | `Chartmate-<version>-mac-x64.dmg` |
| Windows 10 or later, x64 | `Chartmate-<version>-win-x64.exe` |
| Windows 10 or later, Arm | `Chartmate-<version>-win-arm64.exe` |

On macOS, open the `.dmg` and drag Chartmate to Applications. On Windows, run the installer: it installs for your
user only, without administrator rights. Each release also has `.zip` archives of the same apps.

Each release's notes have a table saying how each platform's build is signed (for example "Developer ID +
notarized" for macOS, or "unsigned"). An unsigned build needs one extra step the first time:

- **Windows**: SmartScreen warns; choose **More info**, then **Run anyway**.
- **macOS**: macOS refuses to open the app. Open **System Settings**, **Privacy & Security**, and click **Open
  Anyway** next to the message about Chartmate (on macOS 14 and earlier: right-click the app, then **Open**).

The desktop app needs no account and no server: your charts, drawings, watchlist and baskets are stored on
your computer (see [Data location](#data-location)).

### Updates

Signed builds update themselves. The app checks for a new version 15 seconds after it starts and then every 6
hours, downloads it in the background and then asks whether to restart now or later; with **Later** the update
is installed the next time you quit. Your data is kept. The dialog shows a short, plain-text summary of the
release notes. If a check, download or install you asked for fails, a dialog says so; the details are in the
[log](#data-location), and the next check tries again.

On macOS:

- **Check for Updates…** in the **Chartmate** menu checks right away and tells you the result.
- **Check for Updates Automatically**, next to it, turns the background checks off or on. **Check for Updates…**
  works either way. The choice is saved in `update-settings.json` in the [data directory](#data-location).
- An unsigned build cannot update itself: **Check for Updates…** says so and offers to open the releases page.

On Windows the window has no menu bar, so there is no update menu. A signed build checks and downloads in the
background and asks to restart when an update is ready. Windows builds are unsigned for now (each release's
signing table says), and unsigned builds do not update themselves: download the new installer from the
[releases page](../../releases/latest) and run it over the old version.

Everywhere:

- `CHARTMATE_DISABLE_UPDATES=1` in the environment turns updates off completely (on macOS the menu item is
  grayed out and says why).
- A pre-release build (`1.1.0-beta.1`) also updates to newer pre-releases; a regular release only to regular
  releases. Only a newer version than the one running is offered, and the downloaded app's (macOS) or
  installer's (Windows) own version is checked against it before it is installed.
- **Chartmate 1.0.0 shipped with updates turned off**: if you have 1.0.0, download and install the next version
  once by hand; from then on the app updates itself (on macOS; on Windows once its builds are signed).

## Self-host

Run Chartmate on your own server and use it from any browser. Every release publishes a Docker image for
`linux/amd64` and `linux/arm64` to GitHub Container Registry as `ghcr.io/gedigi/chartmate`. Tags: `X.Y.Z`,
`X.Y`, `X` and `latest`; a pre-release only gets its full version (`X.Y.Z-beta.1`).

### Quick try

One line, no files:

```sh
docker run -d --name chartmate -p 127.0.0.1:8787:8787 -v chartmate-data:/data ghcr.io/gedigi/chartmate:latest
```

Open http://localhost:8787. This runs the image without the hardening flags and is meant for trying Chartmate
out; for anything long-lived use the [Compose install](#recommended-install-docker-compose) below (or the
[hardened `docker run`](#advanced-hardened-docker-run)). If port 8787 is already taken (for example by
`pnpm dev`), use another host port, such as `-p 127.0.0.1:8788:8787`, and open that one. Your data lives in the
`chartmate-data` volume. Remove the container with `docker rm -f chartmate` (the volume, and your data, stays
until you delete it with `docker volume rm chartmate-data`).

### Recommended install (Docker Compose)

Download the Compose file, read it (it is short and commented), then start it:

```sh
curl -fsSLO https://raw.githubusercontent.com/gedigi/chartmate/main/compose.yaml
docker compose up -d
```

Open http://localhost:8787. `docker compose ps` shows the container as `healthy` once it is up.

Switching from the quick try? Run `docker rm -f chartmate` first: both publish port 8787. They also use
different volumes (`chartmate-data` for the quick try, `chartmate_chartmate-data` for Compose), so the Compose
install starts empty; to keep your data, copy one volume into the other the way [Backups](#backups) shows.

This is the same image with the hardening on (read-only root filesystem, a tmpfs on `/tmp`, no Linux
capabilities, `no-new-privileges`), a restart policy (`unless-stopped`) and a healthcheck. No `.env` is
needed. Create one only to set a password, change the port or use Postgres; fetch the annotated template the
same way, copy it to `.env` (never over an existing one, readable by you only) and edit it:

```sh
curl -fsSL -o .env.example https://raw.githubusercontent.com/gedigi/chartmate/main/.env.example
[ -e .env ] || install -m 600 .env.example .env
```

- Data lives in the `chartmate-data` volume (SQLite at `/data/chartmate.db`).
- The port is published on `127.0.0.1` only. To reach it from other machines, prefer a
  [reverse proxy](#behind-a-reverse-proxy-https) on the same host. Otherwise set a password first (see
  [Security](#security)), then `CHARTMATE_BIND=0.0.0.0` in `.env`. Ports Docker publishes bypass host firewalls
  such as ufw, so `0.0.0.0` really is every interface. `CHARTMATE_PORT` changes the host port.
- The container runs as a non-root user and writes only to `/data`, plus SQLite's temporary files (large
  sorts, `VACUUM`) to the `/tmp` tmpfs.
- `CHARTMATE_IMAGE` overrides the image: pin a version (`ghcr.io/gedigi/chartmate:1.0.0`, or by digest, see
  [Security](#security)) or run your own build (`docker build -t chartmate:local .`, then
  `CHARTMATE_IMAGE=chartmate:local`). A fork publishes under its own name; pulling a private package needs
  `docker login ghcr.io` with a token that has the `read:packages` scope.

### Upgrading

```sh
docker compose pull && docker compose up -d
```

For the quick-try container: `docker pull ghcr.io/gedigi/chartmate:latest && docker rm -f chartmate`, then run the
same `docker run` line again (the volume keeps your data).

Database migrations run at startup, and data saved by older versions stays loadable. To upgrade on your own
schedule, pin a version (`CHARTMATE_IMAGE=ghcr.io/gedigi/chartmate:1.0.0` in `.env`, or a digest as in
[Security](#security)) instead of `latest`, and take a backup first. `docker stop` (SIGTERM) shuts the server down cleanly.

### Backups

SQLite: stop the container and archive its volume. Compose names the volume `chartmate_chartmate-data`:

```sh
docker compose stop chartmate
docker run --rm -v chartmate_chartmate-data:/data:ro -v "$PWD:/backup" alpine \
  tar czf "/backup/chartmate-$(date +%F).tgz" -C /data .
docker compose start chartmate
```

The quick-try container uses the `chartmate-data` volume instead: `docker stop chartmate`, the same
`docker run --rm …` line with `-v chartmate-data:/data:ro`, then `docker start chartmate`.

To restore, stop the container and extract the archive into the volume the same way
(`tar xzf /backup/chartmate-<date>.tgz -C /data`, with the volume mounted read-write). Restoring a quick-try
archive into `chartmate_chartmate-data` moves your data to the Compose install.

Postgres (the bundled service):

```sh
# back up
docker compose exec -T postgres pg_dump -U chartmate --clean --if-exists chartmate > chartmate.sql
# restore
docker compose stop chartmate
docker compose exec -T postgres psql -U chartmate -d chartmate -v ON_ERROR_STOP=1 < chartmate.sql
docker compose start chartmate
```

### Postgres

In `.env` (see above), set `POSTGRES_PASSWORD` and uncomment `DATABASE_URL` and `COMPOSE_PROFILES=postgres` (all three
are in `.env.example`), then `docker compose up -d`. This starts the `postgres` service with its own volume and
points Chartmate at it. Data is not copied over from SQLite. Any other Postgres works too: set
`DATABASE_URL=postgres://user:pass@host:5432/chartmate`. Chartmate keeps its tables, and its migration bookkeeping, in the connection's current
schema (the first schema of its `search_path`).

### Behind a reverse proxy (HTTPS)

Terminate HTTPS in a reverse proxy (Caddy, nginx, Traefik, …) on the same host, forwarding to
`127.0.0.1:8787`, and set `CHARTMATE_TRUST_PROXY=1` (the number of proxy hops, or `true`, or the proxy's
IP/CIDR). Chartmate then takes the client IP, the `https` scheme and the host from the `X-Forwarded-*` headers,
so the login rate limits apply per client and the session cookie is marked `Secure`. Set a password (an
exposed instance always needs one), and list the public name in `CHARTMATE_ALLOWED_HOSTS`
(`chartmate.example.com`): without a password that is required, otherwise every request is refused with a 403.
Without `CHARTMATE_TRUST_PROXY` the server sees plain HTTP from the proxy even when the browser uses HTTPS: it
then issues the plain `chartmate_session` cookie without `Secure` (and without the `__Host-` prefix), so a
browser would also send it over plain HTTP. Set the variable whenever a proxy terminates TLS.

The proxy must pass the real host: the `Host` header and every `X-Forwarded-Host` entry must be allowed names
(the `Host` may also be `127.0.0.1:8787`, which some proxies send by default). Serve Chartmate only from a
site block for its own name, never from a catch-all or default server block, which would forward requests for
any name an attacker points at your server. With Caddy, for example (it passes the host by default):

```
chartmate.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

With nginx, inside the `server` block whose `server_name` is `chartmate.example.com`:

```
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### Security

- Set `CHARTMATE_PASSWORD` whenever the instance is reachable from anything but your own machine; it turns on
  a login page. Use a strong password (the server warns at startup below 12 characters), and serve the
  instance over HTTPS only. A password of only whitespace is refused at startup rather than read as "no
  password"; the server also warns when it is reachable beyond loopback without a password (judged on
  `CHARTMATE_PUBLISHED_BIND`, which `compose.yaml` sets from `CHARTMATE_BIND`, or else on `HOST`; the default
  Compose setup publishes on 127.0.0.1 and does not warn).
- Session cookies are signed with `CHARTMATE_SESSION_SECRET` when set (min 16 characters; `openssl rand -hex
  32`). When unset, a random secret is generated on first start and kept in the database (`settings` table),
  so it survives restarts; it is never derived from the password, so a leaked cookie gives nothing to guess the
  password from. Anyone who can read the database can forge sessions, which is no more than they can already
  read. Set the variable to keep sessions valid across a restore into a fresh database.
- Login attempts are rate limited: 10 failures per IP per 15 minutes, plus a global limit of 100
  failures per 15 minutes. The global limit means a determined attacker can lock *you* out for a while.
- **Allowed hosts.** Without a password the server answers only to `localhost`, `127.0.0.1` and `[::1]` (on
  any port), plus the names in `CHARTMATE_ALLOWED_HOSTS` (comma-separated hostnames or IP addresses, no scheme
  or port, e.g. `chartmate.example.com,192.168.1.10`). A request for any other `Host` gets a 403 before it
  reaches the API or the web app, so a malicious page cannot reach your instance by pointing its own domain at
  your machine (DNS rebinding). Only these exact spellings count as loopback: `0.0.0.0`, `127.1`, other
  `127.x.x.x` addresses and other IPv6 forms are refused, so open `http://localhost:8787` or
  `http://127.0.0.1:8787`. Behind a trusted proxy (`CHARTMATE_TRUST_PROXY`) the `Host` header and every
  `X-Forwarded-Host` entry must be allowed. With a password the login protects the instance and any host is
  served, unless `CHARTMATE_ALLOWED_HOSTS` is set, which is then enforced as well. Opening Chartmate by a LAN
  address or name without a password therefore needs that name in `CHARTMATE_ALLOWED_HOSTS`; for anything
  beyond your own machine, set a password.
- **Same-origin writes.** With or without a password, a state-changing API request (anything but `GET`) that
  carries an `Origin` is refused unless that is the request's own origin: same hostname and port as the host
  it was sent to, or the browser marks it `Sec-Fetch-Site: same-origin`. For a loopback host, a loopback
  `Origin` on any port is accepted too, which is what `pnpm dev` needs (the page on port 5173, the API on 8787).
  Requests without an `Origin` (curl, scripts) are not affected.
- **No cross-site API calls.** An API request the browser marks `Sec-Fetch-Site: cross-site` or `same-site`
  (another site's page loading an image, script or no-cors fetch from your instance) gets a 403, whatever its
  method, so another page cannot make your server spend its data-provider quota. Requests the browser marks
  `same-origin` or `none` (a typed URL), and requests without the header (curl, scripts), are not affected.
- **Response headers.** The web app is served with a strict Content Security Policy (same-origin scripts,
  styles, fonts and API calls only, no inline code, Trusted Types required, no framing), `X-Frame-Options:
  DENY`, `Cross-Origin-Opener-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  no-referrer`; API responses carry the last two plus `Cache-Control: no-store`. Hashed bundles under `/assets/` are cached for a year
  (`immutable`), `index.html` and the other files are revalidated on every load. Files whose name starts with a
  dot are never served, and a missing file (a path under `/assets/` or with a file extension) is a 404 rather
  than the app page. If you add your own CSP at a reverse proxy, keep it at least this strict.
- Behind a reverse proxy set `CHARTMATE_TRUST_PROXY`, otherwise every client appears to come from the
  proxy's IP and they all share one rate-limit budget, and the session cookie is not marked `Secure`.
- The session cookie lasts 30 days. Each cookie carries a keyed fingerprint of the password, so changing
  `CHARTMATE_PASSWORD` (or `CHARTMATE_SESSION_SECRET`, or deleting the generated `session_secret` row) signs
  every session out. Over HTTPS the cookie is named `__Host-chartmate_session` (Secure, `Path=/`, no `Domain`,
  so no other site or subdomain can set it); over plain HTTP it is `chartmate_session`. Logout clears both.
- **Pin the image.** `latest` follows every release. To run exactly the image you checked, look up the
  digest of a version, verify that digest itself, then pin both in `.env`:

  ```sh
  docker buildx imagetools inspect ghcr.io/gedigi/chartmate:1.0.0   # prints "Digest: sha256:…"
  gh attestation verify oci://ghcr.io/gedigi/chartmate@sha256:<digest> --repo gedigi/chartmate
  ```

  then `CHARTMATE_IMAGE=ghcr.io/gedigi/chartmate:1.0.0@sha256:<digest>`. Docker then pulls that digest only
  (the tag is just a label), and `docker compose pull` never moves it; upgrade by changing both.
  `gh attestation verify` checks the signed build provenance of exactly that digest: that it was built from
  this repository by its release workflow. Verifying by digest rather than by tag means the image you run is the
  one you checked, even if the tag is moved later. Every image also carries BuildKit provenance and an SPDX SBOM
  (`docker buildx imagetools inspect <image> --format '{{json .SBOM}}'`).

### Advanced: hardened `docker run`

The Compose file's hardening as a single command:

```sh
docker run -d --name chartmate --restart unless-stopped --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:8787:8787 -v chartmate-data:/data ghcr.io/gedigi/chartmate:latest
```

The image sets `HOST=0.0.0.0` so the published port is reachable, runs as the `node` user (uid/gid 1000)
and has a built-in healthcheck on `/api/health` (it honors `PORT`). With `--read-only`, always add
`--tmpfs /tmp`: without it, queries that spill to SQLite temporary files fail. A named volume just works; a
bind-mounted host directory must be writable by uid 1000:

```sh
mkdir -p ./chartmate-data && sudo chown 1000:1000 ./chartmate-data
docker run -d --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:8787:8787 -v "$PWD/chartmate-data:/data" ghcr.io/gedigi/chartmate:latest
```

### Without Docker

Requires Node 22 or later and pnpm 8 (see [Develop](#develop)):

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build && pnpm --filter @chartmate/server start
```

Open http://localhost:8787. The server also serves the built web app. It listens on `127.0.0.1` by
default; set `HOST=0.0.0.0` to reach it from other machines (the Docker image already does).

`pnpm --filter @chartmate/server start` runs with `apps/server/` as its working directory, so the default
`sqlite:./data/chartmate.db` is `apps/server/data/chartmate.db`. The path is relative to wherever the server is
started, so for anything you care about use an absolute path, e.g.
`DATABASE_URL=sqlite:/home/me/chartmate/chartmate.db pnpm --filter @chartmate/server start` (the directory is
created if missing).

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address. Use `0.0.0.0` (or `::`) to accept connections from other hosts. |
| `DATABASE_URL` | `sqlite:./data/chartmate.db` (Docker: `sqlite:/data/chartmate.db`) | `sqlite:<path>` or `postgres://…`. An empty SQLite path (`sqlite:`) is rejected. |
| `CHARTMATE_PASSWORD` | unset (no auth) | Enables password login. Only whitespace is an error; under 12 characters logs a warning. Changing it signs every session out. |
| `CHARTMATE_SESSION_SECRET` | generated once, stored in the database | Cookie signing secret, min 16 chars. Set it to keep sessions across a restore into a fresh database. |
| `CHARTMATE_TRUST_PROXY` | unset (`false`) | `true`, a hop count (e.g. `1`), or an IP/CIDR list of trusted proxies. |
| `CHARTMATE_ALLOWED_HOSTS` | unset | Comma-separated hostnames or IP addresses (no scheme or port; IPv6 in brackets) served besides `localhost`, `127.0.0.1` and `[::1]`. Enforced without a password, and with one when set; see [Security](#security). |
| `CHARTMATE_PUBLISHED_BIND` | unset (Compose: `CHARTMATE_BIND`) | Address the port is published on outside the container. Only used to decide whether to warn about running without a password; `compose.yaml` sets it, you never need to. |
| `CRYPTO_PROVIDER` | `binance` | `binance` or `coinbase`. |
| `BINANCE_BASE_URL` | `https://data-api.binance.vision` | Alternate Binance-compatible endpoint (`https://` only, no credentials, query or fragment). |
| `CHARTMATE_PROVIDERS` | `live` | `fixture` serves deterministic synthetic data (tests/demos, no network). |
| `CHARTMATE_WEB_DIST` | `apps/web/dist` (Docker: `/app/web`) | Directory of the built web app. |

## Develop

Monorepo (pnpm): `packages/shared` (types, sessions, resampling, basket math), `apps/server` (Fastify API),
`apps/web` (React + KLineChart), `apps/desktop` (Electron app) and `e2e` (Playwright). Requires Node 22
(`.nvmrc`) and pnpm 8: `corepack enable` installs the exact version pinned (with its hash) in `package.json`.

```sh
pnpm install --frozen-lockfile --ignore-scripts
DATABASE_URL=sqlite:/tmp/chartmate-dev.db CHARTMATE_PROVIDERS=fixture pnpm dev
```

`pnpm dev` starts the API server (`tsx watch`, port 8787) and the Vite dev server in parallel. Open
http://localhost:5173; Vite proxies `/api/*` to `http://localhost:8787` (`apps/web/vite.config.ts`; if you change
the server's `PORT`, update that target too). The command above uses a scratch database and the deterministic
fixture data (no network); a plain `pnpm dev` uses live data and the default `sqlite:./data/chartmate.db`, which
for `pnpm dev` is `apps/server/data/chartmate.db` (the server's working directory is `apps/server/`).

No dependency install script is needed (CI installs the same way), except Electron's binary download for
running the desktop app unpackaged: `node apps/desktop/node_modules/electron/install.js`.

| Task | Command |
| --- | --- |
| Build shared, server and web | `pnpm build` |
| Typecheck everything (incl. e2e) | `pnpm typecheck` |
| Unit and route tests of every package (no network) | `pnpm test` |
| One package | `pnpm --filter @chartmate/<shared\|server\|web\|desktop> test` |
| Server DB suites on Postgres | `TEST_PG_URL=postgres://… CHARTMATE_TEST_DB=postgres pnpm --filter @chartmate/server exec vitest run --no-file-parallelism test/db test/market test/baskets test/routes test/http` |
| End-to-end tests (Chromium) | `pnpm e2e` (first time: `pnpm exec playwright install chromium`) |
| Dependency vulnerabilities | `pnpm audit` |
| New indicator | `pnpm new:indicator <Name>` (see [Custom indicators](#custom-indicators)) |
| Desktop app, unpackaged | `pnpm --filter @chartmate/desktop start` |

`pnpm e2e` builds everything, starts the built server in fixture mode on port 8799 with a fresh SQLite file under
`test-results/`, and runs `e2e/tests/`. Set `E2E_PORT` to use another port (e.g. `E2E_PORT=8873 pnpm e2e`): the
database (`test-results/e2e-<port>.db`) and the results folder (`test-results/e2e-<port>/`) are named after the
port, so runs in several worktrees at once cannot collide. The run fails if the port is already in use.

Where to read next:

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, the checks every pull request passes, a step-by-step guide to adding
  an indicator, and how releases are made.
- [AGENTS.md](AGENTS.md): the guide to the code (layout, architecture boundaries, conventions), also for coding
  agents.
- [docs/desktop.md](docs/desktop.md): how the desktop app works, its security model, building, smoke tests and
  code signing.

## Using Chartmate

### Charts

- **Timeframes** 1m … 1M, chart types candles / bars / line / area, light and dark themes. The look is flat:
  the chart sits on its own rounded sheet, chrome is solid panels with hairline edges (no glass, glow or drop
  shadows), and every font is the system sans-serif (no web fonts). The time axis labels read with context
  ("Sep 21", "22", "13:30"; daily: "Sep", "22"), the crosshair date chip reads "Wed Sep 30 '26 · 12:30".
- **Symbol search**: the top bar search field (**⌘K** on macOS, **Ctrl+K** elsewhere, focuses it from anywhere).
- **RTH / ETH toggle** for stocks (and baskets containing a stock): RTH shows regular-hours bars only,
  ETH adds pre- and post-market bars, shaded on intraday stock charts (basket charts are not shaded). The shade
  is a per-theme token (`--session-shade`): a faint cool lift on the dark theme, a faint gray-blue on the light one.
  It is hidden for crypto, which trades around the clock.
- **Chart appearance** ("Chart appearance" button in the top bar): candle up/down colors, body style (filled,
  hollow, hollow up, hollow down; OHLC bars use the colors only), **last price line** (neutral, the default:
  the theme's text color, near-white on dark and ink on light; or the candle up/down color). The last price
  sits in a capsule on the price axis with a fine dashed price line and the bar-close countdown, see
  below), line/area color and width, and the default style (color, width, solid/dashed/dotted) of new drawings. It is global (stored in the `default`
  layout, not per symbol) and applies live. Appearance is **per theme**: the dialog edits the active theme
  ("Dark theme" / "Light theme"), toggling the theme switches to the other theme's settings, and "Reset to
  defaults" resets only the active theme. A color that barely shows on the theme background (contrast
  ratio below 1.5) gets an inline "Low contrast on the … background" warning. Layouts saved before
  appearance was per theme (one flat appearance) still load: their settings become the dark theme's.
- **Default market colors**: one up and one down color per theme (the `--up` / `--down` CSS tokens; dark
  `#3ccfd0` / `#e76a88`, light `#0b9da0` / `#c43d68`), used by candles, volume, MACD, AO and PPO bars, positions,
  the watchlist, baskets and sparklines. Volume / MACD / AO / PPO bars without their own colors follow the active
  theme's candle colors, custom ones included. Rising MACD / AO / PPO bars use an opaque soft tone of the same hue;
  the legend shows histogram values in the readable up / down text colors. Parabolic SAR dots use the same up
  / down colors. Indicator lines take a per-theme categorical palette (six colors, none of them green or red);
  VWAP uses its own slot (blue), apart from the moving averages and Bollinger Bands it shares the price pane
  with. The Wyckoff overlay paints with the same palette: accumulation boxes, events and trend bars in the up
  family, distribution in the down family, sideways ranges in a muted gray, plain pivots in the palette's
  gold; bars against the trend take the trend color's soft tone. Everything follows the theme toggle and your
  custom up / down colors.
  Stored colors equal to the defaults of earlier versions are reset once, so they follow the current
  defaults (indicator line colors that are all the old palette too); colors you picked yourself are kept.
- **Readable labels**: labels drawn on a color (crosshair, text annotations, the last price label in candle
  color mode) keep white text while it reaches about 3:1 contrast with the label color, otherwise they use
  white or near-black, whichever contrasts more. KLineChart draws the last price text in one color for up,
  down and unchanged labels, so in candle color mode the rule uses the worst case over the three colors.
  Start/version marker labels keep their muted color on the chart background under the same rule.
- **Bar-close countdown**: on intraday charts (and daily crypto charts) the last price capsule counts down to the
  bar close ("4:59", "1:04:59"; "Closed" once the bar ended). For stocks a bar ends at the session close if that
  comes first: 16:00 New York for RTH, 20:00 for ETH (so a 1h bar starting at 15:30 closes at 16:00 on an RTH
  chart). Chartmate has no exchange holiday or early-close calendar, so the countdown uses these regular session
  times: on an early-close day (such as the day after Thanksgiving, when the regular session ends at 13:00 New
  York), a bar that would run past the early close counts down to its normal end (at the latest 16:00, or 20:00
  with extended hours) instead, and once no newer bar arrives it reads "Closed". On a market holiday the last bar
  is the previous session's, so it reads "Closed". The watchlist's detail panel reads a holiday as closed because
  no fresh quote arrives.

### Indicators

- **Adding**: the **Indicators** button in the top bar opens the picker; type to filter. Each indicator on the chart
  has a chip above it to hide it, open its settings or remove it.
- **One set for every symbol**: up to **30** indicators per chart (the picker stops adding beyond that and the server rejects
  larger layouts). Indicators are a **single global set**, configured once and shown on every ticker;
  timeframe, session, chart type and appearance are global too (all stored in the `default` layout).
  Older per-symbol `sym:<id>` layouts from earlier versions are ignored.
- **Indicator settings** also set each line's width (1–4 px) and solid/dashed/dotted style, and the up/down bar
  colors of histogram indicators (VOL, MACD, AO, PPO). Only the colors you change are yours: every other line
  and bar color keeps following the theme (switch to light and back and they recolor). Layouts from earlier
  versions stored every line color when one changed; a stored color equal to the dark or light default of
  its line is read as that default, so those lines follow the theme again (this also applies if you pick exactly
  the other theme's default color for a line).
- **Oscillator reference levels**: oscillator panes draw thin dashed lines in the theme's muted level color behind
  the indicator lines: MACD, AO, ROC, MTM, TRIX and PPO at 0; RSI at 70 / 30; KDJ at 80 / 20;
  CCI at ±100; WR at -20 / -80 (KLineChart's WR runs from -100 to 0); DMI at 25 (ADX trend threshold). The levels
  are part of the pane's auto-range, so RSI always shows its 30–70 band and
  MACD its zero line even when the values stay on one side. The settings dialog's **Levels** section hides
  them or edits the values (up to 5, separated by commas; empty = none); Reset restores the defaults. They
  are saved with the layout only when changed (older layouts use the defaults).
- **VWAP** resets each session on intraday charts: at midnight New York time for stocks and stock-only baskets,
  at midnight UTC for crypto and for baskets holding crypto (whose intraday bars use the UTC grid). On 1D and
  longer timeframes it spans the whole loaded series.
- **Your own**: an indicator is one file; see [Custom indicators](#custom-indicators) and
  [CONTRIBUTING.md](CONTRIBUTING.md#add-an-indicator).

### Drawings

- **Drawing tools** (toolbar on the left of the chart): trend line, ray, extended line, horizontal line,
  vertical line, price line, parallel channel, Fibonacci retracement, text, long position and short
  position; plus magnet, lock all, delete selected (**Delete** / **Backspace**) and clear all. **Escape**
  cancels the active tool and deselects the drawing.
- **Drawings** are saved per symbol on the server (debounced ~1 s after each change; a failed save is retried
  with backoff, 2 s, 5 s, 10 s, then every 30 s, while a small amber note reads "Drawings not saved for AAPL.
  Retrying…"; after about 4 minutes it stops at "Drawings not saved for AAPL." with **Retry**). Unsaved drawings
  stay with their symbol in this browser tab: switching symbols or opening the Baskets page keeps retrying them,
  one note names every symbol still waiting ("Drawings not saved for AAPL, MSFT and 3 more."; its Retry retries
  them all), and charting the symbol again shows them from memory instead of the server's older copy (the last
  save wins over changes another tab made meanwhile). A save the server refuses for good (a 4xx error) turns the
  note red and keeps the drawings until you choose **Discard**. Reloading or closing the tab drops drawings that
  were never saved. Points are stored in
  time/price coordinates (bar timestamp + price), not pixels, so they stay anchored to the same price and
  time across timeframes, zoom levels and window sizes.
- **Drawing styles**: selecting a drawing shows a small style bar at the top of the chart (color, width,
  solid/dashed/dotted; text annotations: color and font size). Styles are saved with the drawing; drawings
  without their own style follow the default drawing style. Legacy drawings with non-hex colors (or other
  unsupported style values) fall back to the default style on their next save.
- **Drawing colors**: the color button opens a small set of swatches taken from the theme: sky (the accent),
  white / black, gray, the candle up and down colors, and the six indicator hues (pink, cyan, orange, gold,
  violet, blue). A drawing stores the swatch it uses, not a fixed color, so it recolors when you switch between
  the dark and light themes (up / down follow your own candle colors). Arrow keys move between swatches, Enter or
  Space picks, Escape closes. The swatch you pick, even the one the drawing already has, becomes the color of
  every new drawing (all tools, both themes) until you choose **Reset to default** in the popover. New drawings
  (and drawings you only recolor) store just the color: their width and line style keep following the default
  drawing style in Chart appearance until you change them on the drawing itself. **Reset to default** returns
  the drawing to the default drawing color (sky, or the one set in Chart appearance) and new drawings to it as
  well. A drawing saved with a plain color before swatches existed keeps it exactly, shown as a marked
  **Custom** swatch until you pick another; a Chart appearance drawing color equal to a swatch of the theme is
  shown as that swatch. Long / short positions have no color of their own: they always use the candle up /
  down colors.
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
- **Exact price**: selecting a horizontal line or price line shows a **Price** field in the style bar
  (double-clicking the line focuses it). Type a price (the symbol's precision, or up to 8 decimals) and press
  Enter or leave the field to move the line there; Escape reverts; invalid prices show an error; locked
  drawings are read-only. Only the price changes (the time anchor is kept). Horizontal lines placed or dragged
  with the mouse are rounded to the symbol's price precision.
- **Price labels**: price lines and horizontal lines have **On line** (price text on the line) and **On axis**
  (price label on the right axis) toggles in the style bar; defaults: price line both on, horizontal line
  axis only. Saved with the drawing.
- **⌘ magnet**: hold **⌘** (macOS) or **Ctrl** (other systems) while placing or dragging a drawing to snap
  it to the nearest open/high/low/close (strong magnet); releasing the key returns to the toolbar's magnet
  setting.
- **Shift (horizontal)**: hold **Shift** while placing or dragging a trend line, ray, extended line or parallel
  channel to keep it perfectly horizontal: every point takes the anchor's price (the first point while drawing,
  the fixed end while dragging one end), rounded to the symbol's price precision. A channel's width point stays
  free. Combined with ⌘/Ctrl, the snap picks the anchor price and Shift keeps the line flat.
- **Copy and paste**: **⌘C** / **⌘V** (macOS) or **Ctrl+C** / **Ctrl+V** (other systems) copy the selected
  drawing and paste a copy, which is selected and saved like a newly drawn drawing. Every drawing type works,
  with its style and options (channel extend, price labels, text, position prices). The clipboard lives in
  Chartmate only (the system clipboard is never read or written): it is kept across symbols, timeframes and a
  visit to Baskets, and emptied by a page reload (or restarting the desktop app). A locked drawing can be
  copied; the copy is unlocked unless **Lock all drawings** is on. Where the copy lands:
  - At the same times and prices, so it lands where it was copied from, also on another symbol or timeframe. A
    daily-anchored drawing stays anchored to its dates on stock charts (09:30 New York on intraday charts); a
    drawing copied from an intraday chart snaps to its days on a daily (or longer) chart.
  - Entirely outside the visible time range, it keeps its width in bars and is centered on the visible range;
    only then, if its prices miss the visible bars' low–high, they are scaled into that range (percentages kept;
    a position keeps its prices if the scaled ones would not be valid). Otherwise its prices never change.
  - While an identical drawing is in the way (such as the original), it moves 5 bars to the right; a long /
    short position moves by its own width plus 2 bars (boxes and labels never overlap), and horizontal lines,
    price lines and other horizontal drawings move up by 5 % of the visible price range. Repeated pastes
    cascade (up to 50 steps).

  The keys are left alone in text fields, editable content, dialogs, popups and behind a modal, while page text
  is selected, when no drawing is selected (copy) or nothing was copied (paste), and while the key repeats. In
  the desktop app the Edit menu's Copy and Paste do the same.
- **Parallel channels** are finite by default: click the start and end of the base line, then a third point for
  the channel's width. Both lines span exactly from the first to the second point's time, with a dashed midline
  halfway between them (in the channel's color and width, longer dashes when the channel itself is dashed or
  dotted; not a stored point) and a subtle fill: a light tint of the channel's own hue on the chart background,
  as for position zones, never pink or brown. Its weight is tuned per theme (a touch stronger on dark, so it stays
  visible inside the extended-hours shade; calm on light), always lighter than position zones, and at most 14%
  opacity, so the candles stay visible. Clicking a line, the
  midline or the fill selects (and drags) the channel; clicking beyond its ends does not. A right click inside
  the fill is ignored (a right click on a line removes the channel, as for other unlocked drawings).
  - **Extend left / Extend right** (style bar) extend the lines, midline and fill to the
    chart's left / right edge; both on gives an infinite channel. Both are off for new channels.
  - **Stored** as `parallelChannel` drawings (three points) with optional `styles.extend` (`left` / `right`;
    only the sides that differ from the default are saved).
  - **Legacy channels** (`parallelStraightLine`, drawn by older versions as infinite channels) still look exactly
    as before (infinite, no fill): a missing `extend` means both sides extended. They get the same toggles (turning a side off is
    saved as `extend: { left: false }`).

### Long and short positions

Positions (toolbar: "Long position", "Short position") have no position size: they show prices, % distances,
R:R and the outcome in %, with no account, risk, quantity or money amounts.

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

### Measure

With no drawing tool active, hold **Shift** and drag on the price pane to measure from the press to the cursor: a box tinted in the up color (end price at or above the start) or the down color,
with the price change and percent, the number of bars and the time span (e.g. "12 bars, 3d 4h"), and the
volume over those bars when the symbol has volume. **Shift**-click without dragging starts a measure whose end
follows the mouse until the next click. It stays until the next click without Shift, **Escape**, the next
measure, a new drawing tool or a symbol / timeframe change. Points snap like drawings (the magnet, or ⌘ / Ctrl
held). Bars are the chart's actual bars (sessions, weekends and baskets included); the span is calendar time.
A measure is never a drawing: it is not saved, copied, locked or counted, and Clear all leaves it alone.
Shift on a drawing still drags it (kept horizontal), and indicator panes and the axes ignore it.

### Keyboard shortcuts

**⌘** is the Command key on macOS; use **Ctrl** on Windows and Linux (and **Alt** for **⌥**).

| Keys | Action |
| --- | --- |
| ⌘K | Focus the symbol search |
| ⌥T / ⌥H | Start a trend line / a horizontal line (again: cancel) |
| Delete, Backspace | Delete the selected drawing (unless locked) |
| Escape | Cancel the drawing tool, deselect the drawing, end the measure |
| ⌘C / ⌘V | Copy the selected drawing / paste it |
| ⌘ while placing or dragging | Snap to the nearest open, high, low or close |
| Shift while placing or dragging | Keep a trend line, ray, extended line or channel horizontal |
| Shift-drag, Shift-click | Measure |
| Enter, Space (watchlist row) | Open the symbol |
| Delete, Backspace (watchlist row) | Remove the symbol |
| Alt+↑ / Alt+↓ (watchlist row or header) | Move it up / down |
| F2 (section header) | Rename the section |
| ← / → (sidebar edge) | Resize the sidebar by 16 px (64 px with Shift); Home / End: narrowest / widest; Enter: default |

The drawing shortcuts are ignored while a form control (field, checkbox, select, button) has the focus or inside a
dialog, and are shown in the buttons' tooltips.

### Watchlist and sections

The right sidebar lists symbols with live quotes (every 15 s) and a 30-day sparkline. Click a row (or press Enter or Space) to
open its chart; Delete or Backspace removes the focused row; drag rows or press **Alt+↑/↓** to reorder. The open symbol's row
has a quiet highlight.
The row always shows the regular-session price and day change (a tinted pill); during pre/post-market a second
line ("Pre 231.40 +0.82%") shows the extended price and its change vs the last regular close (`Quote.ext`),
otherwise the name. A small gauge under the price places the price in its 30-day closing range (the sparkline's daily
closes and the live price).

The list is loaded from the server when the app opens. Until it arrives, quiet placeholder rows show and the add
field, adding, removing and reordering are off, so nothing you do is replaced by the loaded list. If the server
cannot be reached, a muted "Can't reach the server. Retrying…" line shows (the error itself in its tooltip) and
the load is retried with backoff (2 s, 5 s, 10 s, then every 30 s); a load the server refuses for good (a 4xx
error) is not retried and the list stays read-only. Changes are saved about half a second after each edit; a
failed save is retried the same way ("Watchlist not saved. Retrying…"), and after about 4 minutes (10 retries)
it stops at "Watchlist not saved." with a **Retry** button, so a tab left open offline never keeps writing an old
list over changes made elsewhere. The layout and drawings use the same small amber note, stacked at the top
right of the chart panel next to the indicator chips (outside the plot); only a save the server
rejects for good (a 4xx error) shows in the error color, until the next change.

Below the list, a **detail panel** shows the open symbol: market status (stocks: open / pre-market / after hours /
closed from the New York clock and the quote's freshness; crypto trades around the clock), the day range as a
gauge (open → now), and open, previous close, volume, 30-day average volume and the 52-week high / low, all from
the daily bars and the quote. A quote fetched more than about 35 s ago (two missed polls, e.g. while the page was
hidden) is not shown: the panel falls back to the daily bars until a fresh one arrives. The bars reload every
5 minutes while the page is visible, and right away when it becomes visible again (unless they loaded less
than 60 s before).

**Resizing.** Drag the sidebar's left edge (a hairline appears on hover) to make it wider or narrower; the chart
follows live. The width ranges from 240 px to half the window, and never leaves the chart narrower than 480 px.
With the handle focused, **←/→** resize by 16 px (64 px with **Shift**), **Home/End** jump to the
narrowest/widest, and **Enter** or a double-click restores the default 320 px. The width is a per-device preference stored in the browser
(`chartmate.sidebar.width`), not in the saved layout; it is re-clamped when the window is resized, and hiding the
watchlist keeps it. Narrow rails drop the sparkline first, then the 30-day gauge, so names keep their room; wide
rails give the extra space to names and a longer sparkline, and the detail panel shows its stats in three columns.

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

### Baskets

A basket is a weighted set of stocks/crypto charted as one synthetic instrument.

- A basket has one or more **versions**; each has weights and an `effective from` calendar date.
  A version applies from 00:00 UTC of that date on daily and longer timeframes, and on intraday charts of
  baskets holding crypto. On intraday charts and live quotes of a **stock-only** basket it applies from the
  start of that date's New York session (04:00 New York time, pre-market), so the previous evening's
  post-market (which runs past midnight UTC in winter) stays on the old holdings; the `Start` and version
  markers sit at that time too.
- When a version starts, each constituent is sized in units at the **prior trading close**, so the
  basket value is continuous across a rebalance (no jump). If that daily close is invalid (zero, negative
  or missing in the provider's data), the last valid close up to 5 bars earlier is used and a notice says so.
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
  tomorrow (UTC). A version dated tomorrow is sized at the latest daily close before that date, which may
  not be final yet: until that date begins (00:00 UTC) its holdings are provisional, re-sized every few
  minutes, and they are then fixed at that final close. A basket holds at most 100 versions and 100 different symbols across all of
  them.
- **Deleting** a basket (Baskets page) also removes it from the watchlist and clears its drawings; if it was
  on the chart, the chart switches to the first other watchlist symbol. A reference that survives (say, the
  cleanup failed or another tab still lists it) shows as "Deleted basket" in the watchlist and on the chart,
  and is not reloaded over and over.

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
or drawings. If a provider is down or rate limiting, cached bars are served marked `stale`, and requests to it
pause for 30 seconds. A crypto symbol Binance does not list is left out of quote requests for 10 minutes.

Fetched history is cached in the database and not re-downloaded. An empty answer from a provider is only
remembered as "no bars here" when it cannot be a passing glitch: the range ended more than 7 days ago, lies
before the symbol's listing date, or holds no trading session (a stock's weekend or night); otherwise it is
asked again on the next load. Bars and the record of the range they cover are written in one transaction.
Yahoo's bars are split- and
dividend-adjusted *as of the day they were fetched*, so the server checks each stock for splits at most
once a day when serving its bars (a lightweight Yahoo chart call with split events since the last check,
stamped in `symbols.splits_checked_at`). When a split occurred since the last check, that symbol's daily
bars and the intraday bars still within Yahoo's lookback are dropped and refetched on demand; older intraday
bars (no longer downloadable) are kept and rescaled by the split ratio. Baskets holding the stock recompute
their units. Each check also looks back 7 days before the previous one, so a split the provider reports a few
days late is still applied; applied splits are recorded by their New York date (`applied_splits`), so none is applied twice, even when the
provider restamps an event a few hours later. A stock
whose bars were cached before its metadata row existed (e.g. the lookup failed at the time) has its refetchable
bars dropped once when the row appears, since when they were fetched is unknown. Note for upgrades: the first check after upgrading looks for splits since each symbol's last
metadata refresh (`symbols.updated_at`) minus 7 days, so older splits (already reflected in the cache) change
nothing; a split between an older cached fetch and that baseline is not detected (delete the symbol's cache as
in Troubleshooting if a chart shows such a jump). Split events dated in the future are applied only once they
have happened. A failed check
never fails a request; it is retried after an hour. Dividends are not detected: after one, older cached
bars stay adjusted as of their fetch day (see [Troubleshooting](#troubleshooting) to refetch a symbol).

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

**Rolling back to a version before watchlist sections.** Downgrading is not automatic: an older server refuses to
start once migration 003 is recorded (Kysely rejects unknown applied migrations). To roll back anyway, stop the
server, back up the database and delete that record —
`DELETE FROM kysely_migration WHERE name = '003_watchlist_sections';` — then start the older version: it reads the
mirrored `watchlist` table (symbols only; sections are not visible to it). Upgrading again re-runs 003, which keeps
the existing `watchlist_entries` rows, so watchlist edits made while downgraded are not carried over (empty that
table before upgrading to re-import the old list instead).

**Rolling back to 1.0.0.** This version adds migrations 004 (symbol ids), 005 (applied splits) and 006
(settings), and 1.0.0 refuses to start while they are recorded. Stop the server, back up the database, then
`DELETE FROM kysely_migration WHERE name IN ('004_symbol_ids', '005_applied_splits', '006_settings');` and start
1.0.0. Migration 004 cannot be undone: ids stay in their normalized spelling (1.0.0 reads them fine) and merged
or dropped entries do not come back. The added `applied_splits` and `settings` tables and the
`symbols.splits_tracked_from` column are left in place and ignored by 1.0.0. Sessions issued by either version
are not accepted by the other, so expect to log in again. Before upgrading again, run
`UPDATE symbols SET splits_tracked_from = splits_checked_at;`: splits 1.0.0 applied in the meantime are not in
`applied_splits`, and without this the first check after the upgrade could apply them a second time.

## Desktop app

The desktop app is the same Chartmate in its own window: the server and the web UI run inside the app, with no
network listener, no account and no login. The window is frameless: the app's top bar is the title bar (on
macOS with the traffic lights, on Windows with the native caption buttons in the top bar's colors). How it
works, its security model and how it is built and signed: [docs/desktop.md](docs/desktop.md).

### Data location

| OS | Directory |
|---|---|
| macOS | `~/Library/Application Support/Chartmate/` |
| Windows | `%APPDATA%\Chartmate\` |

The directory holds:

- `chartmate.db` (SQLite with WAL), created with mode 0600 inside a
  0700 directory;
- `window-state.json`;
- `update-settings.json` (whether to check for updates automatically), once you change that setting;
- `logs/main.log`, which rotates at 1 MB and keeps 2 old files.

What gets logged:

- **Main process**: lifecycle lines (start, window shown, quit) at INFO, plus warnings (blocked navigations,
  requests and listeners) and errors. Blocked navigations and requests are logged at most 20 times a minute
  (the page's and the app's own outbound requests counted separately); beyond that, one line at the end of the
  minute (or at quit) says how many were left out.
- **Embedded server**: warnings and errors only. Error objects are reduced to type, message and code, with no
  stack, request URLs drop their query strings, and headers are never logged.
- **Before writing any line**: absolute paths, URL credentials and secret-looking values are scrubbed.

Migrations run before the window loads. `CHARTMATE_USER_DATA_DIR=/abs/path` overrides the directory in
development runs (`pnpm --filter @chartmate/desktop start`) and in the test-only copy the smoke tests build; the
released app ignores it (even when its executable is renamed), just as it refuses `--user-data-dir`.

### Environment

Environment overrides the desktop app honors:

- `CHARTMATE_PROVIDERS` (`live` (the default) or `fixture`);
- `CRYPTO_PROVIDER`;
- `BINANCE_BASE_URL`, limited to `https://data-api.binance.vision` (the default), `https://api.binance.com` and
  `https://api.binance.us`; any other value is ignored (and logged);
- `CHARTMATE_DISABLE_UPDATES=1` (no update checks or downloads at all, see [Updates](#updates)).

A released (hardened) build **refuses to start** (with an error dialog) if `NODE_USE_ENV_PROXY`, `SSLKEYLOGFILE` or
`NODE_EXTRA_CA_CERTS` is set. Node applies the first during pre-execution, before any app code runs, so the app
cannot undo it; the second would let TLS session keys be logged; the third would add trusted root certificates
(Electron normally drops it already). `NODE_USE_SYSTEM_CA` is allowed: provider requests ignore it (see below).

Provider requests connect **directly**: they ignore `HTTP(S)_PROXY` and trust only Node's bundled root
certificates. Corporate HTTP proxies are not supported, and neither are TLS-inspecting middleboxes, which need
their own root certificate. On such networks the desktop app cannot reach the market data providers; use the
self-hosted server there instead.

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
| `GET`, `POST /api/baskets`; `GET`, `PUT`, `DELETE /api/baskets/:id`; `POST /api/baskets/:id/versions` | Baskets and their versions (at most 50 constituents per version, 100 versions and 100 distinct symbols per basket). Appending a version is atomic; one that loses a race with another edit three times gets a 409. |
| `GET`, `PUT /api/watchlist` | The watchlist (see [Watchlist and sections](#watchlist-and-sections)). |
| `GET`, `PUT /api/layouts/:key` | Chart layout; `default` is the one the app uses. |
| `GET`, `PUT /api/drawings/:symbol` | Drawings of a symbol. |

Symbol ids are `stock:<TICKER>`, `crypto:<BASE>` or `basket:<uuid>`; timeframes are `1m 5m 15m 30m 1h 2h 4h 1D
1W 1M`. Ids are case-insensitive and normalized (`crypto:btc` is `crypto:BTC`; basket UUIDs are lowercase), and
each code must fit its class: a stock ticker is 1–20 of `A–Z 0–9 . - = ^` starting with a letter, digit or `^`
(`BRK-B`, `^GSPC`, `ES=F`), a crypto base 1–20 letters or digits, a basket a UUID; anything else is a 400.
Migration 004 rewrote the ids stored by earlier versions (watchlist, layouts, drawings, basket weights) to this
spelling, merging case variants and dropping ids that are not valid. A basket version that loses an invalid
constituent this way is reweighted: its other constituents are rescaled to sum to 100%, and the server logs the
basket id and version at that first start (a version whose weights would not stay positive and finite is left
as it was).

The watchlist is a `WatchlistEntry[]`: `{ type: 'symbol', id }` or `{ type: 'section', id: <uuid>, title,
collapsed }`, read and replaced as a whole. `PUT /api/watchlist` still accepts the older plain symbol id array
(e.g. from a tab opened before an upgrade): it is merged into the stored list, so sections are kept — removed
symbols are dropped, the rest follow the array's order, new ones are appended (an empty array still empties the
list). Migration 003 copied an existing watchlist, in order, into the `watchlist_entries` table; the old
`watchlist` table is kept and mirrored with the symbols.

## Custom indicators

To add one, run `pnpm new:indicator <Name>` (add `--pane main` for an overlay on the candles): it creates
`apps/web/src/chart/indicators/custom/<name>.ts` and a matching test in `apps/web/test/indicators/`, wired to the
palette, and refuses names already in the picker or files that exist. [CONTRIBUTING.md](CONTRIBUTING.md#add-an-indicator)
walks through the rest (calculation, catalog fields, colors, screenshots); this section is the reference.

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
examples; `custom/ppo.ts` (the percentage price oscillator: params, two lines, a histogram and a level) is the
annotated example that CONTRIBUTING.md walks through. Restart `pnpm dev` (or rebuild) after adding a file.

`custom/wyckoff.ts` (with its calculation in `wyckoffCalc.ts`) is a port of the Pine Script indicator
'Wyckoff Accumulation Distribution' by faytterro and draws its boxes, labels and bar colors in a `draw`
callback. Indicator code never hardcodes a color: lines take palette slots (`lineSlots`), and an indicator that
paints on the canvas itself takes its colors from `indicators/colors.ts` (`activeIndicatorColors()`, read at draw
time); a test rejects color literals in `src/chart/indicators/`. **License:** these two files (and their tests)
are covered by the [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/), not by the project's AGPL-3.0;
keep their MPL-2.0 headers and attribution when modifying or redistributing them.

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
    name: 'RANGE', label: 'Average bar range', pane: 'sub', defaultParams: [10], paramLabels: ['Period'], lines: ['Range'],
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

## Roadmap

- Compare/overlay another symbol on the same chart
- Price alerts
- FX (currency pair) data

## License

Chartmate is free software, licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). You may use, study, modify and share it. If you distribute it, or run a modified version as a
service that other people use over a network, you must make your version's complete source code available to
them under the same license.

Exceptions: the Wyckoff indicator files keep their own MPL-2.0 license (see [Custom indicators](#custom-indicators)),
and third-party dependencies keep their own licenses.
