# D1 Migrations

Drizzle-managed sequential migrations for the orchestrator's D1 database
live at `apps/orchestrator/migrations/`. Filename shape:

```
NNNN_short_snake_case.sql
```

`NNNN` is a zero-padded numeric prefix that determines apply order.

## Why prefixes collide

When two dev worktrees branch off `main` at prefix `K` and each generates
a new migration, both get `K+1`. Whichever PR merges second has a
duplicate prefix on `main`, and the migration journal becomes ambiguous.

## How collisions are detected

A pre-commit check (`scripts/check-migration-collision.sh`, wired into
`scripts/precommit.sh`) compares newly-staged migration filenames against
the canonical main worktree's filesystem.

The canonical main worktree (default `/data/projects/duraclaw`) is the
checkout the deploy pipeline runs `git pull` on. Its filesystem always
reflects what is currently shipped, so it is a zero-cost authority for
collision detection — no fetch, no hook-time network, no separate sync
daemon. See [`docs/modules/deployment.md`].

If a staged migration's prefix is already taken under a different
filename in that worktree, the commit fails with:

```
Migration prefix collision detected vs canonical main:
  /data/projects/duraclaw/apps/orchestrator/migrations
  ✗ apps/orchestrator/migrations/0034_foo.sql
      collides with 0034_bar.sql (prefix 0034)

Rename the colliding migration to the next free prefix and re-stage.
```

The fix is mechanical: rename the new migration to the next free prefix
and re-stage.

## Edge cases

- **Fresh clones / CI / non-VPS devs** — if `/data/projects/duraclaw`
  does not exist, the hook fail-opens (silent skip). Override the path
  with `DURACLAW_MAIN_MIRROR=/path/to/mirror` if your layout differs.
- **Committing inside the canonical worktree itself** — the hook detects
  self-reference via `realpath` and skips.
- **Editing an existing migration** (rare; squashes / reverts) — the
  hook only fires on `--diff-filter=A` (additions), so modifications
  pass through.

## Residual gap

Two open PRs in parallel can both pass pre-commit (each sees only
shipped main) and only collide when the second PR merges. CI on PRs
(running the same script against the PR base) closes that gap; the
pre-commit hook is the cheap local belt to a CI suspenders.
