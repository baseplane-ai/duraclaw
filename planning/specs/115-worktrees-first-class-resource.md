---
initiative: worktrees-first-class
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 115
created: 2026-04-27
updated: 2026-04-27
research:
  - planning/research/2026-04-27-gh115-worktrees-first-class.md
  - planning/research/2026-04-27-gh115-interview-summary.md
related:
  - planning/specs/16-chain-ux-p1-5.md            # P3 U3 force-release on stale=24h
  - planning/specs/37-session-state-collapse.md   # P1b worktreeInfoJson placeholder (dropped here)
phases:
  - id: p1
    name: "Schema + migration 0027 (worktrees table, agent_sessions.worktreeId FK, drop worktreeInfoJson)"
    tasks:
      - "Pre-flight: take a D1 backup with `wrangler d1 export <db-name> --output=apps/orchestrator/migrations/backups/pre-0027.sql` BEFORE running the migration. This is the rollback fixture."
      - "Pre-clean stale rows: DELETE FROM worktreeReservations WHERE stale = 1"
      - "RENAME worktreeReservations -> worktrees; ALTER TABLE worktrees ADD id TEXT, path TEXT, branch TEXT, status TEXT NOT NULL DEFAULT 'held', reservedBy TEXT NOT NULL, released_at INTEGER, createdAt INTEGER NOT NULL, lastTouchedAt INTEGER NOT NULL"
      - "Backfill: id = lower(hex(randomblob(8))); path = '/data/projects/' || worktree; reservedBy = json_object('kind','arc','id', issueNumber); createdAt = strftime('%s', heldSince)*1000; lastTouchedAt = strftime('%s', lastActivityAt)*1000"
      - "Drop legacy columns from worktrees: ALTER TABLE worktrees DROP COLUMN worktree, ownerId, heldSince, lastActivityAt, modeAtCheckout, stale, issueNumber (after backfill)"
      - "Recreate primary key + indexes: PRIMARY KEY (id); UNIQUE INDEX idx_worktrees_path; INDEX idx_worktrees_reservedBy ON worktrees(json_extract(reservedBy, '$.kind'), json_extract(reservedBy, '$.id'))"
      - "ALTER TABLE agent_sessions ADD worktreeId TEXT REFERENCES worktrees(id)"
      - "Backfill agent_sessions.worktreeId by joining on (kataIssue, project): UPDATE agent_sessions SET worktreeId = (SELECT id FROM worktrees WHERE json_extract(reservedBy,'$.id') = agent_sessions.kataIssue AND path = '/data/projects/' || agent_sessions.project)"
      - "ALTER TABLE agent_sessions DROP COLUMN worktreeInfoJson (dead since migration 0016, never read or written)"
      - "Update apps/orchestrator/src/db/schema.ts: replace worktreeReservations definition (220-236) with worktrees; add worktreeId column on agentSessions (127-184); remove worktreeInfoJson"
      - "**Hand-write the migration file** at apps/orchestrator/migrations/0027_worktrees_first_class.sql using the literal SQL sequence in B-MIGRATION-1 (steps 1-9). Drizzle's auto-generator does NOT produce the rebuild pattern, the backfill JOINs, or the pre-clean DELETE — running `drizzle:generate` for this migration would produce a naive ALTER-only migration that fails on SQLite (cannot ADD PRIMARY KEY via ALTER). Update schema.ts to match the post-migration shape so subsequent `drizzle:generate` invocations stay in sync, but do NOT regenerate this specific 0027 file."
    test_cases:
      - "drizzle migration applies cleanly on a copy of prod D1 (or local dev D1) with no errors"
      - "post-migrate: SELECT count(*) FROM worktrees > 0 (assuming prior reservations existed); SELECT count(*) FROM worktrees WHERE id IS NULL = 0"
      - "post-migrate: every agent_sessions row with kataIssue IS NOT NULL has a non-null worktreeId OR a documented reason (orphan / pre-stale)"
      - "PRAGMA table_info(agent_sessions) does NOT include worktree_info_json"
      - "pnpm --filter @duraclaw/orchestrator typecheck passes after schema change"
  - id: p2
    name: "Orchestrator API (POST/GET/release/DELETE /api/worktrees, POST /api/sessions worktree param)"
    tasks:
      - "Add Hono routes in apps/orchestrator/src/api/index.ts: POST /api/worktrees (reserve), GET /api/worktrees (list), POST /api/worktrees/:id/release (mark released_at), DELETE /api/worktrees/:id (hard delete)"
      - "Define request/response types in shared module (apps/orchestrator/src/api/worktrees-types.ts new): `WorktreeRequest = {kind: 'fresh', reservedBy: ReservedBy}` (fresh-pick from pool, derives reservedBy per B-API-5 if called via /api/sessions); `ReservedBy = {kind: 'arc'|'session'|'manual', id: string|number}`; `WorktreeRow = {id, path, branch, status, reservedBy, ownerId, released_at?, createdAt, lastTouchedAt}`. Note: `kind:'register'` is NOT part of v1 — registration of pre-existing clones happens via the gateway sweep (B-DISCOVERY-1), not via the user-facing API."
      - "Implement reserve handler: pool-pick from WHERE status='free' ORDER BY lastTouchedAt LIMIT 1 FOR UPDATE (D1 lacks SELECT FOR UPDATE; use UPDATE ... WHERE status='free' ... RETURNING via single transaction); on success transition row to status='held' with reservedBy + ownerId + lastTouchedAt; on empty pool return 503 {error:'pool_exhausted', freeCount, totalCount, hint:'Run scripts/setup-clone.sh on the VPS'}"
      - "Implement same-reservedBy idempotent re-acquire: if POST /api/worktrees finds an existing row WHERE json_extract(reservedBy,'$.kind') = req.kind AND json_extract(reservedBy,'$.id') = req.id, return that row 200 instead of allocating a new one"
      - "Implement cross-reservation conflict: if requested path is already held by a different reservedBy, return 409 {error:'conflict', existing: {reservedBy, status}}"
      - "Implement release handler: UPDATE worktrees SET released_at = unixepoch()*1000, status='cleanup' WHERE id = ?"
      - "Implement DELETE handler: hard-delete row (admin only — gate via existing session-cookie role check)"
      - "Extend POST /api/sessions body shape in apps/orchestrator/src/api/index.ts:63-77: add worktree?: { kind: 'fresh' } | { id: string }; in lib/create-session.ts: 27-42 thread through; if provided, call internal reserveWorktree() before D1 INSERT; persist agent_sessions.worktreeId with the reserved id"
      - "Update CreateSessionParams type at lib/create-session.ts:27-42 to include worktree?: WorktreeRequest"
      - "Update SessionDO spawn config at agents/session-do/rpc-lifecycle.ts:82: project_path = (caller-supplied worktree.path) ?? config.project (falls back to today's behavior for callers without worktreeId)"
      - "Update GatewayCommand in packages/shared-types/src/index.ts: ExecuteCommand and ResumeCommand gain optional worktree_path field (already-resolved absolute path the runner uses verbatim)"
      - "Update runner-link.ts:300-304 to populate worktree_path from SessionDO state when present"
    test_cases:
      - "curl -X POST /api/worktrees -d '{\"kind\":\"fresh\",\"reservedBy\":{\"kind\":\"session\",\"id\":\"sess-X\"}}' returns 200 with {id, path, branch, status:'held'}"
      - "second identical POST returns SAME id (idempotent)"
      - "POST with reservedBy of different kind targeting the same path returns 409 with existing.reservedBy"
      - "POST against an empty pool returns 503 with pool_exhausted + freeCount:0"
      - "POST /api/sessions {worktree: {kind:'fresh'}} creates a session with worktreeId set; SELECT worktreeId FROM agent_sessions confirms"
      - "POST /api/worktrees/:id/release returns 200; SELECT released_at FROM worktrees WHERE id = ? IS NOT NULL"
      - "DELETE /api/worktrees/:id (admin) returns 200; SELECT count(*) FROM worktrees WHERE id = ? = 0"
  - id: p3
    name: "Gateway auto-discovery sweep (classify clones; honor .duraclaw/reservation.json)"
    tasks:
      - "Add packages/agent-gateway/src/worktree-sweep.ts (new): scan /data/projects/<name>; for each, run git -C <path> rev-parse --abbrev-ref HEAD to read branch; check for <path>/.duraclaw/reservation.json"
      - "Sweep classification: branch == default_branch (main/master/<configurable>) AND no reservation.json -> status='free', reservedBy=null. branch != default AND no reservation.json -> status='held', reservedBy={kind:'manual', id:<branchName>}. reservation.json present -> status='held', reservedBy=<file contents>"
      - "Sweep frequency: every 60s via setInterval; also on-demand at the head of POST /sessions/start (lazy upsert) so a brand-new clone appears in the registry on first use"
      - "RPC to orchestrator: gateway POSTs /api/gateway/worktrees/upsert with {path, branch, reservedBy} per discovered clone. Orchestrator INSERTs new rows or UPDATEs branch + lastTouchedAt for existing path"
      - "Add bearer auth on /api/gateway/worktrees/upsert via existing CC_GATEWAY_SECRET (mirror reaper RPC pattern from packages/agent-gateway/src/reaper.ts:208-238)"
      - "Add scripts/setup-clone.sh enhancement: optional --reserve-for=arc:<id>|session:<id>|manual:<id> flag writes the .duraclaw/reservation.json at clone time (not required; sweep falls back to branch heuristic)"
      - "Default-branch detection: read git -C <path> symbolic-ref refs/remotes/origin/HEAD (returns refs/remotes/origin/main or master); fall back to env CC_DEFAULT_BRANCH or 'main'"
    test_cases:
      - "gateway sweep on a fresh clone on main with no reservation.json: registry row created with status='free'"
      - "gateway sweep on a clone on a feature branch with no reservation.json: registry row with status='held', reservedBy.kind='manual'"
      - "gateway sweep on a clone with .duraclaw/reservation.json={kind:'arc', id:115}: registry row reservedBy={kind:'arc', id:115}"
      - "rm a clone directory and run sweep: registry row remains (deletion is operator-driven; sweep does NOT auto-prune missing clones — just stops touching them)"
      - "manual `bash scripts/setup-clone.sh --reserve-for=arc:200` on the VPS produces a clone whose first sweep registers it as arc:200"
  - id: p4
    name: "auto-advance + checkout-worktree refactor (worktreeId-keyed; chain successor inheritance)"
    tasks:
      - "Refactor apps/orchestrator/src/lib/checkout-worktree.ts:44-114: function signature becomes checkoutWorktree(db, {worktreeId, mode}, userId). Drop issueNumber + worktree (project) parameters. Idempotency check uses worktreeId. Return shape unchanged"
      - "Update apps/orchestrator/src/lib/auto-advance.ts:181-201: instead of {issueNumber: kataIssue, worktree: project}, compute worktreeId by SELECT worktreeId FROM agent_sessions WHERE id = predecessor.id; pass to checkoutWorktree"
      - "Update apps/orchestrator/src/lib/auto-advance.ts:213-233 (spawn successor): pass worktreeId from predecessor as createSession param so the successor row inherits the same FK"
      - "Update apps/orchestrator/src/lib/chains.ts:337-354: chain aggregation no longer JOINs worktreeReservations on issueNumber; resolves worktree via agent_sessions.worktreeId -> worktrees"
      - "Update apps/orchestrator/src/agents/session-do/mode-transition.ts:42-46 + 264: continue to read kataIssue for chain identity; do NOT use it as worktree key"
      - "Update apps/orchestrator/src/agents/session-do/status.ts:199-215 (reservation activity refresh): UPDATE worktrees SET lastTouchedAt = unixepoch()*1000 WHERE id = (SELECT worktreeId FROM agent_sessions WHERE id = ?)"
      - "Remove deprecated /api/chains/:issue/checkout endpoint at apps/orchestrator/src/api/index.ts:2814-2848 OR thin-wrap it: resolve issue->worktreeId then delegate to POST /api/worktrees. Recommend remove (callers in this repo are limited to auto-advance internals)"
    test_cases:
      - "vitest covers checkoutWorktree(worktreeId) idempotent re-call returns same row"
      - "auto-advance test: predecessor with worktreeId=W1 advancing to next mode produces a successor row with worktreeId=W1 (inherited)"
      - "chain aggregation: GET /api/chains/:issue returns the chain rows with their shared worktreeId visible"
      - "no orchestrator file references worktreeReservations.issueNumber as a worktree key (grep -nE 'worktreeReservations\\.issueNumber'); chain identity uses agent_sessions.kataIssue exclusively"
      - "**integration regression**: a pre-existing arc-bound chain (kataIssue=N, worktreeReservations row migrated to worktrees with reservedBy={kind:'arc',id:N}, two completed predecessor sessions, one in-flight successor) successfully completes its mode transition post-refactor. Verifies the migration didn't break in-flight chains. Run via scripts/verify/gh115-vp-chain-inherit.sh on a D1 fixture seeded with pre-migration state."
  - id: p5
    name: "forkWithHistory worktreeId override"
    tasks:
      - "Update apps/orchestrator/src/agents/session-do/branches.ts:239-307 (forkWithHistoryImpl): add optional worktreeId?: string parameter. If passed, set on the forked SessionMeta + propagate to triggerGatewayDial; else inherit ctx.state.worktreeId (session-meta level — not ctx.state.project)"
      - "Update apps/orchestrator/src/agents/session-do/rpc-messages.ts:137-171 (orphan auto-fork): pass current session's worktreeId so the auto-recovery fork stays on the same clone"
      - "Update apps/orchestrator/src/api/index.ts (fork endpoint near 2649-2717): accept optional worktreeId in body; thread through to RPC"
      - "Persist worktreeId on the forked agent_sessions row at fork time so D1 stays in sync (today: forkWithHistory drops kataIssue and runner_session_id; the new worktreeId persistence is added)"
    test_cases:
      - "forkWithHistory without worktreeId param: child has worktreeId == parent.worktreeId"
      - "forkWithHistory with explicit worktreeId of a free clone: child has the new worktreeId; sessions row reflects it"
      - "forkWithHistory with worktreeId of a clone reserved by a different kind/id: 409 from underlying reservation check (re-validates exclusivity for kind='session' targets)"
  - id: p6
    name: "kata CLI auto-reserve for code-touching modes"
    tasks:
      - "Add packages/kata/src/lib/reserve-worktree.ts (new): reserveWorktreeIfNeeded(orchestratorBaseUrl, sessionId, mode, kataIssue?). If mode is in CODE_TOUCHING_MODES (debug, implementation, verify, task) AND no existing reservation for this session, POST /api/worktrees with kind='fresh', reservedBy = kataIssue ? {kind:'arc', id:kataIssue} : {kind:'session', id:sessionId}. Returns the WorktreeRow. Handles 503 pool_exhausted by writing the operator hint to stderr and process.exit(1)"
      - "Wire into packages/kata/src/commands/enter.ts after mode validation, before session-creation API call. Pass returned worktree.id as createSession param worktree: { id }"
      - "Read-only modes (research, planning, freeform) skip reservation entirely — return null fast"
      - "Surface the chosen clone path in the kata enter stdout: `[kata] Reserved worktree: /data/projects/duraclaw-dev2 (branch: main)`"
      - "Add same-arc idempotency: if a previous session in the same chain already reserved (lookup by kataIssue), reuse — POST /api/worktrees with same reservedBy returns existing row (P2 idempotency contract)"
    test_cases:
      - "`kata enter debug` (no --issue) on a worktree with a free pool: prints reserved path; agent_sessions row has worktreeId set; reservedBy.kind='session'"
      - "`kata enter implementation --issue=200` with existing arc reservation: reuses same worktreeId (idempotent)"
      - "`kata enter freeform`: no reservation; agent_sessions row has worktreeId=NULL"
      - "`kata enter debug` on an exhausted pool: stderr operator-hint message; exit code 1; no D1 session row created"
  - id: p7
    name: "Janitor (DO alarm primary; worker cron fallback; manual sweep endpoint)"
    tasks:
      - "On session close (SessionDO terminal status transition): if worktreeId is set, RPC orchestrator: UPDATE worktrees SET released_at = now(), status = 'cleanup' WHERE id = ? — but ONLY if no other agent_sessions row with same worktreeId is in non-terminal status (last-session check)"
      - "Schedule DO alarm for session-bound reservations: in SessionDO at close, ctx.storage.setAlarm(now + idle_window) where idle_window defaults to 24h (configurable via env CC_WORKTREE_IDLE_WINDOW_SECS)"
      - "alarm() handler: re-fetch released_at; if NULL (re-attached), no-op; else DELETE FROM worktrees WHERE id = ? AND released_at < now() - idle_window"
      - "Worker cron in apps/orchestrator/wrangler.toml: schedule = ['0 * * * *'] (hourly); handler in apps/orchestrator/src/cron.ts (new): DELETE FROM worktrees WHERE released_at IS NOT NULL AND released_at < strftime('%s','now')*1000 - idle_window_ms RETURNING id; broadcast collection delta for each deleted row"
      - "Re-attach behavior: in lib/create-session.ts and POST /api/worktrees handler, when reserving against an existing released row of the same reservedBy: SET released_at = NULL, status = 'held' (revive); the alarm/cron then no-ops on next fire"
      - "Add admin endpoint POST /api/admin/worktrees/sweep (cookie + role=admin gate): runs the same DELETE logic synchronously and returns {deletedCount}"
      - "Authorization for re-attach: only the SAME reservedBy.kind + reservedBy.id can revive a released row; another caller seeing a released row is treated as if free for fresh-pick (i.e. it gets allocated to whoever asks first)"
    test_cases:
      - "session close (status -> 'completed'): worktrees.released_at is set within 1s"
      - "wait idle_window (use small idle_window in test, e.g. 5s): cron sweep deletes the row"
      - "re-attach within idle_window: POST /api/worktrees same reservedBy clears released_at; row survives next cron tick"
      - "POST /api/admin/worktrees/sweep returns deletedCount; D1 SELECT confirms"
      - "alarm-driven path: SessionDO alarm fires post idle_window with no re-attach -> row deleted"
  - id: p8
    name: "Verification + dogfood (kata debug, chain advance, fork, pool exhaust)"
    tasks:
      - "Write scripts/verify/gh115-vp-debug-no-issue.sh: kata enter debug (no --issue) on a worktree with a free clone in pool; assert stdout shows reserved path; assert SELECT worktreeId FROM agent_sessions WHERE id = $sid IS NOT NULL"
      - "Write scripts/verify/gh115-vp-chain-inherit.sh: kata enter implementation --issue=N on a fresh chain; advance to verify; assert both sessions share the same worktreeId via SELECT worktreeId FROM agent_sessions WHERE kataIssue = N"
      - "Write scripts/verify/gh115-vp-fork-override.sh: forkWithHistory with explicit worktreeId; assert child agent_sessions row has the new id; assert parent's worktreeId unchanged"
      - "Write scripts/verify/gh115-vp-pool-exhaust.sh: reserve every clone in pool; attempt new POST /api/worktrees {kind:'fresh'}; assert 503 + pool_exhausted body"
      - "Write scripts/verify/gh115-vp-discovery.sh: create a new clone via setup-clone.sh; trigger sweep; assert the new clone appears in GET /api/worktrees within 60s"
      - "Write scripts/verify/gh115-vp-janitor.sh: reserve, release, fast-forward time (or set short idle_window), trigger cron, assert row deleted"
      - "Write scripts/verify/gh115-vp-migration.sh: take a wrangler d1 export of pre-migration state; apply 0027 to a local sqlite copy; assert post-state matches B-MIGRATION-1 verification queries (no NULL ids, worktreeId backfill ratio, dropped worktreeInfoJson)"
      - "Write scripts/verify/gh115-ship-gate.sh: e2e — kata enter debug succeeds from cold start (with at least one free clone in pool) and the session's runner runs in the reserved clone path"
    test_cases:
      - "all gh115-vp-*.sh scripts pass on the dev VPS with a clone pool of size >= 2"
      - "scripts/verify/gh115-ship-gate.sh exit code 0 — THIS IS THE v1 RELEASE GATE"
