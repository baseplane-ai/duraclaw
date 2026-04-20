---
initiative: agent-sessions-synced-collection
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 35
created: 2026-04-20
updated: 2026-04-20
phases:
  - id: p1
    name: "Schema + shared-types"
    tasks:
      - "Drizzle migration: add `context_usage_json TEXT`, `worktree_info_json TEXT` to `agent_sessions`; drop `message_count` column"
      - "Drizzle migration: add `project_members` table with composite PK (project_name, user_id), role CHECK constraint, FK cascades"
      - "Extend `SyncedCollectionOp<TRow>` in packages/shared-types with optional `visibleToUserIds?: string[]` on insert / update / delete variants"
      - "Update `AgentSessionRow` type in shared-types: add contextUsageJson, worktreeInfoJson; remove messageCount; keep sdkSessionId on the row"
      - "Add `SessionLocalState` type (id + wsReadyState only) in shared-types; retire `SessionLiveState` type"
    test_cases:
      - "pnpm --filter orchestrator db:migrate applies cleanly on a fresh D1"
      - "pnpm typecheck passes across the workspace"
      - "sqlite3 inspect: new table + columns present; message_count absent"
  - id: p2
    name: "Server broadcast + ACL filter"
    tasks:
      - "Write `broadcastSessionRow(env, ctx, sessionId, op: 'insert' | 'update' | 'delete')` helper in apps/orchestrator/src/lib/broadcast-session.ts: SELECT full row from D1, compute visibleToUserIds, skip if userId==='system', call broadcastSyncedDelta wrapped in ctx.waitUntil"
      - "Write `computeVisibleUserIds(db, projectName, ownerUserId)` helper: `SELECT user_id FROM project_members WHERE project_name = ?` then union with owner; returns string[]"
      - "Extend UserSettingsDO.handleBroadcast in user-settings-do.ts to filter ops per-op by visibleToUserIds before dispatching; update `isSyncedCollectionFrame` validator to accept the new optional field"
      - "Replace `auth !== expected` in user-settings-do.ts:102–104 with `constantTimeEquals` from ~/agents/session-do-helpers"
      - "SessionDO: wire broadcastSessionRow('update') after every syncStatusToD1 / syncResultToD1 / syncSdkSessionIdToD1 / syncKataToD1 call"
      - "SessionDO: add syncContextUsageToD1(json) that writes agent_sessions.context_usage_json (alongside existing session_meta cache write) + broadcastSessionRow; call from the context_usage gateway_event handler"
      - "SessionDO: add syncWorktreeInfoToD1(json) that writes agent_sessions.worktree_info_json + broadcastSessionRow; call from the worktree-resolution path inside kata_state handling"
      - "REST /api/sessions POST: call broadcastSessionRow(sessionId, 'insert') after D1 insert, wrapped in ctx.waitUntil"
      - "REST /api/sessions/:id PATCH: call broadcastSessionRow(sessionId, 'update') after D1 update, wrapped in ctx.waitUntil"
      - "REST /api/sessions/:id/fork POST: call broadcastSessionRow(newSessionId, 'insert') after creating the fork row"
    test_cases:
      - "Unit: broadcastSessionRow skips when row.userId==='system'; calls broadcastSyncedDelta with {value: fullRow, visibleToUserIds} when not"
      - "Unit: UserSettingsDO.handleBroadcast drops ops whose visibleToUserIds excludes this.userId; keeps ops with no visibleToUserIds (back-compat)"
      - "Unit: constantTimeEquals resists trivial timing probes (existing test pattern in session-do.test.ts)"
  - id: p3
    name: "Members API + REST kata-state"
    tasks:
      - "Create `requireAdmin` Hono middleware in apps/orchestrator/src/api/middleware/require-admin.ts: reads better-auth session, asserts `session.user.role === 'admin'`, returns 403 otherwise. (No existing middleware — codebase currently has only scattered `isAdmin` inline checks.)"
      - "Add GET /api/projects/:name/members → {members: Array<{userId, role, createdAt}>}; gated by `requireAdmin` middleware"
      - "Add POST /api/projects/:name/members body {userId, role} → 201 with the inserted member row; gated by `requireAdmin`; FK validation (userId must exist in users table)"
      - "Add DELETE /api/projects/:name/members/:userId → 204; gated by `requireAdmin`; idempotent (404 if pair not found)"
      - "Add GET /api/sessions/:id/kata-state → {state: KataSessionState | null}; auth via getOwnedSession (404 on mismatch); Cache-Control: no-store; reads kv.kata_state blob from SessionDO via an RPC call"
      - "Add SessionDO @callable getKataStateBlob(): Promise<KataSessionState | null> that reads from its local kv table"
    test_cases:
      - "POST /api/projects/duraclaw/members as admin → 201; non-admin → 403"
      - "GET /api/projects/duraclaw/members as admin returns inserted row"
      - "DELETE /api/projects/duraclaw/members/<uid> → 204; subsequent GET omits the row"
      - "GET /api/sessions/<owned-id>/kata-state returns {state: {...}} or {state: null}; Cache-Control header present"
      - "GET /api/sessions/<foreign-id>/kata-state → 404 (not 403)"
  - id: p4
    name: "Client sessionsCollection + consumer migration"
    tasks:
      - "Sub-phase p4.a (foundation): Create apps/orchestrator/src/db/sessions-collection.ts exporting `sessionsCollection` via createSyncedCollection with id:'sessions', syncFrameType:'agent_sessions', queryKey:['sessions'], queryFn: GET /api/sessions, onInsert/onUpdate (throw on onDelete — hard-delete out of scope), OPFS persistence with fresh schemaVersion. New file only — no consumers wired yet; existing sessionLiveStateCollection still intact."
      - "Sub-phase p4.b (local-only narrowing): Rename session-live-state-collection.ts → session-local-collection.ts; narrow SessionLocalState to {id, wsReadyState}; drop the seedSessionLiveStateFromSummary helper; export new `useSessionLocalState(sessionId)` hook. Type-fail the old useSessionLiveState callers intentionally — they'll be fixed in p4.d."
      - "Sub-phase p4.c (hook rewrite): Rewrite apps/orchestrator/src/hooks/use-sessions-collection.ts: delete backfillFromRest + focus/reconnect handlers + the exported `refresh()`; export `useSessionsCollection()` that returns useLiveQuery(sessionsCollection) and `useSession(sessionId)` selector. File should drop to ~10% of pre-migration LOC."
      - "Sub-phase p4.d (consumer migration): Replace every useSessionLiveState call-site (NavSessions, SessionHistory, StatusBar, ChainView, SessionListItem, chain-progress, session-card) with either useSessionsCollection + per-session selector or useSessionLocalState. Use the pre-migration grep output as the checklist; p4.d is complete when the grep returns zero hits."
      - "Sub-phase p4.e (event handler cleanup): In use-coding-agent.ts: update context_usage handler to no-op (synced-collection delta from SessionDO is authoritative); update kata_state handler to `queryClient.invalidateQueries({queryKey:['sessions', sessionId, 'kata-state']})`; stop writing to the retired collection. Keep the wsReadyState write-through effect to sessionLocalCollection (the one field that survives)."
      - "Sub-phase p4.f (messageCount purge): Drop all messageCount references in the client (session cards, list items, history view). `grep -r messageCount apps/orchestrator/src` must return zero hits."
    test_cases:
      - "Sidebar renders session list on cold load without the deleted backfill hooks"
      - "Creating a session via the UI reflects immediately (optimistic); server echo reconciles without flicker"
      - "Cross-browser: user A creates a session in browser 1; browser 2 (same user) shows it within one WS RTT"
      - "typecheck passes; biome passes; no references to useSessionLiveState, messageCount, or sessionLiveStateCollection remain"
  - id: p5
    name: "Verification & cleanup"
    tasks:
      - "Run scripts/axi full verification flow (see Verification Plan) against a worktree-local stack"
      - "Run scripts/verify/axi-dual-login.sh for cross-user fanout: seed project_members, confirm member sees the owner's status transition"
      - "Run scripts/verify/axi-both reconnect: interrupt WS, run turns server-side, reconnect, confirm queryFn resync populates full state"
      - "Confirm orphan (userId='system') sessions appear via REST cold-load but no broadcast fires for them"
      - "Run pnpm test across the workspace; pnpm typecheck; pnpm --filter orchestrator build"
    test_cases:
      - "All automated + manual verify steps in Verification Plan pass"
      - "No console warnings about missing visibleToUserIds, dropped broadcasts, or schema mismatches"
