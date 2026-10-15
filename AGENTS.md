# Agent guide

How to work on Chartmate. `README.md` is the user-facing reference (download, self-hosting, features,
configuration); `docs/desktop.md` covers the desktop app's internals, security model, smoke tests and signing;
`CONTRIBUTING.md` is the contributor's checklist (setup, checks, licensing, adding an indicator, releases). This
file is for whoever changes the code. Keep them accurate: a change that alters behavior, a command, an env var or
a default updates the docs in the same commit, and a user-visible change gets a line in `CHANGELOG.md`.

## What Chartmate is

A single-user charting app (desktop app for macOS and Windows, or self-hosted): candlestick charts for US
stocks/ETFs (with pre/post market) and crypto, indicators, drawing tools, a watchlist with sections, and baskets
(weighted synthetic instruments charted like any symbol). Free data only (Yahoo Finance; Binance or Coinbase), cached in
SQLite or Postgres. It ships as a web server (also as a Docker image) and as an Electron desktop app for macOS and
Windows.

Visual beauty is the core value proposition. A change that works but looks worse is not done.

## Repo layout

pnpm 8 workspace (8.15.9, pinned with its sha512 in the root `package.json` `packageManager`; `corepack enable`
uses it, and so does CI), Node 22 (the exact version in `.nvmrc`, used by every workflow), TypeScript 5.9, Vitest
everywhere.

| Path | Package | Responsibility |
| --- | --- | --- |
| `packages/shared` | `@chartmate/shared` | Types shared by server and web, timeframes, NY time and session tagging, resampling, basket math, watchlist model, quote helpers. Pure, heavily tested. |
| `apps/server` | `@chartmate/server` | Fastify 5 API + static web hosting; Kysely over SQLite (better-sqlite3) or Postgres; providers, bar cache with coverage tracking, baskets service, optional password auth. |
| `apps/web` | `@chartmate/web` | React 19 + Vite 8 UI; charts through KLineChart 10. |
| `apps/desktop` | `@chartmate/desktop` | Electron 44 app embedding the server (no listener) and the web build; hardened. |
| `e2e` | (root scripts) | Playwright end-to-end tests against the built server in fixture mode. |
| `docs/desktop.md` | | Desktop app internals, security model, smoke tests, signing and notarization. |
| `CHANGELOG.md` | | User-facing release notes; the release workflow copies the tag's section into the GitHub Release. |
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
- Every request first passes the Host / Origin guard (`apps/server/src/hostGuard.ts`, the first `onRequest`
  hook): without a password (or with `CHARTMATE_ALLOWED_HOSTS` set) the Host, and behind a trusted proxy every
  X-Forwarded-Host, must be loopback or listed; state-changing `/api` requests with an `Origin` must come from
  the request's own origin, password or not. The desktop app builds the server with no extra host and
  `allowedOrigins: ['app://chartmate']`; the environment cannot override either.

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
| Dependency vulnerabilities (prod and dev; CI fails on any) | `pnpm audit` |
| Typecheck everything (incl. e2e) | `pnpm typecheck` |
| All unit tests | `pnpm test` |
| One package | `pnpm --filter @chartmate/<shared\|server\|web\|desktop> test` (or `typecheck`) |
| One file | `pnpm --filter @chartmate/web exec vitest run test/chart/theme.test.ts` |
| Server DB suites on Postgres (as CI's `postgres` job; e.g. `docker run` the digest-pinned image from `compose.yaml` on a free port) | `TEST_PG_URL=postgres://… CHARTMATE_TEST_DB=postgres pnpm --filter @chartmate/server exec vitest run --no-file-parallelism test/db test/market test/baskets test/routes test/http` |
| End-to-end | `pnpm e2e` (first time: `pnpm exec playwright install chromium`); `E2E_PORT=8873 pnpm e2e` for another port |
| Docker image | `docker build -t chartmate .` |
| Docker image smoke test (read-only rootfs + tmpfs, healthcheck, API, UI, SQLite temp files, SIGTERM) | `scripts/docker-smoke.sh chartmate` (another arch: `--platform linux/arm64`; an image built with `--build-arg GITHUB_REPOSITORY=owner/name`: add `--expect-repository owner/name` to check its source link) |
| Re-record provider fixtures (network) | `pnpm --filter @chartmate/server exec tsx scripts/record-fixtures.ts` |
| Scaffold a custom indicator + its test (see `CONTRIBUTING.md`) | `pnpm new:indicator <Name> [--pane main]` |

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
app, which needs the dev bundle: `node apps/desktop/scripts/bundle.mjs --dev`), `SMOKE_HARDENED_APP` (the unmodified
packaged app), `SMOKE_EXPECT_UNSIGNED` (`1` unsigned, `0` signed), `SMOKE_ALLOW_REAL_USERDATA=1` (needed outside CI for
the hardened spec; it moves the real per-user data aside and back), `SMOKE_LIVE=1` (live providers), `SMOKE_PROVIDERS`
(`fixture` by default). See "Smoke tests" in `docs/desktop.md` for the full sequence.

