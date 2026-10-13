@AGENTS.md

## Claude Code notes

- `AGENTS.md` (imported above) is the single source of truth; put shared guidance there, not here.
- Worktrees: run `pnpm e2e` with a distinct `E2E_PORT` per worktree, and never use bare `git stash` (the stash
  stack is shared between worktrees).
- For UI changes, look at the running app in both themes and attach the dark and light screenshots. Start it
  on scratch data, e.g. `DATABASE_URL=sqlite:/tmp/chartmate-dev.db CHARTMATE_PROVIDERS=fixture pnpm dev`, so the
  user's `apps/server/data/chartmate.db` is never touched.