---

## Overview

The sidebar session list (`agent_sessions` — name, project, status, kata phase, turn count, cost, etc.) is the last major data surface in the orchestrator that refreshes by polling REST on mount / window focus / WS reconnect. This spec migrates it onto the `createSyncedCollection` factory landed by GH#32, so every runner-originated state transition (status, numTurns, kataPhase, contextUsage, worktreeInfo, cost, summary) and every user-originated mutation (create, rename, archive, fork) pushes a delta to every tab the owning user has open — and, when project membership is configured, to every member of that project. A minimal `project_members` table + admin-only REST API unlocks cross-user visibility using the hybrid-ACL fanout pattern (`visibleToUserIds` on the frame, `UserSettingsDO` filters per-op).

## Feature Behaviors

### B1: sessions-collection-cold-load

**Core:**
- **ID:** sessions-collection-cold-load
- **Trigger:** Browser mounts the orchestrator React tree with no persisted OPFS data for the `sessions` collection.
- **Expected:** `sessionsCollection`'s `queryFn` fires a single `GET /api/sessions`; response rows populate the collection; `useLiveQuery(sessionsCollection)` emits the rows. No `backfillFromRest`, `window.focus`, or reconnect-backfill handlers run — the factory covers them. The response includes both the caller's own sessions AND sessions in any project where the caller is a member — keeping cold-load visibility symmetric with hot-path broadcast visibility (B10). A member who reloads the page still sees the owner's sessions in their sidebar.
- **Verify:** On a cold browser profile, open the app as user A. Network tab shows exactly one `GET /api/sessions` during bootstrap. Sign out, sign in as user B (added to project `duraclaw` as a member in B9). Reload. Sidebar shows A's sessions in the `duraclaw` project. `sessionLiveStateCollection` is gone from `window.tanstackDb` (or equivalent), replaced by `sessionsCollection` and `sessionLocalCollection`.
- **Source:** new `apps/orchestrator/src/db/sessions-collection.ts`; rewrites `apps/orchestrator/src/hooks/use-sessions-collection.ts`; retires `apps/orchestrator/src/db/session-live-state-collection.ts`; updates `apps/orchestrator/src/api/index.ts:1300` (session list endpoint).

#### API Layer
- `GET /api/sessions` **updated** to be membership-aware. Previous filter `WHERE user_id = ?` is replaced with:
  ```sql
  WHERE user_id = :caller
     OR project IN (SELECT project_name FROM project_members WHERE user_id = :caller)
  ORDER BY last_activity DESC NULLS LAST
  LIMIT 200
  ```
  Orphan rows (`user_id = 'system'`) remain visible via the same symmetric rule the ownership check applies — they match neither the owner branch nor the member branch by default, so they're NOT returned to arbitrary members. The existing behavior of orphans being visible to `getOwnedSession` via the `'system'` placeholder is preserved only for single-user-VPS deployments; deferred to future work.
