---
initiative: arcs-first-class-parent
type: project
issue_type: feature
status: approved
priority: high
github_issue: 116
created: 2026-04-27
updated: 2026-04-29
phases:
  - id: p1
    name: "Schema + single-drop migration (arcs table, kata* drop, partial unique idx)"
    tasks:
      - "Add `arcs` table to `apps/orchestrator/src/db/schema.ts`: columns `id text PK`, `userId text NOT NULL FK→users.id (CASCADE)`, `title text NOT NULL`, `externalRef text` (JSON column carrying `{provider:'github'|'linear'|'plain', id, url?}` — store as text, parse on read), `worktreeId text FK→worktrees.id` (nullable; arc-less / read-only arcs may have no worktree. The `worktrees` table was added by #115's migration 0031), `status text NOT NULL DEFAULT 'draft'` (allowed values: `'draft'|'open'|'closed'|'archived'`), `parentArcId text FK→arcs.id` nullable, `createdAt text NOT NULL`, `updatedAt text NOT NULL`, `closedAt text` nullable. Add expression unique index `idx_arcs_external_ref` on `(json_extract(external_ref, '$.provider'), json_extract(external_ref, '$.id'))` WHERE `external_ref IS NOT NULL` (deduplicates GH issue → arc 1:1). Add composite index `idx_arcs_user_status_lastactivity` on `(userId, status)` for kanban queries"
      - "In `apps/orchestrator/src/db/schema.ts`: keep Drizzle table `agentSessions` (DB name `agent_sessions`) — no rename; the auth `sessions` table already owns that identifier (see Gotcha #13). Add columns: `arcId text NOT NULL FK→arcs.id` (CASCADE delete) — `notNull()` is enforced at the Drizzle schema + app layer only; SQLite cannot ALTER an existing column to add NOT NULL without a table recreate, and we accept that trade-off rather than collide with the auth `sessions` table (see Gotcha #12 + #13). Add `mode text` (renamed from `kataMode`; same nullable text column), `parentSessionId text FK→agent_sessions.id` nullable. Drop columns: `kataMode`, `kataIssue`, `kataPhase`. Keep `kataStateJson` — still useful for UI panel rendering. Add partial unique index `idx_agent_sessions_arc_mode_active` on `(arcId, mode)` WHERE `status IN ('idle','pending','running')` to fix the auto-advance idempotency race"
      - "Write migration `apps/orchestrator/migrations/0032_arcs_first_class.sql` (the next sequential number after #115's `0031_worktrees_first_class.sql` on main). **D1 transaction caveat:** D1's SQLite implementation does not allow DDL (CREATE/ALTER/DROP) inside an explicit `BEGIN...COMMIT` transaction; DDL auto-commits. The migration is therefore structured as a sequence of statements that wrangler executes serially — wrangler batches them into the migration file but does not wrap them in BEGIN/COMMIT. Atomicity at the workflow level is provided by wrangler's migration runner: if any statement fails, the migration is marked failed and the dev must wipe local D1 to retry (acceptable per pre-prod rollback policy in P1.rollback). Sequence: (1) `CREATE TABLE arcs ...` with full schema. (2) Backfill: `INSERT INTO arcs(id, userId, title, externalRef, status, createdAt, updatedAt) SELECT 'arc_' || lower(hex(randomblob(8))), userId, COALESCE(...) AS title, json_object('provider','github','id',kataIssue,'url','https://github.com/baseplane-ai/duraclaw/issues/'||kataIssue) AS externalRef, CASE WHEN ... END AS status, MIN(createdAt), MAX(COALESCE(lastActivity,createdAt)) FROM agent_sessions WHERE kataIssue IS NOT NULL GROUP BY userId, kataIssue` (one arc per `(userId, kataIssue)` pair). For orphan sessions (kataIssue IS NULL), one implicit arc per session. (3) Add `arcId` column to `agent_sessions` (nullable at the DB layer; `notNull()` enforced at Drizzle + app layer only — see Gotcha #12) and backfill via `UPDATE agent_sessions SET arcId = (SELECT a.id FROM arcs a WHERE a.userId=agent_sessions.userId AND json_extract(a.externalRef,'$.id')=agent_sessions.kataIssue)` for kata-linked rows; for arc-less rows, the implicit-arc backfill in step (2) keys by sessionId so a `UPDATE agent_sessions SET arcId = 'arc_orphan_' || id WHERE kataIssue IS NULL` finishes coverage. (4) Add `mode` column and `UPDATE agent_sessions SET mode = kataMode`. The `prompt` column already exists on `agent_sessions` (verified at `db/schema.ts:144` — used in step 2's orphan backfill SUBSTR call); no new column needed for prompt. (5) Add `parentSessionId` column (initialized NULL). (6) Backfill `arcs.worktreeId` from `agent_sessions.worktreeId` (the existing `agent_sessions.worktreeId text REFERENCES worktrees(id)` column from migration 0031). For each arc, pick the worktreeId from any one of its sessions (NULL if none). No carry-over columns needed; the `worktrees` table already owns reservation lifecycle fields per #115's schema. (7) Drop kata columns: SQLite supports `ALTER TABLE ... DROP COLUMN` natively (v3.35+; D1 uses recent enough SQLite). (8) Create the new indexes (`idx_arcs_external_ref`, `idx_arcs_user_status_lastactivity`, `idx_agent_sessions_arc_mode_active`). The four pre-existing `agent_sessions` indexes are unchanged — column adds/drops in modern SQLite do not invalidate them. Test on a seeded D1 in vitest BEFORE shipping to dev"
      - "In `apps/orchestrator/src/lib/types.ts`: add `ArcSummary` type with shape `{ id, title, externalRef: {provider,id,url?} | null, status: 'draft'|'open'|'closed'|'archived', worktreeId?: string, parentArcId?: string, createdAt, updatedAt, closedAt?, sessions: Array<{id, mode, status, lastActivity, createdAt}>, worktreeReservation?: {worktree, heldSince, lastActivityAt, ownerId, stale}, prNumber?: number, lastActivity }`. Keep `ChainSummary` type alias as `type ChainSummary = ArcSummary` for one release to ease the rename, then drop in P5"
      - "Add helper `parseExternalRef(json: string | null): {provider,id,url?} | null` to `apps/orchestrator/src/lib/arcs.ts` (NEW file, replaces `lib/chains.ts`). Add `formatExternalRef({provider,id,url?}): string` for round-trip. Add `buildArcRow(env, db, userId, arcId): Promise<ArcSummary | null>` (replaces `buildChainRow`) that: (a) fetches arc row, (b) fetches sessions for that arc via `WHERE arcId = ?` (use the composite index), (c) fetches worktree row from `worktrees` table if `arc.worktreeId` set (#115's worktrees table is the source of truth for reservation lifecycle), (d) calls existing GH issue/PR cache to resolve `prNumber`, (e) returns ArcSummary. Add `buildArcRowFromContext(arcRow, sessionRows, worktree, ctx)` pure function for bulk operations. Add `deriveColumn(sessions: Array<{mode, status, lastActivity, createdAt}>, arcStatus): 'backlog'|'research'|'planning'|'implementation'|'verify'|'done'` — same logic as `lib/chains.ts:166-189` but reads `mode` instead of `kataMode`; returns `'backlog'` for arcs in `'draft'` status. Add `COLUMN_QUALIFYING_MODES` set: `new Set(['research','planning','implementation','verify','close'])`"
      - "Update `apps/orchestrator/src/lib/create-session.ts`: change `POST /api/sessions` parameter from optional `kataIssue: number` to required `arcId: string`. If `arcId` missing AND `kataIssue` provided (legacy clients during transition), look up or auto-create an arc with `externalRef={provider:'github',id:kataIssue}` and use its id. Implicit arc auto-creation when neither `arcId` nor `kataIssue` provided: create a draft-status arc with `title = (prompt.slice(0, 50) + '…')` and no externalRef, then use its id. Insert sessions row with `arcId`, `mode` (from request), drop the `kataIssue` write"
      - "Add `apps/orchestrator/src/db/migration-test.ts`: vitest fixture that seeds 3 user-and-issue patterns into agent_sessions: (1) two sessions with `kataIssue=42, kataMode='research'` and `kataMode='planning'` for the same user (chain shape), (2) one orphan `kataIssue=null` session (debug-style), (3) one session with `kataIssue=99` plus a row in `worktrees` table referenced by `agent_sessions.worktreeId` (e.g. `worktreeId='wt-abc'`). Run the migration. Assert: 3 arcs created (one per kataIssue + implicit for orphan), session `arcId` populated, session `mode` populated from `kataMode`, arc 99 has `worktreeId` populated (the same value as the seed session's worktreeId, e.g. `'wt-abc'`), `kataMode/kataIssue/kataPhase` columns gone from `agent_sessions`"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- migration-test`; `pnpm test --filter @duraclaw/orchestrator -- arcs` (the new lib tests)"
    test_cases:
      - id: "migration-roundtrip-chain-pattern"
        description: "Two sessions sharing kataIssue=42 backfill into one arc; both sessions get the same arcId; mode column preserves kataMode values"
        type: "unit"
      - id: "migration-roundtrip-orphan"
        description: "Session with kataIssue=null backfills into its own implicit arc (one arc per orphan); arc.title fallback uses session prompt summary"
        type: "unit"
      - id: "migration-drops-kata-cols"
        description: "After migration, agent_sessions table has no kataMode/kataIssue/kataPhase columns; SELECT against them throws"
        type: "unit"
      - id: "arc-unique-on-external-ref"
        description: "Two sessions for same userId+kataIssue produce ONE arc, not two (expression unique index works)"
        type: "unit"
      - id: "implicit-arc-on-create"
        description: "POST /api/sessions with no arcId and no kataIssue auto-creates a draft-status arc; new session row references it"
        type: "integration"
      - id: "typecheck-clean"
        description: "pnpm typecheck succeeds across orchestrator + shared-types"
        type: "build"
  - id: p2
    name: "Three primitives — advanceArc, branchArc, rebindRunner; remove forkWithHistory + handleModeTransitionImpl"
    tasks:
      - "Add `apps/orchestrator/src/agents/session-do/advance-arc.ts` (NEW file, replaces `lib/auto-advance.ts` + `agents/session-do/mode-transition.ts`). Export `advanceArcImpl(ctx: SessionDOContext, args: {mode?: string, prompt: string, agent?: string}): Promise<{ok: boolean, sessionId?: string, error?: string}>`. Behavior: (1) read current session row to get `arcId`; (2) close current session (set `status='idle'`, broadcast session row update); (3) call `createSession()` with `{arcId, mode: args.mode ?? null, prompt: args.prompt, agent: args.agent ?? 'claude', userId, project}` to mint new session row + new SessionDO via existing spawn path; (4) return new session id. NO transcript carryover (the new session sees only its prompt). The closing-old-session step does NOT clear `runner_session_id` on the old row (preserved for future hydration if user navigates back). Refer to `lib/auto-advance.ts:136-242` for the existing gate logic that must port over (idempotency, worktree availability) and `mode-transition.ts:111-228` for the existing artifact-preamble pattern that is DROPPED in the new model"
      - "Add `apps/orchestrator/src/agents/session-do/branches.ts` — keep `serializeHistoryForFork()` (lines 121-142, used by both new primitives), DELETE `forkWithHistoryImpl()` (lines 239-307). Add `branchArcImpl(ctx: SessionDOContext, args: {fromMessageSeq?: number, prompt: string, mode?: string}): Promise<{ok: boolean, newArcId?: string, newSessionId?: string, error?: string}>`. Behavior: (1) read current session's history; (2) call `serializeHistoryForFork(ctx, fromMessageSeq?)` to wrap up to that seq (extend the helper to accept an optional max-seq cutoff if not already supported); (3) create new arc with `parentArcId = ctx.session.arcId`, `title = '<parent.title> — side arc'` (or user-overridable via UI), `externalRef = parent.externalRef` (inherits the GH issue ref by default), `status = 'open'`; (4) call `createSession()` with `{arcId: newArcId, mode: args.mode, prompt: <prior_conversation>...</prior_conversation>\\n\\nContinuing the conversation above. New user message follows.\\n\\n${args.prompt}`}; (5) return both new arc and session ids. The `<prior_conversation>` template matches today's `forkWithHistory` exactly"
      - "Add `apps/orchestrator/src/agents/session-do/rebind-runner.ts` (NEW). Export `rebindRunnerImpl(ctx: SessionDOContext, args: {nextUserMessage?: string | ContentBlock[]}): Promise<{ok: boolean, error?: string}>`. Behavior: (1) clear `runner_session_id` to null in DO state; (2) if `nextUserMessage` provided, append to local history via `safeAppendMessage(...)`; (3) call `serializeHistoryForFork(ctx)` to wrap full local history; (4) call `triggerGatewayDial(ctx, {type: 'execute', prompt: <prior_conversation>...</prior_conversation>\\n\\nContinuing the conversation above. New user message follows.\\n\\n${nextText}})`. Same DO, same session row, fresh runner. Robust against orphan-runner state (matches today's `forkWithHistoryImpl` orphan path verbatim, just renamed and scoped to orphan recovery)"
      - "Update `apps/orchestrator/src/agents/session-do/rpc-messages.ts:154-171` (`sendMessageImpl` orphan preflight): replace the `return forkWithHistoryImpl(ctx, content)` at line 164 with `return rebindRunnerImpl(ctx, {nextUserMessage: content})`. The preflight detection logic (gateway `listSessions` query, orphan match) is unchanged"
      - "Delete `apps/orchestrator/src/agents/session-do/mode-transition.ts` entirely. Remove the call from `gateway-event-handler.ts:712`: when a `kata_state` event arrives with `prev !== next` mode, the DO no longer triggers `handleModeTransition`. Mode change in kata is now a kata-internal concern; orchestrator only sees the `mode` write at session creation time (via the prompt-or-arg). For dev observability, log the kata_state delta but take no action: `logEvent(ctx, 'info', 'kata', \\`mode_change observed prev=${prev} next=${next}\\`)`"
      - "Update `apps/orchestrator/src/agents/session-do/index.ts`: remove `handleModeTransition()` and `forkWithHistory()` callable methods. Add new callables: `advanceArc(args)`, `branchArc(args)`, `rebindRunner(args)`. Each delegates to its respective `*Impl` function"
      - "Update auto-advance gate in `lib/auto-advance.ts` (or move into `advance-arc.ts` and delete the old file): drop the `runEnded` evidence check from the gate. New gate: (1) terminate_reason === 'stopped' (clean exit, NOT crashed/errored), (2) user pref enabled (per-arc override + global default), (3) idempotency: no in-flight successor session for same `(arcId, nextMode)` (the partial unique index now enforces this at the DB layer, but check first to avoid throwing on duplicate insert), (4) worktree available if next mode is code-touching (check via #115's /api/worktrees endpoint — already shipped). The `runEnded` file existence check is REMOVED — kata's evidence file is no longer the gate"
      - "Update `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts:656-660`: on `stopped` event, call new `advanceArcGate()` (the relaxed gate from prior task). If gate returns `{action:'advanced', mode}`, call `advanceArcImpl(ctx, {mode, prompt: \\`enter ${mode}\\`})` (auto-advance path). Otherwise broadcast `{type:'arc_stalled', reason}` for the UI"
      - "Add unit tests `apps/orchestrator/src/agents/session-do/advance-arc.test.ts`: (1) `advanceArc({mode:'planning', prompt:'...'})` creates new session row in same arc; old session row stays at `status='idle'`; new session has `arcId === old.arcId`. (2) Auto-advance gate skips when terminate_reason !== 'stopped'. (3) Idempotency: two simultaneous advance calls with same `(arcId, nextMode)` → only one succeeds, second sees the partial unique index conflict and returns the existing successor's id"
      - "Add unit tests `apps/orchestrator/src/agents/session-do/branches.test.ts`: (1) `branchArc({fromMessageSeq:5, prompt:'try X'})` creates new arc with parentArcId set and externalRef inherited from parent. (2) The new session's prompt contains `<prior_conversation>` wrapper with serialized history up to seq 5 only. (3) Branch from message seq beyond history length → error 400"
      - "Add unit tests `apps/orchestrator/src/agents/session-do/rebind-runner.test.ts`: (1) `rebindRunner({nextUserMessage: 'continue'})` clears runner_session_id; calls triggerGatewayDial with type='execute' and prompt wrapping local history. (2) Session row stays the same id. (3) Idempotent if called twice when no live runner is connected. **Mock mechanism:** stub `triggerGatewayDial` (imported from `runner-link.ts`) via `vi.mock('~/agents/session-do/runner-link', () => ({ triggerGatewayDial: vi.fn().mockResolvedValue({ ok: true }) }))` — assert call args after invoking `rebindRunnerImpl`. For the orphan-detection test in `rpc-messages.test.ts` (B8 path through sendMessageImpl): mock `listSessions` (gateway HTTP client in `~/lib/vps-client.ts`) to return an array containing `{ session_id: 'orphan-id', runner_session_id: ctx.state.runner_session_id, state: 'running' }` — this triggers the orphan preflight branch at `rpc-messages.ts:154-171` and asserts `rebindRunnerImpl` was called instead of the normal resume path"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- advance-arc branches rebind-runner`"
    test_cases:
      - id: "advance-arc-creates-new-session"
        description: "advanceArc creates new sessions row in same arc; old session goes to idle; arcId preserved"
        type: "unit"
      - id: "advance-arc-idempotency"
        description: "Concurrent advance calls with same (arcId, nextMode) result in exactly one new successor session row (partial unique index gate)"
        type: "unit"
      - id: "advance-arc-gate-relaxed"
        description: "Auto-advance gate fires on terminate_reason='stopped' regardless of kata run-end evidence file presence"
        type: "unit"
      - id: "branch-arc-creates-child"
        description: "branchArc creates new arc with parentArcId; externalRef inherited; first session prompt contains <prior_conversation> wrapping history up to fromMessageSeq"
        type: "unit"
      - id: "rebind-runner-orphan-path"
        description: "rebindRunner clears runner_session_id, dials execute with wrapped local history; same session row id"
        type: "unit"
      - id: "rebind-runner-from-sendmessage"
        description: "sendMessageImpl orphan preflight (gateway sees orphan with same runner_session_id) calls rebindRunner instead of forkWithHistory"
        type: "unit"
      - id: "fork-with-history-removed"
        description: "forkWithHistoryImpl no longer exported from branches.ts; class method removed from SessionDO; grep returns no callers"
        type: "unit"
      - id: "mode-transition-removed"
        description: "mode-transition.ts file no longer exists; gateway-event-handler.ts no longer calls handleModeTransition; kata_state mode delta only logs (no behavior change)"
        type: "unit"
  - id: p3
    name: "API surface — /api/arcs CRUD; delete /api/chains; WS frame syncFrameType rename"
    tasks:
      - "Add new Hono routes to `apps/orchestrator/src/api/index.ts` (or split into a new `apps/orchestrator/src/api/arcs.ts` module wired into the main app). Endpoints: (1) `POST /api/arcs` — body `{title, externalRef?:{provider,id,url?}, parentArcId?}` — validates externalRef (if present), checks unique-index conflict, returns 409 if duplicate exists with `{ok:false, existingArcId}`; otherwise inserts and returns 201 with the new arc id. (2) `GET /api/arcs` — same query params as today's /api/chains (mine, lane, column, project, stale), returns `{arcs: ArcSummary[], more_issues_available: boolean}`. Implementation: SELECT arcs JOIN sessions in JS-side group (matches today's pattern in `api/index.ts:2659-2756`). (3) `GET /api/arcs/:id` — returns single ArcSummary. (4) `POST /api/arcs/:id/sessions` — body `{mode?, prompt, agent?}` — calls `advanceArcImpl` on the SessionDO of the latest non-terminal session in this arc, OR for empty arcs (draft status, no sessions) calls `createSession()` directly with the given args. Returns `{sessionId}`. (5) `POST /api/arcs/:id/branch` — body `{fromSessionId, fromMessageSeq?, prompt, mode?}` — invokes `branchArcImpl` on the parent session's DO. Returns `{newArcId, newSessionId}`. (6) `POST /api/arcs/:id/close` — sets arc.status='closed', broadcast arc row update. (7) `POST /api/arcs/:id/archive` — sets arc.status='archived'"
      - "Add `PATCH /api/arcs/:id` route in the same module. Body: `{title?: string, status?: 'open' | 'closed' | 'archived'}` — both fields optional, at least one required (400 if body is empty). Validation: `status` must be one of the three allowed values (NOT 'draft' — drafts transition to open by spawning their first session, not via PATCH); rejecting `status: 'closed'` here is acceptable but the canonical close path is `POST /api/arcs/:id/close` which also stamps `closedAt`. PATCH only writes the fields explicitly present in the body. Response 200 returns the updated `{arc: ArcSummary}`. Broadcasts arc row update via `broadcastArcRow`. Use case: user renames an arc inline in /arc/:arcId; admin re-opens an archived arc via debug action"
      - "Delete `/api/chains` and all `/api/chains/:issue/...` routes from `api/index.ts`, including the worktree ops (`POST /api/chains/:issue/checkout`, `/release`, `/force-release`). #115 has shipped; `/api/worktrees/*` is the replacement and is already live. The kanban + sidebar now exclusively call `/api/arcs`. Update any client callers that still hit `/api/chains/:issue/checkout|release|force-release` to call the corresponding `/api/worktrees/*` endpoint instead — track these client-side rewires as part of P4a's identifier sweep so they land coordinated with the server-side delete"
      - "Update `apps/orchestrator/src/db/chains-collection.ts` → rename file to `apps/orchestrator/src/db/arcs-collection.ts`. Inside: rename `chainsCollection` → `arcsCollection`, `id: 'chains'` → `id: 'arcs'`, `syncFrameType: 'chains'` → `syncFrameType: 'arcs'`, `queryKey: ['chains']` → `queryKey: ['arcs']`, `queryFn` fetches `/api/arcs` instead of `/api/chains`, `getKey: (item) => String(item.issueNumber)` → `getKey: (item) => item.id` (arcs are keyed by their text id, not issue number)"
      - "Update `apps/orchestrator/src/lib/broadcast-chain.ts` → rename to `lib/broadcast-arc.ts`. `broadcastChainRow` → `broadcastArcRow`. Build args change: takes arcId not issueNumber. Calls `buildArcRow(env, db, userId, arcId)`. Emits WS frame `{collection: 'arcs', ops: [{type:'upsert', key:arcId, value:arcRow}]}` (replacing the old `'chains'` collection)"
      - "Update `apps/orchestrator/src/agents/session-do/broadcast.ts:259-280`: `broadcastChainUpdate` → `broadcastArcUpdate`. Passes arcId derived from session's arcId column to the rebuild path. Wire the call site that fires on `kata_state` events to use the new helper"
      - "Update `apps/orchestrator/src/agents/session-do/status.ts:174-216`: `syncKataAllToD1Impl` → keep the function (kataStateJson sync still useful) but DROP the writes to `kataMode`/`kataIssue`/`kataPhase` (those columns are gone). Only `kataStateJson` is written. The function reads `ks.currentMode` and writes it to `sessions.mode` (the renamed column). Update the function signature comment to reflect 'mode + kataStateJson only; phase stays in kata internal'"
      - "Update WS server-side fanout in `apps/orchestrator/src/agents/user-settings-do/` (find the spot that handles `syncFrameType: 'chains'` deltas — search for `'chains'` literal): rename to `'arcs'`. Hard rename, no dual-emit (per the user's decision: pre-prod, no version skew concern)"
      - "Add API contract tests in `apps/orchestrator/src/api/arcs.test.ts`: (1) POST /api/arcs creates arc, returns 201 + id. (2) POST /api/arcs with duplicate externalRef returns 409 + existingArcId. (3) GET /api/arcs returns arcs sorted by lastActivity DESC. (4) POST /api/arcs/:id/sessions creates session, sets arcId, returns sessionId. (5) POST /api/arcs/:id/branch creates child arc with parentArcId, new session has wrapped prompt. (6) POST /api/arcs/:id/close sets status='closed', broadcasts arc row update. (7) Auth: every endpoint returns 401 without session cookie"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- arcs.test`"
    test_cases:
      - id: "post-arcs-creates"
        description: "POST /api/arcs body {title, externalRef} returns 201 with arc id; arc visible in subsequent GET /api/arcs"
        type: "integration"
      - id: "post-arcs-duplicate-409"
        description: "POST /api/arcs with externalRef matching an existing arc returns 409 with existingArcId; no second arc created"
        type: "integration"
      - id: "patch-arcs-rename-and-status"
        description: "PATCH /api/arcs/:id with {title:'New name'} returns 200 with updated title; PATCH with {status:'open'} returns 200; PATCH with {status:'draft'} returns 400 (draft transitions only via spawn); PATCH with empty body returns 400"
        type: "integration"
      - id: "post-arcs-sessions-advance"
        description: "POST /api/arcs/:id/sessions creates new sessions row; same arcId on parent and child sessions; old frontier session goes to idle"
        type: "integration"
      - id: "post-arcs-branch"
        description: "POST /api/arcs/:id/branch creates new arc with parentArcId; new session prompt contains <prior_conversation> wrapper"
        type: "integration"
      - id: "ws-frame-renamed"
        description: "Server emits WS deltas with collection='arcs' (not 'chains'); client subscribes accordingly"
        type: "integration"
      - id: "chains-routes-deleted"
        description: "GET /api/chains returns 404 (route deleted). Legacy /api/chains/:issue/checkout|release stubs return 200 only via arc translation"
        type: "integration"
  - id: p4a
    name: "UI surface — identifier sweep + kanban data shape (arcsCollection, ArcSummary, ArcStatusItem rename, hooks, string literals)"
    tasks:
      - "Update all imports of `chainsCollection` → `arcsCollection` across the client. Run `grep -rn chainsCollection apps/orchestrator/src/` to enumerate; replace each. Files known from research: `KanbanBoard.tsx:37,78`, `KanbanLane.tsx`, `KanbanColumn.tsx`, `KanbanCard.tsx`, `chain-status-item.tsx:158`. Confirm no stragglers via post-replace grep"
      - "Update all imports of `ChainSummary` type → `ArcSummary`. Files: `KanbanBoard.tsx:41`, `KanbanCard.tsx:22`, `KanbanLane.tsx:14`, `KanbanColumn.tsx:9`, `lib/types.ts` (already done in P1), `lib/chains.ts` (file renamed to `lib/arcs.ts` in P1)"
      - "Update kanban data shape: `KanbanCard.tsx` props change from `chain: ChainSummary` to `arc: ArcSummary`. Inside the component, `chain.issueNumber` → display logic: if `arc.externalRef?.provider === 'github'` show `#${arc.externalRef.id}`, else show empty. `chain.issueTitle` → `arc.title`. `chain.issueType` → derive from external ref provider OR an arc.type column if added. `chain.column` → `deriveColumn(arc.sessions, arc.status)`. `chain.sessions[].kataMode` → `arc.sessions[].mode` everywhere"
      - "Rename file `components/chain-status-item.tsx` → `components/arc-status-item.tsx`. Update imports in `components/status-bar.tsx:11`. Inside: `useLiveQuery(chainsCollection)` → `useLiveQuery(arcsCollection)`. The 'kata: ...' label at line 231 STAYS (kata UI labels preserved per interview decision)"
      - "Rename hooks: `hooks/use-chain-preconditions.ts` → `hooks/use-arc-preconditions.ts`, `hooks/use-chain-checkout.ts` → `hooks/use-arc-checkout.ts`, `hooks/use-chain-auto-advance.ts` → `hooks/use-arc-auto-advance.ts`. Function names: `useChainAutoAdvance` → `useArcAutoAdvance`, etc. Update all importers"
      - "Update kanban string literals in `KanbanBoard.tsx`: `'Loading chains…'` → `'Loading arcs…'` (line 203), `'No chains match the current filter.'` → `'No arcs match the current filter.'` (line 215), `'No chains yet. Spawn a session with a `kataIssue` tag to create one.'` → `'No arcs yet. Spawn a session with a GitHub issue ref to create one.'` (line 219). Other strings: `'Start ${nextMode} for #${issueNumber}'` toast → `'Start ${nextMode} in arc \\'${arc.title}\\''`. `AdvanceConfirmModal.tsx` line 72 `'Advance #${issueNumber} from ${currentMode} to ${nextMode}?'` → `'Advance \\'${arc.title}\\' from ${currentMode} to ${nextMode}?'`"
      - "Add unit tests for `deriveColumn(sessions, arcStatus)` in `apps/orchestrator/src/lib/arcs.test.ts` (split off from the existing `chains.test.ts`, which was already covering the chain version of this fn). Coverage: (a) empty sessions array → 'backlog', (b) arc.status === 'draft' → 'backlog' regardless of sessions, (c) latest session mode='research' → 'research', (d) latest session mode='implementation' (qualifying) and prior session mode='debug' (non-qualifying) → 'implementation' (debug skipped), (e) all sessions terminal status with mode='close' → 'done', (f) mixed canonical and non-canonical modes pick the latest qualifying one. Mirror today's `chains.test.ts:80-291` test cases with the renamed inputs"
      - "Verify: `pnpm typecheck`; `pnpm test --filter @duraclaw/orchestrator -- arcs KanbanBoard ArcStatusItem`; `pnpm dev` starts cleanly; navigate to `/board` and confirm kanban renders from arcs (will not have new route or sidebar Arcs section yet — those land in P4b)"
    test_cases:
      - id: "kanban-renders-from-arcs"
        description: "KanbanBoard subscribes to arcsCollection (not chainsCollection); renders lanes and columns from ArcSummary data"
        type: "integration"
      - id: "string-sweep-p4a"
        description: "grep -rn 'No chains' apps/orchestrator/src returns no matches; grep 'chainsCollection' returns no matches"
        type: "unit"
      - id: "kata-ui-labels-preserved"
        description: "ArcStatusItem still renders 'kata: <mode>/<phase>' label (kata UI labels NOT swept per interview decision)"
        type: "unit"
      - id: "derive-column-unit"
        description: "deriveColumn returns 'backlog' for empty/draft, picks latest qualifying mode, skips non-qualifying modes (covers the 6 fixture cases listed in the task)"
        type: "unit"
      - id: "p4a-typecheck-clean"
        description: "pnpm typecheck succeeds; pnpm test --filter @duraclaw/orchestrator green"
        type: "build"
  - id: p4b
    name: "UI surface — /arc/:arcId route, sidebar Arcs section, per-message branch UI"
    tasks:
      - "Add new route `apps/orchestrator/src/routes/_authenticated/arc.$arcId.tsx`: TanStack Router file-based route. Component reads `arcsCollection` filtered by id, renders arc detail view: arc title (editable inline — calls PATCH /api/arcs/:id on blur), external ref badge, worktree reservation badge, session timeline (newest top, oldest bottom; each row: mode, status, lastActivity, runner state), branch tree (if `parentArcId` set show 'forked from <parent.title>'; if children exist show 'side arcs (N)'). Cards click-through to `/?session=:id` (preserves existing session-by-query-param tab convention per the interview). Breadcrumb back to `/board` and `/`"
      - "Update sidebar `components/layout/nav-sessions.tsx`: add new section 'Arcs' between 'Recent' and 'Worktrees'. Implementation: `useLiveQuery(arcsCollection)` filtered to `status IN ('open','draft')`. Each arc renders as a collapsible group; sessions for that arc nest below when expanded. Implicit single-session arcs (no externalRef AND only one session) render as plain session items (no expand chevron, no group label) to match today's flat-session UX. Click → `/arc/:arcId` for multi-session arcs, `/?session=:id` for single-session arcs"
      - "Add unit test for the implicit-arc filter logic at `apps/orchestrator/src/components/layout/nav-sessions.test.tsx`. Pure function `isImplicitSingleSessionArc(arc: ArcSummary): boolean` returns true iff `arc.externalRef === null && arc.sessions.length === 1 && arc.parentArcId == null`. Test cases: (a) externalRef null + 1 session + no parent → true (implicit), (b) externalRef set + 1 session → false (multi-session capable), (c) externalRef null + 2 sessions → false (multi-session), (d) externalRef null + 1 session + parentArcId set → false (side arc, even if single-session)"
      - "Add per-message branch UI in chat view. Find the message-rendering component (likely `features/agent-orch/AgentDetailView.tsx` or similar — locate via `grep -rn 'role.*assistant' apps/orchestrator/src/features/`). Add context menu (right-click or 3-dot button on hover) per assistant message with action 'Branch from here'. On click, prompt for new prompt text via modal, then call `POST /api/arcs/:id/branch` with `{fromSessionId, fromMessageSeq, prompt}`. After response, navigate to `/?session=${newSessionId}`. Optimistic UI: insert placeholder branch row in arc detail's branch tree pending refresh"
      - "Verify: `pnpm dev`; navigate to `/arc/:someArcId` (detail view renders), sidebar shows three sections (Recent, Arcs, Worktrees), per-message branch button is present and creates a new arc on click. `pnpm test --filter @duraclaw/orchestrator -- nav-sessions arc-detail`"
    test_cases:
      - id: "arc-detail-route"
        description: "/arc/:arcId renders arc detail with session timeline; back link goes to /board; clicking a session card navigates to /?session=:id"
        type: "integration"
      - id: "sidebar-arcs-section"
        description: "Sidebar has three sections: Recent, Arcs, Worktrees. Implicit single-session arcs render as flat sessions (no expand). Multi-session arcs are collapsible groups"
        type: "integration"
      - id: "is-implicit-arc-unit"
        description: "isImplicitSingleSessionArc returns true only when externalRef null + sessions.length===1 + parentArcId null; the four boundary cases are covered"
        type: "unit"
      - id: "per-message-branch"
        description: "Right-click on assistant message in chat shows 'Branch from here'; opens modal; on submit calls /api/arcs/:id/branch and navigates to new session"
        type: "integration"
      - id: "p4b-smoke-flow"
        description: "Manual smoke: open arc detail, rename via inline edit (PATCH fires), click 'Branch from here' on a message, navigate to new arc"
        type: "integration"
  - id: p5
    name: "Cleanup, kata writer validation, naming sweep, full verify"
    tasks:
      - "In `packages/kata/src/state/writer.ts`: add pre-write validation that `state.currentMode` (when non-null) is in the registered modes from `.kata/kata.yaml`. Read kata.yaml via the existing `loadKataConfig()` helper; match `state.currentMode` against the modes hash keys (`research`, `planning`, `implementation`, `task`, `verify`, `debug`, `freeform`, `default`). On mismatch throw `Error(`Mode '${state.currentMode}' not registered in kata.yaml`)`. This is the new validation surface that replaces what (didn't exist) at the orchestrator layer"
      - "Add unit test `packages/kata/src/state/writer.test.ts`: writeState({currentMode:'planning'}) succeeds; writeState({currentMode:'foobar'}) throws; writeState({currentMode:undefined}) succeeds (null mode is fine)"
      - "Identifier sweep — second pass to catch stragglers. Run from repo root: `grep -rn --include='*.ts' --include='*.tsx' 'chainsCollection\\|ChainSummary\\|buildChainRow\\|ChainBuildContext\\|broadcastChainRow\\|broadcastChainUpdate\\|chain-status-item\\|use-chain-' apps/ packages/ | grep -v node_modules | grep -v '\\.test\\.'`. For each match not already touched in P1-P4, rename. Common stragglers: comments, jsdoc, documentation strings"
      - "Drop the `type ChainSummary = ArcSummary` alias in `lib/types.ts` (added in P1). Run a final grep for `ChainSummary` references — should be zero"
      - "Delete `apps/orchestrator/src/lib/chains.ts` if not already deleted in P1 (the new file is `lib/arcs.ts`). Confirm no imports remain"
      - "Update `planning/progress.md` with #116 status; update `.claude/rules/session-lifecycle.md` to reflect the three new primitives (advanceArc/branchArc/rebindRunner) instead of the old paths (handleModeTransition/forkWithHistory/auto-advance). Specifically the 'orphan case' bullet should describe rebindRunner and the 'follow-up after >30min idle' bullet should describe how /api/arcs/:id/sessions advances rather than the in-place mode transition"
      - "Drop the obsolete chain naming-sweep tasks: rename `kata-task` skill if it references chain terminology (likely doesn't, but verify with `grep -rn chain ~/.claude/skills/`)"
      - "Final verify: `pnpm build && pnpm typecheck && pnpm test`. All three must pass. Run a full smoke through the dev environment: scripts/verify/dev-up.sh, browse /board, click into an arc, advance a session, branch from a message, verify rebindRunner kicks in if you SIGSTOP a runner and send a message"
      - "Update CLAUDE.md `## Architecture` section: replace 'chain' references with 'arc' where they describe schema; keep references to 'kata' methodology unchanged"
    test_cases:
      - id: "kata-writer-validates-mode"
        description: "writeState({currentMode:'unknown'}) throws; valid modes pass; null currentMode passes"
        type: "unit"
      - id: "no-chain-identifiers-remain"
        description: "grep for chainsCollection / ChainSummary / buildChainRow / chain-status-item / use-chain- across apps + packages returns zero matches (excluding test fixtures)"
        type: "unit"
      - id: "legacy-chains-routes-gone"
        description: "GET /api/chains, GET /api/chains/:issue/spec-status, GET /api/chains/:issue/vp-status, and POST /api/chains/:issue/checkout|release|force-release all return 404 after P3 lands (no compat-stub interim)"
        type: "integration"
      - id: "full-build-passes"
        description: "pnpm build && pnpm typecheck && pnpm test all green; smoke flow exercises arc detail, advance, branch, rebind"
        type: "build"
      - id: "session-lifecycle-rule-updated"
        description: ".claude/rules/session-lifecycle.md describes advanceArc/branchArc/rebindRunner; mentions of handleModeTransition / forkWithHistory removed"
        type: "docs"
---

## Overview

Replace the computed "chain" aggregation
(`buildChainRow` + `chainsCollection` + `WHERE kataIssue = ?` queries)
with a first-class `arcs` table — a durable parent that owns the
external ref (GH issue, Linear, etc.), references a worktree
reservation (via #115), and parents the sessions that progress through
phases. Three overloaded session-progression paths
(`handleModeTransitionImpl`, `tryAutoAdvance`, `forkWithHistoryImpl`)
collapse into three explicit primitives (`advanceArc`, `branchArc`,
`rebindRunner`) with non-overlapping semantics. Kata terminology
(`kataIssue`, `kataMode`, `kataPhase`) leaves the schema entirely;
kata becomes a consumer that writes free-form `mode` strings into a
generic column, validating them against its own `kata.yaml`.

This unifies the data model around arcs-as-durable-containers and
makes branching (cross-arc and in-arc) explicit instead of overloaded
through `forkWithHistory`. **#115 (worktrees as first-class resource)
has merged** — `arcs.worktreeId` references `worktrees.id` directly,
and `agent_sessions.worktreeId text REFERENCES worktrees(id)` was
added by #115's migration 0031. This amended spec reflects the
post-merge schema state; the original spec's worktree carry-over
columns and `worktree_reservations` backfill are no longer needed and
have been removed. Read `planning/specs/115-worktrees-first-class.md`
on main for the canonical worktrees schema.

## Feature Behaviors

### B1: `arcs` table created with externalRef tuple, draft/open/closed/archived status, parent FK

**Core:**
- **ID:** arcs-table-created
- **Trigger:** Migration `0032_arcs_first_class.sql` runs.
- **Expected:** Table `arcs` exists with columns `(id, userId FK→users, title NOT NULL, externalRef text JSON, worktreeId FK→worktrees nullable, status NOT NULL DEFAULT 'draft', parentArcId FK→arcs nullable, createdAt, updatedAt, closedAt nullable)`. Status values restricted to `'draft'|'open'|'closed'|'archived'` via app-layer validation (no DB CHECK constraint — D1 SQLite supports them but Drizzle's text-with-default pattern stays consistent with rest of schema). Expression unique index `idx_arcs_external_ref` on `(json_extract(external_ref, '$.provider'), json_extract(external_ref, '$.id'))` WHERE `external_ref IS NOT NULL`. Composite index `idx_arcs_user_status_lastactivity` on `(userId, status)`.
- **Verify:** Migration test (P1.test_cases.migration-roundtrip-chain-pattern) seeds two sessions sharing `kataIssue=42`, runs migration, asserts exactly one arc row exists with `externalRef={provider:'github',id:42,url:...}`.
**Source:** new file `apps/orchestrator/migrations/0032_arcs_first_class.sql`; new table in `apps/orchestrator/src/db/schema.ts`

#### Data Layer
- New table `arcs` with columns above
- Two new indexes: `idx_arcs_external_ref` (expression unique), `idx_arcs_user_status_lastactivity` (composite)
- `arcs.worktreeId` is nullable (FK to `worktrees.id` from #115's migration 0031) — arc-less / read-only arcs may have no worktree

---

### B2: `arcId`/`mode`/`parentSessionId` added to `agent_sessions`; `kataMode`/`kataIssue`/`kataPhase` dropped

**Core:**
- **ID:** sessions-columns-restructured
- **Trigger:** Same migration as B1.
- **Expected:** No table rename — `agent_sessions` keeps its name (the auth `sessions` table already owns that identifier; see Gotcha #13). Columns added: `arcId text FK→arcs.id ON DELETE CASCADE` (`notNull()` enforced at Drizzle + app layer; SQLite cannot ALTER an existing column to add NOT NULL without a table recreate, and we accept that trade-off — see Gotcha #12), `mode text` (renamed from `kataMode`; backfill copies values), `parentSessionId text FK→agent_sessions.id` nullable. Columns dropped: `kataMode`, `kataIssue`, `kataPhase`. Column `kataStateJson` PRESERVED (still used for UI panel rendering). Partial unique index `idx_agent_sessions_arc_mode_active` on `(arcId, mode)` WHERE `status IN ('idle','pending','running')` enforces the auto-advance idempotency invariant.
- **Verify:** P1.test_cases.migration-drops-kata-cols asserts post-migration `SELECT kataMode FROM agent_sessions` throws.
**Source:** `apps/orchestrator/migrations/0032_arcs_first_class.sql`; `apps/orchestrator/src/db/schema.ts:127-184` (column-only changes; no table rename)

#### Data Layer
- Column changes as above
- Existing indexes (`runnerIdUnique`, `userLastActivity`, `userProject`, `visibilityLastActivity`) untouched — modern SQLite preserves indexes across `ALTER TABLE ADD/DROP COLUMN`
- New partial unique index `idx_agent_sessions_arc_mode_active` for advance idempotency

---

### B3: `arcs.worktreeId` backfilled from existing `agent_sessions.worktreeId` (no carry-over)

**Core:**
- **ID:** arc-worktree-backfilled
- **Trigger:** Same migration as B1.
- **Expected:** Migration step (8) does `UPDATE arcs SET worktreeId = (SELECT s.worktreeId FROM agent_sessions s WHERE s.kata_issue = json_extract(arcs.external_ref, '$.id') AND s.worktreeId IS NOT NULL LIMIT 1)`. Reservation lifecycle (`heldSince`, `lastTouchedAt`, `ownerId`) lives on the `worktrees` table per #115's schema; arcs reference via FK only. No carry-over columns added to arcs. The `worktree_reservations` table was already dropped by #115's migration 0031.
- **Verify:** Migration test seeds an arc-99 + agent_sessions row with `worktreeId='wt-abc'`; runs migration; asserts arc 99 has `worktreeId='wt-abc'`.
**Source:** migration `0032_arcs_first_class.sql`; `apps/orchestrator/src/db/schema.ts` (arcs.worktreeId FK → worktrees.id)

#### Data Layer
- `arcs.worktreeId text REFERENCES worktrees(id)` populated from `agent_sessions.worktreeId`
- Reservation lifecycle fields owned by `worktrees` table per #115

---

### B4: Implicit single-session arc auto-created for arc-less sessions

**Core:**
- **ID:** implicit-arc-on-create
- **Trigger:** `POST /api/sessions` (or `createSession()` internal) called without `arcId` and without `kataIssue`.
- **Expected:** Server auto-creates a draft-status arc with `title = ${prompt.slice(0,50)}…` (or `'Untitled session'` if prompt empty), `externalRef = null`, then inserts the new sessions row referencing that arc's id. Sidebar UI renders this arc as a flat session entry (no expand affordance) since it has only one session and no externalRef — matches today's flat-session UX for debug/freeform sessions.
- **Verify:** P1.test_cases.implicit-arc-on-create + UI assertion (P4): `POST /api/sessions {prompt:'foo bar', mode:'debug'}` creates arc with `title='foo bar'`, status='draft'; sidebar shows the session as a flat row (not as a collapsible arc group).
**Source:** `apps/orchestrator/src/lib/create-session.ts` (rewrite the optional-kataIssue branch into mandatory-arcId-or-implicit-arc-creation)

#### API Layer
- `POST /api/sessions` body now accepts `arcId?: string` (optional). If absent, server auto-creates implicit arc.
- Response includes `arcId` (always populated) so client can follow-up with `/arc/:arcId` if user explicitly navigates.

#### UI Layer
- Sidebar 'Arcs' section: implicit single-session arcs (no externalRef, single session) render as plain session rows (no expand chevron). Multi-session arcs and external-linked arcs render as collapsible groups.

---

### B5: Arc title auto-fills from externalRef + user-editable

**Core:**
- **ID:** arc-title-autofill
- **Trigger:** `POST /api/arcs` body has `externalRef` set; OR migration backfill creates arcs from kataIssue groupings.
- **Expected:** Server fetches issue/PR title from the existing GH issue cache (`fetchGithubIssues` / `fetchGithubPulls` in `api/index.ts`). If found, `arc.title = issue.title`. If not (cache miss, network error, or non-GH provider), fallback to `'Issue #${id}'`. User can rename the arc anytime via UI; the backend `PATCH /api/arcs/:id` accepts `{title}` and writes it. Renames do NOT re-fetch from external — once user-typed, the title is locked to user intent (external label drift no longer clobbers).
- **Verify:** Integration test: create arc with externalRef={github,42}; assert title matches the cached GH issue 42's title. Then PATCH /api/arcs/:id with {title:'My custom name'}; assert title is updated; advance external title (mock cache change) and assert arc title is NOT clobbered.
**Source:** `apps/orchestrator/src/api/index.ts` (POST /api/arcs handler); migration backfill SQL in P1

#### API Layer
- New endpoint: `PATCH /api/arcs/:id` body `{title?: string, status?: 'open'|'closed'|'archived'}`
- Response 200: `{ok: true, arc: ArcSummary}`

---

### B6: `advanceArc` primitive — POST /api/arcs/:id/sessions creates new session in same arc

**Core:**
- **ID:** advance-arc-primitive
- **Trigger:** Client calls `POST /api/arcs/:id/sessions` with `{mode?, prompt, agent?}`; OR server auto-advance gate fires after a session's `stopped` event.
- **Expected:** Server (1) finds the arc's latest non-terminal session (the "frontier"), (2) closes it (sets `status='idle'`, broadcasts row update), (3) calls `createSession()` to mint a new sessions row with `arcId` of the arc, `mode` from request, `parentSessionId` set to the prior frontier session's id (so the timeline tree is preserved). The new session goes through the standard spawn flow (DO mints, runner dials, SDK runs). NO transcript carryover between old and new sessions — each session is its own context. `advanceArcImpl` runs in the SessionDO of the closing frontier session.
- **Verify:** P2.test_cases.advance-arc-creates-new-session: precondition arc with one running session; POST /api/arcs/:id/sessions; assert two sessions rows exist (old=idle, new=pending), both have same arcId, new session has parentSessionId=old.id.
**Source:** new file `apps/orchestrator/src/agents/session-do/advance-arc.ts`; route in `api/index.ts` POST /api/arcs/:id/sessions; replaces `handleModeTransitionImpl` (deleted) and the auto-advance dispatcher in `lib/auto-advance.ts:136-242`

#### API Layer
- `POST /api/arcs/:id/sessions` body `{mode?: string, prompt: string, agent?: string}`
- Response 201: `{sessionId: string, arcId: string}`
- Response 409: idempotency conflict (an in-flight session for `(arcId, mode)` already exists). Body: `{ok:false, existingSessionId}`. The partial unique index throws on insert; handler catches and returns existing.

#### Data Layer
- New session row inserted; `parentSessionId` = prior frontier session id

---

### B7: `branchArc` primitive — creates child arc with parentArcId + transcript wrap

**Core:**
- **ID:** branch-arc-primitive
- **Trigger:** Client calls `POST /api/arcs/:id/branch` with `{fromSessionId, fromMessageSeq?, prompt, mode?}`; OR per-message "Branch from here" UI affordance fires.
- **Expected:** Server (1) opens the parent session's DO, (2) calls `branchArcImpl(ctx, args)` which serializes the parent session's history up to `fromMessageSeq` (or full history if not given) via `serializeHistoryForFork()`, (3) creates a new arc with `parentArcId = parent.arcId`, `title = '<parent.title> — side arc'` (UI overridable), `externalRef = parent.externalRef` (inherits GH issue ref by default), `status = 'open'`, (4) creates the new arc's first session with prompt `<prior_conversation>\n${transcript}\n</prior_conversation>\n\nContinuing the conversation above. New user message follows.\n\n${prompt}`. Returns both new arc id and new session id. UI shows the branch tree under the parent arc's detail view.
- **Verify:** P2.test_cases.branch-arc-creates-child + P3.test_cases.post-arcs-branch: precondition arc 'foo' with 5 messages; POST /api/arcs/:id/branch {fromSessionId, fromMessageSeq:3, prompt:'try X'}; assert (a) new arc created with parentArcId='foo.id', (b) new session's prompt contains `<prior_conversation>` and the first 3 messages serialized, (c) new arc inherits externalRef from parent.
**Source:** `apps/orchestrator/src/agents/session-do/branches.ts` (replaces `forkWithHistoryImpl` intentional path)

#### API Layer
- `POST /api/arcs/:id/branch` body `{fromSessionId: string, fromMessageSeq?: number, prompt: string, mode?: string, title?: string}`
- Response 201: `{newArcId: string, newSessionId: string}`
- Response 400: invalid fromMessageSeq (negative, beyond history length)

---

### B8: `rebindRunner` primitive — orphan recovery: same session, mint new runner_session_id, prior_conversation wrap

**Core:**
- **ID:** rebind-runner-primitive
- **Trigger:** `sendMessageImpl` orphan preflight at `rpc-messages.ts:154-171` detects that the gateway holds a runner with `runner_session_id === ctx.runner_session_id` and `state === 'running'`.
- **Expected:** Server clears `runner_session_id` to null in DO state, appends the user's new message to local history, calls `serializeHistoryForFork(ctx)` to wrap full local history, calls `triggerGatewayDial(ctx, {type:'execute', prompt:<prior_conversation>...</prior_conversation>...})`. Same DO, same sessions row id; the orphaned runner on the VPS is left to die or be reaped (per existing reaper behavior, GH#113).
- **Verify:** P2.test_cases.rebind-runner-orphan-path + rebind-runner-from-sendmessage. Integration: simulate an orphan via gateway test stub returning a session matching runner_session_id; sendMessage with `{prompt:'continue'}`; assert (a) runner_session_id cleared, (b) `triggerGatewayDial` called with type='execute' and prompt containing `<prior_conversation>`, (c) sessions row id unchanged.
**Source:** new file `apps/orchestrator/src/agents/session-do/rebind-runner.ts`; replaces `forkWithHistoryImpl` orphan path

#### Data Layer
- DO state mutation: `runner_session_id` set to null
- Local history append: new user message persisted via `safeAppendMessage`

---

### B9: `forkWithHistoryImpl` and `handleModeTransitionImpl` removed

**Core:**
- **ID:** legacy-paths-removed
- **Trigger:** P2 implementation lands.
- **Expected:** File `apps/orchestrator/src/agents/session-do/mode-transition.ts` deleted entirely. Function `forkWithHistoryImpl` removed from `agents/session-do/branches.ts`. Class methods `handleModeTransition()` and `forkWithHistory()` removed from `SessionDO` facade in `agents/session-do/index.ts`. All callers updated: `gateway-event-handler.ts:712` (mode_transition trigger) → no longer calls anything (just logs the kata_state mode delta); `rpc-messages.ts:164` (orphan path) → calls `rebindRunnerImpl` instead. Helper `serializeHistoryForFork()` PRESERVED in branches.ts because `branchArcImpl` and `rebindRunnerImpl` both reuse it.
- **Verify:** P2.test_cases.fork-with-history-removed + mode-transition-removed. `grep -rn forkWithHistoryImpl handleModeTransitionImpl apps/orchestrator/src/` returns zero matches. `git log -p` shows file deletion of `mode-transition.ts`.
**Source:** `apps/orchestrator/src/agents/session-do/mode-transition.ts` (delete); `branches.ts` (delete `forkWithHistoryImpl`); `index.ts` (remove class methods); `gateway-event-handler.ts:712` (remove call)

---

### B10: Auto-advance gate relaxed — drops kata `runEnded` evidence dependency

**Core:**
- **ID:** auto-advance-gate-relaxed
- **Trigger:** Session emits terminal `stopped` event; `gateway-event-handler.ts:656-660` decides whether to auto-advance.
- **Expected:** New gate (in order): (1) `terminate_reason === 'stopped'` (clean exit). Errors and crashes do NOT auto-advance. (2) User pref enabled (per-arc override + global default; same logic as today). (3) Idempotency: no in-flight successor session for `(arcId, nextMode)` — the partial unique index from B2 enforces this at insert; the gate checks first to fail-fast. (4) Worktree available if `nextMode` is code-touching (`{implementation, verify, debug, task}`). The kata `run-end.json` evidence file check that today's gate uses (`auto-advance.ts:173-177`, GH#73) is REMOVED. Auto-advance becomes kata-agnostic: any session that exits cleanly triggers the next session in the arc, regardless of kata methodology state.
- **Verify:** P2.test_cases.advance-arc-gate-relaxed: simulate `stopped` event without writing `run-end.json` to evidence dir; assert auto-advance fires anyway (one new session row created in arc). Negative test: `terminate_reason='error'` → no auto-advance.
**Source:** auto-advance gate logic moves from `lib/auto-advance.ts:136-242` into `agents/session-do/advance-arc.ts`; `lib/auto-advance.ts` deleted at end of P2 (or P5)

---

### B11: `/api/arcs` CRUD surface; `/api/chains` deleted outright (no compat stubs — #115 has shipped)

**Core:**
- **ID:** api-arcs-surface
- **Trigger:** P3 implementation lands.
- **Expected:** New endpoints: `POST /api/arcs` (create), `GET /api/arcs` (list with filters: mine/lane/column/project/stale), `GET /api/arcs/:id` (detail), `PATCH /api/arcs/:id` (rename, status change), `POST /api/arcs/:id/sessions` (B6), `POST /api/arcs/:id/branch` (B7), `POST /api/arcs/:id/close` (sets status='closed'), `POST /api/arcs/:id/archive` (sets status='archived'). Old endpoints deleted in the same phase: `GET /api/chains`, `GET /api/chains/:issue/spec-status`, `GET /api/chains/:issue/vp-status`, `POST /api/chains/:issue/checkout`, `POST /api/chains/:issue/release`, `POST /api/chains/:issue/force-release`. Worktree ops migrate to `/api/worktrees/*` (already live from #115). Client callers that still hit the old worktree-op routes are rewired in P4a's identifier sweep so the server-side delete and the client-side rewire ship coordinated. No transition window, no compat stubs — pre-prod, single coordinated deploy.
- **Verify:** P3.test_cases.* (post-arcs-creates, post-arcs-duplicate-409, post-arcs-sessions-advance, post-arcs-branch, chains-routes-deleted).
**Source:** `apps/orchestrator/src/api/index.ts` (or new `api/arcs.ts` module)

#### API Layer (full route table)
| Method | Path | Body / Params | Response |
|---|---|---|---|
| `POST` | `/api/arcs` | `{title, externalRef?, parentArcId?}` | `201 {arcId}` / `409 {ok:false, existingArcId}` |
| `GET` | `/api/arcs` | `?mine, ?lane, ?column, ?project, ?stale` | `200 {arcs: ArcSummary[], more_issues_available: boolean}` |
| `GET` | `/api/arcs/:id` | — | `200 {arc: ArcSummary}` / `404` |
| `PATCH` | `/api/arcs/:id` | `{title?, status?}` | `200 {arc: ArcSummary}` |
| `POST` | `/api/arcs/:id/sessions` | `{mode?, prompt, agent?}` | `201 {sessionId, arcId}` |
| `POST` | `/api/arcs/:id/branch` | `{fromSessionId, fromMessageSeq?, prompt, mode?, title?}` | `201 {newArcId, newSessionId}` |
| `POST` | `/api/arcs/:id/close` | — | `200 {arc: ArcSummary}` |
| `POST` | `/api/arcs/:id/archive` | — | `200 {arc: ArcSummary}` |

---

### B12: WS sync frame `syncFrameType: 'chains'` renamed to `'arcs'`; hard switch in single deploy

**Core:**
- **ID:** ws-frame-renamed
- **Trigger:** P3 implementation lands.
- **Expected:** Server emits `{collection: 'arcs', ops: [...]}` deltas via the `synced-collection-delta` WS frame mechanism. Client `arcsCollection` subscribes by listening for `collection: 'arcs'`. NO dual-emit during transition — pre-prod, no version skew concern, single coordinated deploy. `db/chains-collection.ts` renamed to `db/arcs-collection.ts`; `id: 'chains'` → `id: 'arcs'`; `queryKey: ['chains']` → `queryKey: ['arcs']`.
- **Verify:** P3.test_cases.ws-frame-renamed: integration test with WS test harness — assert deltas come through with `collection:'arcs'`; assert `arcsCollection` receives them.
**Source:** `apps/orchestrator/src/db/chains-collection.ts` (rename + reshape); `apps/orchestrator/src/agents/user-settings-do/` (server-side fanout); `lib/broadcast-arc.ts` (renamed)

---

### B13: `arcsCollection` replaces `chainsCollection`; `ArcSummary` type replaces `ChainSummary`

**Core:**
- **ID:** client-collection-renamed
- **Trigger:** P4 implementation lands.
- **Expected:** Client-side `chainsCollection` import replaced with `arcsCollection` across all subscribers: `KanbanBoard.tsx`, `KanbanLane.tsx`, `KanbanColumn.tsx`, `KanbanCard.tsx`, `chain-status-item.tsx` (renamed `arc-status-item.tsx`). Type `ChainSummary` replaced with `ArcSummary` everywhere. The transition alias `type ChainSummary = ArcSummary` (added in P1 for forward-compat) is dropped in P5 once all sites are migrated.
- **Verify:** P4.test_cases.kanban-renders-from-arcs + string-sweep (`grep -rn chainsCollection apps/orchestrator/src/` returns no matches).
**Source:** all client files listed above

#### UI Layer
- KanbanBoard renders lanes (issue type) × columns (kanban phase) from `arcsCollection`
- KanbanCard props change from `chain: ChainSummary` to `arc: ArcSummary`; references like `chain.issueNumber` become `arc.externalRef?.id`
- Kanban *component names* preserved (KanbanBoard/Lane/Column/Card stay as-is per interview decision: layout-pattern naming over domain naming)

---

### B14: `ArcStatusItem` renamed from `ChainStatusItem`; kanban derives column from sessions.mode at query time

**Core:**
- **ID:** arc-status-item
- **Trigger:** P4 implementation lands.
- **Expected:** File `components/chain-status-item.tsx` renamed to `components/arc-status-item.tsx`. Component reads `arcsCollection` to find the current arc; renders the same rung ladder UI (research → planning → implementation → verify → close) computed from the arc's sessions. The "kata: <currentMode>/<currentPhase>" text label at line 231 IS PRESERVED (kata UI labels stay per interview decision: methodology framing remains visible). The kanban-column derivation logic moves to `lib/arcs.ts:deriveColumn(sessions, arcStatus)` — same algorithm as today's `lib/chains.ts:166-189`, just reading `mode` instead of `kataMode`.
- **Verify:** P4.test_cases.kata-ui-labels-preserved: ArcStatusItem renders 'kata: planning/p2' label (or whatever kata's current state is); P4.test_cases.kanban-renders-from-arcs verifies kanban grouping works.
**Source:** `components/arc-status-item.tsx` (renamed file); `lib/arcs.ts` (new home for `deriveColumn`)

---

### B15: `/arc/:arcId` route + sidebar 'Arcs' section

**Core:**
- **ID:** arc-detail-route
- **Trigger:** P4 implementation lands.
- **Expected:** New TanStack Router route `apps/orchestrator/src/routes/_authenticated/arc.$arcId.tsx`. Component renders arc detail view: editable title, externalRef badge (linked GH issue), worktree reservation badge (if any), session timeline (newest top), branch tree (parent and children if any). Session click navigates to `/?session=:id` (preserves existing tab-by-query-param convention). Breadcrumb back to `/board` and `/`. Sidebar (`components/layout/nav-sessions.tsx`) gains a new 'Arcs' section above 'Worktrees': `useLiveQuery(arcsCollection)` filtered to status IN ('open','draft'), rendering each as a collapsible group; sessions nest below when expanded. Implicit single-session arcs (no externalRef AND only one session) render as flat session items (no expand chevron, no group label) so today's flat-session UX for debug/freeform sessions is preserved.
- **Verify:** P4.test_cases.arc-detail-route + sidebar-arcs-section.
**Source:** new file `routes/_authenticated/arc.$arcId.tsx`; modified `components/layout/nav-sessions.tsx`

#### UI Layer
- New route component renders arc detail
- Sidebar grows from 2 sections (Recent, Worktrees) to 3 (Recent, Arcs, Worktrees)
- Implicit single-session arcs render as flat sessions (no expand) — preserves debug/freeform UX

---

### B16: Per-message "Branch from here" UI affordance in chat view

**Core:**
- **ID:** in-arc-branch-ui
- **Trigger:** User right-clicks (desktop) or long-presses (mobile) an assistant message in the chat view (`features/agent-orch/AgentDetailView.tsx` or wherever messages render).
- **Expected:** Context menu has 'Branch from here' action. On click, opens a modal with a prompt input. On submit, calls `POST /api/arcs/:id/branch` with `{fromSessionId, fromMessageSeq, prompt}`. After response 201, navigates to `/?session=${newSessionId}`. Optimistic UI: insert a placeholder branch row in the arc detail view's branch tree pending refresh.
- **Verify:** P4.test_cases.per-message-branch.
**Source:** `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx` (or wherever message rendering lives)

#### UI Layer
- Per-message context menu (desktop right-click + mobile long-press)
- Branch creation modal
- Optimistic placeholder in branch tree
- Coexists with the existing dnd-kit long-press for context menus per `feedback_dnd_long_press.md` MEMORY (use `{distance: N}` activation, not `{delay, tolerance}`)

---

### B17: Unique indexes enforce arc and session idempotency

**Core:**
- **ID:** idempotency-indexes
- **Trigger:** Migration lands.
- **Expected:** Two indexes: (1) `idx_arcs_external_ref` — expression unique on `(json_extract(external_ref,'$.provider'), json_extract(external_ref,'$.id'))` WHERE external_ref IS NOT NULL. Prevents duplicate arcs for the same GH issue. INSERT with conflict throws; handler returns 409 with existing arc id. (2) `idx_agent_sessions_arc_mode_active` — partial unique on `(arcId, mode)` WHERE status IN ('idle','pending','running'). Fixes today's auto-advance race where two simultaneous `stopped` events could spawn duplicate successors. INSERT with conflict throws; handler returns 409 with existing session id.
- **Verify:** P2.test_cases.advance-arc-idempotency (concurrent advance → exactly one new session); P3.test_cases.post-arcs-duplicate-409 (concurrent arc creation with same externalRef → second returns 409).
**Source:** migration `0032_arcs_first_class.sql` step (8); schema definitions in `db/schema.ts`

---

## Non-Goals

- **#115 (worktrees as first-class resource) implementation.** This spec depends on #115's worktrees table and `/api/worktrees/*` endpoints, but those are owned by issue #115. **#115 has merged.** This amended spec reflects the post-merge schema state.
- **Kata methodology changes.** Kata still prescribes `research / planning / implementation / verify / debug / task / freeform` modes; phase tracking (p0/p1/p2 within a mode) stays in `.kata/sessions/{id}/state.json`. The orchestrator schema does not gain a `phase` column. UI labels like "Kata: planning/p2" in `KataStatePanel` and `ArcStatusItem` are PRESERVED.
- **DO topology changes.** DO = Session stays. The decision about whether arc-level state should live in DO (vs D1) was settled in the issue: DOs are disposable; D1 owns arc-level state.
- **Multi-tenancy / shared arcs.** Single-user invariants unchanged. `arcs.userId NOT NULL FK→users.id`. No cross-user arc visibility.
- **Native SDK `resume` for `rebindRunner`.** The interview considered SDK `resume` (clean swap of runner_session_id, runner reads on-disk session file) as an alternative to the `<prior_conversation>` wrap. Rejected: hasLiveResume collision risk if a zombie orphan reconnects mid-resume. Wrap-and-execute path is robust against any orphan-runner state.
- **Same-DO `handleModeTransition`.** Today's "research → planning preserves chat thread visually" UX is dropped. Every phase change spawns a new session row. UX shifts to "phase timeline view per arc". Bookmark this as an architectural bet — reverting requires reintroducing same-DO mode rotation, a non-trivial primitive.
- **Native SDK `resume` for cross-deploy resume.** The existing idle-resume path (DO state idle, runner_session_id present, sendMessage triggers `resume`) is unchanged by this spec. `rebindRunner` is the orphan-recovery primitive only.
- **D1 CHECK constraints on arc.status enum.** Per the rest of the schema's pattern (e.g., `agent_sessions.status` is text without CHECK), validation lives in app layer. If we ever need DB-level guarantees, that's a follow-up migration.
- **Per-tool-type kanban columns.** Kanban columns stay as today's mode-derived ladder (backlog/research/planning/implementation/verify/done). No "debug column", no "freeform column".
- **Push notifications for branch events.** Branch creation does not fire a push. Only the existing gate-arrival push triggers persist.
- **Kata writing structured `phase` JSON.** Mode is plain text; kata writes `state.currentMode` as a string and the orchestrator's `sessions.mode` column is `text`. No JSON shape on phase.
- **Removing `kataStateJson` column.** This column is preserved on sessions for UI panel rendering (KataStatePanel reads it for display). Only the three columns kataMode/kataIssue/kataPhase are dropped.
- **Migrating prod data.** Pre-prod; each developer has their own local D1 state. The migration script tested in vitest covers the patterns; no separate production migration runbook.

## Implementation Phases

See frontmatter for full task + test_case breakdowns.

### Phase 1: Schema + single-drop migration

- New `arcs` table with externalRef tuple, draft/open/closed/archived status, parentArcId FK
- `agent_sessions` gains `arcId`/`mode`/`parentSessionId` columns; `kataMode`/`kataIssue`/`kataPhase` dropped (no rename — see Gotcha #13)
- `arcs.worktreeId` backfilled from `agent_sessions.worktreeId` (#115's worktrees primitive owns reservation lifecycle)
- Implicit-arc auto-creation in createSession
- Tests: migration round-trip across the three patterns (chain shape, orphan, worktree-linked)
- **Done when:** `pnpm test --filter @duraclaw/orchestrator -- migration-test arcs` passes; manually verified on a seeded local D1 that round-trip migration produces correct arc + session topology
- **Rollback:** Migration is destructive (drops columns, adds columns). Roll back by either (a) restoring from a pre-migration D1 backup if available, or (b) writing a reverse migration that reverses the column adds/drops. Pre-prod, so rollback is "wipe local D1, re-run dev-up"

### Phase 2: Three primitives — advanceArc, branchArc, rebindRunner

- New: `advanceArcImpl`, `branchArcImpl`, `rebindRunnerImpl` modules
- Deleted: `mode-transition.ts` entire file; `forkWithHistoryImpl` function; class methods `handleModeTransition`/`forkWithHistory`
- `sendMessageImpl` orphan preflight rewired to `rebindRunnerImpl`
- Auto-advance gate relaxed (drops `runEnded` evidence file check)
- Tests: three primitives unit tests + idempotency stress test
- **Done when:** `pnpm test` passes; `grep -rn forkWithHistoryImpl handleModeTransitionImpl` returns zero matches; smoke flow covers advance + branch + orphan recovery
- **Rollback:** P1 schema is independent of P2 logic. Revert P2 commits to restore old paths; old paths still compile against the new schema (they read sessions.mode instead of sessions.kataMode)

### Phase 3: API surface + WS frame rename

- New: `/api/arcs` CRUD endpoints (POST, GET, GET/:id, PATCH/:id, /:id/sessions, /:id/branch, /:id/close, /:id/archive)
- Deleted (all in P3, no compat-stub interim — #115 has shipped): `/api/chains`, `/api/chains/:issue/spec-status`, `/api/chains/:issue/vp-status`, `/api/chains/:issue/checkout|release|force-release`. Worktree ops migrate to `/api/worktrees/*` (live since #115)
- WS frame rename: `syncFrameType: 'chains'` → `'arcs'`; `chainsCollection` → `arcsCollection` (renamed file)
- Tests: API contract tests for each endpoint + idempotency 409 scenario + WS frame integration
- **Done when:** `pnpm test --filter @duraclaw/orchestrator -- arcs.test` passes; `pnpm typecheck` clean
- **Rollback:** Revert P3 commits. WS frame name is a coordinated change between server and client; rollback restores both. P1+P2 schema and primitives are independent

### Phase 4a: UI surface — identifier sweep + kanban data shape

P4 was split into two sub-phases for feasibility (P4-as-one was ~9 task bullets touching ~15 files). P4a is the rename-heavy half: client-side renames, kanban data shape, string literals, deriveColumn unit tests. No new components, no new routes — purely a rename + reshape pass.

- Identifier sweep: `chainsCollection` → `arcsCollection`, `ChainSummary` → `ArcSummary`, hooks `use-chain-*` → `use-arc-*`, `chain-status-item.tsx` → `arc-status-item.tsx`
- Kanban data shape: card props from `chain: ChainSummary` to `arc: ArcSummary`; component names preserved (KanbanBoard/Lane/Column/Card stay as-is)
- String literal updates in kanban + advance modal
- New `deriveColumn` unit tests (split from chains.test.ts) covering 6 fixture cases
- **Done when:** `pnpm typecheck` + `pnpm test` green; `/board` renders kanban from arcs; `grep -rn chainsCollection apps/orchestrator/src/` returns zero matches; `grep -rn 'No chains' apps/orchestrator/src/` returns zero matches
- **Rollback:** Revert P4a commits. P3 server emits arc deltas; client without P4a won't render them but won't crash (ChainSummary alias from P1 still resolves)

### Phase 4b: UI surface — /arc/:arcId route, sidebar Arcs section, per-message branch UI

P4b is the additive half: brand-new route component, new sidebar section, new context-menu affordance. None of these existed before. Splitting from P4a means a clean break point: P4a can ship and verify without P4b's UX rewrites in flight.

- New TanStack Router route `_authenticated/arc.$arcId.tsx` with arc detail view (editable title, session timeline, branch tree)
- Sidebar gains 'Arcs' section between 'Recent' and 'Worktrees'; implicit single-session arcs render as flat sessions
- Per-message "Branch from here" UI affordance (context menu + modal + POST /api/arcs/:id/branch + navigate)
- Unit tests for the implicit-arc filter logic
- **Done when:** Manual smoke flow exercises arc detail route loads, sidebar shows three sections, per-message branch creates new arc + session and navigates correctly
- **Rollback:** Revert P4b commits. P4a-shipped UI continues to work (kanban, status item, hooks all stable). New route returns 404 (no entry left in router config), sidebar reverts to two sections

### Phase 5: Cleanup, kata writer validation, naming sweep, full verify

- Kata writer pre-write validation: `state.currentMode` ∈ registered modes from `kata.yaml`
- Identifier sweep — second pass for stragglers (comments, jsdoc)
- Drop `type ChainSummary = ArcSummary` alias from lib/types.ts
- Update `.claude/rules/session-lifecycle.md` to describe the three new primitives
- Update CLAUDE.md Architecture section
- Final smoke + full test suite
- **Done when:** `pnpm build && pnpm typecheck && pnpm test` all green; `grep -rn 'chainsCollection\|ChainSummary\|buildChainRow\|chain-status-item\|use-chain-' apps/ packages/ | grep -v node_modules | grep -v '.test.'` returns zero matches; smoke flow exercises full lifecycle
- **Rollback:** P5 is mostly cleanup; revert returns the `ChainSummary` alias and any sweep-renamed identifiers. Doesn't break P1-P4 functionality

## Verification Plan

### VP1: Migration round-trip on seeded local D1

```
1. cd apps/orchestrator
2. pnpm test -- migration-test                      # expect: migration-roundtrip-* tests pass
3. # Confirm three round-trip cases pass:
   #   - chain-pattern (two sessions kataIssue=42 → one arc, both arcId=arc-42)
   #   - orphan (session kataIssue=null → implicit arc with title from prompt)
   #   - arc-worktree-backfilled (arc 99 has worktreeId matching the seed session's worktreeId)
4. # Manual smoke:
   wrangler d1 execute duraclaw_local --command "SELECT name FROM sqlite_master WHERE type='table'"
   # expect: 'arcs' present, 'agent_sessions' present (still), 'worktrees' present (from #115's migration 0031)
   wrangler d1 execute duraclaw_local --command "PRAGMA table_info(agent_sessions)"
   # expect: kata_mode, kata_issue, kata_phase columns absent; arc_id, mode, parent_session_id columns present
5. wrangler d1 execute duraclaw_local --command "SELECT count(*) FROM arcs"
   # expect: matches the count of distinct (userId, kataIssue) pairs + orphan sessions in pre-migration agent_sessions
```

### VP2: advanceArc primitive — POST /api/arcs/:id/sessions

```
1. # Start dev: scripts/verify/dev-up.sh
2. # Create an arc via the new endpoint:
   curl -X POST http://localhost:43537/api/arcs \
     -H "Content-Type: application/json" \
     -d '{"title":"Test arc","externalRef":{"provider":"github","id":999,"url":"https://github.com/test/repo/issues/999"}}'
   # expect: 201 with {arcId}
3. # Spawn first session in the arc:
   curl -X POST http://localhost:43537/api/arcs/<arcId>/sessions \
     -H "Content-Type: application/json" \
     -d '{"mode":"research","prompt":"Investigate X"}'
   # expect: 201 with {sessionId, arcId}
4. # Wait for session to complete (or send /interrupt then /stop)
5. # Spawn second session in the same arc — this is the advance:
   curl -X POST http://localhost:43537/api/arcs/<arcId>/sessions \
     -H "Content-Type: application/json" \
     -d '{"mode":"planning","prompt":"Plan based on research"}'
   # expect: 201 with new sessionId; arcId same; the previous session row goes to status='idle'
6. # Verify in D1:
   wrangler d1 execute duraclaw_local --command \
     "SELECT id, mode, status, parentSessionId FROM agent_sessions WHERE arcId = '<arcId>' ORDER BY createdAt"
   # expect: two rows, first mode=research status=idle, second mode=planning status=running parentSessionId=<first.id>
```

### VP3: Concurrent advance — idempotency

```
1. # Setup: arc with one running session
2. # Fire two simultaneous advance requests in parallel:
   curl -X POST http://localhost:43537/api/arcs/<arcId>/sessions \
     -H "Content-Type: application/json" -d '{"mode":"planning","prompt":"go"}' &
   curl -X POST http://localhost:43537/api/arcs/<arcId>/sessions \
     -H "Content-Type: application/json" -d '{"mode":"planning","prompt":"go"}' &
   wait
3. # Verify exactly two sessions in arc (one prior + one successor), not three:
   wrangler d1 execute duraclaw_local --command \
     "SELECT count(*) FROM agent_sessions WHERE arcId = '<arcId>'"
   # expect: 2
4. # Confirm one of the two POSTs returned 409 with the existing successor's id
   # (the partial unique index `idx_agent_sessions_arc_mode_active` enforced at insert)
```

### VP4: branchArc primitive — POST /api/arcs/:id/branch

```
1. # Setup: arc 'parent-arc' with at least 5 messages exchanged in a session
2. # Branch from message seq 3:
   curl -X POST http://localhost:43537/api/arcs/<parent-arc-id>/branch \
     -H "Content-Type: application/json" \
     -d '{"fromSessionId":"<sessionId>","fromMessageSeq":3,"prompt":"Try a different approach"}'
   # expect: 201 with {newArcId, newSessionId}
3. # Verify new arc exists with parentArcId set:
   wrangler d1 execute duraclaw_local --command \
     "SELECT id, title, parentArcId, externalRef FROM arcs WHERE id = '<newArcId>'"
   # expect: parentArcId='<parent-arc-id>'; externalRef inherited from parent; title='<parent.title> — side arc'
4. # Verify new session prompt contains <prior_conversation> wrapping first 3 messages:
   wrangler d1 execute duraclaw_local --command \
     "SELECT prompt FROM agent_sessions WHERE id = '<newSessionId>'"
   # expect: prompt starts with '<prior_conversation>' and contains 3 'User:' / 'Assistant:' role lines
5. # Navigate UI to /arc/<parent-arc-id>; assert 'side arcs (1)' link visible; click → /arc/<newArcId>
```

### VP5: rebindRunner via orphan recovery

```
1. # Setup: spawn a session, wait for it to be running with a runner_session_id
2. # Simulate an orphan: kill -SIGSTOP the runner process (so it's "alive" to gateway but unresponsive)
   pgrep -f "session-runner.*<sessionId>" | xargs kill -STOP
3. # In the browser, send another message to the session
4. # Expected behavior in the DO logs (wrangler tail apps/orchestrator):
   #   - logEvent 'gate' or similar showing orphan preflight detected
   #   - rebindRunnerImpl invoked
   #   - runner_session_id cleared in DO state
   #   - triggerGatewayDial fired with type='execute' and prompt containing <prior_conversation>
5. # Verify D1 has the same session id (NOT a new session row):
   wrangler d1 execute duraclaw_local --command \
     "SELECT id, runner_session_id FROM agent_sessions WHERE id = '<sessionId>'"
   # expect: same id, runner_session_id changed (new value after rebind)
6. # Cleanup: kill -CONT the original runner so it can exit naturally; reaper handles cleanup
```

### VP6: Auto-advance gate relaxation — clean stop without runEnded evidence

```
1. # Setup: create an arc with a research-mode session
2. # Send /stop to the runner (or wait for SDK's natural completion)
3. # Critically: do NOT write run-end.json to the kata evidence dir (simulate kata not writing it)
4. # Expected: orchestrator auto-advance gate fires anyway
5. # Verify next session was spawned:
   wrangler d1 execute duraclaw_local --command \
     "SELECT count(*) FROM agent_sessions WHERE arcId = '<arcId>'"
   # expect: 2 (research + planning successor)
6. # Negative test: kill -9 the runner instead of /stop. terminate_reason should be 'crashed' not 'stopped'.
   # Verify auto-advance does NOT fire (only one session row in arc).
```

### VP7: WS frame rename — `chains` → `arcs`

```
1. # Open browser at http://localhost:43537/board
2. # Open DevTools → Network → WS tab → click the open WS connection → Messages
3. # Trigger an arc-row update (e.g., advance a session)
4. # Expected frame: {type:'synced-collection-delta', collection:'arcs', ops:[{type:'upsert', key:'<arcId>', value:{...ArcSummary}}]}
5. # NOT 'collection:chains' — this is the renamed channel
6. # Confirm: grep -rn 'syncFrameType.*chains' apps/orchestrator/src/ returns zero matches
```

### VP8: Sidebar 'Arcs' section + per-message branch UI

```
1. # Open http://localhost:43537/
2. # Verify sidebar has three sections in order: Recent, Arcs, Worktrees
3. # Implicit single-session arcs (debug/freeform sessions) appear as flat session rows in Arcs (no expand chevron)
4. # Multi-session arcs (with externalRef) appear as collapsible groups; click expand → sessions nest below
5. # Open a session in the chat view; right-click an assistant message
6. # Expected: context menu with 'Branch from here' action
7. # Click 'Branch from here'; modal opens; type 'Try Y'; submit
8. # Expected: modal closes; navigation to /?session=<newSessionId>
9. # Verify in /arc/<arcId>: branch tree shows the new side arc as a child node
```

### VP9: Kata writer validation — invalid mode rejected

```
1. cd packages/kata
2. # In a test or REPL:
   import { writeState } from './src/state/writer'
   await writeState('test-session', { currentMode: 'foobar', ... })
   # expect: throws Error: Mode 'foobar' not registered in kata.yaml
3. await writeState('test-session', { currentMode: 'planning', ... })  # registered
   # expect: succeeds
4. await writeState('test-session', { currentMode: undefined, ... })  # null mode
   # expect: succeeds (null is fine, just skip validation)
```

### VP10: Naming sweep — final grep gates

```
1. # From repo root:
2. grep -rn --include='*.ts' --include='*.tsx' \
     'chainsCollection\|ChainSummary\|buildChainRow\|ChainBuildContext\|broadcastChainRow\|broadcastChainUpdate\|chain-status-item\|use-chain-' \
     apps/ packages/ | grep -v node_modules | grep -v '\.test\.' | grep -v '/migrations/'
   # expect: zero matches (all renamed in P1-P5)
3. grep -rn 'kataMode\|kataIssue\|kataPhase' apps/ packages/ | grep -v node_modules | grep -v '/migrations/'
   # expect: zero matches in source (only allowed in migration files which document the drop)
4. # Note: kataStateJson is allowed (column preserved); kataState (event field name) is allowed
5. # 'Kata' in user-visible UI strings is allowed (kata-methodology label preserved)
```

## Implementation Hints

### Key Imports

- `~/db/schema` — `arcs`, `agentSessions` Drizzle table definitions
- `~/lib/arcs` (NEW) — `parseExternalRef`, `formatExternalRef`, `buildArcRow`, `buildArcRowFromContext`, `deriveColumn`, `COLUMN_QUALIFYING_MODES`
- `~/lib/types` — `ArcSummary`, transitional `type ChainSummary = ArcSummary`
- `~/agents/session-do/advance-arc` (NEW) — `advanceArcImpl`, `advanceArcGate`
- `~/agents/session-do/branches` — `branchArcImpl`, `serializeHistoryForFork` (KEEP); `forkWithHistoryImpl` (DELETE)
- `~/agents/session-do/rebind-runner` (NEW) — `rebindRunnerImpl`
- `~/db/arcs-collection` (RENAMED from `chains-collection`) — `arcsCollection`
- `~/components/arc-status-item` (RENAMED from `chain-status-item`) — `ArcStatusItem`

### Code Patterns

**Pattern 1 — `arcs` table Drizzle definition.** Mirror the existing `agentSessions` shape but with arc fields. Use `text` for JSON columns (D1 doesn't have a native JSON type; we serialize via `JSON.stringify` on write and `JSON.parse` on read). Indexes use the same `index('idx_name')` pattern as the rest of `db/schema.ts`.

```typescript
export const arcs = sqliteTable('arcs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  externalRef: text('external_ref'),  // JSON: {provider,id,url?}
  worktreeId: text('worktree_id'),    // FK to worktrees.id (added by #115's migration 0031); nullable for arc-less / read-only arcs
  status: text('status').notNull().default('draft'),
  parentArcId: text('parent_arc_id'),  // self-FK for side arcs; runtime check
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  closedAt: text('closed_at'),
}, (t) => ({
  externalRefUnique: uniqueIndex('idx_arcs_external_ref')
    .on(sql`json_extract(${t.externalRef}, '$.provider')`, sql`json_extract(${t.externalRef}, '$.id')`)
    .where(sql`${t.externalRef} IS NOT NULL`),
  userStatusActivity: index('idx_arcs_user_status_lastactivity').on(t.userId, t.status),
}))
```

**Pattern 2 — `advanceArcImpl` skeleton.** The DO already has helpers for closing a session and minting via `createSession`. Reuse them.

```typescript
// apps/orchestrator/src/agents/session-do/advance-arc.ts
export async function advanceArcImpl(
  ctx: SessionDOContext,
  args: { mode?: string; prompt: string; agent?: string },
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const arcId = ctx.session.arcId
  if (!arcId) return { ok: false, error: 'session has no arcId (corrupt state)' }

  // Close current session (set status='idle', broadcast)
  await ctx.do.updateState({ status: 'idle' })
  await broadcastSessionRow(ctx)

  // Create successor session in same arc
  const newSession = await createSession(ctx.env, ctx.db, {
    userId: ctx.userId,
    project: ctx.session.project,
    arcId,
    mode: args.mode ?? null,
    prompt: args.prompt,
    agent: args.agent ?? 'claude',
    parentSessionId: ctx.session.id,
  })
  return { ok: true, sessionId: newSession.id }
}
```

**Pattern 3 — `rebindRunnerImpl` (mostly copy of today's forkWithHistoryImpl orphan path).**

```typescript
// apps/orchestrator/src/agents/session-do/rebind-runner.ts
export async function rebindRunnerImpl(
  ctx: SessionDOContext,
  args: { nextUserMessage?: string | ContentBlock[] },
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.session.project) return { ok: false, error: 'session has no project' }

  // Append user message to local history (if provided)
  if (args.nextUserMessage) {
    const userMsg = makeUserMessage(args.nextUserMessage)
    await safeAppendMessage(ctx, userMsg)
    await persistTurnState(ctx)
    await broadcastMessages(ctx, [userMsg])
  }

  // Wrap full local history
  const transcript = serializeHistoryForFork(ctx)
  const nextText = typeof args.nextUserMessage === 'string'
    ? args.nextUserMessage
    : extractText(args.nextUserMessage)
  const wrappedPrompt = transcript
    ? `<prior_conversation>\n${transcript}\n</prior_conversation>\n\nContinuing the conversation above. New user message follows.\n\n${nextText}`
    : nextText

  // Clear runner_session_id and dial fresh
  await ctx.do.updateState({ runner_session_id: null })
  await triggerGatewayDial(ctx, { type: 'execute', prompt: wrappedPrompt })
  return { ok: true }
}
```

**Pattern 4 — Migration backfill SQL skeleton.** Per Gotcha #11, no top-level `BEGIN/COMMIT` — D1 auto-commits DDL regardless. Statements are sequenced so each step depends only on prior DDL having committed.

```sql
-- 0032_arcs_first_class.sql
-- NOTE: No BEGIN/COMMIT — D1 auto-commits DDL.
-- Workflow-level atomicity: wrangler stops on first failure; dev wipes local D1 to retry.

-- 1. Create arcs table
CREATE TABLE arcs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  external_ref text,
  worktree_id text REFERENCES worktrees(id),  -- worktrees table added by #115's migration 0031
  status text NOT NULL DEFAULT 'draft',
  parent_arc_id text REFERENCES arcs(id),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  closed_at text
);
CREATE UNIQUE INDEX idx_arcs_external_ref
  ON arcs(json_extract(external_ref, '$.provider'), json_extract(external_ref, '$.id'))
  WHERE external_ref IS NOT NULL;
CREATE INDEX idx_arcs_user_status_lastactivity ON arcs(user_id, status);

-- 2. Backfill: one arc per (userId, kataIssue) pair
INSERT INTO arcs(id, user_id, title, external_ref, status, created_at, updated_at)
SELECT
  'arc_' || lower(hex(randomblob(8))) AS id,
  user_id,
  COALESCE('Issue #' || kata_issue, 'Untitled arc') AS title,
  json_object('provider', 'github', 'id', kata_issue, 'url', 'https://github.com/baseplane-ai/duraclaw/issues/' || kata_issue) AS external_ref,
  'open' AS status,
  MIN(created_at) AS created_at,
  MAX(COALESCE(last_activity, created_at)) AS updated_at
FROM agent_sessions
WHERE kata_issue IS NOT NULL
GROUP BY user_id, kata_issue;

-- 3. Backfill orphan sessions (kata_issue IS NULL): one implicit arc per session
INSERT INTO arcs(id, user_id, title, external_ref, status, created_at, updated_at)
SELECT
  'arc_orphan_' || s.id AS id,
  s.user_id,
  COALESCE(SUBSTR(s.prompt, 1, 50), 'Untitled session') AS title,
  NULL AS external_ref,
  'draft' AS status,
  s.created_at,
  COALESCE(s.last_activity, s.created_at) AS updated_at
FROM agent_sessions s
WHERE s.kata_issue IS NULL;

-- 4. Add columns to agent_sessions
ALTER TABLE agent_sessions ADD COLUMN arc_id text;
ALTER TABLE agent_sessions ADD COLUMN mode text;
ALTER TABLE agent_sessions ADD COLUMN parent_session_id text;

-- 5. Backfill arc_id: kata-linked sessions
UPDATE agent_sessions
SET arc_id = (
  SELECT a.id FROM arcs a
  WHERE a.user_id = agent_sessions.user_id
    AND json_extract(a.external_ref, '$.id') = agent_sessions.kata_issue
)
WHERE kata_issue IS NOT NULL;

-- 6. Backfill arc_id: orphan sessions (one-to-one match by id)
UPDATE agent_sessions
SET arc_id = 'arc_orphan_' || id
WHERE kata_issue IS NULL;

-- 7. Backfill mode from kataMode
UPDATE agent_sessions SET mode = kata_mode;

-- 8. Backfill arcs.worktree_id from agent_sessions.worktree_id
--    (agent_sessions.worktree_id text REFERENCES worktrees(id) was added by #115's migration 0031)
UPDATE arcs SET worktree_id = (
  SELECT s.worktree_id FROM agent_sessions s
  WHERE s.kata_issue = json_extract(arcs.external_ref, '$.id')
    AND s.worktree_id IS NOT NULL
  LIMIT 1
)
WHERE external_ref IS NOT NULL;

-- 9. Drop kata columns
ALTER TABLE agent_sessions DROP COLUMN kata_mode;
ALTER TABLE agent_sessions DROP COLUMN kata_issue;
ALTER TABLE agent_sessions DROP COLUMN kata_phase;

-- 10. Create the new partial unique index for advance idempotency
--     (the four pre-existing agent_sessions indexes are unchanged — modern SQLite
--      preserves indexes across ADD/DROP COLUMN, so no recreate needed)
CREATE UNIQUE INDEX idx_agent_sessions_arc_mode_active
  ON agent_sessions(arc_id, mode)
  WHERE status IN ('idle', 'pending', 'running');
```

**Pattern 5 — `arcsCollection` rename mirror.** Copy of `chains-collection.ts`, two-line change.

```typescript
// apps/orchestrator/src/db/arcs-collection.ts (renamed from chains-collection.ts)
function createArcsCollection() {
  return createSyncedCollection<ArcSummary, string>({
    id: 'arcs',
    queryKey: ['arcs'] as const,
    syncFrameType: 'arcs',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/arcs'))
      if (!resp.ok) throw new Error(`GET /api/arcs ${resp.status}`)
      const json = (await resp.json()) as { arcs: ArcSummary[] }
      return json.arcs
    },
    getKey: (item) => item.id,  // <-- keyed by arc id, not issueNumber
    persistence,
    schemaVersion: 1,  // bump from chains-collection's schemaVersion if persistence has stale data
  })
}
export const arcsCollection = createArcsCollection()
```

### Gotchas

1. **D1 `ALTER TABLE DROP COLUMN`** — SQLite supports it natively as of v3.35 (CF D1 uses recent SQLite). If a partial index references the column being dropped, you must drop the index first. None of our existing indexes reference `kataMode/kataIssue/kataPhase`, so this is safe — but verify with `wrangler d1 execute --command "SELECT * FROM sqlite_master WHERE sql LIKE '%kata_%'"` before running migration in dev.

2. **JSON expression unique index** — the syntax `CREATE UNIQUE INDEX ... ON arcs(json_extract(external_ref, '$.provider'), json_extract(external_ref, '$.id')) WHERE external_ref IS NOT NULL` is valid SQLite but Drizzle's typed builder may not generate it cleanly. Use raw `sql\`...\`` template tags inside the index definition (Pattern 1 example). Verify the generated migration SQL via `pnpm drizzle-kit generate` before hand-writing the file.

3. **Migration is destructive** — there's no automatic reverse. If a migration test fails on a developer's local D1, they need to wipe and re-run dev-up. Document this clearly in the spec body for P1's "rollback" section.

4. **`<prior_conversation>` wrapper has known caveat** — the new runner sees prior turns as "context" not as native SDK history; tool-result re-emission and reasoning blocks may behave subtly differently than a true SDK `resume`. This is the trade-off accepted in interview Round 1 Q-B (option A wins for robustness). Document in the spec's Non-Goals.

5. **`syncFrameType` rename is coordinated** — server emits `arcs`, client subscribes to `arcs`. If only one ships, the other side gets nothing. Use a single deploy that contains both server (P3) and client (P4) changes, OR sequence P3 to land just before P4 in the same dev session before shipping.

6. **Auto-advance gate relaxation drops the `runEnded` evidence file dependency** — kata sessions that USED to need the evidence file to advance no longer do. If a kata session crashes mid-task with `terminate_reason='stopped'` (clean exit but task incomplete), auto-advance still fires. Manually verify in dev that this matches the desired UX before wide release. The B10 negative test covers `terminate_reason='error'` but doesn't probe partial-completion-clean-exit edge cases.

7. **Implicit single-session arcs** — every session creation without an arcId mints an implicit arc. This means MANY new arcs in dev as users spawn debug/freeform sessions. The sidebar Arcs section needs to render these as flat session rows (NOT collapsible groups) to avoid UX regression. UI logic: `arc.externalRef === null && arc.sessions.length === 1 && arc.parentArcId === null` → render flat.

8. **Component naming preserved** (KanbanBoard, KanbanLane, KanbanColumn, KanbanCard) — the rename does NOT extend to layout-pattern component names, only to data identifiers. Verify in the final grep that `KanbanCard` still exists; only `chain` / `Chain` / `chainsCollection` / `ChainSummary` / `useChain*` / `chain-status-item` are gone.

9. **#115 (worktrees as first-class resource) has landed (closed).** `worktrees` table exists in the schema; `agent_sessions.worktreeId text REFERENCES worktrees(id)` was added by migration 0031. `arcs.worktreeId` references `worktrees.id` directly. There is no `worktree_reservations` table any more (dropped in 0031). The original spec's worktree carry-over columns and `worktree_reservations` backfill are no longer needed and have been removed from this amended spec.

10. **Kata UI labels preserved on purpose** — `KataStatePanel` and `ArcStatusItem` continue to render "Kata: planning/p2" labels. This is INTENTIONAL: the schema/identifier purge does not extend to kata methodology labels because kata IS the user-visible methodology layer. Reviewers may flag this as inconsistent with the "purge kata terminology" wording in the issue body — point them to the interview decision.

11. **D1 transaction semantics for DDL** — D1's SQLite implementation does NOT allow `CREATE/ALTER/DROP TABLE` inside an explicit `BEGIN…COMMIT` transaction; DDL auto-commits regardless. The migration is therefore structured as a sequence of statements that wrangler executes serially. **Atomicity is workflow-level**, not transactional: if any statement fails, wrangler marks the migration failed and the dev wipes local D1 to retry. Pre-prod tolerates this (rollback policy in P1). DML statements (INSERT, UPDATE) inside the migration *can* be wrapped in a transaction if needed; the spec's migration script is sequenced so each DML step depends only on the prior DDL having completed (auto-committed). Pattern 4 SQL skeleton intentionally omits BEGIN/COMMIT at the top.

12. **`arcId` NOT NULL is enforced at the Drizzle schema + app layer, not at the DB layer.** SQLite cannot ALTER an existing column to add NOT NULL without a table recreate; given the auth `sessions` table collision (see Gotcha #13), we accept Drizzle's `notNull()` declaration + insert validation as sufficient. Pre-prod tolerates this; if prod ever needs DB-level enforcement, a follow-up migration can do the recreate dance with the table named correctly.

13. **Auth-`sessions` collision** — `apps/orchestrator/src/db/schema.ts:48` exports `sessions` for Better Auth's login session table. The original spec proposed renaming `agent_sessions` → `sessions`; this clobbers the auth identifier. The amended spec keeps `agent_sessions` / `agentSessions` names. All references to "the renamed sessions table" or "post-rename" are stale and have been removed.

### Reference Docs

- **CLAUDE.md** (`/data/projects/duraclaw-dev3/CLAUDE.md`) — architecture diagram and DO observability conventions; the `## Architecture` section gets updated in P5.
- **`.claude/rules/session-lifecycle.md`** — describes today's three progression paths (handleModeTransitionImpl, auto-advance, forkWithHistory orphan); rewritten in P5 to describe the three new primitives.
- **`.claude/rules/orchestrator.md`** — Hono app structure; relevant when adding `/api/arcs` routes.
- **`.claude/rules/worktree-setup.md`** — port derivation; the dev orchestrator port is `43537` (per duraclaw-dev3) used in VP curl examples.
- **`.claude/rules/deployment.md`** — never run `pnpm ship` manually; CI pipeline handles deploy on push to main.
- **MEMORY: `feedback_dnd_long_press.md`** — dnd-kit activation constraint guidance; relevant for B16's per-message context menu (use `{distance: N}`, not `{delay, tolerance}`).
- **`planning/research/2026-04-27-arcs-conversion.md`** — the P0 research doc with full file:line citations across all five subagent dives. Read first if unsure where something lives.
- **GH#115** — worktrees as first-class resource (hard dependency); `/api/worktrees/*` endpoints expected to ship there.
- **GH#73** — kata Stop hook writes `run-end.json` evidence file; B10 explicitly DROPS this dependency from auto-advance.
- **GH#113** — reaper suppression on pending_gate; relevant context for orphan recovery in B8 (rebindRunner doesn't intersect with pending_gate semantics, but reaper behavior in general matters when runners are stuck).
- **Drizzle ORM docs** — https://orm.drizzle.team/docs/sql-schema-declaration#indexes-and-constraints — for the partial unique index syntax (`.where()` chained on `uniqueIndex()`).
- **SQLite `json_extract`** — https://sqlite.org/json1.html#jex — for the expression unique index in B17.
