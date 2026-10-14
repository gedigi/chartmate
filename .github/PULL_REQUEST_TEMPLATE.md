<!-- Thanks for contributing! See CONTRIBUTING.md. Describe Chartmate on its own terms (no other charting products). -->

## What and why

<!-- What changes, and why. Link the issue it closes, if any ("Closes #…"). -->

## Screenshots

<!-- UI or chart changes: the running app in BOTH themes. Delete this section otherwise. -->

| Dark | Light |
| --- | --- |
|  |  |

## Checklist

- [ ] Tests first: new behavior is covered, a bug fix has a regression test.
- [ ] `pnpm typecheck` and `pnpm test` pass (`pnpm e2e` too when a UI flow changes; `pnpm audit` after a dependency change).
- [ ] UI / chart changes: dark and light screenshots attached above.
- [ ] No color literals: colors come from palette slots (`lineSlots`), theme tokens or `activeIndicatorColors()`.
- [ ] Docs: the README (and CONTRIBUTING / AGENTS where relevant) reflects any change in behavior, commands, env vars or defaults.
- [ ] Commits use the conventional style (`feat(web): …`).

### New indicator

- [ ] Scaffolded with `pnpm new:indicator`, calculation tested against hand-computed values (warm-up and edge cases).
- [ ] Shown in the picker and checked in both themes, on a few symbols and timeframes.
- [ ] Ported code (if any) has a compatible license, kept headers and attribution, noted above.
