# Agent guide

How to work on Chartmate. `README.md` is the user-facing reference (features, configuration, desktop app);
this file is for whoever changes the code. Keep both accurate: a change that alters behavior, a command, an
env var or a default updates the README in the same commit.

## What Chartmate is

A self-hosted, single-user alternative to TradingView: candlestick charts for US stocks/ETFs (with pre/post
market) and crypto, indicators, drawing tools, a watchlist with sections, and baskets (weighted synthetic
instruments charted like any symbol). Free data only (Yahoo Finance; Binance or Coinbase), cached in SQLite or
Postgres. It ships as a web server (also as a Docker image) and as an Electron desktop app for macOS and Windows.

Visual beauty is the core value proposition. A change that works but looks worse is not done.

## Repo layout

pnpm 8 workspace, Node 22 (`.nvmrc`), TypeScript 5.9, Vitest everywhere.

| Path | Package | Responsibility |
| --- | --- | --- |
| `packages/shared` | `@chartmate/shared` | Types shared by server and web, timeframes, NY time and session tagging, resampling, basket math, watchlist model, quote helpers. Pure, heavily tested. |
| `apps/server` | `@chartmate/server` | Fastify 5 API + static web hosting; Kysely over SQLite (better-sqlite3) or Postgres; providers, bar cache with coverage tracking, baskets service, optional password auth. |
| `apps/web` | `@chartmate/web` | React 19 + Vite 8 UI; charts through KLineChart 10. |
| `apps/desktop` | `@chartmate/desktop` | Electron 44 app embedding the server (no listener) and the web build; hardened. |
| `e2e` | (root scripts) | Playwright end-to-end tests against the built server in fixture mode. |
| `docs/superpowers` | | Original design spec and implementation plan. Historical: the code and the README win where they differ. |

## Architecture boundaries

- Only `apps/web/src/chart/*` imports `klinecharts` (tests excepted; no lint rule enforces it).
  `ChartAdapter` (`apps/web/src/chart/ChartAdapter.ts`) is the seam: components talk to the adapter, never to
  KLineChart.
- Market data comes from providers behind `MarketDataProvider` (`apps/server/src/providers/types.ts`): Yahoo,
  Binance, Coinbase, and a deterministic `fixture` provider (`CHARTMATE_PROVIDERS=fixture`) for tests and demos.
  `providers/registry.ts` picks them.
- Symbol ids are prefixed: `stock:AAPL`, `crypto:BTC` (priced in USD), `basket:<uuid>` (`parseSymbolId` in
  `packages/shared/src/types.ts`).
- Basket math (units at the prior close, chained versions, simulated pre-start history) lives in
  `packages/shared/src/basket.ts`; `apps/server/src/baskets/service.ts` feeds it bars.
- The web client only uses relative `/api/...` URLs, so the same bundle runs behind Vite's proxy, from the
  server, and on desktop.
- Desktop: the window loads `app://chartmate/`; `/api/*` goes to `fastify.inject`, everything else is a static
  file of the web build (`apps/desktop/src/lib/protocol.ts`). There is no network listener
  (`listenGuard.ts`), no preload and no IPC.

## Commands

Install (as CI does; no dependency install scripts are needed):

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

With `--ignore-scripts`, Electron's binary is not downloaded. Before `pnpm --filter @chartmate/desktop start`
or an unpackaged smoke run, fetch it once with `node apps/desktop/node_modules/electron/install.js`.

| Task | Command |
| --- | --- |
| Dev (API on 8787 + Vite on 5173, `/api` proxied) | `pnpm dev` |
| Build shared, server, web | `pnpm build` |
| Run the built server (serves the web build) | `pnpm --filter @chartmate/server start` |
| Typecheck everything (incl. e2e) | `pnpm typecheck` |
| All unit tests | `pnpm test` |
| One package | `pnpm --filter @chartmate/<shared\|server\|web\|desktop> test` (or `typecheck`) |
| One file | `pnpm --filter @chartmate/web exec vitest run test/chart/theme.test.ts` |
| End-to-end | `pnpm e2e` (first time: `pnpm exec playwright install chromium`); `E2E_PORT=8873 pnpm e2e` for another port |
| Docker image | `docker build -t chartmate .` |
| Re-record provider fixtures (network) | `pnpm --filter @chartmate/server exec tsx scripts/record-fixtures.ts` |

Desktop (`apps/desktop`; `pnpm --filter @chartmate/desktop <script>`):

| Script | What it does |
| --- | --- |
| `start` | Build the web UI, bundle in dev mode, run unpackaged (DevTools on). |
| `bundle` | esbuild the main process + server into `dist/main.cjs`. |
| `pack:dir` | Unpacked app under `release/` (e.g. `release/mac-arm64/Chartmate.app`), no installer. |
| `dist:mac` / `dist:win` | dmg + zip (arm64, x64) / NSIS + zip (x64, arm64) in `release/`. Build Windows in CI. |
| `test` | Unit + security tests, then the server's DB suites on `node:sqlite`. |
| `smoke` | Playwright + Electron smoke tests. |

