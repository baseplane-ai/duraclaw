---
initiative: session-state-subtraction
type: project
issue_type: feature
status: approved
priority: high
github_issue: 76
created: 2026-04-23
updated: 2026-04-23
phases:
  - id: p1
    name: "Create useDerivedStatus hook + client render collapse + delete derive-status.ts"
    depends_on: []
    tasks:
      - "Create apps/orchestrator/src/hooks/use-derived-status.ts. Model shape after `apps/orchestrator/src/hooks/use-derived-gate.ts` (same pattern: `useMessagesCollection(sessionId)` → `useMemo` fold over messages). Exports `useDerivedStatus(sessionId: string): SessionStatus | undefined`. Fold semantics: (a) if no messages yet → return `undefined` (caller falls back to `session?.status`); (b) scan messages tail-first for the most recent terminal or in-flight marker — a `type='result'` message part → return 'idle'; a part with `type === 'tool-permission' || 'tool-ask_user'` and `state === 'approval-requested'` → return 'waiting_gate'; a `type='text'` part with `state === 'streaming'` (same field used by gateway-event-mapper to mark in-flight assistant text) → return 'running'; otherwise continue scanning; (c) if no terminal or in-flight marker found → return `undefined` (fall through to caller's fallback). No TTL. No `nowTs`. No external refs. Pure derivation over the collection. Takes the same `useMessagesCollection(sessionId)` dep as useDerivedGate so the two hooks share the live-query subscription."
      - "Write unit tests for useDerivedStatus at apps/orchestrator/src/hooks/__tests__/use-derived-status.test.tsx. Use the canonical part type names (matching `useDerivedGate`): `tool-permission` / `tool-ask_user` for gate parts; `text` with `state: 'streaming'` for in-flight assistant text; `result` for the terminal marker. Cases: (a) empty collection → undefined; (b) tail has a `result` part → 'idle'; (c) tail has a `tool-permission` part with `state: 'approval-requested'` → 'waiting_gate'; (d) tail has a `text` part with `state: 'streaming'` → 'running'; (e) tail has a tool_result part after a `result` part → 'idle' (result wins because we scan tail-first and result is more recent). **These tests MUST NOT mock `useSessionsCollection`** — the sessions row defaults to absent, so the P5 tiebreaker reads `row?.messageSeq ?? -1` → `-1`, keeping `localMaxSeq > -1` true and the messages fold result survives. Documented here so P5's extension doesn't accidentally invalidate these tests."
      - "Delete apps/orchestrator/src/lib/derive-status.ts in full. The whole file (TTL_MS constant + deriveStatus predicate + DeriveStatusRow interface + the DeriveStatusRow/deriveStatus re-exports). No grace shim, no deprecation wrapper — import sites go to `useDerivedStatus` directly."
      - "In apps/orchestrator/src/components/status-bar.tsx:240-296, replace the 4-tier fold (`liveStatus ?? (readyState !== 1 ? rawD1Status : undefined) ?? d1Status`) with `const status = useDerivedStatus(sessionId) ?? (session?.status as SessionStatus | undefined)`. Delete `overrideFiredRef`, the GH#69 B6 tripwire useEffect (lines 240-287), the `d1Status`/`rawD1Status`/`liveStatus` locals, and the `deriveStatus` + `useNow` imports at this file only. `readyState` local stays (it still drives `WsDot` color and `deriveDisplayStateFromStatus`'s wsReadyState arg). Safe to drop `useNow` at this call site: `deriveDisplayStateFromStatus` accepts `nowTs` with a `Date.now()` default and the current call site already omits it, so dropping the `useNow` hook subscription has no behavioral effect here."
      - "Replicate the same replacement in apps/orchestrator/src/components/tab-bar.tsx:372-380, apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx:115-124, and apps/orchestrator/src/components/disconnected-banner.tsx:44-50 — same import swap (`useDerivedStatus` from `~/hooks/use-derived-status`), same fold collapse, delete the `useNow` and `deriveStatus` imports at each of these 4 render surfaces only. **Do NOT delete the `useNow` module itself** — 8 other importers exist (nav-sessions.tsx, SessionCardList.tsx, SessionListItem.tsx, __root.tsx, SessionHistory.tsx, SessionSidebar.tsx, ActiveStrip.tsx, command-menu.tsx) and their use of useNow is out of scope."
      - "Search-and-destroy every remaining `import { deriveStatus }` and `import { TTL_MS }` across apps/orchestrator/src/**. Each hit is either a render-path caller (migrate to useDerivedStatus) or a test (see P5). Zero matches post-phase — enforced by audit task in P6 verification."
      - "Add a dev-only tripwire in apps/orchestrator/src/components/status-bar.tsx immediately above the `useDerivedStatus` call: `if (import.meta.env.DEV) { const legacy = local as unknown as { liveStatus?: unknown; liveGate?: unknown; liveError?: unknown }; if (legacy?.liveStatus !== undefined || legacy?.liveGate !== undefined || legacy?.liveError !== undefined) { throw new Error('[gh76] legacy status signal on sessionLocalCollection — this channel is deleted in P2') } }`. Vite's `import.meta.env.DEV` is dead-code-eliminated in production builds, so the entire block disappears from the prod bundle; the tripwire is safe to ship independently of P2. Removed in P2 once the source of the signal (session_status frame + liveStatus field) is physically deleted."
    test_cases:
      - id: "use-derived-status-fold"
        description: "Unit tests at apps/orchestrator/src/hooks/__tests__/use-derived-status.test.tsx cover the five fold cases (empty / result / pending gate / streaming text / ambiguous tail). Passes under `pnpm --filter @duraclaw/orchestrator test`."
        type: "unit"
      - id: "derive-status-deleted"
        description: "`rg 'derive-status'` across apps/orchestrator/ returns 0 matches. `rg 'deriveStatus\\b'` returns 0 matches outside test file graveyards."
        type: "audit"
      - id: "render-collapse-status-bar"
        description: "Mount StatusBar for a session whose messagesCollection tail is a `result` message and whose D1 `agent_sessions.status='running'` (stuck-running scenario). Derived status yields `idle`. Visible label reads `Idle`. No `deriveStatus` import in the bundle."
        type: "integration"
      - id: "render-collapse-all-four-surfaces"
        description: "status-bar.tsx, tab-bar.tsx, features/agent-orch/AgentDetailView.tsx, disconnected-banner.tsx each call `useDerivedStatus(sessionId)`. Each falls back to `session?.status` when useDerivedStatus returns undefined (cold-load, no messages yet). Verified via snapshot tests with messagesCollection empty + D1 row status='idle'."
        type: "integration"
      - id: "tripwire-throws-in-dev"
        description: "Seed sessionLocalCollection with a legacy shape `{liveStatus:'running'}`. In DEV build, StatusBar throws on mount. In PROD build (`import.meta.env.DEV === false`), StatusBar renders normally (the throw block is DCE'd by Vite). Verified via Vite build-mode toggle in the test — run vitest with `{define: {'import.meta.env.DEV': 'false'}}` for the prod-mode case."
        type: "unit"

  - id: p2
    name: "Server: delete session_status frame + liveStatus/liveGate/liveError + broadcastSessionStatus"
    depends_on: [p1]
    tasks:
      - "In apps/orchestrator/src/agents/session-do.ts: delete `broadcastSessionStatus()` (the method body at :1547 plus its two call sites — on DO state diff emit and in `onConnectInner`). Delete the `{type:'session_status'}` frame definition in packages/shared-types/src/index.ts."
      - "In apps/orchestrator/src/db/session-local-collection.ts: delete the `liveStatus`, `liveGate`, `liveError` fields from the `SessionLocalState` interface (lines 33-37). **Keep `wsCloseTs: number | null`** — it's consumed by `deriveDisplayStateFromStatus(status, wsReadyState, wsCloseTs, nowTs)` for the WS_GRACE_MS suppression window, which non-goal #6 preserves. Final shape: `{id, wsReadyState, wsCloseTs}`. Update the type export in packages/shared-types/src/index.ts (SessionLocalRow) if it exists to match."
      - "In apps/orchestrator/src/features/agent-orch/use-coding-agent.ts (~line 426 frame-type switch): delete the `session_status` case. Delete `setLiveStatus` / `setLiveGate` / `setLiveError` writes at all call sites. The WS message handler stops writing to sessionLocalCollection's now-deleted fields."
      - "In apps/orchestrator/src/db/session-local-collection.ts (lines 33-37 + the useSessionLocalState accessor at line 47): the interface already collapses under task 2 above. The existing `useSessionLocalState` function returns the whole row and stays — its consumers now only see `{id, wsReadyState, wsCloseTs}`. Migrate any remaining call-site property reads of `.liveStatus` / `.liveGate` / `.liveError` to `useDerivedStatus(sessionId)` / `useDerivedGate(sessionId)`. Grep for such reads before deleting: `rg 'local.*\\.(liveStatus|liveGate|liveError)' apps/orchestrator/src` — zero matches at end of phase."
      - "Delete the P1 dev-only tripwire added in status-bar.tsx once P2 is green — the signal it guards against is physically removed by P2."
    test_cases:
      - id: "session-status-frame-removed"
        description: "`rg \"'session_status'\" apps/orchestrator/ packages/shared-types/` returns 0 matches. `rg 'broadcastSessionStatus' apps/orchestrator/` returns 0 matches."
        type: "audit"
      - id: "session-local-shape-collapsed"
        description: "SessionLocalState in apps/orchestrator/src/db/session-local-collection.ts exports exactly `{id: string, wsReadyState: number, wsCloseTs: number | null}`. No `liveStatus`, `liveGate`, `liveError` fields remain. `wsCloseTs` is preserved (feeds the WS_GRACE_MS suppression). TypeScript build passes across the workspace."
        type: "audit"
      - id: "status-source-survives-session-status-deletion"
        description: "Manual QA step in the Verification Plan (§4). Send a message through the full stack (orchestrator dev-up + local gateway). DO runs, messages stream. StatusBar shows `Running` then `Idle` — all derived from messagesCollection. Open DevTools → Network → WS frames on the `agent:<sessionId>` socket; filter for `session_status` — zero matches. Only `synced-collection-delta` and `gateway_event` frame types appear."
        type: "manual"

  - id: p3
    name: "Gate collapse — delete state.gate scalar + session_status gate carry + gateway_event gate re-emit"
    depends_on: [p2]
    tasks:
      - "In apps/orchestrator/src/agents/session-do.ts: delete the `state.gate` scalar field from the DO's in-memory state. Delete the `GateResolver` book-keeping that writes it (inspect `handleAskUser`, `handlePermissionRequest`, `resolveGate` paths). The pending gate lives on the `messagesCollection` row (type='ask_user' / type='permission_request') whose resolution flips its own `resolved` field — which the client already observes via useDerivedGate."
      - "**Precondition check (first task of P3):** confirm that spec #14's `{kind:'snapshot'}` frame already carries `tool-permission` and `tool-ask_user` parts on the messages it re-delivers. Read `apps/orchestrator/src/agents/session-do.ts` `sendSnapshot` / `getHistory` paths + the snapshot-emission logic in spec #14 (`planning/specs/14-messages-transport-unification.md`). If any filter strips gate parts on snapshot, extend the snapshot path BEFORE deleting the gateway_event re-emit. This unblocks the rest of P3."
      - "Delete the gate carry on the now-removed `session_status` frame (covered by P2) and the gate re-emit path on reconnect in `onConnectInner` that replayed `gateway_event` for pending gates. Post-change: reconnect relies on messagesCollection snapshot to re-surface the pending gate — confirmed by the precondition check above."
      - "In apps/orchestrator/src/features/agent-orch/use-coding-agent.ts: delete the gateway_event `ask_user` / `permission_request` handler branches that used to write to `sessionLocalCollection.liveGate`. The message arrives via the messages synced-collection-delta and `useDerivedGate(sessionId)` folds it for the UI."
      - "Verify `useDerivedGate` in apps/orchestrator/src/hooks/use-derived-gate.ts handles the cold-load + reconnect-with-stale-cache paths unchanged — it already folds over messagesCollection, which is the same path we're deleting the redundant channel from."
    test_cases:
      - id: "gate-scalar-removed"
        description: "`rg 'state\\.gate' apps/orchestrator/src/agents/session-do.ts` returns 0 matches. `rg 'liveGate' apps/orchestrator/` returns 0 matches."
        type: "audit"
      - id: "gate-survives-reconnect"
        description: "Manual QA step in Verification Plan §6. Start a session that fires `ask_user` in the dev stack. Mid-gate, kill + restart orchestrator dev server (force WS drop + reconnect). On reconnect, messagesCollection snapshot re-delivers the pending ask_user row; useDerivedGate surfaces it; the UI re-renders the Approve/Deny prompt. Verify via DevTools WS-frame capture: no `session_status` and no gate-carrying `gateway_event` on the reconnect."
        type: "manual"
      - id: "gate-resolves-via-message-update"
        description: "Unit test on useDerivedGate. Seed messagesCollection with a tool-permission part in `approval-requested` state. Assert useDerivedGate returns the gate payload. Mutate the part to `approval-given`. Assert the hook returns null on the next tick. No mocking of `session_status` frames — the hook's only input is messagesCollection."
        type: "unit"

  - id: p4
    name: "Server: delete lastEventTs + TTL flush infrastructure + raw_event fallback + revert aeb9209"
    depends_on: [p2]
    tasks:
      - "Delete `last_event_ts` column from D1 `agent_sessions` schema (apps/orchestrator/src/db/schema.ts). Add Drizzle migration to DROP COLUMN. Delete matching column from `session_meta` DO SQLite DDL + all reads/writes in apps/orchestrator/src/agents/session-do.ts."
      - "Delete `bumpLastEventTs()` (session-do.ts:~2405) and `flushLastEventTsToD1()` / `shouldForceFlushLastEventTs()` (session-do.ts:~2425-2459). Delete `LAST_EVENT_FLUSH_DEBOUNCE_MS` (:254) and `LAST_EVENT_FLUSH_MAX_INTERVAL_MS` (:266). Delete all call sites that invoke bumpLastEventTs (search the event-dispatch path, session.init handler, result handler, etc.)."
      - "Surgically undo aeb9209 (do NOT use `git revert` — the commit's files have been modified since and auto-revert would conflict; manual deletion only). Specifically: drop the hibernation-persistence plumbing for lastEventTs — the `session_meta` last_event_ts column reads/writes, rehydration code in `hydrateMetaFromSql`, and the alarm piggyback on WATCHDOG_INTERVAL_MS that flushed on hibernation all go. `flushLastEventTsOnHibernate` (if present) is deleted; the alarm handler's branch is simplified to the remaining `messageSeq` flush + recovery-grace deadline check. The DO-SQLite DDL change rides with the B4 migration."
      - "Rename `WATCHDOG_INTERVAL_MS` in session-do.ts:177 — the constant stays at 30s but the comment/rename reflects its post-subtraction role: hibernation-safe alarm for (a) periodic messageSeq D1 flush and (b) recovery-grace deadline expiration. Update the only function documentation that referenced `lastEventTs` flushing."
      - "Delete the `raw_event` fallback emission path — catch blocks at apps/orchestrator/src/agents/session-do.ts:4320, :4342, :4387, :4428, :4446. These were lossy fallbacks with no client handler. Fail-loud instead: `console.error` + `this.ctx.storage.alarm` nudge (so we revisit on recovery) — the message's authoritative write is the synced-collection-delta for messagesCollection."
      - "Delete the `{type:'raw_event'}` frame type from packages/shared-types/src/index.ts."
    test_cases:
      - id: "last-event-ts-schema-removed"
        description: "D1 schema has no `last_event_ts` column. DO `session_meta` table DDL has no matching column. Drizzle migration file added (e.g. `drizzle/0XXX_drop_last_event_ts.sql`). `rg 'last_event_ts|lastEventTs' apps/orchestrator/src/` returns 0 matches."
        type: "audit"
      - id: "flush-infra-deleted"
        description: "`rg 'LAST_EVENT_FLUSH|bumpLastEventTs|shouldForceFlushLastEventTs|flushLastEventTsToD1' apps/orchestrator/src/` returns 0 matches."
        type: "audit"
      - id: "raw-event-removed"
        description: "`rg \"'raw_event'\" apps/orchestrator/ packages/shared-types/` returns 0 matches. The 5 former catch-block emission sites in session-do.ts use `console.error` + alarm nudge. Unit test for the persistence-failure path asserts log + alarm scheduling (no wire emission)."
        type: "audit"
      - id: "watchdog-still-works-on-hibernation"
        description: "Use the hibernation test harness (the one that spec #31 / GH#69 B5 built). Boot DO → force alarm through hibernation cycle → recovery-grace expires correctly → runner re-dial token still valid within grace, expired after. No lastEventTs involved. session-do.test.ts:1229-1262 + 1276-1316 + 3338-3372 all pass."
        type: "integration"

  - id: p5
    name: "Client: add messageSeq to agent_sessions synced-collection delta + test rewrite"
    depends_on: [p3, p4]
    tasks:
      - "In apps/orchestrator/src/agents/session-do.ts's `broadcastSessionRow()` (around :2457): include the current per-session `messageSeq` counter (already tracked for messages broadcasts) on every agent_sessions delta frame. The field name on the row is `messageSeq: number`. Rollout-safe: the wire shape extension is additive — older server builds emit rows without it and the client treats missing `messageSeq` as `-1` (always accepted). Server-side: the broadcast always includes it going forward."
      - "Add the `messageSeq` column definitively to apps/orchestrator/src/db/schema.ts on the `agentSessions` Drizzle table (same file that owns every other agent_sessions column). Drizzle migration: ADD COLUMN message_seq INTEGER NOT NULL DEFAULT -1. The D1 mirror type in apps/orchestrator/src/db/collections/sessions-collection.ts auto-regenerates from the Drizzle type — no separate declaration."
      - "Update `useSessionsCollection` + the sessions query to project `messageSeq` through to the row. In the new hook `useDerivedStatus` (created in P1), add the tiebreaker — fully self-contained, no external ref plumbing: the hook already subscribes to `messagesCollection` for the session; compute `localMaxSeq = messages.reduce((m, r) => Math.max(m, r.seq ?? -1), -1)` in the same useMemo. Also subscribe to the sessions row via `useSessionsCollection`'s lookup keyed on sessionId and read `row.messageSeq ?? -1`. Tiebreaker: if `localMaxSeq > row.messageSeq`, prefer the derived-from-messages value (the D1 row is stale). If `row.messageSeq >= localMaxSeq` (warm cache, idle session, no client drift), return `undefined` and fall through to the caller's `session?.status` fallback. The hook signature stays `useDerivedStatus(sessionId): SessionStatus | undefined`. No shared ref, no React context, no change to `use-coding-agent.ts`."
      - "Rewrite apps/orchestrator/src/features/agent-orch/__tests__/ws-bridge.test.ts:108-127. The existing test asserts the 4-signal priority chain; replace with: seed messagesCollection with a (user → assistant → result) sequence, seed sessions row with `status='running'` + stale messageSeq, assert useDerivedStatus returns `idle`. Delete the `sessionLocalCollection` fixture setup — the collection no longer carries status fields."
      - "Delete apps/orchestrator/src/agents/__tests__/session-do.test.ts:3488-3542 (`shouldForceFlushLastEventTs` coverage — the function is deleted in P4)."
    test_cases:
      - id: "agent-sessions-delta-carries-message-seq"
        description: "Inspect a broadcast frame on the user-stream WS during an active session. The `synced-collection-delta` for `agent_sessions` carries `messageSeq` on the row. D1 schema has a matching `message_seq` column."
        type: "integration"
      - id: "hybrid-derivation-under-race"
        description: "Simulate post-reconnect race: messagesCollection has received a `result` frame (localMaxSeq=5) but the agent_sessions delta with status='idle' + messageSeq=5 has not yet arrived; the stale D1 cache still shows status='running' + messageSeq=3. `useDerivedStatus` detects local messageSeq > D1 messageSeq and returns the derived `idle`. Verified via unit test on the hook's fold logic."
        type: "unit"
      - id: "hybrid-derivation-warm-cache-fallthrough"
        description: "Steady-state warm-cache path (most common): messagesCollection has 3 rows with max seq=3; sessions row has messageSeq=5 + status='idle'. `useDerivedStatus` detects `row.messageSeq >= localMaxSeq` and returns `undefined` — caller's `session?.status` fallback surfaces `idle` from D1. Catches sign-flip bugs in the `>` comparison. Verified via unit test with explicit mock of both collections."
        type: "unit"
      - id: "ws-bridge-test-rewritten"
        description: "ws-bridge.test.ts has no references to `liveStatus` / `rawD1Status` / `deriveStatus`. It asserts useDerivedStatus + hybrid fallback semantics only. Passes under `pnpm --filter @duraclaw/orchestrator test`."
        type: "unit"
      - id: "legacy-flush-test-deleted"
        description: "`rg 'shouldForceFlushLastEventTs' apps/orchestrator/` returns 0 matches, including in tests."
        type: "audit"

  - id: p6
    name: "Verify + cleanup + docs"
    depends_on: [p5]
    tasks:
      - "Workspace-wide: `pnpm typecheck && pnpm test && pnpm --filter @duraclaw/orchestrator build` all clean."
      - "Audit sweep: `rg -c '(deriveStatus|TTL_MS|liveStatus|liveGate|liveError|rawD1Status|session_status|raw_event|lastEventTs|last_event_ts|bumpLastEventTs|flushLastEventTsToD1|LAST_EVENT_FLUSH)' apps/ packages/` — every hit must be in `planning/` or this spec file. Zero code matches."
      - "Net LOC accounting: `git diff --stat main...HEAD` shows net deletion ≥ 400 LOC (target ~550 LOC delete minus ~20 LOC messageSeq add). Record the actual number in the PR body."
      - "Update CLAUDE.md (root) section 'Client data flow (session live state)' to reflect the collapsed render path: `useDerivedStatus(sessionId) ?? session?.status`. Delete the `liveStatus` / `liveGate` / `liveError` mentions in the sessionLocalCollection / sessionLiveStateCollection bullets. Keep everything about messagesCollection / branchInfoCollection unchanged. Add to 'Key invariants': 'Session status derives from messagesCollection via useDerivedStatus; D1 agent_sessions is the idle/background fallback, not a truth-gate.'"
    test_cases:
      - id: "build-clean"
        description: "`pnpm typecheck && pnpm test && pnpm --filter @duraclaw/orchestrator build` exits 0 with no warnings in the changed files."
        type: "integration"
      - id: "audit-zero-legacy-symbols"
        description: "The 14-term rg audit from the task returns zero code matches. Only documentation files mention the deleted symbols."
        type: "audit"
      - id: "net-deletion-target-met"
        description: "`git diff main...HEAD -- 'apps/*' 'packages/*' --stat` shows net removed > net added, total net deletion ≥ 400 LOC."
        type: "audit"
