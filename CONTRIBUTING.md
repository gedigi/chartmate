# Contributing to Chartmate

Thanks for helping. Chartmate is a charting app whose core value is how it looks: a change that works but looks
worse is not done. This page covers the setup, the checks every pull request passes, and a step-by-step guide to
the most common contribution, [adding an indicator](#add-an-indicator).

[AGENTS.md](AGENTS.md) is the full guide to the code (layout, architecture boundaries, conventions, desktop
security model); read it before larger changes. The [README](README.md) is the user-facing reference.

## Setup

Requires Node 22 (`.nvmrc`) and pnpm 8.

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
| Dependency vulnerabilities (after any dependency change) | `pnpm audit` |
| End-to-end, when a UI flow changes (first time: `pnpm exec playwright install chromium`) | `pnpm e2e` (`E2E_PORT=8873 pnpm e2e` for another port) |

Write the failing test first, then the code; a bug fix comes with a regression test.

## Pull requests

- **Commits**: small and logical, conventional style with a lowercase summary of what changed:
  `feat(web): …`, `fix(server): …`, `docs: …`, `test(shared): …`, `refactor: …`, `ci: …`, `chore: …`.
- **Language**: American English in code, comments, UI strings and docs; sentence case for UI labels.
  Describe Chartmate on its own terms: do not name or compare it to other charting products.
- **Docs**: a change to behavior, a command, an env var or a default updates the README in the same pull request.
- **UI changes**: attach screenshots of the running app in **both** the dark and the light theme.
- **Dependencies**: only licenses compatible with AGPL-3.0 (MIT, BSD, ISC, Apache-2.0, MPL-2.0 and similar).

## License and sign-off

Chartmate is licensed under the [GNU AGPL-3.0-only](LICENSE). By contributing, you agree that your contribution is
licensed under the same license.

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO): a `Signed-off-by:` line certifying that you wrote the change, or otherwise have the right to submit it under
the project's license. `git commit -s` adds it from your Git name and email:

```
Signed-off-by: Your Name <you@example.com>
```

The email must match the commit's author email. CI checks every commit of a pull request
(`scripts/check-dco.sh`). Forgot it? `git rebase --signoff main` and force-push the branch.

Porting an existing indicator? Only port code whose license allows it, keep its license header and attribution,
and say so in the pull request (the Wyckoff indicator is an MPL-2.0 example).

## Add an indicator

An indicator is one file in `apps/web/src/chart/indicators/custom/`. It is registered with the chart and listed
in the indicator picker automatically; no other file needs editing. Its colors come from the app's palette, so it
matches every other indicator in both themes.

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
indicator works as is (a placeholder moving average), so `pnpm dev` shows it right away.

### 2. Write the calculation, test first

The exported `calc…` function is pure: bars in, one result per bar out, `null` while there is not enough history
(the warm-up). No chart, no DOM, no globals, no network. Replace the placeholder tests with the real formula's
expected values (a short hand-computed series, the warm-up, edge cases such as an empty list or a flat series),
then the placeholder formula. Shared helpers live in `apps/web/src/chart/indicators/calc.ts`.

Keep the module's top-level code free of side effects: the indicators are bundled eagerly, so a module that throws
while being imported stops the app from starting (a module with the wrong shape is only skipped, with a console
warning).

### 3. Fill in the template and the catalog entry

`template` is a KLineChart indicator template: `name`, `shortName`, `calcParams` (the defaults), `figures` (one
`line` figure per line, or a `bar` figure for a histogram) and `calc`. Set `usePricePrecision: true` when the values
are prices (moving averages, bands, ATR); drop it for ratios and percentages.

`catalog` is the picker and settings entry:

| Field | Meaning |
| --- | --- |
| `name`, `label` | `name` equals `template.name`; `label` is what the picker shows (sentence case). |
| `pane` | `'sub'` (own pane) or `'main'` (overlay on the candles). |
| `defaultParams`, `paramLabels` | The default params and one label per param. Params are integers in 1…1000 unless listed in `decimalParams` (decimals > 0) or bounded by `paramMin` / `paramMax`. |
| `lines` | One name per `line` figure, in figure order. |
| `lineSlots` | The palette slot (0-5) of each line, index-aligned with `lines`; default: line i uses slot i. |
| `bars` | A histogram with editable up / down colors; inferred from a `bar` figure. |
| `levels` | Default dashed reference levels of an oscillator, at most 5 (e.g. `[70, 30]`, `[0]`); `sub` only. |
| `description` | A longer explanation for the picker tooltip. |

`customIndicatorProblem` (`apps/web/src/chart/indicators/extensions.ts`) validates this shape; the generated test
runs it.

### 4. Colors: palette slots only

Never write a color. Each theme has a six-slot categorical palette (`INDICATOR_PALETTE` in
`apps/web/src/chart/theme.ts`), tuned to read on its background:

| Slot | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| Hue | amber | violet | cyan | orange | magenta | blue |

Pick each line's slot with `lineSlots`. In its own pane, start at slot 0. On the price pane the lines share the
candles with other overlays (MA uses slots 0-3, EMA and BOLL 0-2, BBI 0, VWAP 5), so the scaffold puts an overlay
on slot 4. Lines of one indicator must use distinct slots. Histograms (`bars`) use the theme's up / down colors.

An indicator that paints on the canvas itself (a template `draw` callback, like `custom/wyckoff.ts`) takes every
color from `activeIndicatorColors()` (`apps/web/src/chart/indicators/colors.ts`), **called inside the callback**,
so a theme toggle or a custom candle color repaints it correctly:

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

### 5. Check it in the app, in both themes

```sh
pnpm --filter @chartmate/web exec vitest run test/indicators/keltnerChannels.test.ts
pnpm typecheck && pnpm test
DATABASE_URL=sqlite:/tmp/chartmate-dev.db CHARTMATE_PROVIDERS=fixture pnpm dev
```

Restart `pnpm dev` after adding the file. Add the indicator from the picker (**Indicators**), open its settings,
switch the theme (sun / moon button) and look at it on a few symbols and timeframes. Attach a dark and a light
screenshot of the chart with the indicator to the pull request.

### 6. Document it

Give the indicator a `catalog.description` (the picker tooltip) when its label alone does not say how it behaves.
If users need to know more (session anchoring, timeframes it does not support, unusual params), add it to the
README's "Charts" section in the same pull request.
