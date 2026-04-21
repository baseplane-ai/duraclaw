---
initiative: session-state-collapse
type: project
issue_type: feature
status: approved
priority: high
github_issue: 37
created: 2026-04-21
updated: 2026-04-21
supersedes: "Spec #35 (unimplemented phases only — B1–B7, B13–B16 absorbed; B8–B12 project-members ACL deferred)"
phases:
  - id: p1
    name: "Schema migration + broadcast wiring"
    tasks:
      - "Sub-phase P1a (schema + helper): Drizzle migration, type extension, broadcastSessionRow helper, error status bug fix. **Independently shippable** — adds columns and helper without wiring; dead code in production is harmless. Commit checkpoint."
      - "Sub-phase P1b (wiring): Wire broadcast at all sync*ToD1 call sites, add new sync helpers, delete session_summary frame, wire REST endpoints. Commit checkpoint. P1b depends on P1a but P1a can merge alone if P1b stalls."
      - "Drizzle migration: add `error TEXT`, `error_code TEXT`, `kata_state_json TEXT`, `context_usage_json TEXT`, `worktree_info_json TEXT` to `agent_sessions`; drop `message_count`"
      - "Extend `SessionSummary` in `packages/shared-types/src/index.ts` (L576): add `error`, `errorCode`, `kataStateJson`, `contextUsageJson`, `worktreeInfoJson`; remove `messageCount`. This is the existing D1-mirrored row type used throughout the codebase. Optionally rename to `SessionSummary` for clarity and update all import sites — or keep the name and extend in place."
      - "Write `broadcastSessionRow(env, ctx, sessionId, op)` helper in `apps/orchestrator/src/lib/broadcast-session.ts`: SELECT full row from D1, skip if userId==='system', call broadcastSyncedDelta wrapped in ctx.waitUntil"
      - "Wire `broadcastSessionRow('update')` after every existing `syncStatusToD1` call (9 sites in session-do.ts: L722, L1858, L1882, L1935, L2904, L2936, L3070, L3128, L3206)"
      - "Wire `broadcastSessionRow('update')` after every `syncResultToD1` call (L3070)"
      - "Wire `broadcastSessionRow('update')` after every `syncSdkSessionIdToD1` call site: L2721 (session.init handler — sdkSessionId assignment)"
      - "Wire `broadcastSessionRow('update')` after every `syncKataToD1` call site: L1105 (function definition, called from L3140 in kata_state handler). Verify both definition-site and call-site are covered."
      - "Add `syncContextUsageToD1(json)` with 5s debounce: writes `agent_sessions.context_usage_json`, calls broadcastSessionRow. Wire from context_usage gateway_event handler (session-do.ts:3213–3229)"
      - "Add `syncWorktreeInfoToD1(json)`: writes `agent_sessions.worktree_info_json`, calls broadcastSessionRow. Wire from worktree-resolution path inside kata_state handling"
      - "Add `syncKataStateJsonToD1(blob)`: writes `agent_sessions.kata_state_json` (full KataSessionState blob alongside existing kataMode/kataIssue/kataPhase). Wire from kata_state gateway_event handler"
      - "Add `syncErrorToD1(error, errorCode)`: writes `agent_sessions.error`, `agent_sessions.error_code`. Wire from error gateway_event handler (session-do.ts:3206)"
      - "Fix L3206: change `syncStatusToD1(sessionId, 'idle')` to `syncStatusToD1(sessionId, 'error')` in the error gateway_event handler"
      - "Delete `session_summary` WS frame emission from SessionDO (added in 5952e94). numTurns/totalCostUsd/durationMs now flow via broadcastSessionRow from syncResultToD1"
      - "Wire `broadcastSessionRow('insert')` from REST POST /api/sessions and POST /api/sessions/:id/fork after D1 insert"
      - "Wire `broadcastSessionRow('update')` from REST PATCH /api/sessions/:id after D1 update"
    test_cases:
      - id: "schema-new-columns"
        description: "After migration: `sqlite3 ... '.schema agent_sessions'` shows error, error_code, kata_state_json, context_usage_json, worktree_info_json columns. message_count absent."
        type: "unit"
      - id: "broadcast-fires-on-status-transition"
        description: "Start a session, run one turn. broadcastSyncedDelta counter increments at least 3 times (running, waiting_gate or running, idle)."
        type: "integration"
      - id: "error-status-written"
        description: "Trigger an error (e.g., rate limit). D1 row has status='error', error column populated. Previously wrote 'idle'."
        type: "integration"
      - id: "context-usage-debounced"
        description: "During a 30s active turn, context_usage events fire ~10 times. D1 writes occur <= 7 times (5s debounce). Each broadcast carries the latest value."
        type: "integration"
      - id: "session-summary-frame-gone"
        description: "`grep -r 'session_summary' apps/orchestrator/src/agents/session-do.ts` returns zero hits."
        type: "audit"
      - id: "typecheck-passes"
        description: "`pnpm typecheck` at repo root — exit 0."
        type: "unit"

  - id: p2
    name: "Client collection + reader migration"
    tasks:
      - "Sub-phase P2a (collection definitions): Create sessions-collection.ts, session-local-collection.ts, rewrite use-sessions-collection.ts, add `parseJsonField<T>` helper in `apps/orchestrator/src/lib/json.ts`, delete use-derived-status.ts. Commit checkpoint."
      - "Sub-phase P2b (consumer migration): Migrate all component readers, refactor use-coding-agent.ts handlers, update StatusBar. Commit checkpoint."
      - "Create `apps/orchestrator/src/db/sessions-collection.ts`: export `sessionsCollection` via createSyncedCollection with id:'sessions', syncFrameType:'agent_sessions', queryKey:['sessions'], queryFn: GET /api/sessions, OPFS persistence with fresh schemaVersion"
      - "Create `apps/orchestrator/src/db/session-local-collection.ts`: export `sessionLocalCollection` with localOnlyCollectionOptions, schema {id, wsReadyState}. No persistence, no sync. Export `useSessionLocalState(sessionId)` hook"
      - "Rewrite `apps/orchestrator/src/hooks/use-sessions-collection.ts`: delete backfillFromRest, focus/reconnect handlers, refresh(). Export `useSessionsCollection()` → useLiveQuery(sessionsCollection) and `useSession(sessionId)` selector"
      - "Delete `apps/orchestrator/src/hooks/use-derived-status.ts`"
      - "In `apps/orchestrator/src/lib/display-state.ts`: update `deriveDisplayStateFromStatus` callers — input is now `session.status` from sessionsCollection, not `useDerivedStatus(id) ?? live.status`"
      - "Migrate every `useSessionLiveState(sessionId)` call site to `useSession(sessionId)` from sessionsCollection: NavSessions, SessionHistory, SessionListItem, StatusBar, ChainView, ChainProgress, SessionCard, TabBar"
      - "Migrate `useDerivedStatus(sessionId)` call sites: StatusBar, AgentDetailView, ChatThread, use-coding-agent.ts — replace with `useSession(sessionId)?.status`"
      - "In `use-coding-agent.ts`: (a) stop writing to sessionLiveStateCollection entirely; (b) write wsReadyState to sessionLocalCollection; (c) stop handling `session_summary` WS frames (frame type deleted in P1); (d) keep useDerivedGate derivation unchanged"
      - "In `use-coding-agent.ts`: update context_usage handler to no-op (synced-collection delta from D1 is authoritative); update kata_state handler to invalidation-only (queryClient.invalidateQueries)"
      - "Update StatusBar: read `contextUsage` from `useSession(sessionId)?.contextUsageJson` (parsed via selector), `kataState` from `useSession(sessionId)?.kataStateJson` (parsed via selector), `wsReadyState` from `useSessionLocalState(sessionId)?.wsReadyState`. **JSON parse convention:** add `parseJsonField<T>(json: string | null): T | null` helper that wraps `JSON.parse` in a try/catch, returns `null` on `SyntaxError` or null input. Use in selectors for `contextUsageJson`, `kataStateJson`, `worktreeInfoJson`. No throws, no crashes on corrupt D1 data."
    test_cases:
      - id: "sidebar-renders-cold"
        description: "On cold OPFS, sidebar renders session list via sessionsCollection queryFn. No backfillFromRest calls."
        type: "integration"
      - id: "status-updates-live-sidebar"
        description: "Two tabs open. Start turn in tab 1. Tab 2 sidebar shows status transitions (running → idle) without manual refresh."
        type: "integration"
      - id: "derived-status-deleted"
        description: "`grep -r 'useDerivedStatus' apps/orchestrator/src` returns zero hits."
        type: "audit"
      - id: "context-usage-bar-renders"
        description: "During an active turn, StatusBar shows context-usage progress bar updating from sessionsCollection data."
        type: "integration"
      - id: "error-visible-in-sidebar"
        description: "After a session errors while backgrounded, sidebar shows 'error' status with error message tooltip — without opening the session."
        type: "integration"

  - id: p3
    name: "Deletion + verification"
    tasks:
      - "Delete `apps/orchestrator/src/db/session-live-state-collection.ts`"
      - "Verify `apps/orchestrator/src/hooks/use-derived-status.ts` was deleted in P2 (confirmed by grep audit)"
      - "Delete bespoke gateway_event handlers in use-coding-agent.ts for context_usage, kata_state writing to sessionLiveStateCollection"
      - "Delete session_summary frame handler in use-coding-agent.ts"
      - "Delete seedSessionLiveStateFromSummary helper"
      - "Delete upsertSessionLiveState helper"
      - "Run full verification plan (below)"
      - "`pnpm test && pnpm typecheck && pnpm biome check`"
    test_cases:
      - id: "gate-dialog-still-works"
        description: "Trigger a permission_request during a session turn. Gate dialog renders with tool call details and approval buttons. Approve the gate. Turn resumes. Confirms useDerivedGate (B14) is unaffected by useDerivedStatus deletion."
        type: "integration"
      - id: "ws-disconnect-shows-disconnected"
        description: "Kill the session WS (`scripts/axi eval 'window.__sessionWs?.close()'`). StatusBar shows DISCONNECTED indicator within 1s. Reconnect WS. StatusBar returns to previous status. Confirms sessionLocalCollection.wsReadyState write-through and deriveDisplayStateFromStatus integration."
        type: "integration"
      - id: "no-live-state-refs"
        description: "`grep -r 'sessionLiveStateCollection\\|useSessionLiveState\\|seedSessionLiveState\\|upsertSessionLiveState' apps/orchestrator/src` returns zero hits."
        type: "audit"
      - id: "no-message-count-refs"
        description: "`grep -ri 'messageCount\\|message_count' apps/orchestrator/src` returns zero hits (excluding migration files)."
        type: "audit"
      - id: "no-session-summary-frame-refs"
        description: "`grep -r 'session_summary' apps/orchestrator/src` returns zero hits."
        type: "audit"
      - id: "full-test-suite"
        description: "`pnpm test && pnpm typecheck && pnpm biome check` — all exit 0."
        type: "unit"