Smoke env vars: `SMOKE_APP` (the TEST-ONLY copy from `smoke/prepare-inspectable.mjs`; unset = unpackaged
app), `SMOKE_HARDENED_APP` (the unmodified packaged app), `SMOKE_EXPECT_UNSIGNED` (`1` unsigned, `0` signed),
`SMOKE_ALLOW_REAL_USERDATA=1` (needed outside CI for the hardened spec; it moves the real per-user data aside
and back), `SMOKE_LIVE=1` (live providers), `SMOKE_PROVIDERS` (`fixture` by default). See the README's
"Smoke tests" for the full sequence.

## Testing

- TDD: write the failing test first, then the code. Bugs get a regression test.
- Run `pnpm typecheck` and `pnpm test` (and `pnpm e2e` when the UI flow changes) before every commit; all must
  pass.
- Unit tests never touch the network; providers are tested against recorded fixtures.
- e2e uses its own database per port (`test-results/e2e-<port>.db`), so parallel worktrees just pick different
  `E2E_PORT`s.
- Never touch user data: `apps/server/data/*.db` (the dev database), the desktop data directory
  (`~/Library/Application Support/Chartmate/`, `%APPDATA%\Chartmate\`) or any `DATABASE_URL` you did not
  create. For manual runs use a scratch `DATABASE_URL` and `CHARTMATE_PROVIDERS=fixture`.

## Conventions

- American English everywhere: code, comments, UI strings, docs, commit messages.
- Sentence case for UI labels and headings; no ALL-CAPS labels.
- `packages/shared`, `apps/server` and `apps/desktop` are NodeNext ESM: relative imports end in `.js`.
  `apps/web` uses bundler resolution (no extension).
- Persisted data stays loadable. Layouts, drawings, watchlists and baskets saved by older versions must still
  parse: zod schemas in `apps/server/src/routes/*.ts` accept old shapes (optional fields, `.catch()` to drop an
  invalid part instead of rejecting the whole layout), and the web side migrates on read. Add a test with the
  old payload whenever a stored shape changes. Schema changes go through a new Kysely migration in
  `apps/server/src/db/migrations.ts`.
- Configuration env vars are `CHARTMATE_*` (plus the generic `PORT`, `HOST`, `DATABASE_URL`,
  `CRYPTO_PROVIDER`, `BINANCE_BASE_URL`). No other prefixes.
- Never hardcode the GitHub repository URL or owner: use relative links in docs and
  `github.repository` / `GITHUB_REPOSITORY` in workflows and build config.
- Commits: small and logical, conventional style as in `git log`: `feat(web): …`, `fix(desktop): …`,
  `docs: …`, `test(shared): …`, `refactor: …`, `style: …`, `ci: …`, `chore: …`; lowercase summary saying
  what changed.

## Design principles

- One market color source per theme: `THEME_TOKENS` in `apps/web/src/chart/theme.ts` plus the matching CSS
  variables in `apps/web/src/styles.css` (`THEME_CSS_VARS`); a parity test keeps them equal. Candles, volume,
  MACD/AO, positions, watchlist, baskets and sparklines all use the same up/down colors.
- Soft tones are opaque and hue-locked (`softTone` / `tintFill` in `apps/web/src/chart/color.ts`), never an
  `rgba()` of the strong color (pink on white, brown on dark).
- Every color must work on both themes; the chart typeface is the UI's (`CHART_FONT`).
- UI changes: check both themes and include screenshots of both (dark and light) in the review.

## Desktop security model

The renderer is untrusted web content. Read the README's "Security model" before touching `apps/desktop`.

- No new IPC channels, preload scripts or exposed APIs. If one is ever unavoidable it needs strict input
  validation and a security review.
- Keep the CSP header (no `unsafe-inline` / `unsafe-eval`) and Trusted Types (`trusted-types 'none'`): never
  write HTML strings into the DOM.
- Main-process network goes through the outbound allowlist (`netAllowlist.ts`) on the direct, CA-pinned
  transport (`directFetch.ts`). Adding a host is a security change.
- Fuses (`build/fuses.cjs`), window hardening (`hardening.ts`), startup guards (`startupGuards.ts`), the listen
  guard and the navigation/permission handlers are pinned by tests. Changing any of them needs a security
  review.

## Releases

- Push a tag `vX.Y.Z`: `.github/workflows/desktop.yml` tests, then builds macOS arm64/x64 (dmg + zip) and
  Windows x64/arm64 (NSIS + zip), smoke-tests both, and publishes a full GitHub Release with the binaries.
- A suffixed tag (`vX.Y.Z-beta.1`) publishes a pre-release instead.
- Builds are unsigned unless the signing secrets are configured; unsigned builds contain no auto-updater.
- `.github/workflows/ci.yml` runs typecheck, tests, the web build, e2e and the Docker build on pull requests
  and pushes to `main`.

## Specs and plans

`docs/superpowers/specs` and `docs/superpowers/plans` hold the original design and implementation plan. They
are historical records, not instructions: do not execute the plan, and trust the code and README over them.
