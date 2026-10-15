# Contributing to Chartmate

Thanks for helping. Chartmate is a charting app whose core value is how it looks: a change that works but looks
worse is not done. This page covers the setup, the checks every pull request passes, and a step-by-step guide to
the most common contribution, [adding an indicator](#add-an-indicator).

[AGENTS.md](AGENTS.md) is the full guide to the code (layout, architecture boundaries, conventions, desktop
security rules); read it before larger changes. The [README](README.md) is the user-facing reference, and
[docs/desktop.md](docs/desktop.md) covers the desktop app's internals, security model and code signing.
Maintainers: see [Releases](#releases) at the end.

## Setup

Requires Node 22 (`.nvmrc` pins the exact version CI uses) and pnpm 8: `corepack enable` installs the exact version pinned (with its sha512) in
the root `package.json`.

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

No dependency install script is needed (CI installs the same way). Run the app on scratch data with the
deterministic fixture provider, so you never touch real data or the network:

```sh
DATABASE_URL=sqlite:/tmp/chartmate-dev.db CHARTMATE_PROVIDERS=fixture pnpm dev
```

Then open http://localhost:5173 (the API runs on 8787; Vite proxies `/api`). Never point a manual run at
`apps/server/data/chartmate.db` or the desktop app's data directory.

## Checks

Every pull request must pass these (CI runs them all):

| Check | Command |
| --- | --- |
| Typecheck (all packages and the e2e suite) | `pnpm typecheck` |
| Unit tests (no network) | `pnpm test` |
| One package / one file | `pnpm --filter @chartmate/web test` / `pnpm --filter @chartmate/web exec vitest run test/indicators/calc.test.ts` |
| Server DB suites on Postgres (CI's `postgres` job; each test file gets its own schema) | `TEST_PG_URL=postgres://… CHARTMATE_TEST_DB=postgres pnpm --filter @chartmate/server exec vitest run --no-file-parallelism test/db test/market test/baskets test/routes test/http` |
| Dependency vulnerabilities (after any dependency change) | `pnpm audit` |
| End-to-end, when a UI flow changes (first time: `pnpm exec playwright install chromium`) | `pnpm e2e` (`E2E_PORT=8873 pnpm e2e` for another port) |

Write the failing test first, then the code; a bug fix comes with a regression test.

## Pull requests

- **Commits**: small and logical, conventional style with a lowercase summary of what changed:
  `feat(web): …`, `fix(server): …`, `docs: …`, `test(shared): …`, `refactor: …`, `ci: …`, `chore: …`.
- **Language**: American English in code, comments, UI strings and docs; sentence case for UI labels.
  Describe Chartmate on its own terms: do not name or compare it to other charting products.
- **Docs**: a change to behavior, a command, an env var or a default updates the README (or `docs/desktop.md`) in
  the same pull request. A change users will notice also gets a line in the `## Unreleased` section at the top of
  `CHANGELOG.md` (renamed to the version at release time).
- **UI changes**: attach screenshots of the running app in **both** the dark and the light theme.
- **Dependencies**: only licenses compatible with AGPL-3.0 (MIT, BSD, ISC, Apache-2.0, MPL-2.0 and similar).
  `pnpm licenses:check` checks every shipped dependency against the allowlist in
  `scripts/third-party-notices.mjs` (CI runs it too).

## License

Chartmate is licensed under the [GNU AGPL-3.0-only](LICENSE). Contributions are accepted under that same license
(inbound = outbound): by opening a pull request you license your contribution under AGPL-3.0-only. No contributor
license agreement or commit sign-off is required.

Porting an existing indicator? Only port code whose license allows it, keep its license header and attribution,
and say so in the pull request (the Wyckoff indicator is an MPL-2.0 example).

## Add an indicator

An indicator is one file in `apps/web/src/chart/indicators/custom/`. It is registered with the chart and listed
in the indicator picker automatically; no other file needs editing. Its colors come from the app's palette, so it
matches every other indicator in both themes.

This guide follows a complete example that ships with Chartmate:
[`custom/ppo.ts`](apps/web/src/chart/indicators/custom/ppo.ts), the **percentage price oscillator**, with its test
[`test/indicators/ppo.test.ts`](apps/web/test/indicators/ppo.test.ts). It has everything an indicator can have:
three params, two lines (PPO and its signal line), a histogram in the up / down colors and a zero reference
level, in its own pane. The snippets below are copied from those files (a test keeps them identical); read the
files for the whole picture.

### 1. Scaffold it

```sh
pnpm new:indicator KeltnerChannels               # an oscillator in its own pane
pnpm new:indicator Envelope --pane main          # an overlay on the candles
```

The name is PascalCase or an acronym (`TSI`), 2 to 24 letters and digits. The command creates:

- `apps/web/src/chart/indicators/custom/keltnerChannels.ts`: the calculation, the chart template and the
  picker entry, already wired to the palette;
- `apps/web/test/indicators/keltnerChannels.test.ts`: tests of the calculation, of the picker entry and of the
  line colors in both themes.

It refuses a name that is already in the picker (built-in or custom) and never overwrites a file. The generated
indicator works as is (a placeholder moving average), so the app shows it right away. The steps below turn the
placeholder into the real thing.

### 2. The calculation, test first

The calculation is a plain function: bars in, one result per bar out, `null` during the warm-up (not enough
history yet; nothing is drawn there). No chart, no DOM, no globals, no network. Start with a test whose expected
values you computed by hand on a short series:

<!-- snippet: apps/web/test/indicators/ppo.test.ts -->
```ts
  it('fast and slow EMA spread as a percentage of the slow EMA, its signal line and the histogram', () => {
    // Hand-computed with fast 2, slow 3, signal 2 (see the ema test for the EMAs).
    const ppo = [50 / 11, 25 / 6, 25 / 18]; // (11.5 - 11) / 11, (12.5 - 12) / 12, (73/6 - 12) / 12, in %
```

Then cover the edges: the warm-up, an empty list, a flat series, a division by zero. Then write the function:

<!-- snippet: apps/web/src/chart/indicators/custom/ppo.ts -->
```ts
export function calcPpo(bars: ReadonlyArray<{ close: number }>, fast: number, slow: number, signal: number): PpoResult[] {
  const closes = bars.map((b) => b.close);
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const ppo = fastEma.map((f, i) => {
    const s = slowEma[i];
    return f === null || s === null || s === undefined || s === 0 ? null : ((f - s) / s) * 100;
  });
  const sig = ema(ppo, signal);
  return ppo.map((p, i) => {
    const s = sig[i] ?? null;
    return { ppo: p, signal: s, hist: p === null || s === null ? null : p - s };
  });
}
```

Run just your test while you work:

```sh
pnpm --filter @chartmate/web exec vitest run test/indicators/ppo.test.ts
```

Shared helpers (moving averages, ATR, session keys) live in `apps/web/src/chart/indicators/calc.ts`. Keep the
module's top-level code free of side effects: indicators are bundled eagerly, so a module that throws while being
imported stops the app from starting (a module with the wrong shape is only skipped, with a console warning).

### 3. The chart template

`template` tells the chart how to compute and draw the indicator. Each value of a result is a **figure**: `key`
names the field, `type` is `line` or `bar` (a histogram). `calcParams` are the default params, passed to `calc` in
order:

<!-- snippet: apps/web/src/chart/indicators/custom/ppo.ts -->
```ts
  template: {
    name: 'PPO', // unique; equal to catalog.name
    shortName: 'PPO', // the chart legend
    calcParams: [12, 26, 9], // default params; the user edits them in the settings dialog
    precision: 2, // values are percentages
    // One figure per value: `key` names the field of PpoResult, `type` line or bar. Lines are listed in
    // catalog.lines in this same order; their colors come from catalog.lineSlots, never from here.
    figures: [
      { key: 'hist', title: 'Hist: ', type: 'bar', baseValue: 0, styles: histStyles },
      { key: 'ppo', title: 'PPO: ', type: 'line' },
      { key: 'signal', title: 'Signal: ', type: 'line' },
    ],
    calc: (dataList, ind) => calcPpo(dataList, ind.calcParams[0] ?? 12, ind.calcParams[1] ?? 26, ind.calcParams[2] ?? 9),
  },
```

For an indicator whose values are prices (moving averages, bands, ATR), set `usePricePrecision: true` next to
`template` instead of a fixed `precision`: values then use the charted symbol's precision.

### 4. The picker entry

`catalog` is what the indicator picker and the settings dialog show:

<!-- snippet: apps/web/src/chart/indicators/custom/ppo.ts -->
```ts
  catalog: {
    name: 'PPO',
    label: 'Percentage price oscillator',
    pane: 'sub', // its own pane under the candles
    defaultParams: [12, 26, 9],
    paramLabels: ['Fast period', 'Slow period', 'Signal period'],
    lines: ['PPO', 'Signal'], // the line figures, in figure order
    lineSlots: [0, 1], // palette slots: PPO gold, signal violet, in each theme's own shade
    levels: [0], // a dashed zero line, editable in the settings dialog
```

| Field | Meaning |
| --- | --- |
| `name`, `label` | `name` equals `template.name`; `label` is what the picker shows (sentence case). |
| `pane` | `'sub'` (own pane) or `'main'` (overlay on the candles). |
| `defaultParams`, `paramLabels` | The default params and one label per param. Params are integers in 1…1000 unless listed in `decimalParams` (decimals > 0) or bounded by `paramMin` / `paramMax`. |
| `lines` | One name per `line` figure, in figure order (bar figures are not listed). |
| `lineSlots` | The palette slot (0-5) of each line, index-aligned with `lines`; default: line i uses slot i. |
| `bars` | A histogram with editable up / down colors; inferred from a `bar` figure. |
| `levels` | Default dashed reference levels of an oscillator, at most 5 (e.g. `[70, 30]`, `[0]`); `sub` only. |
| `description` | A longer explanation for the picker tooltip. |

`customIndicatorProblem` (`apps/web/src/chart/indicators/extensions.ts`) validates this shape, and the test checks
it:

<!-- snippet: apps/web/test/indicators/ppo.test.ts -->
```ts
    expect(customIndicatorProblem(indicator)).toBeNull();
    expect(catalogEntry('PPO')).toMatchObject({
      label: 'Percentage price oscillator', pane: 'sub', defaultParams: [12, 26, 9], lines: ['PPO', 'Signal'], levels: [0], bars: true,
    });
```

### 5. Colors: never write one

Indicator code contains no colors. Each theme has a six-slot categorical palette (`INDICATOR_PALETTE` in
`apps/web/src/chart/theme.ts`), tuned to read on its background:

| Slot | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| Hue (as the drawing color swatches name them) | gold | violet | cyan | orange | pink | blue |

**Lines** pick a slot with `lineSlots`, as above. In its own pane, start at slot 0. On the price pane the lines
share the candles with other overlays (MA uses slots 0-3, EMA and BOLL 0-2, BBI 0, VWAP 5), so the scaffold puts an
overlay on slot 4. Lines of one indicator use distinct slots. The test pins them in both themes:

<!-- snippet: apps/web/test/indicators/ppo.test.ts -->
```ts
  it.each(['dark', 'light'] as const)('draws its two lines in distinct palette colors on the %s theme', (theme) => {
    expect(defaultLineColors('PPO', theme)).toEqual([INDICATOR_PALETTE[theme][0], INDICATOR_PALETTE[theme][1]]);
  });
```

**Histograms** use the chart's bar colors: the theme's up / down colors, or the ones the user picked in the
indicator settings. KLineChart passes both to the figure's `styles` callback, which only chooses between them:

<!-- snippet: apps/web/src/chart/indicators/custom/ppo.ts -->
```ts
const histStyles: IndicatorFigureStylesCallback<PpoResult> = ({ data, indicator, defaultStyles }) => {
  const own = indicator.styles?.bars?.[0];
  const theme = defaultStyles!.bars[0]!;
  const hist = data.current?.hist ?? 0;
  const prev = data.prev?.hist ?? null;
  const color = hist > 0 ? own?.upColor ?? theme.upColor : hist < 0 ? own?.downColor ?? theme.downColor : own?.noChangeColor ?? theme.noChangeColor;
  return { color, borderColor: color, style: prev !== null && hist > prev ? 'stroke' : 'fill' };
};
```

A bar returned as `'stroke'` (here: a rising one) is drawn filled in the soft tone of its color.

**Custom drawing.** An indicator that paints on the canvas itself (a template `draw` callback, like
`custom/wyckoff.ts`) takes every color from `activeIndicatorColors()` (`apps/web/src/chart/indicators/colors.ts`),
**called inside the callback**, so a theme toggle or a custom candle color repaints it correctly:

```ts
draw: ({ ctx }) => {
  const c = activeIndicatorColors(); // bg, text, muted, level, up, down, upSoft, downSoft, upText, downText, palette
  ctx.strokeStyle = c.palette[2]!;
  // …
  return false; // false: KLineChart still draws the figures; true: this callback replaces them
},
```

For a soft fill use the opaque tones (`upSoft`, `downSoft`, or `softTone` / `tintFill` from `chart/color.ts`), never
an `rgba()` of a strong color.

**The color-literal guard.** A test (`apps/web/test/indicators/colors.test.ts`) fails on any color written in a
string or template literal under `apps/web/src/chart/indicators/`: hex colors (`'#fff'`, `'#1a2b3c'`, with or
without alpha), CSS color functions (`rgb(`, `rgba(`, `hsl(`, `hsla(`, `hwb(`, `lab(`, `lch(`, `oklab(`, `oklch(`)
and common color names as whole words (`'red'`, `'white'`, `'gold'`…, so keep them out of labels too). Comments are
not checked.

### 6. See it in the app, in both themes

```sh
pnpm typecheck && pnpm test
DATABASE_URL=sqlite:/tmp/chartmate-dev.db CHARTMATE_PROVIDERS=fixture pnpm dev
```

Open http://localhost:5173 (restart `pnpm dev` after adding a file), click **Indicators** in the top bar and type
the name (`PPO`): the picker lists it under its pane. Add it, open its settings (the settings button on its chip)
to try the params, levels and colors, then switch the theme with the sun / moon button. Look at a few symbols and
timeframes, including the first bars (the warm-up). Attach a dark and a light screenshot of the chart to the pull
request.

### 7. Document it

Give the indicator a `catalog.description` (the picker tooltip) when its label alone does not say what it shows.
If users need to know more (session anchoring, timeframes it does not support, unusual params), add it to the
README's "Indicators" section (under "Using Chartmate") in the same pull request, and a line to the
`## Unreleased` section of `CHANGELOG.md`.

## Releases

A release is a pushed `vX.Y.Z` tag. The tag builds and publishes everything; nothing is uploaded by hand.

1. On `main`, rename the `## Unreleased` section at the top of [CHANGELOG.md](CHANGELOG.md) to
   `## [X.Y.Z] - YYYY-MM-DD` (pull requests record user-visible changes there in plain language as they land; add
   anything missing), and set `"version": "X.Y.Z"` in `apps/desktop/package.json`, the product version the
   desktop app reports. A test fails while the desktop version has no changelog section. Start a new empty
   `## Unreleased` section after the release.
2. Run the full checks (`pnpm audit`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`) and merge.
3. Tag the merge commit on `main` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`. Both release
   workflows stop if the tagged commit is not on `main`. A suffixed tag
   (`vX.Y.Z-beta.1`) makes a pre-release. Who can create `v*` tags, and whether they can be moved or deleted,
   depends on the repository's tag rulesets (docs/desktop.md recommends restricting creation to the owner and
   blocking updates and deletions).
4. **TODO (after the next release, the first one with the `compose.yaml` asset):** switch the README's
   [Recommended install](README.md#recommended-install-docker-compose) from the `raw.githubusercontent.com/…/main`
   URLs to the release assets (`https://github.com/<repository>/releases/latest/download/compose.yaml` and
   `…/env.example`), and update `apps/server/test/selfhost-docs.test.ts`, which pins those URLs. Then delete
   this step.

What the tag runs:

- `.github/workflows/desktop.yml`: tests, `pnpm audit` and the license gate, then builds, signs and smoke-tests
  macOS (arm64, x64: dmg + zip) and Windows (x64, arm64: NSIS installer + zip), and creates the GitHub Release.
  Its notes are the tag's `CHANGELOG.md` section followed by a table saying how each platform was signed. It is
  marked Latest only when no higher full release exists, and it stays a draft when Windows signing failed in CI
  (sign with `sign:win`, then publish it). Signing setup (Apple
  Developer ID and notarization, the Certum certificate for Windows, the manual `sign:win` fallback):
  [docs/desktop.md](docs/desktop.md#signing-notarization-updates). The release also gets the tag's `compose.yaml`
  and `.env.example` (as `env.example`: GitHub renames assets that start with a dot), so
  `releases/latest/download/compose.yaml` always matches the latest image.
- `.github/workflows/docker.yml`: tests, smoke-tests the amd64 and arm64 images (`scripts/docker-smoke.sh`), then
  pushes the multi-arch image to `ghcr.io/gedigi/chartmate` with provenance and SBOM attestations. `X.Y`, `X` and
  `latest` move only for the highest release in their range, so a backport never moves them backward.

After the first image is published, make the GHCR package public once (the package's **Package settings**,
**Change visibility**) and check that it is linked to this repository; until then, pulls need a login.

On every pull request and push to `main`, `.github/workflows/ci.yml` runs `pnpm audit` (any known vulnerability in
a runtime or build-time dependency fails it), typecheck, tests, an indicator scaffold check (`pnpm new:indicator`,
then typecheck and the indicator tests), the web build, e2e and a Docker build. Every workflow defaults to a
read-only token, pins each action to a commit SHA, gets pnpm through corepack (hash-checked) and installs with
`--ignore-scripts`; only `ci.yml` caches dependencies. The macOS signing secrets reach only jobs that run no
dependency code; the Certum login runs first in the Windows job, before any dependency code. Dependabot opens weekly update pull requests for npm packages, the pinned
actions, the Docker base image and the Compose Postgres image.