---

## Overview

Collapse all per-session live state onto a single `agent_sessions` synced-collection row, eliminating the derived-status bug class and retiring `sessionLiveStateCollection`. This spec is the full rollup of R1 (status collapse), R2 (retire sessionLiveStateCollection), and R3 (D1-mirror error/result) identified in research #37. It subsumes the unimplemented phases of spec #35 (`agent_sessions` synced collection), adding status derivation deletion, error/result D1 mirroring, and `session_summary` frame retirement. Project-members ACL (spec #35 B8–B12) is deferred.

**Motivation:** 13 of the last 15 fix commits (2026-04-09 through 2026-04-20) trace to two gaps: status having 4 sources of truth (DO / D1 / client mirror / derived-from-messages) and `sessionLiveStateCollection` being a bespoke `localOnly` collection with hand-wired upsert paths. This spec eliminates both gaps structurally — one collection, one source of truth, one write pattern.

## Feature Behaviors

### B1: schema-migration

**Core:**
- **ID:** schema-migration
- **Trigger:** Drizzle migration applied on deploy.
- **Expected:** `agent_sessions` gains 5 new columns. `message_count` dropped.
- **Verify:** `sqlite3 .schema agent_sessions` output includes all new columns; `message_count` absent. `pnpm typecheck` passes.
- **Source:** new migration under `apps/orchestrator/drizzle/`; schema at `apps/orchestrator/src/db/schema.ts:128–165`

