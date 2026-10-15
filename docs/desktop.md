# Chartmate desktop app

`apps/desktop` packages the Chartmate server and web UI as a desktop app (product name **Chartmate**) for macOS
and Windows, built with Electron 44. The self-hosted server is unchanged; the desktop app embeds it. For users,
the [README](../README.md#desktop-app) covers downloading, the data location and the environment it honors; this
page is for whoever builds, signs or changes the app. Paths are relative to `apps/desktop/` unless they say
otherwise.

- [How it works](#how-it-works)
- [Build and run](#build-and-run)
- [Smoke tests](#smoke-tests)
- [Network and environment](#network-and-environment)
- [Security model](#security-model)
- [Signing, notarization, updates](#signing-notarization-updates)
- [Renaming the product](#renaming-the-product)

## How it works

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
  The database holds the user's layouts, drawings, watchlists and baskets as well as the bar cache. It runs in WAL
  mode with `synchronous = NORMAL`: a committed change survives an app crash and the file never corrupts, but an
  OS crash or power loss can lose the last few commits. `FULL` would close that window with an fsync on every
  write, which layout and drawing autosaves make frequent; NORMAL is the chosen tradeoff.
- **One file.** esbuild bundles the desktop main process and the whole server into a single minified
  `dist/main.cjs` (~2.5 MB). The package holds only `package.json`, that file and its third-party license
  comments (`dist/main.cjs.LEGAL.txt`), the web build, the icon and, in signed builds only, the updater bundle
  (`dist/updater.cjs`, plus its `.LEGAL.txt` when it has license comments), in an asar archive with maximum compression and English locales
  only. It has no `node_modules`.
- **Frameless window.** The web top bar is the title bar. On macOS the native traffic lights sit on it; on
  Windows the native caption buttons (minimize, maximize, close, snap layouts) are drawn over its right end in
  the top bar's colors, following the theme through the page's `<meta name="theme-color">` (no IPC). Linux
  keeps the native frame.

## Build and run

```sh
pnpm install --frozen-lockfile --ignore-scripts
node apps/desktop/node_modules/electron/install.js   # Electron binary (skipped by --ignore-scripts); once
pnpm --filter @chartmate/desktop start      # build the web UI, dev bundle, run unpackaged (DevTools enabled)
pnpm --filter @chartmate/desktop pack:dir   # unpacked app only, e.g. release/mac-arm64/Chartmate.app
pnpm --filter @chartmate/desktop dist:mac   # release/Chartmate-<v>-mac-{arm64,x64}.{dmg,zip}
pnpm --filter @chartmate/desktop dist:win   # release/Chartmate-<v>-win-{x64,arm64}.{exe,zip}; needs Windows or CI
pnpm --filter @chartmate/desktop test       # unit + security tests (protocol, guards, allowlist, fuses, workflows …)
```

Building the NSIS installer on Apple-silicon Macs fails unless Rosetta is installed, because electron-builder's
`makensis` is an x86_64 binary. Build Windows installers in CI.

**Hardened and development bundles.** `scripts/bundle.mjs --dev` produces the development bundle (unminified,
source maps, `__DEV_BUNDLE__ = true`); `start` and the unpackaged smoke run use it. Every other bundle (`bundle`,
`pack:dir`, `dist:*`, the TEST-ONLY copy) is a production bundle. Whether the startup guards, the DevTools
lockdown, the `devtools:` request exception and the fixed data directory apply is decided once, in `src/boot.ts`,
by `isHardened()` (`src/lib/buildMode.ts`): a production bundle is **always** hardened, and the dev bundle is
hardened when packaged. Electron's `app.isPackaged` alone is not used as a gate, because it only compares the
executable's file name with `electron`/`electron.exe`: a user-level copy of the installed app with the executable
renamed would otherwise run without the guards. `bundle.mjs` writes `dist/bundle-kind.json`
(`{"kind":"prod"|"dev"|"test-inspectable"}`), and the `afterPack` hook (`build/after-pack.cjs`) fails the build
unless the packaged `app.asar` holds a `prod` bundle, so a dev bundle can never be packaged. TEST-ONLY copies are
made from an already packaged app by `smoke/prepare-inspectable.mjs`, outside electron-builder.

## Smoke tests

```sh
pnpm --filter @chartmate/web build && node apps/desktop/scripts/bundle.mjs --dev && pnpm --filter @chartmate/desktop smoke   # unpackaged app (dev bundle)

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

The unpackaged run needs the dev bundle: a production bundle is hardened even unpackaged, so it refuses
Playwright's `--inspect`/`--remote-debugging-port` switches (the specs check for the dev bundle's source map and
say so).

A released (hardened) build refuses to start with a debugging or weakening switch (see [Security model](#security-model)), so no
test harness can attach to it. `smoke/prepare-inspectable.mjs` therefore builds a separate copy for the
functional tests:

- the copy is named `… TEST-ONLY` and carries a `TEST-ONLY-NOT-FOR-DISTRIBUTION.txt` marker;
- its only code differences: the switch guard is compiled out, and it honors `CHARTMATE_USER_DATA_DIR` so the
  functional tests run on a scratch directory (`bundle.mjs --test-inspectable`, a production bundle otherwise:
  it cannot be combined with `--dev`);
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
- a copy whose executable is renamed to `Electron` / `electron.exe` (Electron then reports `isPackaged = false`)
  stays hardened: the log says `hardened=true`, it ignores `CHARTMATE_USER_DATA_DIR`, and it refuses
  `--remote-debugging-port` and `--inspect`;
- a tampered `app.asar` refuses to start (macOS);
- the updater is present only in signed builds (`SMOKE_EXPECT_UNSIGNED`).

Because the shipped app ignores `CHARTMATE_USER_DATA_DIR`, this spec runs against the real per-user data directories:
the current one, plus those of any `previousProductNames`. For that reason it only runs in CI (`CI=true`) or
locally with `SMOKE_ALLOW_REAL_USERDATA=1`.

- It moves the directories aside to `*.smoke-backup` first and moves them back afterwards, retrying while
  Windows still holds file handles.
- Nothing is deleted: the directory the run created is renamed to `*.smoke-trash-<timestamp>`.
- Don't run it while Chartmate is open.

## Network and environment

The desktop app honors only `CHARTMATE_PROVIDERS`, `CRYPTO_PROVIDER`, `BINANCE_BASE_URL` and
`CHARTMATE_DISABLE_UPDATES=1` from the environment (`src/lib/desktopConfig.ts`, `src/lib/updatePolicy.ts`), plus
`CHARTMATE_USER_DATA_DIR` in dev-bundle runs and the TEST-ONLY copy. Everything else that concerns the network
surface or storage is fixed: no listener, no login, SQLite in the per-user data directory.

`BINANCE_BASE_URL` adds its host to the outbound allowlist, so a hardened build accepts only
`https://data-api.binance.vision` (the default), `https://api.binance.com` and `https://api.binance.us` (no path,
port, credentials, query or fragment). Any other value is ignored with one warning in the log, and the default is
used. The dev bundle accepts any https URL without credentials, port, query or fragment.

An invalid `CHARTMATE_PROVIDERS`, `CRYPTO_PROVIDER` (or, in the dev bundle, `BINANCE_BASE_URL` or a relative
`CHARTMATE_USER_DATA_DIR`) stops the app at startup with a short error box naming the variable, with no stack or
path, and exit code 1. The reason is also logged.

A released (hardened) build **refuses to start** (with an error dialog) if `NODE_USE_ENV_PROXY` or `SSLKEYLOGFILE` is set.
Node applies the first during pre-execution, before any app code runs, so the app cannot undo it, and the second
would let TLS session keys be logged. `NODE_USE_SYSTEM_CA` is allowed: provider requests ignore it (see below).

`NODE_EXTRA_CA_CERTS` is dropped by Electron itself: the `EnableNodeOptionsEnvironmentVariable` fuse covers it
along with `NODE_OPTIONS`. The guard still refuses it if it ever got through.

Independently of that, provider requests never use Node's global dispatcher. They go through an explicit undici
`Agent` (`src/lib/directFetch.ts`) that connects directly, ignoring `HTTP(S)_PROXY`, and trusts only Node's
bundled root store (`tls.rootCertificates`). This restricts trust to that root store; it is not certificate
pinning, so any certificate chaining to a bundled root is accepted. Real Node and Electron child processes prove
this (`test/directFetch.test.ts`).

Provider traffic is therefore **direct-only**. Corporate HTTP proxies are not supported, and neither are
TLS-inspecting middleboxes, which need their own root certificate. On such networks the desktop app cannot reach
the market data providers; use the self-hosted server there instead.

## Security model

The renderer is treated as untrusted web content, and the main process exposes nothing to it except `app://chartmate`.

- **Auth is disabled** on desktop. No port is listening, and the only client is the app's own sandboxed
  renderer. A password would only put a login screen in front of a single-user local app.
- **Host and Origin guard**: the embedded server keeps its guard against DNS rebinding and cross-site writes
  (`apps/server/src/hostGuard.ts`). `desktopConfig.ts` builds the server with no extra allowed host (inject
  requests carry Host `localhost`) and `allowedOrigins: ['app://chartmate']`, so a state-changing API request is
  accepted only from the renderer's own origin. The environment cannot change either (`CHARTMATE_ALLOWED_HOSTS`
  is ignored on desktop); `test/hostGuard.test.ts` runs the real protocol handler against the real server.
  The guard also refuses API requests marked `Sec-Fetch-Site: cross-site` or `same-site`. Chromium sends no
  fetch-metadata header (and no `Origin`) on the renderer's app:// requests, so they pass; the handler forwards
  the header unchanged, and the test covers both cases.
- **Window settings** (`src/lib/hardening.ts`, pinned by a snapshot test):
  - `sandbox`, `contextIsolation` and `webSecurity` are on;
  - Node is off everywhere, including workers and subframes;
  - there is no preload script and no `webview`;
  - spellcheck and experimental features are off;
  - DevTools are available only when the dev bundle runs unpackaged. In every hardened build (see
    [Build and run](#build-and-run)), DevTools are also closed if they ever open, and the menu has no DevTools item.
- **Sandboxing and crashes**: `app.enableSandbox()` is called before ready, and only a single instance can run. A
  crashed renderer is reloaded at most 3 times per minute. After that, a static error page is shown once, and if
  that page crashes too, the window is closed with an error dialog. There is never a reload loop.
- **Command-line switches and environment** (`src/boot.ts`, the first module evaluated): a hardened build exits
  with code 1 if `NODE_USE_ENV_PROXY`, `SSLKEYLOGFILE` or `NODE_EXTRA_CA_CERTS` is set (see
  [Network and environment](#network-and-environment)), or any of these switches is present (`--x`, `-x`, and `/x`
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
  is also allowed when the dev bundle runs unpackaged. Blocked navigations and requests are logged at most 20 times a
  minute, then summarized in one line (`createRateLimiter` in `src/lib/logger.ts`), so a page cannot turn them
  into a stream of synchronous file writes. The renderer's blocks and the main process's outbound allowlist
  blocks have separate budgets. The summary ("N more … lines suppressed in the last S s") is written by a timer
  at the end of the minute, or at quit.
- **Main-process network**: `globalThis.fetch` is wrapped by an allowlist on top of the direct undici
  transport described above. It allows HTTPS only, exact hosts and
  the default port, and it follows redirects itself so that every hop is checked. On a redirect to another
  origin it drops the `Authorization`, `Cookie` and `Proxy-Authorization` headers. The allowed hosts are:
  - `query1/query2.finance.yahoo.com` and `finance.yahoo.com`, found by observing live traffic;
  - `guce.yahoo.com` and `consent.yahoo.com`, for the EU consent flow (from the yahoo-finance2 source);
  - the configured Binance host (one of the three above in a hardened build), or `api.exchange.coinbase.com`.

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
- **Opening the browser**: `shell.openExternal` is called in exactly one place, when a macOS build that cannot
  update itself offers the releases page after **Check for Updates…**. The URL is baked in at bundle time from
  `GITHUB_REPOSITORY` (`build/repository.cjs`) and re-validated before the call (`src/lib/releasesPage.ts`): it
  must be exactly `https://github.com/<owner>/<name>/releases`, with a strict slug and no port, credentials, query
  or fragment. A test pins that there is no other call.
- **Update UX** (`src/lib/updateController.ts`, `src/lib/updateMenu.ts`): native menu items (macOS) and message
  boxes in the main process only. No IPC, no preload, nothing is injected into the renderer. Data from GitHub is
  untrusted: the version must be plain semver (otherwise the dialog says "a new version"), and release notes,
  which arrive as HTML, become plain text with tags removed, entities decoded, and every Unicode control (Cc,
  except newline), format (Cf: zero-width, bidirectional overrides and isolates, soft hyphen, tags), line
  separator (Zl) and paragraph separator (Zp) character dropped, at most 12 lines and 600 characters
  (`src/lib/releaseNotes.ts`). Error dialogs never show the error text. Updater log lines have CR, LF, U+2028 and
  U+2029 escaped and are capped at 500 characters, so release data cannot forge log lines.
- **Unused features**: the app never uses `remote` or `file://`.

## Signing, notarization, updates

Signing is configured only through environment variables or CI secrets. `build/signing.cjs` decides, per
platform, whether a build is signed. Without the secrets, the build is unsigned and still succeeds.

- **macOS**:
  - Locally (`dist:mac`), electron-builder signs: set `CSC_LINK` (a base64 `.p12`) and `CSC_KEY_PASSWORD`, and for
    notarization also `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. A signed build signs the
    `.dmg` itself too; a local `dist:mac` notarizes only the app.
  - In CI, electron-builder never sees a key: separate jobs that run no dependency code sign and notarize (see
    [macOS signing in CI](#macos-signing-in-ci)). Each `.dmg` is signed, notarized and stapled
    (`xcrun notarytool submit --wait`, `xcrun stapler staple`) and checked with
    `spctl -a -t open --context context:primary-signature`, so Gatekeeper accepts the download as well as the app
    inside it.
  - The hardened runtime is on. The only entitlement is `com.apple.security.cs.allow-jit`, which V8 needs. Because
    there are no native modules, there is no `disable-library-validation`.
- **Windows**: one of these (checked in this order):
  - Azure Trusted Signing: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
    `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`,
    `AZURE_PUBLISHER_NAME`.
  - A Certum SimplySign cloud certificate, see [Windows signing with Certum](#windows-signing-with-certum).
  - A `.p12` certificate: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`. Certificates issued today keep their key in
    hardware or a cloud HSM, so this only fits older certificates.
- **Auto-update** (`electron-updater`, GitHub provider) is **on in signed builds**.
  - **Unsigned builds**: the updater is compiled out entirely, whatever `product.json` says. There is no
    `updater.cjs` in the package and no updater code path in `main.cjs`. On macOS, **Check for Updates…**
    explains that updates need a signed build and offers the releases page (see [Security model](#security-model)).
    Windows builds stay unsigned, and therefore without an updater, until a Certum certificate is set up.
  - **Signed builds**: the updater runs only when all of these hold (`updateAvailability` in
    `src/lib/updatePolicy.ts`):
    - `CHARTMATE_DISABLE_UPDATES` is not set to `1` (if it is, the macOS menu item is disabled and a second,
      disabled item names the variable);
    - the app is packaged, on macOS or Windows;
    - `autoUpdate` is `true` in `product.json` (it is from the release after 1.0.0 on; set it to `false` to ship
      a build without updates);
    - the build ships an `app-update.yml` (parsed as YAML), and on Windows it names a `publisherName` (without it
      electron-updater would skip the signature check) **and** the build pins the publisher DN
      (`CHARTMATE_WIN_PUBLISHER_DN`, see below).

    Otherwise, on macOS, **Check for Updates…** says updates are not available in this build. If the updater
    fails to start, the error is logged and the app runs on without updates.
  - **Where the controls are**:
    - macOS: **Check for Updates…** and the **Check for Updates Automatically** checkbox, under About in the app
      menu.
    - Windows: none. The frameless window (title bar overlay) has no visible menu bar, so menu items would be
      unreachable, and there is no IPC or preload to put them in the page. Signed Windows builds update in the
      background only; `CHARTMATE_DISABLE_UPDATES=1` turns that off.
  - **How it behaves** (`src/lib/updateController.ts`):
    - **Check for Updates…** checks right away and reports "You're up to date", "Chartmate X is available"
      while it downloads, or a short failure message.
    - In the background, with automatic checks on, the first check runs 15 s after start, then every 6 hours; it
      is silent until an update has been downloaded. The schedule stops when the app quits or the user chooses
      to restart.
    - Downloads are automatic. When an update is ready to install, a native dialog offers **Restart Now**
      (Windows: **Restart now**; `quitAndInstall`) or **Later** (`autoInstallOnAppQuit`: installed when the app
      quits), with a plain-text summary of the release notes. "Ready" means downloaded on Windows; on macOS it
      means Squirrel.Mac has also fetched and verified the update (its own `update-downloaded`, which in
      electron-updater 6.8.9 comes after electron-updater's), so a hand-over that fails (read-only or translocated
      app, unwritable `/Applications`, a signature that does not satisfy the designated requirement) never shows a
      **Restart Now** that does nothing. On macOS with no window open, the app asks for focus
      (`app.focus({ steal: false })`) before showing the dialog.
    - Failures are reported only when someone is waiting for the outcome, and worded by what failed: "Couldn't
      check for updates" or "Couldn't download the update" after a manual check, "Couldn't install the update"
      after a manual check whose hand-over failed, or after **Restart Now** (an installer that cannot start, or a
      failure that arrived while the dialog was open). Background failures are only logged. The state then goes
      back to idle and the schedule continues, so the next check retries. A version whose install failed is
      marked for the session: a later download of it does not show the restart prompt, unless on macOS
      Squirrel.Mac then reports that version ready to install (its own `update-downloaded`), which clears the
      mark. If the app has not quit 60 s after **Restart Now**, the state is reset and the version marked the same
      way.
    - macOS: if Squirrel.Mac reports neither ready nor an error within 10 minutes of the download, the hand-over
      counts as failed (logged, version marked, schedule resumed). **Check for Updates…** during the hand-over
      says the update is being prepared, and the outcome is then reported.
    - Once an update is ready, no further check runs: another check would start a second Squirrel.Mac
      hand-over. **Check for Updates…** offers the restart again instead.
  - **The setting**: **Check for Updates Automatically** is saved in `<userData>/update-settings.json`
    (`src/lib/updateSettings.ts`). The file name is fixed. It is read through a single descriptor opened with
    `O_NOFOLLOW | O_NONBLOCK` and checked with `fstat` (on Windows, which has neither flag, an `lstat` comes
    first), so a symlink, FIFO or other non-regular file is refused; it must be at most 1 KiB holding exactly
    `{"checkAutomatically": <boolean>}`. Anything else is ignored and logged, and the default (on) applies. Writes
    go to a fresh temp file (exclusive create, 0600, fsync) that is renamed over the target, so a planted symlink
    is replaced, never written through.
  - **How updates are verified**:
    - Integrity: each download is checked against the SHA-512 listed in `latest-mac.yml` / `latest.yml`. That
      file comes from the same GitHub release over the same HTTPS connection, so this catches corrupted or
      truncated downloads; it does not prove who published the update. The code signature does.
    - Windows: our own verifier (`src/lib/winSignature.ts`) replaces electron-updater's, which skips the check
      when PowerShell cannot run. It runs `Get-AuthenticodeSignature` (the system PowerShell by absolute path, no
      shell, the file path passed in an environment variable, progress silenced, errors stopping the script,
      ASCII-only JSON out) and fails **closed**: any error, timeout, stderr output other than CLIXML progress
      records, unreadable result, status other than `Valid`, a different file, a subject that does not match the
      pinned DN, or an installer whose `ProductVersion` (electron-builder's NSIS installer carries the app version
      there) is not the version the release advertised and newer than the running app refuses the installer.
      Every attribute in the pin (at least CN, O and C) must match; extra subject fields are allowed. The pin is
      `CHARTMATE_WIN_PUBLISHER_DN`, baked in at bundle time; the `publisherName` in `app-update.yml` only has to
      be present. Where PowerShell runs in Constrained Language Mode, the script cannot run, so updates are
      refused. The issuer is not pinned: Certum may change its intermediate at renewal.
    - macOS: before the zip is handed to Squirrel.Mac, the app extracts it with `/usr/bin/ditto -x -k` (the tool
      Squirrel.Mac unpacks with) into a private temporary directory (`src/lib/updateBundle.ts`). The zip must be
      a regular file of at most 1 GiB, extraction is limited to 2 minutes, and the archive must hold exactly one
      top-level entry, an `.app` directory. Its `CFBundleShortVersionString`, read with `/usr/bin/plutil` (XML or
      binary plist), must equal the version the release advertised and be newer than the running app. The
      temporary directory is always removed: its directories are made owner-writable first (a bundle can hold
      read-only ones), and a failed removal is only logged, never turning a result into another. Anything unexpected refuses the update, and the loopback listener is
      then never armed. This compares versions; it does not by itself prove what Squirrel.Mac will install, which
      is why Squirrel.Mac's own signature check (next) still matters. Squirrel.Mac then checks that the new app's code
      signature satisfies the running app's designated requirement. The hand-over is the only case that opens a
      listener (the loopback exception described under [How it works](#how-it-works)), one per hand-over.
  - **Downgrades**: `allowDowngrade` and `forceDevUpdateConfig` are `false`, `channel` is never set (setting it
    would allow downgrades), and `isUpdateSupported` accepts only a valid semver strictly newer than the running
    version. These judge the version **the release metadata advertises**. The downloaded update's own version is
    checked as well: the app's `CFBundleShortVersionString` on macOS, the installer's `ProductVersion` on Windows
    (above). Both are read from the downloaded file before it is installed; neither stops someone who can publish
    a validly signed newer release.
  - **Pre-releases**: a full release only ever updates to full releases; a pre-release build (`1.1.0-beta.1`,
    detected by parsing the version) also to newer pre-releases (`src/lib/updatePolicy.ts`).
  - **Network**: electron-updater downloads through its own session partition (`electron-updater`; a test pins
    the dependency's partition name). That partition connects directly (`setProxy({ mode: 'direct' })`: no system
    or PAC proxy, like provider traffic), and its request filter allows HTTPS only, on the default port, without
    URL credentials, to `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`,
    checking every redirect hop. `api.github.com` is not allowed: the public GitHub provider only uses it for a
    custom host (pinned by a test). TLS is verified by Chromium's certificate verifier, which also honors
    locally trusted roots (unlike the bundled-CA transport that market data uses); the code signature checks above
    are what protect against an intercepted connection. The proxy setting is applied (awaited) and the filter
    installed before the first check can run.
  - **Release assets**: the packaging steps run with `CHARTMATE_PUBLISH=github`, so electron-builder writes
    `app-update.yml` (`provider: github`, owner and repository from `GITHUB_REPOSITORY`) into the app and
    `latest-mac.yml` / `latest.yml` next to the artifacts (`--dir` builds get no `app-update.yml`). On macOS the
    zips, blockmaps and `latest-mac.yml` are computed from the signed, stapled apps (`--prepackaged`, one run per
    architecture, merged by `scripts/merge-update-info.mjs`). The release job attaches the zips, the installers,
    the blockmaps (for differential downloads) and `latest*.yml`. macOS updates install from the zip, never the
    dmg. The GitHub provider only sees published (not draft) releases.
  - **Licenses**: every build ships the AGPL-3.0 `LICENSE` and `THIRD_PARTY_NOTICES.txt` next to `app.asar`
    (`Contents/Resources` on macOS, `resources` on Windows). A `beforePack` hook in `build/builder-config.cjs`
    generates the notices from the installed dependency graph (the repository root's
    `scripts/third-party-notices.mjs`, profile `desktop`) and fails the build if a shipped dependency's license is
    not on the AGPL-3.0-compatible allowlist. A few MIT and ISC packages distribute no license file: for them the
    notices state the license their `package.json` declares, its declared author and repository, and that no
    license file was distributed, followed by the standard license text labeled as such (no copyright line is made
    up).
  - **1.0.0 shipped with `autoUpdate: false`**, so 1.0.0 installs never check for updates: their users install
    the next version once by hand, and update automatically from then on.
  - **Untestable without a real signed release**: the GitHub feed lookup, the Squirrel.Mac hand-over and
    install, the Windows signature check against a real certificate, and the restart. Unit tests cover the
    policy, the controller (with a fake updater), the menu, the settings file, the bundle version check (real
    `ditto`/`plutil` on macOS, a fake runner elsewhere), the DN pin, the verifier (with a fake process runner) and
    the sanitizers; the smoke test checks the macOS menu and that unsigned builds contain no updater.

### macOS signing in CI

A tag build is signed when the repository variable `CHARTMATE_MAC_SIGN_IDENTITY` holds the identity name
(`Developer ID Application: Jane Doe (TEAMID)`); without it the build is unsigned and has no updater. The key and
the Apple credentials live only in the `macos-signing` environment, and only two jobs, which run no dependency
code, can read them:

1. `package-mac` (no secrets) installs the dependencies and builds both apps unsigned. It bundles with
   `CSC_NAME` set to the identity name, so `build/signing.cjs` compiles the updater in; electron-builder itself
   gets no identity and signs nothing.
2. `sign-mac` (`macos-signing`) starts on a fresh runner with only `.github/scripts/macos-sign.sh` and the two
   entitlements plists checked out: no Node.js setup, no package manager, no npm package. It imports the `.p12`
   into a temporary keychain with a random password, the key non-extractable (`security import -x`) and usable by
   `codesign` only. It signs the nested code inside-out (Mach-O files, then helper apps and frameworks, deepest
   first, then the app) with the hardened runtime, a secure timestamp and the entitlements from
   `build/entitlements.mac*.plist`. It verifies the signature (`codesign --verify --deep --strict`), then
   notarizes each app (`notarytool` with a keychain profile), staples it and checks it with `spctl`.
3. `dist-mac` (no secrets) builds the dmgs, zips, blockmaps and `latest-mac.yml` from the signed apps with
   `electron-builder --prepackaged` (which packages without signing), and smoke-tests the signed arm64 app.
4. `notarize-mac-dmg` (`macos-signing`, no dependency code) signs each dmg, notarizes and staples it, and checks
   it with `spctl`.

Set up the repository once:

1. Create an environment named `macos-signing` (Settings, Environments). Under deployment branches and tags,
   allow only tags matching `v*`. Optionally add yourself as a required reviewer: each signed release then waits
   for your approval twice (`sign-mac` and `notarize-mac-dmg`).
2. Add these as `macos-signing` environment secrets, and delete any repository secrets of the same names (any
   workflow can read repository secrets, and they bypass the environment's rules): `CSC_LINK` (the base64 `.p12`,
   exported with its certificate chain), `CSC_KEY_PASSWORD`, and for notarization `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (without these three the build is signed, not notarized).
3. Set the repository variable `CHARTMATE_MAC_SIGN_IDENTITY` to the identity name exactly as
   `security find-identity -v -p codesigning` prints it. With the variable set but the secrets missing, the
   signing job fails: the build would otherwise ship an updater without a signature.

Residual risk:

- The dependencies still build the code that gets signed: a compromised build dependency in `package-mac` could
  plant code in the app, and it would be signed and notarized. `--ignore-scripts`, the frozen lockfile,
  `pnpm audit`, Dependabot's cooldown and the smoke tests are what limit that.
- The signing jobs unpack the app archive built by `package-mac` and run `codesign`, `ditto` and `notarytool` on
  it, but never execute anything from it.
- Approving a signing run approves whatever the tagged commit builds.

### Windows signing with Certum

A Certum cloud certificate keeps its key in Certum's HSM. SimplySign Desktop exposes it while it is logged in,
and you log it in with a one-time code from the SimplySign phone app. Each Windows build is signed in three
places, each with SHA-256 and a Certum timestamp (`http://time.certum.pl`): `chartmate.exe`, the uninstaller and
the installer. `latest.yml` and the blockmaps are computed from the signed files.

**1. Buy and activate (once a year).**

- Buy **Open Source Code Signing in the Cloud** from Certum. Chartmate is AGPL, and the certificate names you as
  "Open Source Developer, *your name*". If you don't qualify, buy **Standard Code Signing in the Cloud**. Do not
  buy a card-and-reader bundle.
- Since March 2026 a code-signing certificate lasts at most 460 days, and its key must stay in hardware or a
  cloud HSM. Renew every year. The open-source certificate allows 5,000 signatures a month, and a release uses
  about 10.
- After identity verification, install the SimplySign app on your phone and activate it from the QR code Certum
  sends you. The QR code holds an `otpauth://totp/…` URI. If you want CI to sign (step 2), also add the QR code to
  your password manager and copy that URI.
- Install SimplySign Desktop: Windows, or `brew install --cask simplysign` on macOS (Intel only; it needs Rosetta).
  Log in with your email and a code from the phone app, then finish Certum's activation. The certificate's
  subject CN (for example `Open Source Developer, Jane Doe`) is your **publisher name**. Copy it exactly and keep
  it the same across renewals.
- Also copy the certificate's full subject, the **publisher DN**: on Windows, run
  `(Get-AuthenticodeSignature <a file you signed>).SignerCertificate.Subject`. Keep at least CN, O and C (for
  example `CN="Open Source Developer, Jane Doe", O=Open Source Developer, C=PL`), plus any other fields that stay
  the same across renewals. Installed copies accept updates only from a certificate matching every field you
  keep: drop a field that a renewal could change, or updates stop at that renewal.

**2. CI signing (`desktop.yml`, tag builds only).** Set up the repository once:

1. Create an environment named `windows-signing` (Settings, Environments). Under deployment branches and tags,
   allow only tags matching `v*`. Optionally add yourself as a required reviewer: each signed release then waits
   for your approval.
2. Add a tag ruleset (Settings, Rules) for `v*` tags. Restrict creation to yourself, so nobody else can trigger a
   signing run, and also block updates and deletions.
3. Set these values. Store the two Certum secrets **only** as `windows-signing` environment secrets, never as
   repository secrets: any workflow can read repository secrets, and they bypass the environment's rules.

| Name | Where | Value |
|---|---|---|
| `CHARTMATE_CERTUM_USERNAME` | `windows-signing` secret | SimplySign account email |
| `CHARTMATE_CERTUM_OTP_URI` | `windows-signing` secret | the `otpauth://totp/…` URI from the activation QR code |
| `CHARTMATE_WIN_PUBLISHER_NAME` | repository variable | the certificate subject CN |
| `CHARTMATE_WIN_PUBLISHER_DN` | repository variable | the publisher DN (at least CN, O and C); without it, signed Windows builds do not update themselves |
| `CHARTMATE_CERTUM_SIMPLYSIGN_MSI_SHA256` | repository variable | SHA-256 of the SimplySign Desktop installer CI downloads (required) |
| `CHARTMATE_CERTUM_SIMPLYSIGN_VERSION` | repository variable, optional | that installer's version (default `9.4.4.92`) |
| `CHARTMATE_CERTUM_SIMPLYSIGN_SIGNER_SHA1` | repository variable, optional | pins the installer's signing certificate thumbprint |
| `CHARTMATE_CERTUM_TOTP_ALGORITHM` | repository variable, optional | `SHA1`, `SHA256` or `SHA512`, if the QR code's URI does not say |

To get the SHA-256, download
`https://files.certum.eu/software/SimplySignDesktop/Windows/<version>/SimplySignDesktop-<version>-64-bit-en.msi`.
On Windows, check that **Properties, Digital Signatures** shows Asseco Data Systems S.A. Then run
`Get-FileHash -Algorithm SHA256 <file>` (or `shasum -a 256 <file>` on a Mac).

On a tag build, the first step of the Windows job runs `scripts/certum/login.ps1`, before any dependency is installed
or any dependency code runs on that runner:

1. It downloads SimplySign Desktop and installs it only if the SHA-256 matches and the installer carries a valid,
   revocation-checked signature whose organization is exactly Asseco Data Systems S.A.
2. It types your email and a code computed from the seed into the login window, at most twice, so a failing
   login is never retried in a loop.
3. It waits for the certificate to appear in the user's certificate store.

The two login secrets exist only in that step's environment; the packaging step gets just the certificate
thumbprint. `build/win-sign.cjs` signs with `signtool /sha1 <thumbprint>`; signtool gets a minimal environment.
Then `scripts/verify-win-signatures.mjs` checks every signature, the SHA-256 digests, the uninstallers (from the
hook's log), `app-update.yml`, `latest.yml` and the blockmaps, and SimplySign Desktop is closed right away, before
the smoke tests run.

If the SimplySign login or the sign hook fails, the release is created as a **draft**:

- Windows is rebuilt without Certum, and the run shows a warning. The build is unsigned, with no updater, unless
  another method is configured.
- The release notes say "Windows signing step failed in CI — sign with `sign:win`".
- macOS is unaffected.
- Run step 3, then publish the draft: `gh release edit vX.Y.Z --draft=false --latest=<true|false>`. Use `true`
  only when no higher full release exists (from the repository root,
  `git tag --list 'v*' | node scripts/release-tags.mjs vX.Y.Z` prints `latest=…`). Until it is published,
  installed copies are not offered the update.

If the files were signed but `verify-win-signatures.mjs` rejects them, the job fails and nothing is published.

Residual risk:

- Windows cannot be signed in a separate job the way macOS is. The SimplySign session belongs to the runner that
  logged in, and electron-builder signs the uninstaller in the middle of building the NSIS installer, which then
  embeds it (and `chartmate.exe`); the installer, `latest.yml` and the blockmaps are computed afterwards. Signing
  only the finished files would ship an unsigned uninstaller and need electron-builder's NSIS steps split apart.
- So the dependencies run on the runner where the certificate session is live, for the whole build: anything
  executed during the build could sign files with your certificate while that session lasts.
- Logging in first keeps the seed out of every later step's environment and away from anything a dependency could
  leave behind (a background process, `GITHUB_ENV` or `GITHUB_PATH` entries), because no dependency code has run
  yet. It is not a hard boundary: GitHub hands every secret a job references to that job's runner, and later
  steps run with administrator rights on the same machine.
- What actually protects the build:
  - dependencies are installed with `--ignore-scripts` from the frozen lockfile;
  - `pnpm audit` runs before packaging;
  - Dependabot keeps dependencies current, a week after each release (cooldown);
  - a required reviewer on `windows-signing` makes you approve each signing run.
- The Azure Trusted Signing and `.p12` (`WIN_CSC_*`) options, when configured, are read by the packaging step
  itself, next to the dependencies.
- Only `chartmate.exe`, the uninstaller and the installer carry Authenticode signatures. The other executables
  and DLLs that come with Electron (`ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, and so
  on) are not signed individually. Windows does not require it, the installer's signature covers what it
  installs, and the update check verifies the installer.

Limitations:

- SimplySign Desktop has no command-line login, so CI drives its window with keystrokes. A SimplySign update
  can break that.
- Certum also rejects outdated clients at login. If that happens, raise `CHARTMATE_CERTUM_SIMPLYSIGN_VERSION` and
  record the new installer's SHA-256.
- The seed is a long-lived credential: anyone holding it and your email can sign as you. If it leaks, re-issue
  the QR code in SimplySign. If you would rather not store it at all, skip this step and use step 3 only.
- To check the seed, run
  `(read -rs CHARTMATE_CERTUM_OTP_URI; export CHARTMATE_CERTUM_OTP_URI; node apps/desktop/scripts/certum/totp.mjs)`
  and paste the URI. The subshell keeps the seed out of your shell. It must print the same code as the phone app;
  if it differs, set `CHARTMATE_CERTUM_TOTP_ALGORITHM`.
- `publisherName` in `app-update.yml` is the certificate CN, but the update check pins the DN in
  `CHARTMATE_WIN_PUBLISHER_DN`, so a certificate with the same CN from another organization is refused. Every
  field you pin must survive renewals.

**3. Manual signing (fallback, no seed stored anywhere).** After CI has published a tag, possibly with an unsigned
Windows build, run this on your Mac or a Windows PC:

```sh
git checkout vX.Y.Z
# SimplySign Desktop: connect, then type the code from the phone app
export CHARTMATE_WIN_PUBLISHER_NAME='Open Source Developer, Jane Doe'
export CHARTMATE_WIN_PUBLISHER_DN='CN="Open Source Developer, Jane Doe", O=Open Source Developer, C=PL'
export CHARTMATE_WIN_PKCS11_MODULE=/usr/local/lib/libSimplySignPKCS.dylib   # macOS
# export CHARTMATE_WIN_CERT_SHA1=<thumbprint>                               # Windows instead (certmgr.msc)
pnpm --filter @chartmate/desktop sign:win
```

`sign:win` does the following:

1. Before it publishes anything, it checks:
   - HEAD is the tag, and the tag is the one on GitHub;
   - there are no changed or untracked files, and no ignored `.env` files;
   - the release exists.
2. It reinstalls `node_modules` from the lockfile, then rebuilds the Windows app for the tag. CI's installers
   cannot be re-signed in place, because the app and the uninstaller are inside them.
3. Right before packaging, it asks for the card PIN, if your setup has one (or takes `CHARTMATE_WIN_PKCS11_PIN`
   from its own environment, removing it there first thing so `git`, `gh` and `pnpm` never inherit it). The PIN
   is never put in electron-builder's environment, which every tool it starts
   would inherit: it is written to an owner-only file (0600) in a fresh private temporary directory (0700), and
   electron-builder gets only that file's path as `CHARTMATE_WIN_PKCS11_PIN_FILE`. The sign hook
   (`build/win-sign.cjs`) reads and deletes the file on its first call, keeps the PIN in memory for the other
   files, and gives it to `osslsigncode` only (as `PKCS11_PIN`). The directory is removed when packaging ends,
   whatever the outcome, and on Ctrl-C or SIGTERM (the signal is then re-raised). The first rejected PIN stops all further signing attempts.
4. It signs, then verifies everything.
5. It shows the files and asks before replacing them on the GitHub Release with `gh release upload --clobber`.
   The repository comes from `gh` or `GITHUB_REPOSITORY`.
6. It changes the release notes' Windows row to "Certum (SimplySign)" and drops the unsigned notes.

`--no-upload` builds and verifies only.

macOS needs these tools:

- Rosetta (`softwareupdate --install-rosetta`). SimplySign Desktop and electron-builder's NSIS compiler are
  Intel-only.
- `gh`, logged in.
- `osslsigncode` and `libp11` from Homebrew.
- If `lipo -archs /usr/local/lib/libSimplySignPKCS.dylib` shows no `arm64`, the signing tools have to be Intel
  builds as well. Install Homebrew under `/usr/local` with `arch -x86_64`, then run
  `arch -x86_64 /usr/local/bin/brew install osslsigncode libp11`. The hook runs them under Rosetta automatically.

Optional settings:

- `CHARTMATE_WIN_PKCS11_CERT` and `CHARTMATE_WIN_PKCS11_KEY`: PKCS#11 URIs for when the token holds more than one
  certificate. List the objects with `pkcs11-tool --module <module> -O`.
- `CHARTMATE_WIN_CERT_CHAIN`: a PEM of Certum's intermediate CA to embed.
- `CHARTMATE_WIN_VERIFY_CAFILE`: the trust store used for verification.
- `CHARTMATE_OSSLSIGNCODE`, `CHARTMATE_WIN_PKCS11_PROVIDER`, `CHARTMATE_OSSLSIGNCODE_ARCH`, `CHARTMATE_SIGNTOOL`:
  tool locations.
- `CHARTMATE_WIN_SIGN_PASS_ENV`: names of extra variables, comma-separated, that the signing tool may see.
  Signing tools get only a minimal environment, so a PKCS#11 module that needs its own configuration variable
  has to be listed here.

Build-only variables (they affect packaging, never the running app):

- `CHARTMATE_PUBLISH=github`: electron-builder writes `app-update.yml` and `latest*.yml` for GitHub Releases
  (needs `GITHUB_REPOSITORY`; see [Release assets](#signing-notarization-updates)). CI's packaging steps and
  `sign:win` set it.
- `CHARTMATE_WIN_SIGN_LOG`: a file the sign hook appends one JSON line to per signed file;
  `scripts/verify-win-signatures.mjs` checks that every expected file was signed (`--sign-log`). CI's Certum packaging step and
  `sign:win` set it to a temporary file.
- `CHARTMATE_WIN_PKCS11_PIN`: the card PIN for `sign:win` (it asks otherwise). In a direct electron-builder run the
  hook also accepts it from the environment, with the exposure described above.
- `CHARTMATE_WIN_PKCS11_PIN_FILE`: set by `sign:win` only (see step 3); the file must be an owner-only regular file.

Windows needs SimplySign Desktop, the Windows SDK (`signtool`) and `gh`.

## Renaming the product

Edit `apps/desktop/product.json` and nothing else:

- `productName` sets the window title, menu, `.app` and installer names, and the data directory name.
- `appId` is the bundle id or AppUserModelID.
- `executableName` names the Windows and Linux executable.

The data directory follows `productName`. To carry users' data over, add the old name to `previousProductNames`.
On first start the app then moves `chartmate.db` (and its WAL/SHM files) and `window-state.json` from the old directory.
It never overwrites existing data.