---

## Overview

GH#76 collapses four overlapping session-status signals (`liveStatus`,
`rawD1Status`, `d1Status`, `wsReadyState`) and seven temporal constants
into a single derivation (`useDerivedStatus(sessionId) ?? session?.status`),
completing the migration spec #31 started. The current model is
over-articulated: five "asymmetry-fix" patches landed in eleven days
(`ed9c673`, `54ae9db`, `c3d8288`, `8dc04ea`, `2761a82`) each plugging a
different hole in a priority chain that fundamentally duplicates state
that already lives on `messagesCollection`. The epic deletes the
duplicate channels + the TTL scaffolding (`derive-status.ts`,
`last_event_ts` column, `session_status` frame, `raw_event` fallback),
extends the same collapse to the `gate` signal (same pathology), and
adds a single new field (`messageSeq` on `agent_sessions` synced-collection
delta) to close a post-reconnect race the hybrid derivation would
otherwise expose. Net: ~550 LOC deleted against ~20 LOC added.

## Feature Behaviors

### B1: Client render uses hybrid derivation as sole status source

**Core:**
- **ID:** hybrid-render-derivation
- **Trigger:** Any component rendering a session's status label (StatusBar, TabBar chip, AgentDetailView header, DisconnectedBanner).
- **Expected:** The component reads `const status = useDerivedStatus(sessionId) ?? session?.status`. No other signal is consulted for status truth. `wsReadyState` continues to gate only the DISCONNECTED visual (via `deriveDisplayStateFromStatus`'s second arg), not the underlying status value.
- **Verify:** Mount StatusBar for a session with messagesCollection tail=`result` and D1 `agent_sessions.status='running'`. Label reads `Idle`. No `deriveStatus` / `TTL_MS` import in the bundle.
- **Source:** `apps/orchestrator/src/components/status-bar.tsx:260-264`, `apps/orchestrator/src/components/tab-bar.tsx:372-380`, `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx:115-124`, `apps/orchestrator/src/components/disconnected-banner.tsx:44-50`. **New file:** `apps/orchestrator/src/hooks/use-derived-status.ts` (created in P1; companion to existing `use-derived-gate.ts`).

#### UI Layer
- No visible UI change in the happy path.
- "Stuck running" scenarios (runner silent but D1 still `running`) surface `Idle` immediately on client, as today — but via derived signal, not a 45s TTL.
- The existing `deriveDisplayStateFromStatus(status, wsReadyState, wsCloseTs, nowTs)` pipeline is preserved; DISCONNECTED suppression via `WS_GRACE_MS=5000` continues unchanged (orthogonal concern).

#### Data Layer
- `sessionLocalCollection` shape collapses from `{id, wsReadyState, wsCloseTs, liveStatus, liveGate, liveError}` → `{id, wsReadyState, wsCloseTs}`. `wsCloseTs` is preserved because it feeds `deriveDisplayStateFromStatus`'s WS_GRACE_MS suppression window (non-goal #6). No migration needed — RAM-only collection.

### B2: `session_status` wire frame and `broadcastSessionStatus` DO method deleted

**Core:**
- **ID:** session-status-frame-delete
- **Trigger:** Any DO state diff that previously fanned out a `{type:'session_status'}` frame; any `onConnectInner` dispatch.
- **Expected:** No `session_status` frame is ever emitted or accepted. The frame type is removed from `packages/shared-types/src/index.ts`. The DO method `broadcastSessionStatus()` is deleted along with its call sites.
- **Verify:** `rg \"'session_status'\" apps/orchestrator/ packages/shared-types/` returns zero. WS frame capture during a live session shows only `synced-collection-delta`, `gateway_event`, and `messages` frames — no `session_status`.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:1547` (deleted)

#### API Layer
- Wire protocol change: frame type `session_status` retired. Backwards compat not needed — all clients ship from same deploy; no external consumers.

### B3: `gate` signal collapses to `useDerivedGate(sessionId)` only

**Core:**
- **ID:** gate-derivation-only
- **Trigger:** `ask_user` or `permission_request` event from runner; user resolves via UI.
- **Expected:** Pending gate lives only on the messagesCollection row. `useDerivedGate(sessionId)` (existing hook; internally folds over `useMessagesCollection(sessionId)`) is the sole render-time source. DO state has no `gate` scalar; no `gateway_event` re-emit on reconnect (snapshot frame re-delivers via messages instead).
- **Verify:** Mid-gate WS drop + reconnect restores the pending gate prompt purely via messagesCollection snapshot. No gate-specific scalar broadcast on the wire.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` GateResolver paths (deleted), `apps/orchestrator/src/hooks/use-derived-gate.ts` (preserved, sole source)

#### UI Layer
- User-visible behavior unchanged: ask_user / permission_request prompts appear and dismiss as they do today. The wire is what changes.

#### Data Layer
- DO state blob loses the `gate` field. sessionLocalCollection loses `liveGate`. messagesCollection (canonical) unchanged.

### B4: `last_event_ts` column + TTL flush infrastructure deleted

**Core:**
- **ID:** last-event-ts-delete
- **Trigger:** Any event previously triggered `bumpLastEventTs()`; any lifecycle transition previously scheduled `flushLastEventTsToD1()`.
- **Expected:** The `last_event_ts` column is dropped from D1 `agent_sessions` and DO `session_meta`. `bumpLastEventTs`, `flushLastEventTsToD1`, `shouldForceFlushLastEventTs`, `LAST_EVENT_FLUSH_DEBOUNCE_MS`, `LAST_EVENT_FLUSH_MAX_INTERVAL_MS` are all deleted. Alarm handler is simplified to (messageSeq flush) + (recovery-grace deadline check) only.
- **Verify:** D1 schema + DO SQLite DDL have no `last_event_ts`. `rg 'lastEventTs|last_event_ts' apps/orchestrator/src/` returns zero. Hibernation recovery tests continue to pass.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:254` (LAST_EVENT_FLUSH_DEBOUNCE_MS), `:266` (LAST_EVENT_FLUSH_MAX_INTERVAL_MS), `:2405` (bumpLastEventTs), `:2425-2459` (flushLastEventTsToD1 + shouldForceFlushLastEventTs)

#### Data Layer
- D1 migration: `ALTER TABLE agent_sessions DROP COLUMN last_event_ts`.
- DO SQLite migration: `ALTER TABLE session_meta DROP COLUMN last_event_ts`.
- Drizzle schema file updated, regenerated migration committed alongside.

### B5: `raw_event` fallback emission path deleted

**Core:**
- **ID:** raw-event-fallback-delete
- **Trigger:** Previously fired when a synced-collection-delta persist failed inside the DO's event-dispatch pipeline (catch blocks at :4320, :4342, :4387, :4428, :4446).
- **Expected:** Those catch blocks no longer emit a `raw_event` wire frame. Instead: `console.error` + schedule a recovery alarm via `this.ctx.storage.setAlarm(Date.now() + 1000)` so the DO re-attempts on wake. The `raw_event` frame type is removed from shared-types.
- **Verify:** Unit test that force-fails a persist inside the handler; assert (a) no WS send, (b) `console.error` fires, (c) alarm scheduled. `rg \"'raw_event'\" packages/shared-types/` returns zero.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:4320`, `:4342`, `:4387`, `:4428`, `:4446`

### B6: `aeb9209` hibernation-persistence for lastEventTs reverted

**Core:**
- **ID:** revert-aeb9209
- **Trigger:** Post-hibernation DO wake; alarm handler executes.
- **Expected:** The `flushLastEventTsOnHibernate` branch of the alarm handler is deleted. The `session_meta` column that persisted the value across hibernation goes with B4's migration. The alarm handler's remaining logic is the (unchanged) messageSeq flush + recovery-grace deadline check.
- **Verify:** Hibernation test harness (spec #31 / GH#69 B5) still passes. No `lastEventTs`-related reads or writes in the post-wake code path.
- **Source:** Commit `aeb9209` — the revert is surgical; the DO SQLite DDL change rides with B4's migration.

### B7: `messageSeq` added to `agent_sessions` synced-collection delta

**Core:**
- **ID:** message-seq-on-session-row
- **Trigger:** Any `broadcastSessionRow()` call in session-do.ts (lifecycle transition, status write, etc.).
- **Expected:** The broadcast row carries `messageSeq: number` matching the DO's current per-session message seq counter. The client's `useDerivedStatus` uses it as a tiebreaker **computed entirely from live-query inputs, no external refs**: compute `localMaxSeq = max(message.seq ?? -1)` across the in-memory `messagesCollection` for that session; read `row.messageSeq ?? -1` from the sessions row. If `localMaxSeq > row.messageSeq`, prefer the derived-from-messages value (D1 is stale). Otherwise fall through to caller's `session?.status` fallback.
- **Verify:** Inspect a live-session delta frame on the user-stream WS; row includes `messageSeq`. Unit test seeds messagesCollection with seq=5 + sessions row with messageSeq=3 + status='running' → hook returns 'idle' (or whatever the messages fold produces). Seq=3 + row.messageSeq=5 → hook returns `undefined` (fall through).
- **Source:** `apps/orchestrator/src/agents/session-do.ts:2457` (broadcastSessionRow), `apps/orchestrator/src/hooks/use-derived-status.ts` (hook logic; created in P1, extended in P5)

#### API Layer
- Additive wire shape change. Additive D1 column (`message_seq INTEGER NOT NULL DEFAULT -1`). Forward/back compat: older serialisations read `-1` → always accepted → falls through to `session?.status` path. Safe to deploy server-first.

#### Data Layer
- D1 migration: `ALTER TABLE agent_sessions ADD COLUMN message_seq INTEGER NOT NULL DEFAULT -1`.
- Drizzle schema updated; migration file committed.

### B8: Dev-only tripwire catches accidental legacy-signal reintroduction

**Core:**
- **ID:** dev-tripwire-legacy-signals
- **Trigger:** StatusBar mount in a dev build where `sessionLocalCollection` somehow contains `liveStatus` or `rawD1Status` fields (shouldn't happen, but catches regressions in PR review).
- **Expected:** In `import.meta.env.DEV`, StatusBar throws with `[gh76] legacy status signal on sessionLocalCollection — this channel is deleted in P2`. In production builds, the block is dead-code-eliminated by Vite.
- **Verify:** Vitest runs with DEV=true and DEV=false; assert throw-vs-silent. Production bundle inspection confirms zero references to the tripwire string.
- **Source:** `apps/orchestrator/src/components/status-bar.tsx` (new, ~10 LOC; added in P1, removed in P2 once the signal is physically gone).

### B9: `ws-bridge.test.ts` 4-signal priority chain test rewritten against derivation

**Core:**
- **ID:** ws-bridge-test-rewrite
- **Trigger:** `pnpm --filter @duraclaw/orchestrator test` running the ws-bridge suite.
- **Expected:** The rewritten test seeds messagesCollection with a (user → assistant → result) sequence, seeds D1 row with `status='running'` + stale `messageSeq`, asserts `useDerivedStatus` returns `idle`. The old fixture (`sessionLocalCollection` with liveStatus/rawD1Status) is deleted.
- **Verify:** File contents contain no references to `liveStatus`, `rawD1Status`, `deriveStatus`. Passes on `pnpm test`.
- **Source:** `apps/orchestrator/src/features/agent-orch/__tests__/ws-bridge.test.ts:108-127` (rewritten)

## Non-Goals

- **Flag-gated rollout.** The collapse ships as a single commit with `git revert` as the rollback mechanism. `useDerivedStatus` has been the primary path via spec #31 since deploy; we're deleting the fallback chain, not the primary path. A flag adds ~50 LOC of new code contradicting the subtract framing.
- **`kata_state` / `context_usage` `gateway_event` broadcast cleanup.** These are redundant with messagesCollection but touch a different hot path with a different risk profile. Separate follow-up issue.
- **Delete the `shouldSendProtocolMessages() => false` suppression.** Spec #31 already deleted all `setState` calls — the suppression is a no-op today. Removing it does nothing observable. Out of scope to avoid pointless wire-protocol churn.
- **Delete `wsReadyState` entirely.** It still drives the DISCONNECTED visual + `WsDot` color via `deriveDisplayStateFromStatus`. Its role narrows from "status truth-gate" to "presentation-only"; it does not disappear.
- **Delete `RECOVERY_GRACE_MS` (15s) or `WATCHDOG_INTERVAL_MS` (30s).** Both load-bearing for runner re-dial grace and hibernation-safe alarm. Independent of the TTL machinery.
- **Delete `STALE_THRESHOLD_MS=5000` in ConnectionManager** or `WS_GRACE_MS=5000` in display-state.ts. Both orthogonal to status derivation — stays.
- **Optimize or reshape `useDerivedStatus` internals beyond adding the messageSeq tiebreaker.** The hook's fold semantics are settled by spec #31; this epic uses it as-is.
- **Server-side `/api/sessions/active` filter or history sort semantics.** Those still read D1 `agent_sessions.status`. Client render is what collapses; server queries are unchanged.

## Implementation Phases

Defined in frontmatter. Dependency chain: p1 → p2 → (p3 ∥ p4) → p5 → p6. p3 and p4 are parallelizable (they touch disjoint code paths — gate scalar vs. lastEventTs/raw_event/aeb9209); p5 depends on **both** because it rewrites `ws-bridge.test.ts` which covers handlers P3 removes and projects `messageSeq` into the row whose schema P4 leaves untouched. p1 ships the render collapse + creates `useDerivedStatus` + dev tripwire; p2 removes the `session_status` frame the tripwire guards against, then deletes the tripwire; p3 handles the gate collapse; p4 handles the server-side TTL/raw_event cleanup + aeb9209 surgical undo; p5 adds the `messageSeq` tiebreaker + rewrites tests; p6 verifies + docs.

## Verification Plan

Run from `/data/projects/duraclaw-dev2` on the feature branch post-implementation.

1. **Lint + typecheck + test**
   - `pnpm typecheck` — exits 0
   - `pnpm test` — exits 0
   - `pnpm --filter @duraclaw/orchestrator build` — exits 0

2. **Audit sweep (must all return zero code matches)**
   - `/usr/bin/grep -rn 'deriveStatus\|TTL_MS\b' apps/orchestrator/src packages/ || echo OK`
   - `/usr/bin/grep -rn 'liveStatus\|liveGate\|liveError\|rawD1Status' apps/orchestrator/src packages/ || echo OK`
   - `/usr/bin/grep -rn 'session_status\|raw_event' apps/orchestrator/src packages/shared-types/src || echo OK`
   - `/usr/bin/grep -rn 'lastEventTs\|last_event_ts\|bumpLastEventTs\|flushLastEventTsToD1\|shouldForceFlushLastEventTs\|LAST_EVENT_FLUSH' apps/orchestrator/src packages/ || echo OK`
   - `ls apps/orchestrator/src/lib/derive-status.ts 2>/dev/null && echo FAIL || echo OK` (file must not exist)
   - `ls apps/orchestrator/src/hooks/use-derived-status.ts` (file must exist — created in P1)

3. **Net LOC target**
   - `git diff main...HEAD --stat -- 'apps/*' 'packages/*'`
   - Record `<total insertions> vs <total deletions>` in PR body. Net removed ≥ 400 LOC. Target ~550 delete minus ~20 add ≈ 530 net.

4. **Local stack verification**
   - `scripts/verify/dev-up.sh` — orchestrator + gateway up on derived ports
   - `scripts/verify/axi-login a`
   - Start a new session in the UI; send a message; wait for `result`.
   - `scripts/verify/axi-a eval \"document.querySelector('[data-testid=\\\"status-bar-label\\\"]').innerText\"` — expect `Idle` after result arrives.
   - Kill the orchestrator process; `scripts/verify/axi-a eval` should show the WS disconnect banner after ~5s (WS_GRACE_MS).
   - Restart orchestrator; wait 5s; banner clears; status label stays correct (derived from messagesCollection).

5. **Hibernation recovery**
   - Run `pnpm --filter @duraclaw/orchestrator test apps/orchestrator/src/agents/__tests__/session-do.test.ts` — grace-action predicate + grace-deadline-alarm + auto-heal-on-sendMessage all pass. `shouldForceFlushLastEventTs` test block absent.

6. **Gate end-to-end**
   - In dev stack, submit a prompt that triggers `ask_user`. Approve it. Verify prompt appears and dismisses normally.
   - Repeat; force WS drop mid-gate (kill orchestrator, restart). On reconnect, verify the ask_user prompt reappears via messagesCollection snapshot. WS-frame inspection: no `session_status` or gate-specific `gateway_event` carrying the gate.

7. **Stuck-running scenario (the whole point of the epic)**
   - Inject a D1 row with `status='running'` but no corresponding messagesCollection tail (manually: via wrangler d1 execute against the local miniflare DB).
   - Load the orchestrator UI on that session. Label shows `Idle` immediately (within one render tick), not after 45s TTL.

## Implementation Hints

### Key imports
```ts
// Replaces the 3 deleted imports (deriveStatus, useNow, TTL_MS)
import { useDerivedStatus } from '~/hooks/use-derived-status'

// For the dev tripwire (p1 only, deleted in p2)
const DEV = import.meta.env.DEV
```

### Code patterns

**Pattern A — render collapse (applied in 4 surfaces):**
```tsx
// Before (status-bar.tsx:260-264)
const d1Status = session ? deriveStatus(session, nowTs) : undefined
const rawD1Status = session?.status as SessionStatus | undefined
const liveStatus = local?.liveStatus as SessionStatus | undefined
const status = liveStatus ?? (readyState !== 1 ? rawD1Status : undefined) ?? d1Status

// After
const status = useDerivedStatus(sessionId) ?? (session?.status as SessionStatus | undefined)
```

**Pattern B — dev tripwire (p1):**
```tsx
// Add immediately above the useDerivedStatus call in status-bar.tsx
if (import.meta.env.DEV) {
  const legacy = local as unknown as { liveStatus?: unknown; liveGate?: unknown; liveError?: unknown }
  if (legacy?.liveStatus !== undefined || legacy?.liveGate !== undefined || legacy?.liveError !== undefined) {
    throw new Error('[gh76] legacy status signal on sessionLocalCollection — this channel is deleted in P2')
  }
}
```

**Pattern C — raw_event fallback replacement (p4):**
```ts
// Before (session-do.ts:4320 and 4 sibling catch blocks)
} catch (err) {
  this.server.send(JSON.stringify({ type: 'raw_event', event }))
}

// After
} catch (err) {
  console.error('[session-do] event persist failed, scheduling recovery alarm', err)
  await this.ctx.storage.setAlarm(Date.now() + 1000)
}
```

**Pattern D — messageSeq on broadcastSessionRow (p5):**
```ts
// In broadcastSessionRow (~:2457)
const row = {
  ...existingRow,
  messageSeq: this.messageSeq, // already tracked for messages broadcasts
}
await broadcastSyncedDelta(this.env, userId, 'agent_sessions', [
  { type: 'update', value: row },
])
```

### Gotchas

- **`DISCONNECTED` banner timing** — `WS_GRACE_MS=5000` in `display-state.ts:88` remains. Do not delete. It suppresses the "Reconnecting…" label for the first 5s of a WS drop; unrelated to status derivation.
- **Cold-load fallback path** — when `useDerivedStatus` returns `undefined` (no messages yet), the hybrid falls through to `session?.status`. Do not remove this fallback — it's the whole point of "hybrid." Cold loads without any messagesCollection rows would otherwise render blank.
- **D1 migration ordering** — the `ALTER TABLE agent_sessions DROP COLUMN last_event_ts` migration (p4) must land in the same deploy as the TypeScript that stops reading/writing that column. Wrangler's migration runner applies DDL transactionally per file; put both changes in a single migration file or in adjacent ones ordered by filename.
- **messageSeq hook logic** — remember the tiebreaker is one-sided. If `localSeq > D1.messageSeq`, prefer derived. If `D1.messageSeq >= localSeq` (common for warm cache), fall through to `session?.status`. Don't swap the comparison — it will mask the race the field exists to close.
- **Commit atomicity across P1/P2** — the whole epic ships as a **single commit** (interview decision: "single commit, ~550 LOC delete"). P1 and P2 are phases within that one commit, not separate deploys. The dev-only tripwire added in P1 and removed in P2 therefore never survives to a production bundle — it exists only inside the atomic commit to satisfy the in-phase test case `tripwire-throws-in-dev`. If an implementer decides to break the epic into separate PRs anyway, the tripwire is still production-safe because `import.meta.env.DEV` is statically DCE'd by Vite in production builds; either path is correct.
- **session-do.test.ts hibernation fixtures** — these fixtures seed `session_meta` with a `last_event_ts` column. Update the fixture schema alongside the DDL change or the tests will fail with "no such column" before they can exercise the recovery-grace path.
- **sessionLocalCollection is memory-only** — it uses `localOnlyCollectionOptions` (see `apps/orchestrator/src/db/session-local-collection.ts:40`). No OPFS persistence, no schemaVersion, no cross-session cache. Dropping `liveStatus` / `liveGate` / `liveError` fields needs no migration or version bump; the collection reseeds on every page load. (OPFS-persisted collections like `messagesCollection` / `sessionsCollection` are unaffected by this epic's shape changes.)

### Reference docs

- Research: `planning/research/2026-04-23-session-state-subtraction-gh76.md` — authoritative map of the 4-signal topology + 7-timeout audit + prior-patch archaeology.
- Spec #31: `planning/specs/31-unified-sync-channel.md` — defines the derivation-from-messages pattern this epic completes (note: `useDerivedStatus` is not yet implemented; P1 creates it).
- Spec #14: `planning/specs/14-messages-transport-unification.md` — `{kind:'snapshot'}` frame that takes over gate re-delivery on reconnect (replaces the deleted gateway_event gate re-emit).
- Spec #37: `planning/specs/37-session-state-collapse.md` — agent_sessions synced-collection-delta shape that becomes the sole status carrier; also the spec that introduced the memory-only sessionLocalCollection (B11).
- Companion hook: `apps/orchestrator/src/hooks/use-derived-gate.ts` — the shape/pattern to mirror when creating `use-derived-status.ts` in P1.
- Cloudflare Durable Objects + WebSocket Hibernation: https://developers.cloudflare.com/durable-objects/api/websockets/ — alarm handler semantics after hibernation wake.