- Response shape unchanged: `{sessions: AgentSessionRow[]}`.

#### Data Layer
- Row shape at the wire: full `AgentSessionRow` including `sdkSessionId`, new `contextUsageJson` / `worktreeInfoJson`. No `messageCount`.

### B2: full-row-broadcast-on-write

**Core:**
- **ID:** full-row-broadcast-on-write
- **Trigger:** Any code path that writes to `agent_sessions` — REST handlers (POST / PATCH / fork), SessionDO `syncXToD1` helpers, new context-usage / worktree-info write paths.
- **Expected:** Immediately after the D1 write commits, the same handler invokes `broadcastSessionRow(env, ctx, sessionId, op)` where `op: 'insert' | 'update'`. The helper (1) SELECTs the full row by id — if the row no longer exists (race with cascade delete), it is a no-op; (2) computes `visibleToUserIds = (SELECT user_id FROM project_members WHERE project_name = row.project) ∪ {row.userId}`; (3) calls `broadcastSyncedDelta(env, row.userId, 'agent_sessions', [{type: op, value: row, visibleToUserIds}])` wrapped in `ctx.waitUntil`. **There is no `'delete'` variant** — per Non-Goals, hard-delete is out of scope; archive is a PATCH setting `archived = true`, which rides the `'update'` path.
- **Verify:** Instrument `broadcastSyncedDelta` with a counter. Trigger a rename via PATCH → counter increments by 1. Trigger a gateway `result` event → counter increments by 1. Archive a session (PATCH with `{archived: true}`) → counter increments by 1, emitted op is `'update'` with the archived row. Full row matches D1 row by byte-for-byte comparison of values.
- **Source:** new `apps/orchestrator/src/lib/broadcast-session.ts`; modifies `apps/orchestrator/src/agents/session-do.ts` at lines 1049, 1061, 1080, 1092 and gateway-event handlers at 2743, 2874–2987, 2989–3010, 3072–3076, 3012–3043, 3100–3134; modifies `apps/orchestrator/src/api/index.ts` at 1479 (POST), 1712 (PATCH), 1769+ (fork).

#### API Layer
- All write endpoints return unchanged responses; broadcasting is fire-and-forget via `ctx.waitUntil`. Broadcast errors log but do not fail the request.

#### Data Layer
- New helper: `broadcastSessionRow(env, ctx, sessionId: string, op: 'insert' | 'update'): Promise<void>`.
- New helper: `computeVisibleUserIds(db, projectName: string, ownerUserId: string): Promise<string[]>`.

### B3: session-do-transition-broadcasts

**Core:**
- **ID:** session-do-transition-broadcasts
- **Trigger:** Gateway events received by SessionDO — `session.init` (sdkSessionId assignment), `assistant` (numTurns increment), `result` (status→idle + cost/duration/summary), `stopped` (status→idle), `error` (status→idle + error payload), `kata_state` (kataMode / kataIssue / kataPhase + worktree info), `ask_user` / `permission_request` (status→waiting_gate), `context_usage` (usage blob).
- **Expected:** Each handler's existing `syncXToD1` call is immediately followed by `broadcastSessionRow(env, ctx, sessionId, 'update')`. All fields that changed in the D1 write are included in the broadcast because the helper selects the full row.
- **Verify:** With two browser tabs open on the same user, start a turn in tab 1. Tab 2's sidebar shows numTurns increment (per-`assistant` event), status transitions (running → waiting_gate → idle), and cost/summary (per `result`) without a manual refresh.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:1049–1106` helpers; event handlers cited in B2.

### B4: context-usage-d1-column

**Core:**
- **ID:** context-usage-d1-column
- **Trigger:** SessionDO receives a `context_usage` gateway event.
- **Expected:** In addition to the existing `session_meta` SQLite cache update, the handler writes `agent_sessions.context_usage_json` = JSON.stringify(parsedUsage) via a new `syncContextUsageToD1(sessionId, json)` helper, then calls `broadcastSessionRow('update')`. Client receives the updated row; a selector parses `contextUsageJson` to render the progress bar on the sidebar.
- **Verify:** During an active session run, observe `sessionsCollection` for the session's row: `contextUsageJson` mutates on each context_usage event, matches the value in the persistent `session_meta.context_usage_json` column, survives reload.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:3100–3134`; new helper adjacent to existing `syncStatusToD1` at 1049.

#### Data Layer
- New column: `agent_sessions.context_usage_json TEXT` (nullable).

### B5: worktree-info-d1-column

**Core:**
- **ID:** worktree-info-d1-column
- **Trigger:** Worktree resolution completes during a session — currently invoked from `syncKataToD1` at `session-do.ts:1092` and worktree-reservations write at 1114.
- **Expected:** The resolved worktree metadata is serialized to `agent_sessions.worktree_info_json` via `syncWorktreeInfoToD1(sessionId, json)`. Broadcast fires as part of the same update. Client selector parses the JSON to render the worktree chip next to the session name. Shape is derived 1:1 from the existing `worktreeReservations` row (schema at `apps/orchestrator/src/db/schema.ts:189–205`).
- **Verify:** After phase p2 is wired, run two turns on a session owned by user A in project `duraclaw` with worktree resolution enabled. Tab 2 (same user) shows the branch chip within one WS RTT of the first turn. Then use D1 console (`pnpm --filter orchestrator db:shell`) to run `UPDATE worktree_reservations SET stale = 1 WHERE worktree = '<name>'` and trigger a follow-up turn; tab 2's `worktreeInfoJson.stale` parses to `true` without a manual reload. `grep -r '"worktreeInfoJson"' apps/orchestrator/src/features/agent-orch` returns at least one selector hit (the sidebar chip consumer).
- **Source:** `apps/orchestrator/src/agents/session-do.ts:1092–1121`; type declared in `packages/shared-types/src/index.ts`.