#### Data Layer
New columns on `agent_sessions`:
```sql
ALTER TABLE agent_sessions ADD COLUMN error TEXT;
ALTER TABLE agent_sessions ADD COLUMN error_code TEXT;
ALTER TABLE agent_sessions ADD COLUMN kata_state_json TEXT;
ALTER TABLE agent_sessions ADD COLUMN context_usage_json TEXT;
ALTER TABLE agent_sessions ADD COLUMN worktree_info_json TEXT;
ALTER TABLE agent_sessions DROP COLUMN message_count;
-- Note: DROP COLUMN requires SQLite 3.35.0+. Drizzle may generate a table
-- rebuild (CREATE new → INSERT SELECT → DROP old → ALTER RENAME) if the D1
-- SQLite version is older. Either approach is correct; Drizzle handles it.
```
Drop: `message_count INTEGER` (superseded by `numTurns` — see spec #35 B18).

`SessionSummary` type in `packages/shared-types/src/index.ts` updated to include: `error: string | null`, `errorCode: string | null`, `kataStateJson: string | null`, `contextUsageJson: string | null`, `worktreeInfoJson: string | null`. `messageCount` removed.

### B2: broadcast-session-row-helper

**Core:**
- **ID:** broadcast-session-row-helper
- **Trigger:** Any code path that writes to `agent_sessions` in D1.
- **Expected:** `broadcastSessionRow(env, ctx, sessionId, op)` SELECTs the full row by id (no-op if row gone — race with cascade delete), skips if `userId === 'system'` (orphan suppression), calls `broadcastSyncedDelta(env, row.userId, 'agent_sessions', [{type: op, value: row}])` wrapped in `ctx.waitUntil`.
- **Verify:** Instrument broadcastSyncedDelta with a counter. Trigger rename PATCH → counter +1. Trigger result event → counter +1. Insert row with userId='system' → counter unchanged.
- **Source:** new `apps/orchestrator/src/lib/broadcast-session.ts`

**Error handling:** D1 query failures inside `broadcastSessionRow` are swallowed (fire-and-forget inside `ctx.waitUntil`). The client self-heals on next `queryFn` refetch or WS reconnect. No retry logic, no error propagation — broadcast is best-effort.

Note: `visibleToUserIds` ACL filtering (spec #35 B10–B11) is deferred. Single-user fanout only.

### B3: status-transition-broadcasts

**Core:**
- **ID:** status-transition-broadcasts
- **Trigger:** Gateway events that change session status: `session.init`, `ask_user`, `permission_request`, `result`, `stopped`, `error`, plus RPCs `stop()`, `abort()`, `forceStop()`, and gateway disconnect.
- **Expected:** Each handler's `syncStatusToD1` call is immediately followed by `broadcastSessionRow(env, ctx, sessionId, 'update')`. All 9 existing call sites wired:
  - L722 (gateway disconnect → idle)
  - L1858 (stop → idle)
  - L1882 (abort → idle)
  - L1935 (forceStop → idle)
  - L2904 (ask_user → waiting_gate)
  - L2936 (permission_request → waiting_gate)
  - L3070 (result → idle)
  - L3128 (stopped → idle)
  - L3206 (error → **error**, not idle — see B4)
- **Verify:** Two tabs open, same user. Start turn in tab 1. Tab 2 sidebar shows status transitions (running → idle, or running → waiting_gate → running → idle) within one WS RTT, without refetch.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` at cited lines.

**Consolidation note:** When multiple `sync*ToD1` helpers fire in the same handler (e.g., `result` calls `syncStatusToD1` at L3070 then `syncResultToD1` at L3071), each triggers its own `broadcastSessionRow`. The first broadcast's SELECT returns the row with updated status but stale result fields; the second returns the fully updated row. This is harmless — TanStack DB applies the latest row via deep-equality, and the two broadcasts arrive in the same microtask on the client. If broadcast volume becomes a concern, the DRY approach (embed broadcast inside each `sync*ToD1` helper, then add a per-session microtask-level dedupe so only one broadcast fires per event loop turn) is a clean follow-up optimization. Not required for correctness.

### B4: fix-error-status

**Core:**
- **ID:** fix-error-status
- **Trigger:** SessionDO receives an `error` gateway event.
- **Expected:** `syncStatusToD1(sessionId, 'error')` — not `'idle'`. Additionally, `syncErrorToD1(sessionId, error.message, error.code)` writes the error detail columns.
- **Verify:** Trigger a rate-limit error. D1 row: `status = 'error'`, `error = 'Rate limit exceeded'`, `error_code = 'rate_limit'`. Previously would have been `status = 'idle'`, `error = NULL`.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:3206`

#### Data Layer
New helper `syncErrorToD1(sessionId, error, errorCode)` writes `agent_sessions.error` and `agent_sessions.error_code`.

### B5: context-usage-d1-sync

**Core:**
- **ID:** context-usage-d1-sync
- **Trigger:** SessionDO receives a `context_usage` gateway event.
- **Expected:** `syncContextUsageToD1(sessionId, json)` writes `agent_sessions.context_usage_json`. **5-second debounce**: the D1 write + broadcast fire at most once per 5s per session, matching the existing `context_usage_cached_at` TTL in `session_meta`. The latest value wins (trailing-edge debounce). The existing `session_meta` cache write continues to fire immediately (no debounce — it's local DO SQLite).
- **Verify:** During a 30s active turn with ~10 context_usage events, D1 write count <= 7. Broadcast carries the latest value. **Active-tab real-time note:** after P2, StatusBar reads `contextUsageJson` from `sessionsCollection` (debounced at 5s). The active-tab context-usage bar will update in ~5s steps instead of real-time. This is an accepted tradeoff — context usage is a rough indicator, not a real-time meter. If sub-second resolution is later needed for the active tab only, a lightweight `gateway_event → local React state` bypass can be re-added without reintroducing `sessionLiveStateCollection`.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:3213–3229`

### B6: kata-state-json-d1-sync

**Core:**
- **ID:** kata-state-json-d1-sync
- **Trigger:** SessionDO receives a `kata_state` gateway event.
- **Expected:** In addition to the existing `syncKataToD1` (which writes `kataMode`, `kataIssue`, `kataPhase`), also write `agent_sessions.kata_state_json = JSON.stringify(fullKataState)`. Broadcast via `broadcastSessionRow`.
- **Verify:** After `kata enter planning --issue=37`, D1 row has `kataStateJson` containing the full blob with `mode`, `phase`, timing, etc. — not just the three scalar columns.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:1105`; schema at `apps/orchestrator/src/db/schema.ts`

### B7: worktree-info-d1-sync

**Core:**
- **ID:** worktree-info-d1-sync
- **Trigger:** Worktree resolution completes during a session. Known call sites: (a) `syncKataToD1` at L1105 (kata_state handler writes worktree reservation alongside kata columns), (b) worktree-reservation refresh at L1114 (reservation renewal path). Implementer should `grep -r 'worktreeReservation\|worktreeInfo' apps/orchestrator/src/agents/session-do.ts` to confirm no additional write sites exist.
- **Expected:** `syncWorktreeInfoToD1(sessionId, json)` writes `agent_sessions.worktree_info_json`. Broadcast fires.
- **Verify:** After a session resolves a worktree, D1 row has `worktreeInfoJson` with branch, dirty, reservation metadata. `grep -n 'syncWorktreeInfoToD1' session-do.ts` returns all call sites — confirm count matches expected.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:1092–1121`

### B8: rest-crud-broadcasts

**Core:**
- **ID:** rest-crud-broadcasts
- **Trigger:** User-initiated REST write — `POST /api/sessions` (create), `PATCH /api/sessions/:id` (rename / archive / change model), `POST /api/sessions/:id/fork` (create new from fork).
- **Expected:** Handler writes D1, then calls `broadcastSessionRow` with `'insert'` (POST, fork) or `'update'` (PATCH). Optimistic mutation state on the client reconciles via TanStack DB's deep-equality on the server echo — no flicker.
- **Verify:** In tab 1, rename a session. Tab 2's sidebar reflects the new name within one WS RTT. Tab 1 does not flicker. In tab 1, archive a session. Tab 2's sidebar shows the archived state.
- **Source:** `apps/orchestrator/src/api/index.ts` — POST (~L1479), PATCH (~L1712), fork (~L1769+)

### B9: delete-session-summary-frame

**Core:**
- **ID:** delete-session-summary-frame
- **Trigger:** Code audit after P1 wiring.
- **Expected:** The `session_summary` WS frame type (added in `5952e94`) is deleted from SessionDO emission. `numTurns`, `totalCostUsd`, `durationMs` now arrive at the client via `agent_sessions` synced-collection deltas from `syncResultToD1` + broadcast. No new bespoke frame, no new handler.
- **Verify:** `grep -r 'session_summary' apps/orchestrator/src/agents/session-do.ts` returns zero hits. `grep -r 'session_summary' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` returns zero hits.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` (emission); `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (handler)

### B10: sessions-collection

**Core:**
- **ID:** sessions-collection
- **Trigger:** Browser mounts the React tree.
- **Expected:** `sessionsCollection` created via `createSyncedCollection` with `id: 'sessions'`, `syncFrameType: 'agent_sessions'`, `queryFn: GET /api/sessions`. OPFS-persisted. Cold-load via queryFn; hot updates via `synced-collection-delta` frames from `UserSettingsDO`. Replaces all uses of `sessionLiveStateCollection` for session metadata.
- **Verify:** On cold browser, open app. Network tab shows one `GET /api/sessions`. All sidebar session data renders from this collection. `window.tanstackDb` (or equivalent debug) shows `sessions` collection, no `session_live_state` collection.
- **Source:** new `apps/orchestrator/src/db/sessions-collection.ts`; rewrites `apps/orchestrator/src/hooks/use-sessions-collection.ts`

### B11: session-local-collection

**Core:**
- **ID:** session-local-collection
- **Trigger:** WS connection readyState changes.
- **Expected:** `sessionLocalCollection` holds `{id, wsReadyState}` per session. `localOnlyCollectionOptions`, no OPFS persistence, no sync. Only writer: `use-coding-agent.ts` readyState effect. Only reader: `useSessionLocalState(sessionId)` hook used by `deriveDisplayStateFromStatus`.
- **Verify:** `grep -r sessionLocalCollection` returns exactly 2 files: the collection definition and use-coding-agent.ts.
- **Source:** new `apps/orchestrator/src/db/session-local-collection.ts`

### B12: consumer-migration

**Core:**
- **ID:** consumer-migration
- **Trigger:** Static audit after P2.
- **Expected:** Every component previously reading `useSessionLiveState(sessionId)` now reads `useSession(sessionId)` from `sessionsCollection`. Components: NavSessions, SessionHistory, SessionListItem, StatusBar, ChainView, ChainProgress, SessionCard, TabBar. `useDerivedStatus(sessionId) ?? live.status` pattern replaced with `useSession(sessionId)?.status` everywhere.
- **Verify:** `grep -r 'useSessionLiveState\|useDerivedStatus' apps/orchestrator/src` returns zero hits. Manual smoke of sidebar + status bar + tab bar + chain view.
- **Source:** components listed above

### B13: delete-use-derived-status

**Core:**
- **ID:** delete-use-derived-status
- **Trigger:** All consumers migrated in B11.
- **Expected:** `apps/orchestrator/src/hooks/use-derived-status.ts` is deleted **in P2** (not deferred to P3). The file, the hook, and all imports are removed. `agent_sessions.status` (written by DO, broadcast via synced-collection delta) is the sole status source for all callers. The ~100ms D1 round-trip on status transitions is accepted as below perceptual threshold.
- **Verify:** File does not exist. `grep -r 'use-derived-status\|useDerivedStatus' apps/orchestrator/src` returns zero hits.
- **Source:** deletes `apps/orchestrator/src/hooks/use-derived-status.ts`

**Rationale (partial walk-back of spec #31):** Spec #31 P4/P5 introduced `useDerivedStatus` as the single status source, derived from the last ~10 messages in `messagesCollection`. The intent was correct — messages should be authoritative. But in practice, derivation from a seq'd stream compounds every ordering quirk into a status bug: missing seq stamps (`3a8169c`), backwards seq (`9b80143`), ordering flashes (`e9b5177`), optimistic-row timing (`3a8169c` again), reconnect gaps, mid-turn tool-state wedges (`ad5f548`). The bug class is structurally open-ended. Collapsing to an authoritative D1 column eliminates it by construction. `useDerivedGate` is retained because gate is transient/message-scoped and hasn't generated fix commits.

### B14: retain-use-derived-gate

**Core:**
- **ID:** retain-use-derived-gate
- **Trigger:** Active-tab session has a pending tool-permission or ask_user gate.
- **Expected:** `useDerivedGate(sessionId)` continues to scan the last ~20 messages for `tool-permission` / `tool-ask_user` parts with `state === 'approval-requested'`. No changes. Gate is inherently message-scoped — the approval UI needs the specific message part reference to render the dialog. Collapsing to D1 would duplicate, not replace.
- **Verify:** `useDerivedGate` file and hook still exist. Gate dialog still renders correctly during permission_request flows.
- **Source:** `apps/orchestrator/src/hooks/use-derived-gate.ts:24–49` (unchanged)

### B15: retire-session-live-state-collection

**Core:**
- **ID:** retire-session-live-state-collection
- **Trigger:** All consumers migrated (B11), all fields relocated (B3–B7), deletion phase (P3).
- **Expected:** `apps/orchestrator/src/db/session-live-state-collection.ts` is deleted. All exported helpers (`upsertSessionLiveState`, `seedSessionLiveStateFromSummary`, `useSessionLiveState`, `sessionLiveStateCollection`) are removed. No references remain.
- **Verify:** File does not exist. `grep -r 'sessionLiveStateCollection\|useSessionLiveState\|seedSessionLiveState\|upsertSessionLiveState' apps/orchestrator/src` returns zero hits.
- **Source:** deletes `apps/orchestrator/src/db/session-live-state-collection.ts`

### B16: delete-bespoke-event-handlers

**Core:**
- **ID:** delete-bespoke-event-handlers
- **Trigger:** Gateway_event handlers for `context_usage` and `kata_state` in `use-coding-agent.ts` previously wrote to `sessionLiveStateCollection`. Collection is retired.
- **Expected:** `context_usage` handler becomes a no-op (D1 broadcast is authoritative — the 5s debounced write + synced-collection delta delivers the value). `kata_state` handler becomes `queryClient.invalidateQueries({queryKey: ['sessions']})` — this is intentionally different because kata_state changes trigger structural sidebar updates (chain linkage, phase display, worktree chip) that benefit from a guaranteed-fresh refetch rather than relying solely on broadcast delta timing. `session_summary` handler deleted (frame type removed in B9).
- **Verify:** No `sessionLiveStateCollection` writes in `use-coding-agent.ts`. Context usage and kata state update in the sidebar within one WS RTT of the synced-collection delta.
- **Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:481–521`

## Non-Goals

- **Project-members ACL** (spec #35 B8–B12) — deferred to a separate spec. Single-user broadcast only; no `visibleToUserIds` filtering. `computeVisibleUserIds` is not implemented; broadcast always targets `row.userId`.
- **Messages collection migration** (issue #38 / R1.5) — the hand-spun `queryCollectionOptions` + WS push path for messages is a separate scope.
- **Gateway-event sequencing** (R4) — context_usage/kata_state events remain un-seq'd. Acceptable because they're now write-through to D1 (stale local data self-corrects on next broadcast).
- **Legacy `SessionStatus` enum cleanup** — `waiting_input`, `waiting_permission` kept in the union type for backwards compatibility. Not emitted by any code path.
- **Hard-delete endpoint** — archive remains the only user-facing delete.
- **Organization / team / workspace abstraction** — membership is project-scoped. Better Auth's `organization()` plugin remains unused.
- **`branchInfoCollection` server persistence** — stays as-is (OPFS + DO-push). Lower priority per research.
- **Dual-live migration period** — big-bang: single PR, OPFS schemaVersion bump. **One-way door:** the D1 migration drops `message_count` (superseded by `numTurns` — no data loss). Client OPFS schemaVersion bump causes old cached data to be dropped and re-seeded from REST on first load. Rollback requires a reverse D1 migration to re-add `message_count` and a client OPFS version bump. This is acceptable — `message_count` was already unreliable and `numTurns` is the canonical field.

## Verification Plan

All commands run from the worktree root. Verify-mode stack assumed up via `scripts/verify/dev-up.sh`. Source `scripts/verify/common.sh` for port variables.

### Phase P1 (schema + broadcast wiring)

1. `cd apps/orchestrator && pnpm db:migrate:dev` — exit 0.
2. `sqlite3 .wrangler/state/v3/d1/.../db.sqlite ".schema agent_sessions"` — output contains `error`, `error_code`, `kata_state_json`, `context_usage_json`, `worktree_info_json`. Does not contain `message_count`.
3. `pnpm typecheck` — exit 0.
4. `grep -ri 'messageCount' apps/orchestrator/src --include='*.ts' --include='*.tsx'` — zero hits (excluding migration files).
5. `grep -r 'session_summary' apps/orchestrator/src/agents/session-do.ts` — zero hits.
6. Start verify stack. Log in as user A. Open two browser tabs (same user). Start a session in tab 1, run one turn.
7. Tab 2's sidebar shows: `status` transitions (running → idle), `numTurns` incremented, `totalCostUsd` populated — all without manual refresh or refetch.
8. Trigger an error in tab 1 (e.g., invalid API key). Tab 2's sidebar shows `status = 'error'`, error message visible in tooltip.

### Phase P2 (client collection + reader migration)

9. Cold OPFS: clear browser data, reload. Sidebar renders session list. Network tab shows exactly one `GET /api/sessions` during bootstrap.
10. Open tab 2. Start a new session in tab 1. Tab 2's sidebar shows the new session immediately (broadcastSessionRow 'insert').
11. During an active turn, StatusBar shows context-usage progress bar updating.
12. `grep -r 'useDerivedStatus\|useSessionLiveState' apps/orchestrator/src` — zero hits.
13. `grep -r 'backfillFromRest' apps/orchestrator/src/hooks/use-sessions-collection.ts` — zero hits.

### Phase P3 (deletion + verification)

14. `grep -r 'sessionLiveStateCollection\|seedSessionLiveState\|upsertSessionLiveState' apps/orchestrator/src` — zero hits.
15. `grep -r 'session_summary' apps/orchestrator/src` — zero hits.
16. `ls apps/orchestrator/src/db/session-live-state-collection.ts` — file does not exist.
17. `ls apps/orchestrator/src/hooks/use-derived-status.ts` — file does not exist.
18. `pnpm test && pnpm typecheck && pnpm biome check` — all exit 0.
19. Kill the user-stream WS for tab 2 (`scripts/axi eval "window.__userStream?.close()"`). Run three status transitions in tab 1. Reconnect WS in tab 2. Tab 2 re-fetches via queryFn and shows final state (reconnect resync confirmed).
20. Verify `useDerivedGate` still works: trigger a permission_request in tab 1. Gate dialog renders with the correct tool call details.
21. REST mutation test: rename a session via `scripts/axi` eval in tab 1. Tab 2 sidebar reflects the new name within one WS RTT.
22. DISCONNECTED test: kill the session WS via `scripts/axi eval 'window.__sessionWs?.close()'`. StatusBar shows DISCONNECTED indicator. Reconnect. StatusBar returns to previous status.

## Implementation Hints

### Key Imports

```typescript
// new helpers
import { broadcastSessionRow } from '~/lib/broadcast-session'

// existing, reuse
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { createSyncedCollection } from '~/db/synced-collection'

// types
import type { SessionSummary } from '@duraclaw/shared-types'
import type { SyncedCollectionOp, SyncedCollectionFrame } from '@duraclaw/shared-types'
```

### Code Patterns

**1. broadcastSessionRow helper** (simplified from spec #35 — no ACL):

```typescript
export async function broadcastSessionRow(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  sessionId: string,
  op: 'insert' | 'update',
): Promise<void> {
  const db = getDb(env)
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)
  const row = rows[0]
  if (!row) return
  if (row.userId === 'system') return // orphan suppression

  ctx.waitUntil(
    broadcastSyncedDelta(env, row.userId, 'agent_sessions', [
      { type: op, value: row },
    ]),
  )
}
```

**2. 5s debounce for contextUsage D1 writes** (in session-do.ts):

```typescript
private contextUsageDebounceTimer: ReturnType<typeof setTimeout> | null = null
private pendingContextUsageJson: string | null = null

private debouncedSyncContextUsageToD1(sessionId: string, json: string) {
  this.pendingContextUsageJson = json
  if (this.contextUsageDebounceTimer) return // already scheduled
  this.contextUsageDebounceTimer = setTimeout(() => {
    this.contextUsageDebounceTimer = null
    if (this.pendingContextUsageJson) {
      this.syncContextUsageToD1(sessionId, this.pendingContextUsageJson)
      this.pendingContextUsageJson = null
    }
  }, 5000)
}
```

**3. sessionsCollection factory** (new file):

```typescript
import { createSyncedCollection } from '~/db/synced-collection'
import type { SessionSummary } from '@duraclaw/shared-types'
import { apiUrl } from '~/lib/platform'
import { queryClient } from './db-instance'

export const sessionsCollection = createSyncedCollection<SessionSummary>({
  id: 'sessions',
  syncFrameType: 'agent_sessions',
  queryKey: ['sessions'],
  queryFn: async () => {
    // apiUrl() returns the correct base URL; credentials: 'include' sends
    // the auth cookie (web) or the bearer header (Capacitor, via fetch
    // interceptor in apps/orchestrator/src/lib/platform.ts). Match the
    // pattern used by existing synced collections (e.g., user_tabs queryFn).
    const resp = await fetch(apiUrl('/api/sessions'), { credentials: 'include' })
    if (!resp.ok) throw new Error(`sessions fetch failed: ${resp.status}`)
    const { sessions } = await resp.json() as { sessions: SessionSummary[] }
    return sessions
  },
  queryClient,
  getKey: (row) => row.id,
  schemaVersion: 1,
})
```

**4. Wiring broadcast at a sync* call site** (pattern for all 9+ sites):

```typescript
// Before (existing):
this.syncStatusToD1(sessionId, 'idle')

// After:
this.syncStatusToD1(sessionId, 'idle')
broadcastSessionRow(this.env, this.ctx, sessionId, 'update')
```

Or wrap into `syncStatusToD1` itself to keep it DRY — either approach works; the invariant is "D1 write and broadcast always go together."

### Gotchas

1. **OPFS schemaVersion bump** — `sessionsCollection` must use a fresh schemaVersion (e.g., 1) since it's a new collection ID. The old `session_live_state` collection's schemaVersion (3) is irrelevant — different collection ID.
2. **`broadcastSessionRow` is async** — it awaits a D1 SELECT. Always wrap in `ctx.waitUntil` at SessionDO call sites to avoid blocking the event handler.
3. **`contextUsage` debounce timer and DO hibernation** — Durable Objects may hibernate between events. The timer approach works because `context_usage` events arrive in rapid succession during active turns (DO stays awake). On wake from hibernation, the timer is lost — no stale write fires, which is correct behavior.
4. **`error` status enum** — `deriveDisplayStateFromStatus` already handles `'error'` → `ERROR` display state (L123). No client-side changes needed for this case.
5. **`session_summary` frame deletion** — the frame was added in `5952e94` just days ago. It has exactly one emitter and one handler. Clean removal, no migration concern.
6. **`useDerivedGate` retention** — this hook scans messages for gate state. It does NOT depend on `useDerivedStatus`. Deleting the latter does not affect the former.

### Reference Docs

- Research doc: `planning/research/2026-04-20-session-state-surface-inventory.md` — full gap inventory with commit-level evidence
- Spec #35: `planning/specs/35-agent-sessions-synced-collection.md` — prior art for broadcast wiring, sessionsCollection factory, consumer migration patterns. This spec supersedes its unimplemented phases.
- Spec #31: `planning/specs/31-unified-sync-channel.md` — origin of `useDerivedStatus`, `session_meta` table, seq'd messages protocol. B12 of this spec partially walks back #31's derivation decision for status (retains it for gate).
- `createSyncedCollection` factory: `apps/orchestrator/src/db/synced-collection.ts` — the target pattern all session state converges on.
