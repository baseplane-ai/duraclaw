# apps/orchestrator/scripts

Operator-facing helpers for D1 schema management, local development, and the
issue #7 cutover (D1 + PartyKit migration).

## Day-to-day local dev

Local dev uses miniflare's local D1 (a SQLite file under
`apps/orchestrator/.wrangler/state/v3/d1/`). Migrations are not auto-applied.

```bash
# First-time setup or whenever migrations land on main:
pnpm --filter @duraclaw/orchestrator db:migrate:local

# Start the dev server:
pnpm --filter @duraclaw/orchestrator dev

# Wipe + reseed local D1 from scratch (drops everything, re-runs migrations):
pnpm --filter @duraclaw/orchestrator db:reset:local
```

## Cloning prod D1 to local

For a realistic local dataset, clone the prod D1 export into local SQLite:

```bash
pnpm --filter @duraclaw/orchestrator db:clone:remote
```

This runs `wrangler d1 export … --remote` to dump a `prod-snapshot.sql`,
resets local D1, then applies the snapshot.

**Caveat:** D1 export only contains tables that already live in D1. On the
current pre-cutover prod, `agent_sessions`, `user_tabs`, and
`user_preferences` are still owned by Durable Objects and will NOT appear
in the export. To exercise those tables locally, see the rehearsal section.

## Cutover rehearsal

Before running `cutover.sh` against prod, rehearse the entire flow against
local D1. This catches SQL escaping bugs, upsert collisions, and migration
ordering problems before they touch production.

```bash
# 1. Capture your own DO state from the deployed worker (uses authenticated
#    session cookie copied from devtools).
WORKER_URL=https://dura.baseplane.ai \
SESSION_COOKIE='<paste-cookie-value>' \
OUTPUT=./dump.json \
pnpm --filter @duraclaw/orchestrator cutover:dump-my-state

# 2. Run the rehearsal script with the dump.
pnpm --filter @duraclaw/orchestrator cutover:rehearse ./dump.json
```

The rehearsal mirrors `cutover.sh` step-for-step (wipe → migrate → export →
load → verify → 0009) but everything targets `--local` D1.

**Limitation of `dump-my-state.sh`:** it only captures the calling user's
data, because the deployed worker has no admin enumeration endpoint. A
follow-up issue will add `GET /admin/dump-do-state` to produce a multi-user
dump in one call. Until then, rehearsal coverage is single-user.

## Drizzle-kit operations

```bash
# Diff the schema in src/db/schema.ts against the latest snapshot. Emits
# a new migration if there are changes. Does NOT touch any database.
pnpm --filter @duraclaw/orchestrator db:generate

# Verify the migration journal is consistent with the snapshot.
pnpm --filter @duraclaw/orchestrator db:check

# Open the drizzle-kit studio UI against the D1 referenced by
# D1_DATABASE_ID in your .env.
pnpm --filter @duraclaw/orchestrator db:studio
```

> **Warning:** `db:studio` (and any future `db:push`) connects to the
> remote D1 referenced by `D1_DATABASE_ID` in your `.env`. If that id
> happens to be the prod id from `wrangler.toml`, you will mutate
> production. Always point `D1_DATABASE_ID` at a dev/staging database.

## Cutover (prod)

```bash
bash apps/orchestrator/scripts/cutover.sh
```

Step 0 of the script asks you to confirm you have rehearsed locally. Do
not proceed without rehearsal — `export-do-state.ts` is the riskiest
piece of the cutover and the rehearsal is the only place it gets exercised
against real-shaped data.