#### Data Layer
- New column: `agent_sessions.worktree_info_json TEXT` (nullable) — stringified `WorktreeInfo`.
- New shared type in `packages/shared-types/src/index.ts` (alongside `AgentSessionRow`):
  ```typescript
  export interface WorktreeInfo {
    worktree: string          // worktreeReservations.worktree (PK)
    issueNumber: number       // worktreeReservations.issueNumber
    heldSince: string         // ISO-8601
    lastActivityAt: string    // ISO-8601
    modeAtCheckout: string    // 'debug' | 'implementation' | etc.
    stale: boolean            // soft-expiry flag
  }
  ```
  Client parse helper: `parseWorktreeInfo(json: string | null): WorktreeInfo | null` returns `null` on null / invalid JSON / shape mismatch (no throw).

### B6: rest-crud-broadcasts

**Core:**
- **ID:** rest-crud-broadcasts
- **Trigger:** User-initiated REST write — `POST /api/sessions` (create), `PATCH /api/sessions/:id` (rename / archive / change model), `POST /api/sessions/:id/fork` (create new from fork).
- **Expected:** Handler writes D1, then calls `broadcastSessionRow` with `'insert'` (POST, fork) or `'update'` (PATCH). Optimistic mutation state on the client reconciles via TanStack DB's deep-equality on the server echo — no flicker.
- **Verify:** In browser tab 1, rename a session. Tab 2's sidebar reflects the new name within one WS RTT. Tab 1 does not flicker (single row transition in React DevTools).
- **Source:** `apps/orchestrator/src/api/index.ts:1479` (POST), 1712 (PATCH), 1769+ (fork).

### B7: orphan-suppression

**Core:**
- **ID:** orphan-suppression
- **Trigger:** A D1 write to an `agent_sessions` row where `user_id === 'system'` (gateway discovery alarm — see `getOwnedSession` at `api/index.ts:195–214`).
- **Expected:** `broadcastSessionRow` short-circuits before calling `broadcastSyncedDelta` — no frame is emitted. Orphan rows appear on the sidebar only when `queryFn` re-runs (reconnect / initial load).
- **Verify:** Trigger the discovery alarm (or insert a test row with `user_id='system'`). No `broadcastSyncedDelta` calls fired (counter unchanged). `GET /api/sessions` still returns the row on next fetch.
- **Source:** `apps/orchestrator/src/lib/broadcast-session.ts` (new).

### B8: project-members-table

**Core:**
- **ID:** project-members-table
- **Trigger:** Drizzle migration applied on deploy.
- **Expected:** New SQLite table:
  ```sql
  CREATE TABLE project_members (
    project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK(role IN ('owner','member')),
    created_at   TEXT NOT NULL,
    PRIMARY KEY(project_name, user_id)
  );
  ```
- **Verify:** `sqlite-shell` the D1; inspect schema; insert valid row; reject row with `role='admin'` via CHECK constraint; reject row with unknown project via FK.
- **Source:** new Drizzle migration under `apps/orchestrator/drizzle/`; schema entry in `apps/orchestrator/src/db/schema.ts`.

#### Data Layer
- See Expected.

### B9: members-admin-api

**Core:**
- **ID:** members-admin-api
- **Trigger:** Admin user calls the members API.
- **Expected:** Three endpoints, all gated by Better Auth `admin()` plugin middleware:
  - `GET /api/projects/:name/members` → 200 `{members: Array<{userId, role, createdAt}>}`.
  - `POST /api/projects/:name/members` body `{userId, role: 'owner'|'member'}` → 201 `{userId, role, createdAt}`; 400 on invalid role; 404 on unknown project / user; 409 on duplicate.
  - `DELETE /api/projects/:name/members/:userId` → 204; 404 on missing pair.
  - Non-admin → 403 on all three.
- **Verify:** See test_cases on phase p3.
- **Source:** new routes in `apps/orchestrator/src/api/index.ts` near the existing `/api/projects` routes.

#### API Layer
- See Expected.

### B10: visible-users-inline-query

**Core:**
- **ID:** visible-users-inline-query
- **Trigger:** `broadcastSessionRow` executing.
- **Expected:** `computeVisibleUserIds` runs `SELECT user_id FROM project_members WHERE project_name = ?` and unions the returned array with `{row.userId}`. No caching. Empty result set ⇒ `visibleToUserIds = [row.userId]` (single-user default). Adding / removing a member takes effect on the next broadcast (no invalidation needed).
- **Verify:** Insert a member via the admin API; in another tab, trigger a status transition on a session in that project; confirm the newly-added member's UserSettingsDO receives a broadcast. Delete the member; next broadcast does not reach them.
- **Source:** new `apps/orchestrator/src/lib/broadcast-session.ts`.

### B11: do-side-per-op-filter