## Testing

- TDD: write the failing test first, then the code. Bugs get a regression test.
- Run `pnpm typecheck` and `pnpm test` (and `pnpm e2e` when the UI flow changes) before every commit; all must
  pass. After any dependency change run `pnpm audit`: it must report no known vulnerabilities (CI and the
  release workflow fail otherwise). An unpatched advisory in a build-only dependency is removed (see
  `.pnpmfile.cjs`) or replaced, never ignored.
- `patches/` holds pnpm patches for upstream bugs (`pnpm.patchedDependencies` in the root `package.json`):
  `app-builder-lib` passes the keychain password to `security set-key-partition-list` (upstream passes the
  `.p12` password, which breaks electron-builder's macOS signing with `CSC_LINK`, as a local `dist:mac` uses it;
  CI signs with `.github/scripts/macos-sign.sh` instead). Re-check each patch when bumping that dependency.
- Unit tests never touch the network; providers are tested against recorded fixtures.
- e2e uses its own database per port (`test-results/e2e-<port>.db`), so parallel worktrees just pick different
  `E2E_PORT`s.
- Never touch user data: `apps/server/data/*.db` (the dev database), the desktop data directory
  (`~/Library/Application Support/Chartmate/`, `%APPDATA%\Chartmate\`) or any `DATABASE_URL` you did not
  create. For manual runs use a scratch `DATABASE_URL` and `CHARTMATE_PROVIDERS=fixture`.

## Conventions

- American English everywhere: code, comments, UI strings, docs, commit messages.
- Sentence case for UI labels and headings; no ALL-CAPS labels. Native macOS menu items and dialog buttons follow
  the platform's title case instead ("Check for Updates…", "Restart Now"); Windows dialog buttons stay in
  sentence case.
- Describe Chartmate on its own terms: never name or compare to other charting products in docs, code
  comments, UI copy, commit messages or release notes.
- `packages/shared`, `apps/server` and `apps/desktop` are NodeNext ESM: relative imports end in `.js`.
  `apps/web` uses bundler resolution (no extension).
- Persisted data stays loadable. Layouts, drawings, watchlists and baskets saved by older versions must still
  parse: zod schemas in `apps/server/src/routes/*.ts` accept old shapes (optional fields, `.catch()` to drop an
  invalid part instead of rejecting the whole layout), and the web side migrates on read. Add a test with the
  old payload whenever a stored shape changes. Schema changes go through a new Kysely migration in
  `apps/server/src/db/migrations.ts`.
- Configuration env vars are `CHARTMATE_*` (plus the generic `PORT`, `HOST`, `DATABASE_URL`,
  `CRYPTO_PROVIDER`, `BINANCE_BASE_URL`). No other prefixes.
- License: the project is `AGPL-3.0-only` (`LICENSE`); new packages carry `"license": "AGPL-3.0-only"`. The
  Wyckoff indicator files keep their MPL-2.0 headers. Only add dependencies whose licenses are compatible with
  AGPL-3.0 (MIT, BSD, ISC, Apache-2.0, MPL-2.0 and similar). `scripts/third-party-notices.mjs` holds the
  allowlist and writes `THIRD_PARTY_NOTICES.txt`; the Docker image (`/app`) and the desktop app (next to
  `app.asar`) ship it with `LICENSE`. `pnpm licenses:check` (CI and the release workflows) and both builds fail on
  a shipped dependency outside the allowlist or without a license text. A new license goes on the allowlist only
  after checking its AGPL-3.0 compatibility.
- Never hardcode the GitHub repository URL or owner: use relative links in docs and
  `github.repository` / `GITHUB_REPOSITORY` in workflows and build config. One exception: the docs (README,
  CONTRIBUTING, AGENTS, `docs/*.md`, `compose.yaml`, `.env.example`) may name the published image
  `ghcr.io/gedigi/chartmate`, the `compose.yaml` / `.env.example` download URLs (raw `main` today,
  `releases/latest/download` once a release carries them) and the attestation check's `--repo gedigi/chartmate`,
  so a copy-paste install or verification works. `apps/server/test/selfhost-docs.test.ts` pins the image name,
  the repository slug and both URL bases in constants and fails on any other mention of the owner in those
  files, so a move is a change to those constants plus a search and replace.
- Custom indicators: one file in `apps/web/src/chart/indicators/custom/` (start from `pnpm new:indicator`), colors
  only through palette slots (`lineSlots`) or `activeIndicatorColors()`; a test rejects color literals there.
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

The renderer is untrusted web content. Read "Security model" in `docs/desktop.md` before touching `apps/desktop`.

- No new IPC channels, preload scripts or exposed APIs. If one is ever unavoidable it needs strict input
  validation and a security review.
- Update UX stays in the main process: native macOS menu items and dialogs only (`src/lib/updateController.ts`;
  the Windows window has no visible menu bar, so Windows updates run in the background), with GitHub release
  data treated as untrusted plain text (`src/lib/releaseNotes.ts`). `shell.openExternal` has a single,
  test-pinned call for the validated build-time releases page (`src/lib/releasesPage.ts`); do not add others.
- Update verification fails closed: the Windows installer verifier (`winSignature.ts`: signature, pinned
  publisher DN from `CHARTMATE_WIN_PUBLISHER_DN`, installer version) and the macOS bundle version check
  (`updateBundle.ts`: `/usr/bin/ditto` + `/usr/bin/plutil`) refuse on any error.
  Changes to the updater (`src/updater.ts`, `updatePolicy.ts`, `updateArming.ts`, `updateBundle.ts`,
  `winSignature.ts`) are security changes.
- Keep the CSP header (no `unsafe-inline` / `unsafe-eval`) and Trusted Types (`trusted-types 'none'`): never
  write HTML strings into the DOM.
- Main-process network goes through the outbound allowlist (`netAllowlist.ts`) on the direct transport
  (`directFetch.ts`: no proxy, trusts only Node's bundled root store). Adding a host is a security change.
- Security gates use `hardened` (`isHardened()` in `buildMode.ts`, computed once in `src/boot.ts`), never
  `app.isPackaged`, which only reflects the executable's file name. Only the `--dev` bundle run unpackaged is
  unhardened.
- Fuses (`build/fuses.cjs`), window hardening (`hardening.ts`), startup guards (`startupGuards.ts`), the listen
  guard and the navigation/permission handlers are pinned by tests. Changing any of them needs a security
  review.

## Releases

- Before tagging: add a `## [X.Y.Z] - <date>` section to `CHANGELOG.md` and set `"version"` in
  `apps/desktop/package.json` (the product version; a test requires a changelog entry for it), and the same
  version in `apps/web/package.json` and `apps/server/package.json` (a test keeps the three equal). The step-by-step
  list is in `CONTRIBUTING.md`, "Releases".
- Push a tag `vX.Y.Z` (the tagged commit must be on `main`, or both release workflows stop):
  `.github/workflows/desktop.yml` tests, then builds macOS arm64/x64 (dmg + zip) and Windows x64/arm64 (NSIS +
  zip), smoke-tests both, and publishes a full GitHub Release with the binaries. The notes start with the tag's
  `CHANGELOG.md` section (`apps/desktop/scripts/changelog-section.mjs`), followed by the signing table. The
  release is marked Latest only when no higher full release exists among the repository's `v*` tags
  (`scripts/release-tags.mjs`), so a backport never takes Latest. `scripts/check-release-assets.mjs` requires
  exactly the expected files, with `latest*.yml` matching them, before the release is created.
- A suffixed tag (`vX.Y.Z-beta.1`) publishes a pre-release instead.
- Builds are unsigned unless signing is configured; unsigned builds contain no auto-updater.
- macOS signing (`docs/desktop.md`, "macOS signing in CI"): the repository variable `CHARTMATE_MAC_SIGN_IDENTITY`
  turns it on for tags; a tag without it fails unless `CHARTMATE_ALLOW_UNSIGNED_MAC` is `true`. Jobs decide from the
  ref and the variable, never from a dependency-running job's output. `package-mac` builds the apps unsigned with no
  secrets; `sign-mac` and `notarize-mac-dmg` run in the `macos-signing` environment on fresh runners with no
  dependency code (only `.github/scripts/macos-sign.sh`, the entitlements and Apple's tools): key imported
  non-extractable into a temporary keychain, inside-out `codesign` with the hardened runtime and a timestamp,
  `notarytool`, `stapler`, `spctl`. `sign-mac` refuses any Mach-O file outside the expected Electron layout
  (`expected_code`), and `notarize-mac-dmg` checks each dmg's app against the cdhash `sign-mac` recorded. `dist-mac`
  (no secrets) makes the dmgs, zips, blockmaps and `latest-mac.yml` from the signed apps (`electron-builder
  --prepackaged`, one run per arch, merged by `scripts/merge-update-info.mjs`). The Apple secrets are
  `macos-signing` environment secrets only. Residual risk: the dependencies build the code that is signed. Changes
  to the signing script, those jobs or the secret scoping are security changes.
- The same tag runs `.github/workflows/docker.yml`: tests, `scripts/docker-smoke.sh` (amd64, and arm64 under
  QEMU), then pushes the multi-arch self-hosting image (`linux/amd64`, `linux/arm64`) to
  `ghcr.io/<owner>/<repo>`, derived from `github.repository` (lowercased), as `X.Y.Z`, plus `X.Y`, `X` and
  `latest` each only when no higher full release exists in that range (pre-releases: `X.Y.Z-suffix` only), with
  provenance and SBOM attestations. The image runs as the numeric user `1000:1000`. Manual dispatch never publishes.
  `compose.yaml` (no `.env` needed) is the documented way to run it, with `.env.example` as the optional
  template; the desktop workflow's release job attaches both to the GitHub Release (`.env.example` as
  `env.example`, since GitHub renames assets that start with a dot).
- `CHANGELOG.md` keeps an `## Unreleased` section at the top for user-visible changes; it is renamed to
  `## [X.Y.Z] - YYYY-MM-DD` at release time (CONTRIBUTING, "Releases").
- Windows signing uses a Certum SimplySign cloud certificate (`docs/desktop.md`, "Windows signing with Certum"):
  - `build/signing.cjs` picks the method.
  - `build/win-sign.cjs` is electron-builder's sign hook. It signs `chartmate.exe`, the uninstaller and the
    installer, using signtool by thumbprint or osslsigncode + PKCS#11.
  - CI logs in with `scripts/certum/login.ps1`, on tag builds only, in the `windows-signing` environment, as the
    first step of the job: before any dependency code runs there, and with the login secrets in no other step.
  - `scripts/verify-win-signatures.mjs` gates the result; SimplySign Desktop is closed right after packaging.
  - If the login or the sign hook fails, Windows ships without Certum, the release notes say so, and the release
    is created as a draft, never marked Latest (the owner publishes it after `sign:win`). A failed verification
    fails the job, and so does a signing setting `build/signing.cjs` rejects.
  - The Certum secrets are `windows-signing` environment secrets only, never repository secrets.
  - Residual risk: the signing cannot move to a job without dependency code (the session is bound to the runner,
    and the uninstaller is signed in the middle of the NSIS build), so code running in that job can use the live
    certificate session, and with administrator rights on the runner could reach the job's secrets.
    `--ignore-scripts`, the frozen lockfile, `pnpm audit`, Dependabot and the environment's required reviewer are
    what limit it. Electron's own DLLs are not signed individually (acceptable; see `docs/desktop.md`).
  - `CHARTMATE_WIN_PUBLISHER_NAME` (the certificate CN) is required, because electron-updater pins it.
- If CI cannot log in, the owner runs `pnpm --filter @chartmate/desktop sign:win` from a checkout of the tag. It
  rebuilds, signs, verifies and replaces the Windows assets of that release. Changes to the signing hook, the
  login script or the secret scoping are security changes.
- `.github/workflows/ci.yml` runs `pnpm audit`, typecheck, tests, the license gate, the indicator scaffold check,
  the web build, e2e and the Docker build on pull requests and pushes to `main`; the release workflows audit and
  check licenses too. Every workflow gets pnpm through corepack (which checks the `packageManager` sha512) and Node
  from `.nvmrc`; only `ci.yml` caches the pnpm store (no cache on a release path). Dependabot
  (`.github/dependabot.yml`) opens weekly update PRs for npm packages (7-day cooldown), the pinned actions, the
  digest-pinned Docker base image and the Compose Postgres image (3 days each). It never proposes a new major of
  Node (the base image, `@types/node`) or Postgres: those are deliberate upgrades (Node: the next LTS, together
  with `.nvmrc`; Postgres: a dump and restore).
  `apps/desktop/test/workflows.test.ts` pins the workflows' rules (actions pinned to SHAs, read-only default
  tokens, secrets only in the step that needs them, signing jobs without dependency code).

## Specs and plans

`docs/superpowers/specs` and `docs/superpowers/plans` hold the original design and implementation plan. They
are historical records, not instructions: do not execute the plan, and trust the code and README over them.
