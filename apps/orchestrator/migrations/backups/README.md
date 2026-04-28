# Migration backups

Pre-deploy snapshots of the D1 database, intended as rollback fixtures
for destructive migrations. Files in this directory are NOT committed
(see `.gitignore`); only this README is tracked.

## Procedure (run BEFORE deploying a destructive migration)

```bash
# Migration 0027 (GH#115 worktrees-first-class):
wrangler d1 export duraclaw-auth \
  --output=apps/orchestrator/migrations/backups/pre-0027.sql
```

The DB name is `duraclaw-auth` (binding `AUTH_DB` in `wrangler.toml`).
Account is the same account the infra pipeline deploys from
(`87bd3030c315cfdc6e9f9c04ad6f37bc`).

## Rollback

If 0027 needs to be reverted: restore the `worktree_reservations` table
from the backup, drop `worktrees`, drop `agent_sessions.worktreeId`,
re-add `agent_sessions.worktree_info_json TEXT`. Coordinate with the
on-call before doing this — the orchestrator code on `main` will be
expecting the post-migration shape.