**Core:**
- **ID:** do-side-per-op-filter
- **Trigger:** `UserSettingsDO.POST /broadcast` receives a frame containing one or more ops with `visibleToUserIds` set.
- **Expected:** For each op: if `visibleToUserIds` is present and `this.userId` is not in it, drop that op. If all ops are filtered out, send nothing. Ops without `visibleToUserIds` (i.e., existing consumers `user_tabs`, `user_preferences`, `projects`, `chains`) are dispatched unchanged — back-compat.
- **Verify:** Unit test constructs a frame with three ops: op A (no visibleToUserIds), op B (visibleToUserIds: [this.userId]), op C (visibleToUserIds: ['other-user']). DO dispatches a frame containing only ops A and B to its sockets.
- **Source:** `apps/orchestrator/src/agents/user-settings-do.ts:99–133` (handleBroadcast), 157–173 (isSyncedCollectionFrame).

#### API Layer
- Wire protocol at `packages/shared-types/src/index.ts:731`:
  ```typescript
  export type SyncedCollectionOp<TRow = unknown> =
    | { type: 'insert'; value: TRow; visibleToUserIds?: string[] }
    | { type: 'update'; value: TRow; visibleToUserIds?: string[] }
    | { type: 'delete'; key: string; visibleToUserIds?: string[] }
  ```

### B12: kata-state-rest

**Core:**
- **ID:** kata-state-rest
- **Trigger:** Client mounts the Kata HUD or receives a `kata_state` invalidation trigger.
- **Expected:** `GET /api/sessions/:id/kata-state` returns `{state: KataSessionState | null}` (type at `packages/shared-types/src/index.ts:493–515`). Authentication via `getOwnedSession`; ownership mismatch returns 404 (not 403, matching existing disclosure policy). `Cache-Control: no-store`. The handler calls SessionDO's new `@callable getKataStateBlob()` which reads from the DO's `kv.kata_state` blob (authoritative source per current architecture).
- **Verify:** Authenticated GET returns blob on a session with kata state; returns `{state: null}` on a session without; returns 404 on a session owned by another user.
- **Source:** new route in `apps/orchestrator/src/api/index.ts`; new `@callable` method in `apps/orchestrator/src/agents/session-do.ts` near the existing `getKataStatus()` at 2587. Response body type imported from `packages/shared-types/src/index.ts:493`.

#### API Layer
- See Expected.

### B13: invalidation-triggers