verification_plan:
  - id: vp-debug-no-issue
    script: scripts/verify/gh115-vp-debug-no-issue.sh
    description: "kata enter debug without --issue reserves a fresh clone end-to-end; agent_sessions.worktreeId is populated"
  - id: vp-chain-inherit
    script: scripts/verify/gh115-vp-chain-inherit.sh
    description: "Chain auto-advance preserves the same worktreeId across mode transitions"
  - id: vp-fork-override
    script: scripts/verify/gh115-vp-fork-override.sh
    description: "forkWithHistory with explicit worktreeId places the child on a different clone than its parent"
  - id: vp-pool-exhaust
    script: scripts/verify/gh115-vp-pool-exhaust.sh
    description: "Empty pool returns 503 pool_exhausted with operator hint"
  - id: vp-discovery
    script: scripts/verify/gh115-vp-discovery.sh
    description: "New clone created on the VPS appears in the registry within 60s sweep cycle"
  - id: vp-janitor
    script: scripts/verify/gh115-vp-janitor.sh
    description: "Released reservation is hard-deleted by the janitor after idle_window expires; re-attach within window survives"
  - id: vp-migration
    script: scripts/verify/gh115-vp-migration.sh
    description: "Migration 0027 applies on a snapshot of pre-migration D1; post-state has worktrees populated, agent_sessions.worktreeId backfilled, worktreeInfoJson dropped"
  - id: vp-ship-gate
    script: scripts/verify/gh115-ship-gate.sh
    description: "Release gate — kata enter debug from cold start spawns a runner in the reserved clone with no manual setup beyond an existing free clone in the pool"