**Core:**
- **ID:** invalidation-triggers
- **Trigger:** Client-side gateway_event handler in `use-coding-agent.ts` receives a `context_usage` or `kata_state` WS event.
- **Expected:** Handler no longer writes to a local collection. For `context_usage`: no-op (the synced-collection delta from SessionDO's D1 write is the authoritative path). For `kata_state`: refetch the kata-state REST endpoint via `queryClient.invalidateQueries({queryKey: ['sessions', sessionId, 'kata-state']})`. Payload of the WS event is ignored entirely — the event functions purely as a wake signal.
- **Verify:** During a kata phase transition, tab 2 (viewing the Kata HUD) refetches `/api/sessions/:id/kata-state` within one WS RTT and re-renders with the new phase. `sessionLiveStateCollection` does not exist; no handler writes to it.
- **Source:** `apps/orchestrator/src/hooks/use-coding-agent.ts:422–451`.

### B14: session-local-collection

**Core:**
- **ID:** session-local-collection
- **Trigger:** Browser WS connection readyState changes (CONNECTING/OPEN/CLOSING/CLOSED).
- **Expected:** New `sessionLocalCollection` in `apps/orchestrator/src/db/session-local-collection.ts` holds `{id, wsReadyState}` rows. `localOnlyCollectionOptions`, no persistence, no sync driver. `useSessionLocalState(sessionId)` hook reads from it. Only writer is `use-coding-agent.ts:460–462` (effect that mirrors connection.readyState).
- **Verify:** Grep the codebase: only two files reference `sessionLocalCollection` (the file itself + use-coding-agent.ts's readyState effect). No legacy `sessionLiveStateCollection` references remain anywhere.
- **Source:** renames + narrows `apps/orchestrator/src/db/session-live-state-collection.ts`; updates `apps/orchestrator/src/hooks/use-coding-agent.ts`.

### B15: consumer-migration

**Core:**
- **ID:** consumer-migration
- **Trigger:** Static analysis / codebase grep after the migration lands.
- **Expected:** Every component previously reading `sessionLiveStateCollection` via `useSessionLiveState(sessionId)` now reads from `sessionsCollection` via a new `useSession(sessionId)` selector (or `useSessionsCollection()` for list views). The `useDerivedStatus(sessionId) ?? live.status` fallback pattern becomes `useDerivedStatus(sessionId) ?? useSession(sessionId)?.status`. Components affected: `NavSessions` (`components/layout/nav-sessions.tsx`), `SessionHistory`, `SessionListItem`, `StatusBar` (`components/layout/status-bar.tsx`), `ChainView`, `ChainProgress`, `SessionCard`. Full list discovered by `grep useSessionLiveState` pre-migration.
- **Verify:** `grep -r useSessionLiveState apps/orchestrator/src/` returns zero hits. Every previously-migrated consumer still renders correctly (manual smoke of sidebar + history + status bar + chain view).
- **Source:** components listed above.

#### UI Layer
- No visual changes. Label / color / icon derivations unchanged.

### B16: backfill-removal

**Core:**
- **ID:** backfill-removal
- **Trigger:** Read of `apps/orchestrator/src/hooks/use-sessions-collection.ts`.
- **Expected:** All of: `backfillFromRest()`, the `useEffect` that calls it on mount, the `onUserStreamReconnect` handler at 236–238, the `window.addEventListener('focus', onFocus)` at 240–241, and the exported `refresh()` function are gone. The file is trimmed to a thin wrapper: `export function useSessionsCollection() { return useLiveQuery(sessionsCollection) }` plus optional `useSession(sessionId)` selector.
- **Verify:** `wc -l apps/orchestrator/src/hooks/use-sessions-collection.ts` is roughly 1/10 of pre-migration size. No imports of `use-sessions-collection` pull in REST-fetch logic.
- **Source:** `apps/orchestrator/src/hooks/use-sessions-collection.ts`.

### B17: constant-time-secret

**Core:**
- **ID:** constant-time-secret
- **Trigger:** UserSettingsDO receives a `POST /broadcast` request.
- **Expected:** Bearer token comparison uses `constantTimeEquals(provided, expected)` from `~/agents/session-do-helpers` instead of `auth !== expected`. Same shape as the gateway-secret check already in `api/index.ts:668`.
- **Verify:** Unit test mirrors the `constantTimeEquals` test in `session-do.test.ts:619+` against the UserSettingsDO handler. Happy path accepts; one-char mismatch rejects; empty secret rejects.
- **Source:** `apps/orchestrator/src/agents/user-settings-do.ts:102–104`.

### B18: drop-message-count

**Core:**
- **ID:** drop-message-count
- **Trigger:** Drizzle migration applied.
- **Expected:** `agent_sessions.message_count` column removed from the schema. All client references (`SessionListItem`, `SessionHistory` display of `session.num_turns ?? session.messageCount`) are simplified to just `session.numTurns`. `AgentSessionRow` type omits the field.
- **Verify:** `grep -ri message_count apps packages` returns zero hits. `grep -ri messageCount apps packages` returns zero hits.
- **Source:** Drizzle schema at `apps/orchestrator/src/db/schema.ts:128–165`; `packages/shared-types/src/index.ts` `AgentSessionRow`; client grep targets.

## Non-Goals

- **Hard-delete endpoint** (`DELETE /api/sessions/:id`) is out of scope. Archive remains the only user-facing delete. Follow-up issue.
- **Orphan session cross-user broadcast.** Sessions with `userId='system'` from the gateway discovery alarm appear only via REST cold-load. Not fanned out.
- **Invitation UI, email flow, accept/reject tokens for project members.** Only admin-only REST endpoints ship in this spec. Invitation ergonomics is a separate product call.
- **Dual-live migration period.** Big-bang: single PR, OPFS schemaVersion bump, clients re-seed from REST on first load after deploy.
- **Moving `totalCostUsd` / `durationMs` / `numTurns` / `status` derivation from server to client.** Server-authoritative as today; derivation hooks (`useDerivedStatus`, `useDerivedGate`) remain fold-over-messages as a fast path for active sessions.
- **`kataState` full blob on the synced collection.** Stays on REST (`GET /api/sessions/:id/kata-state`). The three D1-mirrored columns (`kataMode` / `kataIssue` / `kataPhase`) ride on the synced collection for sidebar display.
- **Organization / team / workspace abstraction.** Membership is project-scoped. Better Auth's `organization()` plugin remains unused.
- **Per-project feature flag, env-var kill switch.** Empty `project_members` table is the de-facto opt-out; no explicit flag.
- **Client-side ACL filtering.** All filtering happens DO-side. Frames carrying session IDs never reach non-authorized users.

## Verification Plan

All commands run from `/data/projects/duraclaw-dev2` unless otherwise noted. Verify-mode stack assumed up via `scripts/verify/dev-up.sh`.

### Phase p1 (schema + types)

1. `cd apps/orchestrator && pnpm db:migrate:dev` — expect exit 0, output shows new migration applied.
2. `sqlite3 .wrangler/state/v3/d1/.../db.sqlite ".schema agent_sessions"` — output contains `context_usage_json` and `worktree_info_json`, does not contain `message_count`.
3. `sqlite3 ... ".schema project_members"` — output shows the table with composite PK.
4. `pnpm typecheck` at repo root — exit 0.
5. `grep -r messageCount apps packages --include='*.ts' --include='*.tsx'` — zero hits.

### Phase p2 (broadcast + ACL filter)

6. `pnpm --filter orchestrator test -- user-settings-do` — unit tests pass (new per-op filter test green).
7. `pnpm --filter orchestrator test -- broadcast-session` — unit tests pass (orphan suppression, visibleToUserIds computation).
8. Start verify stack; log in as user A (see CLAUDE.md — `agent.verify+duraclaw@example.com`). Open two browser tabs via `scripts/verify/browser-dual-up.sh` (both as user A). Start a session in tab 1. Run one turn.
9. Tab 2 sidebar should show the session's `numTurns` increment, `status` transitioning running → idle, and cost/summary within one WS RTT — without the tab ever re-issuing `GET /api/sessions`.
10. `curl -H "Authorization: Bearer <wrong>" http://127.0.0.1:<orch>/parties/user-settings/<userId>/broadcast -X POST -d '{}'` → 401 (constant-time-secret doesn't regress auth).

### Phase p3 (members API + kata-state REST)

11. Seed an admin user manually (admin flag via Better Auth CLI or D1 update). As admin:
    `curl -X POST http://127.0.0.1:<orch>/api/projects/duraclaw/members -H 'Content-Type: application/json' -d '{"userId":"<user-b-id>","role":"member"}'` → 201.
12. `curl http://127.0.0.1:<orch>/api/projects/duraclaw/members` → 200, body contains user B.
13. As non-admin (user B): same POST → 403.
14. As owner user A: `curl http://127.0.0.1:<orch>/api/sessions/<id>/kata-state` on an active session → 200 `{state: {mode: 'implementation', ...}}`. Cache-Control header `no-store` present.
15. As user A on a session owned by a different user: same GET → 404.

### Phase p4 (client migration)

16. `scripts/verify/axi-dual-login.sh` — seed both browsers for users A + B.
17. Add B as member of project `duraclaw` via step 11.
18. In browser A, start a session in `duraclaw`. Run one turn.
19. `scripts/verify/axi-both snapshot` — both A's and B's sidebars show the new session with the completed turn's `numTurns`, `totalCostUsd`, and `status='idle'`.
20. Remove B from members: `curl -X DELETE http://127.0.0.1:<orch>/api/projects/duraclaw/members/<user-b-id>` → 204.
21. Run another turn in A's session.
22. `scripts/verify/axi-b snapshot` — B's sidebar does NOT reflect the newest turn (row's `numTurns` is stale vs. A's).
23. `scripts/verify/axi-b eval 'location.reload()'`; after reload: B's sidebar is missing the session entirely (cold-load filters by `user_id = B`, and B is no longer a member).
24. `grep -r 'useSessionLiveState\\|sessionLiveStateCollection' apps/orchestrator/src` — zero hits.
25. `grep -r 'backfillFromRest\\|onUserStreamReconnect.*use-sessions-collection' apps/orchestrator/src` — zero hits.

### Phase p5 (end-to-end)

26. `pnpm test` at repo root — exit 0.
27. `pnpm typecheck` at repo root — exit 0.
28. `pnpm biome check` at repo root — exit 0.
29. Insert a row with `user_id='system'` (`INSERT INTO agent_sessions (id, user_id, project, status, created_at, updated_at) VALUES ('orphan-1', 'system', 'duraclaw', 'idle', datetime('now'), datetime('now'))`). Log into browser A. Reload. Sidebar shows the orphan row (cold-load via `/api/sessions`).
30. Trigger a D1 update on the orphan row (`UPDATE agent_sessions SET status='running' WHERE id='orphan-1'` — simulates a write path that would broadcast). Tab 2 sidebar does NOT reflect the change (orphan-suppression confirmed).
31. Kill the user-stream WS for tab 2 (`scripts/axi eval "window.__userStream?.close()"`). Trigger three status transitions on a real session in tab 1. Reconnect WS in tab 2. Tab 2 re-fetches via `queryFn` and shows final state (reconnect resync confirmed).

## Implementation Hints

### Key Imports

```typescript
// new helpers
import { broadcastSessionRow } from '~/lib/broadcast-session'
import { computeVisibleUserIds } from '~/lib/broadcast-session'

// existing, reuse
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { chunkOps } from '~/lib/chunk-frame'
import { constantTimeEquals } from '~/agents/session-do-helpers'
import { createSyncedCollection } from '~/db/synced-collection'
import { getOwnedSession } from '~/api/index' // extract to a shared helper if not already

// types
import type { AgentSessionRow } from '@duraclaw/shared-types'
import type { SyncedCollectionOp, SyncedCollectionFrame } from '@duraclaw/shared-types'
```

### Code Patterns

**1. broadcastSessionRow helper skeleton** (new file `apps/orchestrator/src/lib/broadcast-session.ts`):

```typescript
export async function broadcastSessionRow(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  sessionId: string,
  op: 'insert' | 'update',
): Promise<void> {
  const db = getDb(env)

  // Hard-delete is a non-goal (see spec Non-Goals). Archive rides the 'update'
  // path via PATCH { archived: true }. If the row is gone at broadcast time,
  // that's a race with user/account cascade delete — treat as no-op.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)
  const row = rows[0]
  if (!row) return
  if (row.userId === 'system') return // orphan suppression (B7)

  const visibleToUserIds = await computeVisibleUserIds(db, row.project, row.userId)

  ctx.waitUntil(
    broadcastSyncedDelta(env, row.userId, 'agent_sessions', [
      { type: op, value: row, visibleToUserIds },
    ]),
  )
}

export async function computeVisibleUserIds(
  db: DrizzleD1,
  projectName: string,
  ownerUserId: string,
): Promise<string[]> {
  const members = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectName, projectName))
  const ids = new Set(members.map((m) => m.userId))
  ids.add(ownerUserId)
  return Array.from(ids)
}
```

**2. Per-op filter in UserSettingsDO.handleBroadcast** (modify `apps/orchestrator/src/agents/user-settings-do.ts:99–133`):

```typescript
// After validating the frame shape and auth:
const filteredOps = body.ops.filter((op) => {
  const vis = (op as { visibleToUserIds?: string[] }).visibleToUserIds
  if (!vis) return true            // back-compat: existing consumers pass through
  return this.userId != null && vis.includes(this.userId)
})
if (filteredOps.length === 0) return new Response(null, { status: 204 })

const filteredPayload = JSON.stringify({ ...body, ops: filteredOps })
for (const ws of this.sockets) ws.send(filteredPayload)
return new Response(null, { status: 204 })
```

**3. sessionsCollection factory call** (new file `apps/orchestrator/src/db/sessions-collection.ts`):

```typescript
import { createSyncedCollection } from '~/db/synced-collection'
import type { AgentSessionRow } from '@duraclaw/shared-types'

export const sessionsCollection = createSyncedCollection<AgentSessionRow, string>({
  id: 'sessions',
  getKey: (row) => row.id,
  queryKey: ['sessions'],
  queryFn: async () => {
    const resp = await fetch('/api/sessions')
    if (!resp.ok) throw new Error(`GET /api/sessions failed: ${resp.status}`)
    const { sessions } = (await resp.json()) as { sessions: AgentSessionRow[] }
    return sessions
  },
  syncFrameType: 'agent_sessions',
  onInsert: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`POST /api/sessions failed: ${resp.status}`)
    }
  },
  onUpdate: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(`/api/sessions/${m.modified.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`PATCH /api/sessions failed: ${resp.status}`)
    }
  },
  onDelete: async () => {
    // Hard-delete endpoint is a non-goal in this spec; surface a clear error
    // so any caller wiring it up accidentally fails loudly.
    throw new Error('Hard-delete of sessions is not supported — use archive')
  },
  persistence: await dbReady,
  schemaVersion: 4, // bump from sessionLiveStateCollection v3 — new shape
})
```

**4. SessionDO transition broadcast wiring** (pattern — apply at every `syncXToD1` call site in `session-do.ts`):

```typescript
// Before (session-do.ts:2941 — result event handler):
await this.syncResultToD1({ summary, durationMs, totalCostUsd, numTurns })

// After:
await this.syncResultToD1({ summary, durationMs, totalCostUsd, numTurns })
await broadcastSessionRow(this.env, this.ctx, this.sessionId, 'update')
```

Note: `this.ctx` on a Cloudflare DO has `waitUntil`; pass `this.ctx` directly.

**5. Members API route pattern** (mirrors `/api/projects` structure):

```typescript
app.post('/api/projects/:name/members', requireAdmin, async (c) => {
  const projectName = c.req.param('name')
  const body = await c.req.json<{ userId: string; role: 'owner' | 'member' }>()
  if (!['owner', 'member'].includes(body.role)) return c.json({ error: 'invalid role' }, 400)

  const db = getDb(c.env)
  const createdAt = new Date().toISOString()
  try {
    await db.insert(projectMembers).values({
      projectName,
      userId: body.userId,
      role: body.role,
      createdAt,
    })
  } catch (err) {
    // FK violation → 404; unique violation → 409
    if (String(err).includes('FOREIGN KEY')) return c.json({ error: 'unknown project or user' }, 404)
    if (String(err).includes('UNIQUE')) return c.json({ error: 'already a member' }, 409)
    throw err
  }
  return c.json({ userId: body.userId, role: body.role, createdAt }, 201)
})
```

### Gotchas

- **`sessions-collection.ts` must `await dbReady`** before constructing — `createSyncedCollection` expects a resolved persistence handle. On mobile (Capacitor) `dbReady` resolves later than on web; the hook that consumes `sessionsCollection` must be tolerant of a brief "no rows" window at bootstrap (same as other factory consumers today).
- **TanStack DB's `update` semantics require the FULL row**, not a partial. The broadcast helper MUST select the full row after the D1 write, not construct a partial from `this.state`. Partial updates will either fail the deep-equality reconcile or replace fields with `undefined`.
- **`visibleToUserIds` ordering / deduplication doesn't matter** — DO-side uses `Array.includes`. Don't spend perf on `Set` round-tripping at the caller.
- **`broadcastSyncedDelta` does nothing when `SYNC_BROADCAST_SECRET` is missing.** Verify-mode (`.dev.vars`) must include it or cross-tab sync silently degrades. Add a startup assertion in worker init if not already present.
- **OPFS schema version bump evicts client data.** Users reload; `queryFn` re-seeds from REST. Spec #31 P5 used the same mechanism — no user-facing action needed.
- **Drizzle's CHECK constraint on `role`** requires migrating with raw SQL in the `.sql` file — Drizzle-kit doesn't always emit CHECK from schema declarations. Verify the generated migration contains the literal `CHECK(role IN ('owner','member'))`.
- **Admin-only middleware does NOT exist yet** — the codebase has only scattered `isAdmin` inline checks inside route components. Phase p3 creates `requireAdmin` (new file `apps/orchestrator/src/api/middleware/require-admin.ts`) around Better Auth's `admin()` plugin surface (`session.user.role === 'admin'`). Don't invent a new auth scheme; don't reuse `bearer()` which is for API tokens. Use it on all three `/api/projects/:name/members*` routes.
- **`message_count` drop is a breaking migration** — any prod D1 with existing data must be backed up first. Duraclaw deploys from `main` via the infra server; coordinate with operator.
- **Derived-status hook stays unchanged.** `useDerivedStatus` folds over `messagesCollection` — that collection is not touched by this spec. The fallback from active-session's derivation to synced-collection's `row.status` is the new pattern; code example: `const status = useDerivedStatus(id) ?? useSession(id)?.status ?? 'idle'`.
- **`SyncedCollectionOp` wire-protocol extension is additive.** Adding `visibleToUserIds?` as optional does not break existing frames — verified against the four current consumers which simply omit the field. No migration needed for them.
- **Fork + insert broadcast**: the forked session's `userId === originalSession.userId`. Project may differ (forks can retarget). Compute `visibleToUserIds` from the NEW row's project, not the source.

### Reference Docs

- `planning/research/2026-04-20-issue-35-agent-sessions-synced-collection.md` — full research writeup with code references driving this spec.
- `planning/specs/28-synced-collections-pattern.md` — GH#32 spec that introduced `createSyncedCollection`; reference for factory conventions.
- `planning/specs/31-unified-sync-channel.md` — GH#31 spec that removed the Agents SDK state broadcast; this spec builds on its narrowing of `sessionLiveStateCollection`.
- CLAUDE.md § "Synced collections (user-scoped reactive data)" — invariant documentation the orchestrator adheres to; this spec extends the ACL-filtering language there.
- TanStack DB `createCollection` + `queryCollectionOptions` docs — https://tanstack.com/db (sync lifecycle, optimistic mutation contract, deep-equality reconcile).
- Better Auth `admin()` plugin — https://www.better-auth.com/docs/plugins/admin (role gating for members API).