---

# Worktrees as First-Class Reservable Resource

> **Vocabulary correction (interview headline).** In duraclaw, "worktree"
> means a **full clone** under `/data/projects/<name>` — bootstrapped
> by an operator via `scripts/setup-clone.sh`, NOT a `git worktree`
> sub-tree. Duraclaw runs zero git operations across the entire
> session-spawn pipeline. This spec is a **registry over pre-existing
> clones**, decoupling reservation from `kataIssue` so debug, freeform,
> side-arc, and arc-bound sessions all share one primitive.
>
> Cross-references: research findings at
> `planning/research/2026-04-27-gh115-worktrees-first-class.md`
> (current-state map, every claim file:line-cited, full `kataIssue`
> usage map). Locked decisions at
> `planning/research/2026-04-27-gh115-interview-summary.md` (groups A-I,
> five architectural bets, six open risks).

## Overview

`worktreeReservations` (migration 0009) is reshaped into `worktrees`
with a surrogate id, an explicit `path`, and a json `reservedBy`
descriptor. `agent_sessions.worktreeId` becomes the FK that 25+ code
sites currently bridge through `kataIssue`. The orchestrator gains
`POST /api/worktrees`, `GET /api/worktrees`, `POST /api/worktrees/:id/release`,
`DELETE /api/worktrees/:id`. The gateway auto-discovers clones under
`/data/projects/`, classifies them by HEAD branch, and lets setup
ceremony override via `.duraclaw/reservation.json`. Kata's
code-touching modes auto-reserve from the pool; read-only modes skip.
A janitor (DO alarm primary, worker cron fallback) hard-deletes
released reservations after a 24h grace.

## Goals

- A `worktrees` table with surrogate `id`, `path`, `branch`, `status`, `reservedBy: json`, `released_at`, timestamps. Migration 0027 reshapes the existing `worktreeReservations` table; no net-new state-machine layer.
- `agent_sessions.worktreeId` FK as the **only** load-bearing worktree key. `kataIssue` stays as chain identity, untouched.
- HTTP API on the orchestrator: `POST` / `GET` / `POST :id/release` / `DELETE :id` `/api/worktrees`, plus `POST /api/sessions { worktree?: ... }`.
- Standalone-session path: `POST /sessions { worktree: { kind: 'fresh' } }` reserves a clone, no arc/issue required (issue acceptance criterion).
- Janitor pass reclaims `cleanup`-status worktrees after a configurable idle window (default 24h).
- `kata enter debug` (no `--issue`) opens a session with its own clone (issue acceptance criterion).
- Gateway auto-discovers `/data/projects/*` clones; classifies by branch; honors `.duraclaw/reservation.json` setup-ceremony override.

## Non-Goals

- **No `git worktree add` / `git worktree remove`.** The orchestrator and gateway run zero git mutating commands. Branch creation and clone bootstrap are operator gestures (`scripts/setup-clone.sh`). Honors issue's stated non-goal "Changing the gateway's filesystem layout."
- **No clone auto-creation.** Pool exhaustion returns 503 with an operator hint; nobody auto-runs `setup-clone.sh`. (interview I3)
- **No worktree pooling / pre-warming.** v1 reserves on demand from the existing pool. (issue Non-goal)
- **No "no-fs / read-only-session" mode.** Read-only kata modes (research, planning, freeform) skip reservation entirely — they don't get a worktree, they just run in whatever cwd. Code-touching modes always reserve. (interview I4)
- **No UI changes.** Per-session badges, kanban swim lanes, sidebar grouping for worktree state are deferred to a follow-up issue. (interview I2)
- **No `kata link` -> D1 sync fix.** Pre-existing drift bug (`packages/kata/src/commands/link.ts:190` doesn't RPC orchestrator); separate issue. (interview I1)
- **No name-specified reservation in v1.** `POST /api/worktrees { kind: 'fresh' }` only; caller does not pick the clone. v2 may add `POST /api/worktrees { name: 'duraclaw-dev2' }` if a need surfaces.

## Feature Behaviors

### B-SCHEMA-1: `worktrees` table replaces `worktreeReservations`

**Core:**
- **ID:** worktrees-table-reshape
- **Trigger:** Drizzle migration 0027 runs.
- **Expected:** `worktreeReservations` is reshaped into `worktrees` with the following columns:
  - `id TEXT PRIMARY KEY` — surrogate id (8-byte hex)
  - `path TEXT NOT NULL UNIQUE` — absolute clone path
  - `branch TEXT NULL` — observed HEAD branch (informational; populated by sweep)
  - `status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('free','held','active','cleanup'))` — see B-LIFECYCLE-1; `'active'` is in the CHECK for forward-compat but unused in v1
  - `reservedBy TEXT NULL` — json blob `{kind, id}`; NULL only when `status='free'`
  - `ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` — preserved from `worktreeReservations`. Records who owns the reservation; required for arc-bound and session-bound rows. The gateway sweep populates `ownerId` from `.duraclaw/reservation.json` if a `userId` field is present, else from a configured fallback (env `CC_DEFAULT_DISCOVERY_OWNER_USER_ID` — typically the deployment admin's userId). Discovery cannot infer arbitrary user identity, so default-branch (free) clones discovered out-of-band carry the fallback ownerId.
  - `released_at INTEGER NULL` — unix-ms when the row entered grace; NULL except when `status='cleanup'`
  - `createdAt INTEGER NOT NULL` — unix-ms
  - `lastTouchedAt INTEGER NOT NULL` — unix-ms
  Legacy columns (`worktree`, `heldSince`, `lastActivityAt`, `modeAtCheckout`, `stale`, `issueNumber`) are dropped via the rebuild pattern.
- **Verify:** `PRAGMA table_info(worktrees)` returns the new columns; legacy columns absent. Indexes: `path` is UNIQUE via column constraint; `idx_worktrees_reservedBy` on `(json_extract(reservedBy, '$.kind'), json_extract(reservedBy, '$.id'))`.
- **Source:** `apps/orchestrator/src/db/schema.ts:220-236` (replaces `worktreeReservations` definition); new migration `apps/orchestrator/migrations/0027_worktrees_first_class.sql`.

**Data Layer:**
- D1 reshape — see migration tasks in P1 for the literal SQL sequence.

### B-SCHEMA-2: `agent_sessions.worktreeId` FK column

**Core:**
- **ID:** agent-sessions-worktree-id-fk
- **Trigger:** Migration 0027.
- **Expected:** `agent_sessions` gains `worktreeId TEXT NULL REFERENCES worktrees(id)`. Backfill populates rows where `kataIssue IS NOT NULL` by joining on `(kataIssue, project)`. Sessions with `kataIssue IS NULL` get `worktreeId = NULL` — they auto-reserve next time they enter a code-touching kata mode (B-KATA-1).
- **Verify:** `PRAGMA table_info(agent_sessions)` lists `worktreeId`. Post-migrate query: every row with non-null `kataIssue` has a non-null `worktreeId` UNLESS the corresponding pre-migrate `worktreeReservations` row was stale=1 (pre-cleaned by P1).
- **Source:** `apps/orchestrator/src/db/schema.ts:127-184` (add column to `agentSessions`).

### B-SCHEMA-3: Drop dead `worktreeInfoJson` column

**Core:**
- **ID:** drop-worktree-info-json
- **Trigger:** Migration 0027.
- **Expected:** `agent_sessions.worktreeInfoJson` (added by migration 0016, never read or written) is dropped. The shim `syncWorktreeInfoToD1` at `apps/orchestrator/src/agents/session-do/status.ts:219-238` is removed.
- **Verify:** `PRAGMA table_info(agent_sessions)` no longer shows `worktree_info_json`. `grep -rn worktreeInfoJson apps/orchestrator/src` returns zero hits.
- **Source:** `apps/orchestrator/src/db/schema.ts:170` (remove column); `apps/orchestrator/src/agents/session-do/status.ts:219-238` (delete shim); `apps/orchestrator/src/agents/session-do/index.ts:321-325` (delete private `syncWorktreeInfoToD1` method on SessionDO).

### B-DISCOVERY-1: Gateway sweeps `/data/projects/*` and upserts the registry

**Core:**
- **ID:** gateway-worktree-sweep
- **Trigger:** Every 60s (configurable via `CC_WORKTREE_SWEEP_INTERVAL_MS`); also lazily on the head of `POST /sessions/start` so a brand-new clone appears in the registry on first use.
- **Expected:** Gateway scans `/data/projects/<name>` directories; for each, runs `git -C <path> rev-parse --abbrev-ref HEAD` to read branch and checks for `<path>/.duraclaw/reservation.json`. Posts `{path, branch, reservedBy?}` per clone to orchestrator endpoint `POST /api/gateway/worktrees/upsert` (bearer-auth via `CC_GATEWAY_SECRET`).
- **Verify:** Manually `git clone` a new repo under `/data/projects/foo`; within 60s `GET /api/worktrees` returns a row with `path='/data/projects/foo'`.
- **Source:** New file `packages/agent-gateway/src/worktree-sweep.ts`. Bearer pattern mirrors `packages/agent-gateway/src/reaper.ts:208-238`.

**API Layer:**
- New orchestrator endpoint `POST /api/gateway/worktrees/upsert` — **batch endpoint**: accepts an array of clones in one call to amortize sweep round-trip costs.
  ```
  POST /api/gateway/worktrees/upsert
    headers: Authorization: Bearer <CC_GATEWAY_SECRET>
    body: { clones: Array<{path: string, branch: string, reservedBy?: ReservedBy, reservationOwnerUserId?: string}> }
    200: { upserted: Array<{path, action: 'inserted'|'updated'|'unchanged'}>, errors: Array<{path, error}> }
    401: bearer mismatch
    400: malformed body (request shape doesn't validate); the gateway should log and continue — does NOT halt sweep
  ```
- **`ownerId` resolution** for INSERT: the orchestrator handler resolves the row's `ownerId` in this order:
  1. If the request payload includes `reservationOwnerUserId` (gateway extracted it from `.duraclaw/reservation.json`'s `userId` field, when present), use it.
  2. Else, use the env fallback `CC_DEFAULT_DISCOVERY_OWNER_USER_ID` (the deployment admin's userId; required environment variable enforced at orchestrator startup).
  3. The handler validates the resolved id exists in the `users` table (FK constraint will catch this anyway, but explicit validation produces a clean 400 error in the per-clone `errors[]`).
- Per-clone semantics: idempotent INSERT-OR-UPDATE keyed by `path` (the UNIQUE constraint). On INSERT, sets `status` per B-DISCOVERY-2 classification (default branch -> 'free' + reservedBy NULL; feature branch -> 'held' with `reservedBy={kind:'manual', id:branch}`); reservation file (B-DISCOVERY-3) overrides. `ownerId` is set per the resolution above. On UPDATE, refreshes `branch` and `lastTouchedAt` only — does NOT re-classify `reservedBy` or `status` (operator overrides during runtime stay sticky; the next ceremony or admin action explicitly transitions them). `ownerId` is NOT updated on UPDATE — once set, the row's owner is sticky until explicit `DELETE` + re-INSERT. Per-clone errors (malformed reservedBy json, missing user reference, etc.) are reported in `errors[]` but do NOT fail the whole batch.

### B-DISCOVERY-2: Branch heuristic classifies `reservedBy` and `status`

**Core:**
- **ID:** discovery-branch-heuristic
- **Trigger:** Sweep upsert (B-DISCOVERY-1) on a clone with no `.duraclaw/reservation.json`.
- **Expected:**
  - HEAD == default branch (resolved via `git symbolic-ref refs/remotes/origin/HEAD` or env `CC_DEFAULT_BRANCH`, default `main`) -> `status='free'`, `reservedBy=NULL`.
  - HEAD != default -> `status='held'`, `reservedBy = {"kind":"manual","id":"<branchName>"}`.
- **Verify:** `git -C /data/projects/foo checkout main` -> sweep -> row.status='free'. `git checkout -b feat/bar` -> sweep -> row.status='held', reservedBy.kind='manual', reservedBy.id='feat/bar'.
- **Source:** `packages/agent-gateway/src/worktree-sweep.ts` (new).

### B-DISCOVERY-2b: Missing-clone error handling (sweep robustness)

**Core:**
- **ID:** discovery-missing-clone-graceful
- **Trigger:** Sweep runs `git -C <path> rev-parse --abbrev-ref HEAD` and the path no longer exists on disk (operator `rm -rf`'d the clone) or the path lacks a `.git` directory.
- **Expected:** The sweep skips that path with a structured warning log (`level=warn, event=worktree_sweep_skip, path, reason='missing_or_invalid'`) and continues processing other clones. The corresponding `worktrees` registry row is NOT touched on this sweep — its `lastTouchedAt` ages naturally, marking it as "stale-but-not-deleted." **Cleanup of orphaned registry rows (clone deleted out from under the registry) is operator-driven via `DELETE /api/worktrees/:id`** in v1; the janitor (B-JANITOR-1/2) deliberately does NOT auto-prune missing-clone rows because the orphan signal (failed `git -C`) is per-sweep and could falsely trigger from transient mount issues.
- **Verify:** `rm -rf /data/projects/foo` -> next sweep emits the warning log -> `GET /api/worktrees` still includes the row with stale `lastTouchedAt`. Operator-initiated `DELETE /api/worktrees/:id` clears it.
- **Source:** `packages/agent-gateway/src/worktree-sweep.ts` (new).

### B-DISCOVERY-3: `.duraclaw/reservation.json` ceremony override

**Core:**
- **ID:** discovery-reservation-file-override
- **Trigger:** Sweep upsert (B-DISCOVERY-1) on a clone where `<path>/.duraclaw/reservation.json` exists.
- **Expected:** File contents (a `reservedBy` json: `{kind:'arc'|'session'|'manual', id:string|number}`) override the branch heuristic. The orchestrator stores the file's `reservedBy` verbatim and sets `status='held'`.
- **Verify:** `echo '{"kind":"arc","id":115}' > /data/projects/foo/.duraclaw/reservation.json` -> sweep -> row reservedBy={kind:'arc', id:115}.
- **Source:** `packages/agent-gateway/src/worktree-sweep.ts` (new); `scripts/setup-clone.sh` gains optional `--reserve-for=<kind>:<id>` flag that writes this file at clone time (P3 task).

### B-API-1: `POST /api/worktrees` allocates a fresh clone (pool-pick)

**Core:**
- **ID:** api-worktrees-reserve-fresh
- **Trigger:** Caller (kata, UI, or `POST /api/sessions`) issues `POST /api/worktrees {kind:'fresh', reservedBy: {kind, id}}`.
- **Expected:** Within a single transaction, atomically transitions an eligible row into `status='held'` with the requested `reservedBy`. **Eligibility ordering (explicit, not LRU-mixed):** prefer `status='free'` rows (sorted by lowest `lastTouchedAt` for stability); if none, fall back to `status='cleanup' AND released_at IS NOT NULL` rows (B-LIFECYCLE-4 — orphaned releases recyclable as fresh, again ordered by lowest `lastTouchedAt`). Free rows are picked first because they have no implicit owner; cleanup rows are second-class until their grace window expires. Returns 200 `{id, path, branch, status:'held', reservedBy, ...}`. Same-`reservedBy` re-acquire is idempotent (B-CONCURRENCY-3).
- **Verify:** Two clones in pool, both `status='free'`. POST returns 200 with `path` of one; second POST with same reservedBy returns the SAME id.
- **Source:** New handler in `apps/orchestrator/src/api/index.ts`.

**API Layer:**
```
POST /api/worktrees
  body: { kind: 'fresh', reservedBy: { kind: 'arc'|'session'|'manual', id: string|number } }
  200: { id, path, branch, status, reservedBy, released_at: null, createdAt, lastTouchedAt }
  409: { error: 'conflict', existing: {reservedBy, status} }   // see B-CONCURRENCY-1
  503: { error: 'pool_exhausted', freeCount: 0, totalCount: N, hint: '...' }   // see B-API-5
```

### B-API-2: `GET /api/worktrees` lists registry (filterable)

**Core:**
- **ID:** api-worktrees-list
- **Trigger:** `GET /api/worktrees?status=&kind=&id=`.
- **Expected:** Returns array of `WorktreeRow`. Filters compose: `?status=free` returns free pool; `?kind=arc&id=115` returns arc-115's reservation if any.
- **Verify:** With three rows (one free, one arc:115, one session:abc), `GET /api/worktrees?status=free` returns the first only.
- **Source:** New handler in `apps/orchestrator/src/api/index.ts`.

### B-API-3: `POST /api/worktrees/:id/release` marks released_at

**Core:**
- **ID:** api-worktrees-release
- **Trigger:** Session/arc closes, or explicit caller release.
- **Expected:** UPDATE `released_at = now()`, `status = 'cleanup'`. Returns 200 `{id, status:'cleanup', released_at}`. Subsequent `POST /api/worktrees` with the SAME `reservedBy` clears `released_at` and revives (B-LIFECYCLE-3). Janitor (B-JANITOR-1/2) hard-deletes after `idle_window`.
- **Verify:** POST release; `SELECT released_at FROM worktrees WHERE id = ?` returns non-null. POST same reservedBy `kind:'fresh'` -> returns same id, released_at NULL.
- **Source:** New handler in `apps/orchestrator/src/api/index.ts`; SessionDO close hook in `apps/orchestrator/src/agents/session-do/status.ts` (call site for the auto-release path).

### B-API-4: `DELETE /api/worktrees/:id` (admin force-delete)

**Core:**
- **ID:** api-worktrees-delete
- **Trigger:** Admin-gated `DELETE /api/worktrees/:id`.
- **Expected:** Hard-deletes the row regardless of `status`. Bypasses the grace window. Cookie + `users.role='admin'` required.
- **Verify:** As admin: DELETE returns 200; SELECT count = 0. As non-admin: 403.
- **Source:** New handler in `apps/orchestrator/src/api/index.ts`. Auth pattern mirrors existing admin endpoints (search for `role !== 'admin'` in current API code).

### B-API-5: `POST /api/sessions { worktree?: ... }` end-to-end

**Core:**
- **ID:** api-sessions-worktree-param
- **Trigger:** Caller issues `POST /api/sessions {project, prompt?, worktree: {kind:'fresh'} | {id:'<existing>'}, ...}`.
- **Expected:**
  - If `worktree.kind === 'fresh'`, the orchestrator **derives `reservedBy` from session context (explicit rule, not inferred):** `kataIssue` is present and a positive integer -> `reservedBy = {kind:'arc', id: kataIssue}`. Otherwise -> `reservedBy = {kind:'session', id: <newly-allocated-sessionId>}`. The orchestrator never assigns `kind:'manual'` from this endpoint — manual is reserved for setup-ceremony / discovery classification (B-DISCOVERY-2/3) only.
  - With the derived `reservedBy`, the orchestrator calls the same internal `reserveWorktree()` as `POST /api/worktrees` (same idempotency contract via B-CONCURRENCY-3, same conflict response via B-CONCURRENCY-1) before D1 INSERT; on success persists `agent_sessions.worktreeId`.
  - If `worktree.id` is given, the row is fetched and validated against the *derived* `reservedBy`: must be free, or same-`reservedBy` re-acquire (idempotent), or 409 conflict. Then persisted.
  - If `worktree` is absent, `worktreeId` is NULL (today's behavior; back-compat for callers that don't yet thread the param).
- **Verify:** `curl -X POST /api/sessions -d '{"project":"...","kataIssue":115,"worktree":{"kind":"fresh"}}'` -> session row has worktreeId set; the corresponding `worktrees` row has `reservedBy.kind='arc'` and `reservedBy.id=115`. Same call without `kataIssue` -> reservedBy.kind='session'.
- **Source:** `apps/orchestrator/src/api/index.ts:63-77` (extend `CreateSessionBody`); `apps/orchestrator/src/lib/create-session.ts:27-42` (extend `CreateSessionParams`); `apps/orchestrator/src/lib/create-session.ts:67` and `:125` (use resolved worktree.path for `projectPath` and persist `worktreeId`).

**API Layer:**
```
POST /api/sessions
  body: { project, prompt?, kataIssue?, worktree?: {kind:'fresh'} | {id} , ... }
  derived reservedBy:
    - if kataIssue (positive int) present -> {kind:'arc', id: kataIssue}
    - else                                -> {kind:'session', id: <new session id>}
```

### B-LIFECYCLE-1: Status enum semantics

**Core:**
- **ID:** lifecycle-status-enum
- **Trigger:** Any state-altering operation on a worktree row.
- **Expected:**
  - `free`: registry knows the clone exists, no reservation. Eligible for fresh-pick.
  - `held`: reservation exists; row's `reservedBy` is set; `released_at IS NULL`. **Single non-released "in use" status in v1** — encompasses both "no runner connected yet" and "runner connected and working." Runner liveness is observable at the SessionDO level (`cachedGatewayConnId`); the registry does not duplicate this signal.
  - `cleanup`: `released_at IS NOT NULL`. Awaiting janitor delete; recoverable via re-attach during grace window (B-LIFECYCLE-3).
  - **`active` status is reserved for v2 (deferred).** A finer-grained `active` state distinguishing "runner connected" from "held but idle" requires wiring into runner-link's dial-accept callback and bookkeeping the reverse `active -> held` on disconnect/reap. v1 has no consumer (no UI filter, no API gate, no scheduler input that reads `active` distinct from `held`), so the cost is unjustified. The schema CHECK constraint accepts `'active'` as a valid value (forward-compatible) but no code path writes it.
- **Verify:** Unit-test the state-transition matrix. `free -> held` on reserve. `held -> cleanup` on release. `cleanup -> held` on re-attach. Janitor `cleanup -> deleted` after grace window. No transition writes `'active'` in v1.
- **Source:** Schema CHECK constraint at `apps/orchestrator/src/db/schema.ts` includes `'active'` in the enum for forward-compat; no writer in v1.

### B-LIFECYCLE-2: Mark `released_at` on session close (last-session check)

**Core:**
- **ID:** lifecycle-release-on-close
- **Trigger:** SessionDO transitions session to a terminal status (`completed`, `error`, `stopped`, `failed`, `crashed`).
- **Expected:** If `agent_sessions.worktreeId IS NOT NULL`, check whether any OTHER agent_sessions row with the same worktreeId is still in non-terminal status. If yes, no-op (arc-shared case: chain successor is still active). If no, UPDATE `worktrees SET released_at = now(), status = 'cleanup' WHERE id = ?`.
- **Verify:** Two arc-bound sessions sharing worktreeId. Close session A -> released_at remains NULL (B is still active). Close session B -> released_at is set.
- **Source:** New helper in `apps/orchestrator/src/lib/release-worktree-on-close.ts` (new); call site at the end of SessionDO terminal-transition handler (search for `status: 'completed'` UPDATE in `apps/orchestrator/src/agents/session-do/status.ts`).

### B-LIFECYCLE-3: Re-attach during grace window clears `released_at`

**Core:**
- **ID:** lifecycle-reattach-revives
- **Trigger:** `POST /api/worktrees` (or implicit reserve via `POST /api/sessions`) targeting a row where `released_at IS NOT NULL` AND the new request's `reservedBy.kind` and `reservedBy.id` MATCH the row's existing `reservedBy`.
- **Expected:** UPDATE `released_at = NULL, status = 'held'`. Returns the existing row 200. The pending DO alarm or cron sweep no-ops on next fire (handler re-checks `released_at`).
- **Verify:** Reserve a clone for `{kind:'session', id:'X'}`. Release it. Within idle_window, POST same reservedBy -> 200 with same id, released_at=NULL.
- **Source:** Reserve handler in `apps/orchestrator/src/api/index.ts`; same code path as B-API-1 with re-attach branch.

### B-LIFECYCLE-4: Different-reservedBy on a released row treats it as free

**Core:**
- **ID:** lifecycle-released-row-fresh-eligible
- **Trigger:** `POST /api/worktrees {kind:'fresh', reservedBy: <new>}` while a row has `released_at IS NOT NULL` AND its existing `reservedBy` differs from `<new>`.
- **Expected:** The row is eligible for fresh-pick. Reserve handler treats `(status='cleanup' AND released_at IS NOT NULL)` as if `status='free'` for allocation purposes. The new reservation rewrites `reservedBy` and clears `released_at`.
- **Verify:** Released row with reservedBy={session:'A'}. POST fresh from session B picks it up; row's reservedBy becomes {session:'B'}.
- **Source:** Reserve handler at `apps/orchestrator/src/api/index.ts` (the SQL query selects `WHERE status='free' OR (status='cleanup' AND released_at IS NOT NULL)`).

### B-CONCURRENCY-1: Cross-reservation conflict returns 409

**Core:**
- **ID:** concurrency-cross-reservation-409
- **Trigger:** **Explicit-id reservation requests only.** `POST /api/sessions { worktree: { id: '<existing>' } }` (B-API-5) or any future name-specified shape that targets a specific row whose `reservedBy.kind` or `reservedBy.id` differs from caller's, where `released_at IS NULL` (so B-LIFECYCLE-4 doesn't reclassify it as fresh-eligible). **Pool-pick (`{kind:'fresh'}`) does NOT 409** — it skips ineligible rows and falls back to 503 `pool_exhausted` if none remain (B-API-1 + B-API-5 503 path).
- **Expected:** 409 `{error:'conflict', existing: {reservedBy, status, path}}`. Caller decides what to do (kata surfaces this to user as "clone X is held by arc:200").
- **Verify:** Reserve clone for arc:115 -> get id W1. POST `/api/sessions { worktree: { id: 'W1' }, kataIssue: 200 }` (different reservedBy) -> 409. POST `/api/worktrees {kind:'fresh', reservedBy: {kind:'arc', id:200}}` with the same W1 already held -> NOT 409; the pool-pick skips W1 and either picks a free row or 503's.
- **Source:** Reserve handler + session-create handler at `apps/orchestrator/src/api/index.ts`.

### B-CONCURRENCY-2: Sharing policy by `reservedBy.kind`

**Core:**
- **ID:** concurrency-sharing-by-kind
- **Trigger:** Second session attempts to bind to an already-reserved worktree.
- **Expected:**
  - `kind: 'arc'` -> shared. The N-th session with a matching `kataIssue` reuses the same worktreeId. Today's chain behavior. **Allowed.**
  - `kind: 'session'` -> exclusive. Only the original session may bind. A second session attempt -> 409 (treated like cross-reservation conflict).
  - `kind: 'manual'` -> shared. Multiple sessions OK; user is just holding the clone.
- **Verify:** With reservation kind='session' for sess-A: starting another session sess-B with the same worktreeId via `POST /api/sessions {worktree:{id}}` -> 409. With kind='arc' for issue 115: the chain successor in mode `verify` reuses the same worktreeId fine.
- **Source:** Reserve handler at `apps/orchestrator/src/api/index.ts` (kind dispatch in the bind path).

### B-CONCURRENCY-3: Same-`reservedBy` re-acquire is idempotent

**Core:**
- **ID:** concurrency-idempotent-reacquire
- **Trigger:** `POST /api/worktrees {kind:'fresh', reservedBy: {kind, id}}` where a row already exists with matching `reservedBy.kind` AND matching `reservedBy.id`, regardless of `status`.
- **Expected:** Returns the existing row 200 instead of allocating a new one. Mirrors today's `auto-advance.ts:60` same-chain idempotency guarantee. Required so chain auto-advance retrying its checkout does not multi-allocate.
- **Verify:** POST `{kind:'fresh', reservedBy:{kind:'arc',id:115}}` twice -> identical id returned.
- **Source:** Reserve handler at `apps/orchestrator/src/api/index.ts`.

### B-KATA-1: Code-touching modes auto-reserve via `POST /api/worktrees`

**Core:**
- **ID:** kata-auto-reserve-code-touching
- **Trigger:** `kata enter <mode>` for `mode in CODE_TOUCHING_MODES = ['debug','implementation','verify','task']` AND no existing reservation already pinned to this session/arc.
- **Expected:** Kata calls `POST /api/worktrees {kind:'fresh', reservedBy: kataIssue ? {kind:'arc', id:kataIssue} : {kind:'session', id:sessionId}}` BEFORE the session-creation API call. The returned `worktree.id` is passed as `worktree: {id}` to `POST /api/sessions`. On 503 pool_exhausted, kata writes the operator hint to stderr and exits non-zero — no session row created. On 200, kata stdout includes `[kata] Reserved worktree: <path> (branch: <branch>)`.
- **Verify:** `kata enter debug` (no `--issue`) on a worktree with a free clone in pool: stdout shows reserved path; agent_sessions.worktreeId is non-null.
- **Source:** New file `packages/kata/src/lib/reserve-worktree.ts`; call site in `packages/kata/src/commands/enter.ts` after mode validation, before session-creation. CODE_TOUCHING_MODES list mirrors `apps/orchestrator/src/lib/auto-advance.ts:44-45`.

### B-KATA-2: Read-only modes skip reservation

**Core:**
- **ID:** kata-skip-readonly-modes
- **Trigger:** `kata enter <mode>` for `mode in READ_ONLY_MODES = ['research','planning','freeform']`.
- **Expected:** Kata does NOT call `POST /api/worktrees`. Session creation proceeds without `worktree` param; `agent_sessions.worktreeId IS NULL`. The runner runs in whatever cwd the gateway resolves for the project name (today's behavior).
- **Verify:** `kata enter freeform`: agent_sessions.worktreeId is NULL; no new row in `worktrees`.
- **Source:** Same `reserve-worktree.ts` helper short-circuits for read-only modes.

### B-JANITOR-1: SessionDO alarm hard-deletes released session-bound rows

**Core:**
- **ID:** janitor-do-alarm-session-bound
- **Trigger:** SessionDO marks `released_at` on terminal-transition (B-LIFECYCLE-2) for a session-bound reservation (`reservedBy.kind === 'session'`).
- **Expected:** SessionDO schedules `ctx.storage.setAlarm(released_at + idle_window_ms)` where `idle_window_ms` defaults to 24h (env override `CC_WORKTREE_IDLE_WINDOW_SECS`). Alarm fires -> handler re-fetches the row; if `released_at IS NULL` (re-attached), no-op. Else `DELETE FROM worktrees WHERE id = ? AND released_at IS NOT NULL AND released_at < now() - idle_window_ms`.
- **Verify:** Configure short idle_window (5s) for test. Reserve session-bound, release, wait 6s -> row deleted.
- **Source:** `apps/orchestrator/src/agents/session-do/status.ts` close path schedules the alarm; new alarm handler in SessionDO (search for `alarm()` method).

### B-JANITOR-2: Worker cron sweeps arc-bound and manual rows

**Core:**
- **ID:** janitor-cron-fallback
- **Trigger:** Hourly Cloudflare Workers cron schedule.
- **Expected:** Cron handler runs `DELETE FROM worktrees WHERE released_at IS NOT NULL AND released_at < now() - idle_window_ms RETURNING id`. Broadcasts a tanstack-db collection delta for each deleted row so live UI clients update.
- **Verify:** Configure short idle_window. Reserve arc-bound, release, wait > idle_window, force trigger cron via `POST /api/admin/worktrees/sweep` (B-JANITOR-3). Row deleted.
- **Source:** New `apps/orchestrator/src/cron.ts`; cron schedule entry in `apps/orchestrator/wrangler.toml` (`schedule = ["0 * * * *"]`).

### B-JANITOR-3: Manual sweep endpoint for operators

**Core:**
- **ID:** janitor-manual-sweep
- **Trigger:** Admin POSTs `/api/admin/worktrees/sweep`.
- **Expected:** Runs the cron's DELETE logic synchronously and returns `{deletedCount, deletedIds}`.
- **Verify:** Reserve, release, wait. POST sweep -> deletedCount === 1.
- **Source:** New handler in `apps/orchestrator/src/api/index.ts`; same auth pattern as B-API-4.

### B-AUTOADVANCE-1: `checkoutWorktree` is `worktreeId`-keyed

**Core:**
- **ID:** autoadvance-worktreeid-keyed
- **Trigger:** Refactor of `apps/orchestrator/src/lib/checkout-worktree.ts:44-114`.
- **Expected:** Function signature becomes `checkoutWorktree(db, {worktreeId, mode}, userId)`. Drop `issueNumber` and `worktree` (project) parameters. Idempotency check is `worktreeId`-keyed. Returns shape unchanged.
- **Verify:** Vitest covers `checkoutWorktree({worktreeId})` idempotent re-call returns same row; cross-`worktreeId` calls behave as expected.
- **Source:** `apps/orchestrator/src/lib/checkout-worktree.ts:44-114`.

### B-AUTOADVANCE-2: Chain successor inherits predecessor's `worktreeId`

**Core:**
- **ID:** autoadvance-successor-inherits
- **Trigger:** `tryAutoAdvance` (apps/orchestrator/src/lib/auto-advance.ts:213-233) spawns the successor.
- **Expected:** The successor's `createSession` call passes `worktreeId: predecessor.worktreeId`. Same-arc idempotency on the reservation guarantees the successor finds the same row (`reservedBy.kind='arc', id=kataIssue` matches predecessor's).
- **Verify:** With existing chain on issue 200, predecessor `worktreeId='W1'`. Advance -> successor's `agent_sessions.worktreeId === 'W1'`.
- **Source:** `apps/orchestrator/src/lib/auto-advance.ts:213-233`; `apps/orchestrator/src/lib/create-session.ts:27-42` accepts the inherited id via the `worktree: {id}` param shape from B-API-5.

### B-FORK-1: `forkWithHistory` accepts optional `worktreeId` override

**Core:**
- **ID:** fork-worktreeid-override
- **Trigger:** `forkWithHistoryImpl` is invoked.
- **Expected:** Signature gains optional `worktreeId?: string`. If passed, the fork's SessionMeta (`project_path` as resolved from `worktrees.path`) and the GatewayCommand's `worktree_path` field are set to the new clone. If absent, fork inherits parent's `ctx.state.worktreeId` (and corresponding path). The orphan-recovery path (`apps/orchestrator/src/agents/session-do/rpc-messages.ts:137-171`) explicitly threads parent's worktreeId so auto-recovery never accidentally moves the session to a different clone.
- **Verify:** `forkWithHistory()` without `worktreeId`: child's `agent_sessions.worktreeId === parent.worktreeId`. With explicit free-clone id: child gets the new id; parent unchanged.
- **Source:** `apps/orchestrator/src/agents/session-do/branches.ts:239-307`; `apps/orchestrator/src/agents/session-do/rpc-messages.ts:137-171`; HTTP fork endpoint at `apps/orchestrator/src/api/index.ts:2649-2717` accepts optional body field.

### B-MIGRATION-1: Pre-clean stale rows; reshape inline; backfill rules H1-H8

**Core:**
- **ID:** migration-0027-reshape
- **Trigger:** Migration 0027 runs.
- **Expected:** Use the **CREATE-TABLE-AS-SELECT rebuild pattern** for the `worktreeReservations` -> `worktrees` reshape. This is mandated (not optional) because SQLite cannot ADD a PRIMARY KEY via ALTER and the reshape needs a new PK on `id` plus multi-column DROP. The rebuild is the SQLite-canonical [12-step ALTER TABLE recipe](https://www.sqlite.org/lang_altertable.html#otheralter). Sequence:
  1. `DELETE FROM worktreeReservations WHERE stale = 1` — pre-clean. Stale rows are by definition not actively held.
  2. `CREATE TABLE worktrees_new (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, branch TEXT, status TEXT NOT NULL CHECK (status IN ('free','held','active','cleanup')) DEFAULT 'held', reservedBy TEXT, released_at INTEGER, createdAt INTEGER NOT NULL, lastTouchedAt INTEGER NOT NULL, ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE)`.
  3. `INSERT INTO worktrees_new (id, path, branch, status, reservedBy, released_at, createdAt, lastTouchedAt, ownerId) SELECT lower(hex(randomblob(8))), '/data/projects/' || worktree, NULL, 'held', json_object('kind','arc','id', issueNumber), NULL, strftime('%s', heldSince)*1000, strftime('%s', lastActivityAt)*1000, ownerId FROM worktreeReservations`.
  4. `DROP TABLE worktreeReservations`.
  5. `ALTER TABLE worktrees_new RENAME TO worktrees`.
  6. `CREATE INDEX idx_worktrees_reservedBy ON worktrees(json_extract(reservedBy, '$.kind'), json_extract(reservedBy, '$.id'))` (the UNIQUE on path is implicit from the column constraint).
  7. `ALTER TABLE agent_sessions ADD COLUMN worktreeId TEXT REFERENCES worktrees(id)` — additive, no rebuild needed for `agent_sessions`.
  8. `UPDATE agent_sessions SET worktreeId = (SELECT id FROM worktrees WHERE json_extract(reservedBy,'$.id') = agent_sessions.kataIssue AND path = '/data/projects/' || agent_sessions.project)`.
  9. `ALTER TABLE agent_sessions DROP COLUMN worktreeInfoJson` — D1 supports per-column DROP (SQLite >= 3.35); this single column drop is safe as a standalone statement.
- **Verify:** D1 backup taken before migration via `wrangler d1 export <db-name> --output=pre-0027.sql`. Apply migration locally against the dump: `sqlite3 ./test.db < pre-0027.sql && sqlite3 ./test.db < apps/orchestrator/migrations/0027_worktrees_first_class.sql`. Post-migrate verification queries:
  - `PRAGMA table_info(worktrees)` shows new columns, no legacy columns.
  - `SELECT count(*) FROM worktrees WHERE id IS NULL` returns 0.
  - `SELECT count(*) FROM agent_sessions WHERE kataIssue IS NOT NULL AND worktreeId IS NULL` returns only orphan-reasonable rows (sessions whose worktreeReservation was already stale=1 and pre-cleaned).
  - `PRAGMA table_info(agent_sessions)` does NOT list `worktree_info_json`.
- **Source:** New file `apps/orchestrator/migrations/0027_worktrees_first_class.sql`. **Implementation must use the CREATE-TABLE-AS-SELECT rebuild pattern for the worktreeReservations->worktrees reshape** (cleaner than per-column ALTER given the multi-column DROP requirement and the new primary key). The `agent_sessions` ALTER ADD/DROP runs as separate statements and does not need rebuild. Pre-migration backup procedure documented in spec deploy notes (above).

## Implementation Phases

See YAML frontmatter `phases:` above. Phase order:

- **P1: Schema + migration** — independent. Lands the table, FK, drops dead column. Production goes through this with no behavioral change since no caller uses the new fields yet.
- **P2: Orchestrator API** — depends on P1. New `/api/worktrees` endpoints + `POST /api/sessions { worktree }` param. Still no behavioral change for callers that don't pass `worktree`.
- **P3: Gateway auto-discovery** — depends on P1. Populates the registry. After this phase the registry has rows even before any caller reserves anything.
- **P4: auto-advance + checkout-worktree refactor** — depends on P1-P3. Migrates the existing chain code path from `(issueNumber, worktree, modeAtCheckout)` keying to `worktreeId` keying. **Behavioral parity expected; this is a refactor, not a new feature.**
- **P5: forkWithHistory worktreeId override** — depends on P1-P2. Small targeted change.
- **P6: kata CLI auto-reserve** — depends on P1-P3. The user-visible win for debug/freeform/etc.
- **P7: Janitor (DO alarm + cron + manual sweep)** — depends on P1-P3. Releases need to be reclaimable to keep the pool useful.
- **P8: Verification + dogfood** — depends on all above. Ship gate.

P1, P2, P3 can land independently and are zero-impact for callers that don't opt in. P4 is the riskiest single phase (refactor of in-flight chain logic) and should land with feature-flagging if necessary.

## Verification Plan

See YAML frontmatter `verification_plan:` above. Each `vp-*` script is a literal shell-runnable check producible by `kata-vp-execution`. Scripts to land in `scripts/verify/`. Ship gate is `gh115-ship-gate.sh` (kata enter debug from cold start with at least one free clone in the pool).

## Architectural Bets

These are hard to reverse later. Reviewers should challenge them.

1. **Replace `worktreeReservations` with `worktrees`.** One-way migration. Rollback recreates the old table from a `worktrees` snapshot. Mitigation: D1 backup before migration 0027.
2. **Auto-discovery as the registry's source of truth.** Gateway must run the sweep consistently. If gateway is down for hours, new clones don't appear in registry. Mitigation: 60s sweep + lazy upsert at `POST /sessions/start` head.
3. **Pool model with no auto-creation.** Pool exhaustion is a real user-visible failure mode. Operational dependency: someone runs `setup-clone.sh`. Mitigation: 503 with operator hint surfaces clearly. Future v2 may add auto-clone trigger; explicitly out of v1.
4. **Sharing policy from `reservedBy.kind` (no separate `sharing` column).** Adding a kind requires code change. Mitigation: only three kinds today; if it grows, factor out.
5. **Branch is observed, not controlled.** Mid-session `git checkout` lags until next sweep. Spec says `branch` is informational, not authoritative.

## Open Risks

Each with the spec-phase resolution.

1. **Re-attach authorization during grace window.** Resolution (this spec): **same `reservedBy.kind` AND same `reservedBy.id` only.** Different reservedBy on a `cleanup`-status row treats it as fresh-eligible (B-LIFECYCLE-4). No "transfer" endpoint in v1.
2. **Manual-reservation auto-classification edge case.** Discovery on a feature-branch clone with no `.duraclaw/reservation.json` -> `kind='manual', id=<branchName>`. If a session tries to reserve via `kind:'fresh'`, the existing manual reservation makes it ineligible (B-CONCURRENCY-1 path). **Resolution:** documented as expected; operator can `DELETE /api/worktrees/:id` to force-free, or set the file. No transfer API in v1.
3. **Branch sweep cadence vs. session-runner activity.** A session's mid-flight `git checkout` lags up to 60s. **Resolution:** `branch` is informational; nothing acts on it inside duraclaw. Acceptable.
4. **Janitor: alarm vs. cron implementation.** Spec ships **both** (B-JANITOR-1 alarm for session-bound; B-JANITOR-2 cron fallback for arc-bound and manual). Implementation phase may collapse to cron-only if alarms prove flaky; manual sweep (B-JANITOR-3) is the always-available escape hatch.
5. **`auto-advance.ts` worktreeId resolution.** Resolution (this spec): chain successor inherits predecessor's `worktreeId` via `agent_sessions.worktreeId` (B-AUTOADVANCE-2). Same-arc idempotency on `POST /api/worktrees` (B-CONCURRENCY-3) ensures retries do not multi-allocate.
6. **Migration safety.** Pre-clean step deletes stale rows. **Resolution:** D1 backup pre-migration; recovery path is documented (`POST /api/worktrees` to re-create) if a non-stale row was somehow flagged stale=1 by drift.

## Implementation Hints

### Key imports

| Module | Import | Used For |
|---|---|---|
| `drizzle-orm/sqlite-core` | `sqliteTable, text, integer, primaryKey, index, uniqueIndex` | new `worktrees` table |
| `drizzle-orm` | `sql, eq, and, or, isNull, isNotNull` | reserve handler atomic transition queries |
| `hono` | `Hono, Context` | new endpoints |
| `@duraclaw/shared-types` | `WorktreeRequest, WorktreeRow, ReservedBy` | request/response types |

### Code patterns

**Atomic reserve (single-shot, D1-friendly):**
```ts
// One transaction, no SELECT FOR UPDATE: race-tolerant via UPDATE...RETURNING.
const { id } = await db.transaction(async (tx) => {
  // 1. same-reservedBy idempotency (B-CONCURRENCY-3)
  const existing = await tx.select().from(worktrees)
    .where(and(
      sql`json_extract(reservedBy,'$.kind') = ${req.reservedBy.kind}`,
      sql`json_extract(reservedBy,'$.id')   = ${req.reservedBy.id}`,
    )).limit(1)
  if (existing[0]) {
    if (existing[0].released_at != null) {
      // re-attach (B-LIFECYCLE-3)
      await tx.update(worktrees).set({ released_at: null, status: 'held' }).where(eq(worktrees.id, existing[0].id))
    }
    return existing[0]
  }
  // 2. allocate from free pool — explicit eligibility ordering via subquery
  //    SQLite's UPDATE has no LIMIT clause without compile-time options; the subquery is the
  //    correct guard so exactly one row transitions even under concurrent reserve attempts.
  //    Ordering: free rows first (lowest lastTouchedAt), cleanup-released rows as fallback.
  const eligibleId = await tx.select({ id: worktrees.id })
    .from(worktrees)
    .where(or(eq(worktrees.status, 'free'), and(eq(worktrees.status, 'cleanup'), isNotNull(worktrees.released_at))))
    .orderBy(sql`case status when 'free' then 0 else 1 end`, worktrees.lastTouchedAt)
    .limit(1)
  if (eligibleId.length === 0) {
    const counts = await tx.select({
      free: sql<number>`sum(case when status='free' then 1 else 0 end)`,
      total: sql<number>`count(*)`,
    }).from(worktrees)
    throw new PoolExhaustedError(counts[0])
  }
  const allocated = await tx.update(worktrees)
    .set({ status: 'held', reservedBy: JSON.stringify(req.reservedBy), released_at: null, lastTouchedAt: Date.now() })
    .where(eq(worktrees.id, eligibleId[0].id))
    .returning()
  return allocated[0]
})
```

**Same-issue idempotent fresh (B-CONCURRENCY-3 + auto-advance reuse):**
```ts
// auto-advance.ts: spawn successor with inherited worktreeId
const predecessor = await db.select({ worktreeId: agentSessions.worktreeId })
  .from(agentSessions).where(eq(agentSessions.id, predecessorSessionId)).limit(1)
await createSession({ ...successor, worktree: { id: predecessor[0].worktreeId } })
// Inside createSession: re-validates (must be same reservedBy) + persists agent_sessions.worktreeId.
```

**Discovery sweep classification:**
```ts
// gateway: worktree-sweep.ts
async function classify(path: string): Promise<{branch: string; reservedBy: ReservedBy | null}> {
  const branch = (await execFile('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const reservationFile = join(path, '.duraclaw', 'reservation.json')
  try {
    const fileContents = JSON.parse(await readFile(reservationFile, 'utf8'))
    return { branch, reservedBy: fileContents }   // ceremony override
  } catch (e) { /* ENOENT is the common case */ }
  const defaultBranch = await resolveDefaultBranch(path)   // git symbolic-ref refs/remotes/origin/HEAD
  if (branch === defaultBranch) return { branch, reservedBy: null }
  return { branch, reservedBy: { kind: 'manual', id: branch } }
}
```

**Janitor alarm in SessionDO:**
```ts
// status.ts close path
if (state.worktreeId && reservedBy.kind === 'session') {
  await ctx.storage.setAlarm(Date.now() + idleWindowMs)
}
// alarm() handler
async alarm() {
  const row = await db.select().from(worktrees).where(eq(worktrees.id, state.worktreeId)).limit(1)
  if (!row[0] || row[0].released_at == null) return // re-attached
  if (Date.now() < row[0].released_at + idleWindowMs) return // race; reschedule
  await db.delete(worktrees).where(and(eq(worktrees.id, state.worktreeId), isNotNull(worktrees.released_at)))
}
```

### Gotchas

- **D1 doesn't support `SELECT ... FOR UPDATE`.** The atomic reserve uses `UPDATE ... WHERE status='free' ... RETURNING` for the allocation step; the WHERE clause provides the race guard.
- **`json_extract` index on a json column** — make sure SQLite version supports expression indexes. Cloudflare D1 does. Locally, `sqlite3 --version` should be ≥ 3.38.
- **`PRAGMA foreign_keys = ON`** must be active for the `agent_sessions.worktreeId REFERENCES worktrees(id)` constraint to be enforced. D1 has it on by default; local sqlite testing must set it explicitly.
- **`scripts/setup-clone.sh` is the operator's gesture, NOT duraclaw's.** Do not call it from any orchestrator/gateway code path. Pool exhaustion is a 503; humans clone more.
- **`kataIssue` stays as chain identity.** Do not collapse it into `worktreeId` in any of the ~25 callsites that read it for chain coordination, preference lookup, or successor-idempotency. The migration touches only the worktree-key sites (`auto-advance.ts:181-201`, `checkout-worktree.ts:44-114`, `chains.ts:337-354`, `status.ts:199-215`).

### Reference docs

- D1 docs — atomic UPDATE...RETURNING: https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/
- Drizzle migrations: https://orm.drizzle.team/docs/migrations
- Cloudflare Workers cron triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Existing reaper pattern (cleanup decisions + RPC): `packages/agent-gateway/src/reaper.ts:208-238` — same bearer pattern for new sweep RPC.
- Existing alarm pattern in DOs: search for `ctx.storage.setAlarm` in `apps/orchestrator/src/agents/`.

---
