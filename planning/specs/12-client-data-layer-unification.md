---
initiative: client-data-layer-unification
type: project
issue_type: feature
status: approved
priority: high
github_issue: 12
created: 2026-04-19
updated: 2026-04-19
phases:
  - id: p1
    name: "sessionLiveStateCollection + StatusBar migration"
    tasks:
      - "Create apps/orchestrator/src/db/session-live-state-collection.ts: localOnlyCollectionOptions with id 'session_live_state', keyed on sessionId, persisted to OPFS (schemaVersion 1). Shape: {id, state, contextUsage, kataState, worktreeInfo, sessionResult, wsReadyState, updatedAt}. Use the established dbReady + factory pattern from messages-collection.ts."
      - "Create apps/orchestrator/src/db/projects-collection.ts: queryCollectionOptions wrapping GET /api/gateway/projects/all with staleTime 30_000, refetchInterval 30_000. Use agentSessionsCollection as the pattern reference. Shape: project objects keyed on project name."
      - "In use-coding-agent.ts onStateUpdate (line 254): after setState(newState), upsert into sessionLiveStateCollection with {id: agentName, state: newState, wsReadyState: 1, updatedAt: new Date().toISOString()}. Note: agentName IS the sessionId in this codebase (useAgent's `name` param is the session DO id). Strip active_callback_token before writing — move sanitizeState from session-status-collection.ts to apps/orchestrator/src/db/session-live-state-collection.ts (co-located with the collection it serves, not a generic util)."
      - "Add WS disconnect handling: in use-coding-agent.ts, derive wsReadyState from the useAgent connection state. When the WS connection closes or errors (useAgent returns readyState !== 1), upsert wsReadyState into sessionLiveStateCollection. Use a useEffect that watches the connection's readyState and writes it to the collection on change. This ensures the 'disconnected' DisplayState variant (B10) fires correctly when a session loses its WS connection."
      - "In use-coding-agent.ts onMessage gateway_event handlers (lines 346-371): after setKataState/setContextUsage/setSessionResult, upsert the corresponding field into sessionLiveStateCollection via patch-style update."
      - "In AgentDetailView.tsx: replace the /api/gateway/projects/all setInterval (lines 147-182) with a useLiveQuery on projectsCollection filtered to the active project. Write matched worktreeInfo into sessionLiveStateCollection."
      - "In status-bar.tsx: replace useStatusBarStore() reads for state/contextUsage/sessionResult/kataState/worktreeInfo/wsReadyState with a useLiveQuery on sessionLiveStateCollection keyed on the active sessionId. Keep reading onStop/onInterrupt from useStatusBarStore."
      - "In AgentDetailView.tsx: delete the useLayoutEffect cache-first hydration (lines 83-108), the useEffect live-overlay (lines 114-124), and the useEffect write-through (lines 129-137). These are replaced by the collection's OPFS persistence + useLiveQuery."
      - "Reduce useStatusBarStore to 2 fields: onStop, onInterrupt (and their setters + clear). Delete state/wsReadyState/contextUsage/sessionResult/kataState/worktreeInfo from the store interface and the clear() reset."
      - "Delete apps/orchestrator/src/db/session-status-collection.ts entirely. Remove all imports of readSessionStatusCache/writeSessionStatusCache/sessionStatusCollection."
      - "Update tests: status-bar.test.tsx and AgentDetailView.test.tsx to mock sessionLiveStateCollection instead of useStatusBarStore for server-data fields."
    test_cases:
      - id: "collection-persists"
        description: "sessionLiveStateCollection row survives page reload via OPFS. Open a session, verify status bar renders, reload, verify status bar renders again without WS reconnect."
        type: "integration"
      - id: "tab-switch-no-flash"
        description: "Switch between two session tabs. Status bar renders instantly on each switch (no blank frame). Verified via chrome-devtools-axi snapshot after tab click — status bar elements present in first snapshot."
        type: "e2e"
      - id: "field-count-test"
        description: "Adding a hypothetical test field to the status bar requires touching exactly 2 files: session-live-state-collection.ts (schema) and status-bar.tsx (consumer). Verified by code review."
        type: "review"
      - id: "projects-collection-replaces-poll"
        description: "No setInterval calls remain in AgentDetailView.tsx. projectsCollection refetches every 30s. Worktree info appears in status bar."
        type: "integration"
      - id: "session-status-deleted"
        description: "No file named session-status-collection.ts exists. No imports of readSessionStatusCache or writeSessionStatusCache anywhere in the codebase. Verified via: rg 'session-status-collection' apps/orchestrator/src/ returns 0 matches."
        type: "audit"
      - id: "zustand-reduced"
        description: "useStatusBarStore has exactly 2 data fields (onStop, onInterrupt) plus set/clear. No server-data fields remain. Verified via: grep -c 'state\\|contextUsage\\|sessionResult\\|kataState\\|worktreeInfo\\|wsReadyState' apps/orchestrator/src/stores/status-bar.ts returns 0."
        type: "audit"

  - id: p2
    name: "use-coding-agent.ts cleanup + sidebar live status"
    tasks:
      - "In use-coding-agent.ts: remove useState declarations for state, sessionResult, kataState, contextUsage (lines 137-147). Retain useState for events (debug log accumulator — not server-authoritative state, has no collection equivalent). Remove the agentName-change reset block for state/sessionResult/kataState/contextUsage (lines 155-165, keep branchInfo and events reset). Return values for state/kataState/contextUsage/sessionResult now come from sessionLiveStateCollection via useSessionLiveState in the hook."
      - "Export a useSessionLiveState(sessionId) hook from a new file (apps/orchestrator/src/hooks/use-session-live-state.ts) that wraps useLiveQuery on sessionLiveStateCollection. Returns {state, contextUsage, kataState, worktreeInfo, sessionResult, wsReadyState, isLive}."
      - "In SessionCardList.tsx / SessionListItem.tsx: for each visible session card, call useSessionLiveState(sessionId) to get real-time status instead of relying on agentSessionsCollection's 30s stale data. Show live status dot when isLive is true."
      - "Update use-notification-watcher.ts: replace its session status observation logic with a collection-wide useLiveQuery on sessionLiveStateCollection (no key filter — returns all rows as an array). Use a useRef<Map<string, string>> to track previous status per sessionId. On each query update, iterate all rows; for each row where prevStatus !== currentStatus, fire addNotification on qualifying transitions (running→idle, any→waiting_gate). Update the ref map after processing. This observes all sessions including background ones, matching the current watcher's scope."
      - "Refactor status-bar.tsx to use useSessionLiveState(activeSessionId) instead of raw useLiveQuery, for consistency with sidebar and notification consumers."
    test_cases:
      - id: "hook-shrink"
        description: "use-coding-agent.ts has fewer than 650 LOC (down from 741). No useState for state/sessionResult/kataState/contextUsage. useState retained for events (debug log) and branchInfo only."
        type: "audit"
      - id: "sidebar-live-status"
        description: "Start a session. In the sidebar, the session card shows 'running' status in real-time (not delayed by 30s). Stop the session — card updates to 'idle' within 2 seconds."
        type: "e2e"
      - id: "notifications-still-fire"
        description: "When a session transitions to idle or waiting_gate, notification bell shows unread count. Notification drawer shows the notification with correct session name."
        type: "e2e"

  - id: p3
    name: "Display-state derivation + cleanup"
    tasks:
      - "Create apps/orchestrator/src/lib/display-state.ts: export function deriveDisplayState(state: SessionState | null, wsReadyState: number): DisplayState. Returns a discriminated union with status label, color, icon, and whether the session is interactive. Centralizes the status-dot logic currently duplicated across StatusBar, SessionListItem, and tab-bar."
      - "Update StatusBar, SessionListItem, tab-bar to use deriveDisplayState instead of inline status derivation."
      - "Delete apps/orchestrator/src/db/sessions-collection.ts (the re-export shim). Update all imports to use agent-sessions-collection directly."
      - "Audit: grep for any remaining direct reads of useStatusBarStore server-data fields. Should be zero. Grep for any remaining setInterval fetch patterns. Should be zero."
      - "Update CLAUDE.md architecture section to reflect the new data flow: WS → sessionLiveStateCollection → useLiveQuery → render."
    test_cases:
      - id: "display-state-unit"
        description: "deriveDisplayState returns correct label/color for each SessionState.status value: running, idle, waiting_gate, error, archived. Returns 'disconnected' when wsReadyState !== 1."
        type: "unit"
      - id: "consistent-status-display"
        description: "Status bar, sidebar session card, and tab bar all show the same status indicator for a running session. Verified via chrome-devtools-axi snapshot comparing all three surfaces."
        type: "e2e"
      - id: "no-dead-code"
        description: "No imports of session-status-collection.ts, no imports of sessions-collection.ts (shim), no setInterval for /api/gateway/projects/all. Verified via rg commands in VP4."
        type: "audit"
---

# GH#12: Unify Client Data Layer on TanStack DB Collections

## Overview

Session live state reaches the UI through 5 uncoordinated channels (WS state
sync, WS events, RPC, REST query, manual poll), each written to a different
target (React state, Zustand, OPFS cache, query collection). Every consumer
hand-rolls its own cache-first + live-overlay + write-through logic, making
every new status-bar field a 5-file change. This spec commits to
`sessionLiveStateCollection` as the single render source for session live
state, retiring the Zustand bridge and the ad-hoc OPFS cache.

## Feature Behaviors

### B1: Session Live State Collection

**Core:**
- **ID:** session-live-state-collection
- **Trigger:** WS state sync (`onStateUpdate`) or WS event (`gateway_event`)
  delivers session data to the client.
- **Expected:** Data is upserted into `sessionLiveStateCollection` (OPFS-
  persisted, keyed on sessionId). The collection is the single render source
  for session live state. Components read via `useLiveQuery`.
- **Verify:** After WS delivers a state update, `sessionLiveStateCollection.get(sessionId)`
  returns the updated state within 1 render cycle. After page reload, the row
  is present from OPFS before WS reconnects.
- **Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:254` (onStateUpdate), `:312` (onMessage) — modify to write to collection.

#### Data Layer
New file: `apps/orchestrator/src/db/session-live-state-collection.ts`

```typescript
export interface SessionLiveState {
  id: string                    // sessionId
  state: SessionState | null
  contextUsage: ContextUsage | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
  wsReadyState: number
  updatedAt: string
}
```

- `localOnlyCollectionOptions` + `persistedCollectionOptions` (OPFS, schemaVersion 1)
- Write path: direct `collection.upsert()` from WS handlers (no middleware)
- Multi-tab: last-write-wins (both tabs receive identical DO state)
- Strips `active_callback_token` before persisting (security)
- **Degradation on write failure:** If OPFS is unavailable (Safari private
  browsing, quota exceeded), the collection falls back to memory-only storage
  (per `db-instance.ts` fallback path). Components still work — they just
  lose persistence across page reloads. Tab-switch cache-first hydration
  degrades to WS-only (brief loading state on switch). No user-visible error
  — this matches the current behavior when OPFS is unavailable.

### B2: StatusBar Reads from Collection

**Core:**
- **ID:** status-bar-collection-read
- **Trigger:** StatusBar component mounts or the active session changes.
- **Expected:** StatusBar reads `state`, `contextUsage`, `sessionResult`,
  `kataState`, `worktreeInfo`, `wsReadyState` from `sessionLiveStateCollection`
  via `useLiveQuery`. Reads `onStop`/`onInterrupt` from `useStatusBarStore`
  (callbacks only). No blank flash on tab switch — OPFS persistence provides
  instant hydration.
- **Verify:** Open session A, switch to session B, switch back to A. Status
  bar shows A's data instantly (no loading spinner, no null frame). Verified
  via `chrome-devtools-axi snapshot` — status bar elements present in first
  snapshot after tab click.
- **Source:** `apps/orchestrator/src/components/status-bar.tsx:225` — replace `useStatusBarStore()` server-data reads.

#### UI Layer
- StatusBar: `useLiveQuery` on `sessionLiveStateCollection` replaces Zustand reads
- **Active session ID propagation:** StatusBar receives the active sessionId
  from the URL route param (`useParams()` from TanStack Router — the session
  route is `/session/$sessionId`). This is already available in the routing
  context and avoids adding a new Zustand field or React context. When no
  session is active (e.g., dashboard view), sessionId is undefined and
  StatusBar renders nothing.
- No loading state needed — OPFS row exists from prior session or is populated instantly by WS
- Null guard: if no row for active sessionId, render nothing (same as current `if (!state) return null`)

### B3: Delete Zustand Server-Data Fields

**Core:**
- **ID:** zustand-server-data-delete
- **Trigger:** Spec implementation.
- **Expected:** `useStatusBarStore` contains only `onStop`, `onInterrupt`,
  `set`, and `clear`. No fields for `state`, `wsReadyState`, `contextUsage`,
  `sessionResult`, `kataState`, or `worktreeInfo`.
- **Verify:** Read `apps/orchestrator/src/stores/status-bar.ts` — interface
  has exactly 4 members (`onStop`, `onInterrupt`, `set`, `clear`). Grep for
  `useStatusBarStore` — no call site reads server-data fields.
- **Source:** `apps/orchestrator/src/stores/status-bar.ts:19-53` — reduce to callbacks only.

### B4: Delete Cache-First Effects in AgentDetailView

**Core:**
- **ID:** delete-cache-effects
- **Trigger:** Spec implementation.
- **Expected:** `AgentDetailView.tsx` no longer contains:
  - `useLayoutEffect` for cache-first hydration (lines 83-108)
  - `useEffect` for live-overlay null-guarded writes to Zustand (lines 114-124)
  - `useEffect` for write-through to `sessionStatusCollection` (lines 129-137)
  These are replaced by the collection's OPFS persistence + `useLiveQuery`
  pattern. The three-tier resolution pattern is eliminated by construction.
- **Verify:** `AgentDetailView.tsx` has no import of `readSessionStatusCache`,
  `writeSessionStatusCache`, `sessionStatusCollection`, or `synthesizeStateFromSessionRecord`.
  Grep confirms zero results.
- **Source:** `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx:83-137` — delete.

### B5: Delete sessionStatusCollection

**Core:**
- **ID:** delete-session-status-collection
- **Trigger:** Spec implementation (after B1, B2, B4).
- **Expected:** `apps/orchestrator/src/db/session-status-collection.ts` is
  deleted. All imports removed. The `sessionLiveStateCollection` serves both
  as the render source and the OPFS persistence layer — no separate cache.
- **Verify:** File does not exist. `rg 'session-status-collection' apps/orchestrator/src/`
  returns zero matches. `rg 'sessionStatusCollection' apps/orchestrator/src/`
  returns zero matches.
- **Source:** `apps/orchestrator/src/db/session-status-collection.ts` — delete entirely.

### B6: Projects QueryCollection

**Core:**
- **ID:** projects-query-collection
- **Trigger:** Component that needs worktree info mounts.
- **Expected:** `projectsCollection` wraps `GET /api/gateway/projects/all` as
  a `queryCollectionOptions` collection with `staleTime: 30_000` and
  `refetchInterval: 30_000`. Replaces the raw `fetch` + `setInterval` in
  `AgentDetailView.tsx:147-182`. Worktree info for the active session is read
  from `projectsCollection` and written into `sessionLiveStateCollection`.
- **Verify:** No `setInterval` calls remain in `AgentDetailView.tsx`. Worktree
  info (branch name, dirty, ahead/behind, PR) appears in status bar. Network
  tab shows `/api/gateway/projects/all` fetched every ~30s (not duplicated
  per open session tab).
- **Source:** `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx:147-182` — replace with collection read.

**Project-to-session join logic:** The active session's `state.project`
field contains the project name (e.g., `"duraclaw-dev1"`). This is matched
against `projectsCollection` rows keyed on `project.name`. The matched
row's worktree fields (`branch`, `dirty`, `ahead`, `behind`, `pr`) are
written as `worktreeInfo` into `sessionLiveStateCollection` for the active
sessionId. This mirrors the existing join logic in `AgentDetailView.tsx:154`
(`fetchWorktreeInfo` matches `state.project` against the projects response).

#### Data Layer
New file: `apps/orchestrator/src/db/projects-collection.ts`

```typescript
const queryOpts = queryCollectionOptions({
  id: 'projects',
  queryKey: ['projects'] as const,
  queryFn: async () => {
    const resp = await fetch('/api/gateway/projects/all')
    if (!resp.ok) return []
    return (await resp.json()) as ProjectInfo[]
  },
  queryClient,
  getKey: (item: ProjectInfo) => item.name,
  refetchInterval: 30_000,
  staleTime: 30_000,
})
```

### B7: useSessionLiveState Hook

**Core:**
- **ID:** use-session-live-state-hook
- **Trigger:** Any component needs session live state for a given sessionId.
- **Expected:** `useSessionLiveState(sessionId)` returns `{state, contextUsage,
  kataState, worktreeInfo, sessionResult, wsReadyState, isLive}` via
  `useLiveQuery` on `sessionLiveStateCollection`. `isLive` is true when
  `wsReadyState === 1`. Reusable across StatusBar, sidebar, notifications.
- **Verify:** Two components calling `useSessionLiveState(sameId)` both update
  when the collection row changes. No prop drilling, no Zustand bridge.
- **Source:** New file: `apps/orchestrator/src/hooks/use-session-live-state.ts`

### B8: Sidebar Live Status

**Core:**
- **ID:** sidebar-live-status
- **Trigger:** Session card is visible in the sidebar.
- **Expected:** Session cards show real-time status via `useSessionLiveState`
  instead of relying on `agentSessionsCollection`'s 30s-stale data. Status
  dot updates within 2 seconds of a session state change.
- **Verify:** Start a session. Sidebar card shows "running" immediately. Stop
  the session — card shows "idle" within 2s. No 30s delay.
- **Source:** `apps/orchestrator/src/features/agent-orch/SessionCardList.tsx:14`, `SessionListItem.tsx`

#### UI Layer
- SessionListItem: call `useSessionLiveState(session.id)` for status
- Fallback: if no live state row exists (session never connected in this
  browser), fall back to `agentSessionsCollection` row's `status` field
- Status dot shows live color when `isLive` is true, muted when false

### B9: Notification Watcher Migration

**Core:**
- **ID:** notification-watcher-migration
- **Trigger:** Session live state transitions in `sessionLiveStateCollection`.
- **Expected:** `use-notification-watcher.ts` reads from
  `sessionLiveStateCollection` to detect status transitions (running→idle,
  any→waiting_gate) instead of its own observation logic. Fires
  `addNotification` on transition. Transition detection uses a `useRef<Map<string, string>>`
  that tracks the previous `status` per sessionId. On each `useLiveQuery`
  update, the hook compares `prevStatus !== currentStatus` and fires
  notifications on qualifying transitions. The ref is updated after
  processing, so each transition fires exactly once.
- **Verify:** Session completes → notification bell shows unread count.
  Session hits gate → notification appears with "needs attention" type.
- **Source:** `apps/orchestrator/src/hooks/use-notification-watcher.ts:16`

**Mount guarantee:** `useNotificationWatcher` is called from
`useSessionsCollection`, which is mounted in `nav-sessions.tsx` (sidebar
layout) and `AgentOrchPage.tsx`. These are app-shell-level components that
persist across navigation — the watcher never unmounts during normal use.
The `useRef<Map>` is therefore stable for the lifetime of the app. If a
full page reload occurs, the ref resets, but OPFS-persisted session states
will all appear as "new" (no previous status to compare against), so no
false-positive transition notifications fire — only genuine transitions
from the initial null state are suppressed by checking `prevStatus !== undefined`.

### B10: Display-State Derivation

**Core:**
- **ID:** display-state-derivation
- **Trigger:** Any UI surface needs to render session status.
- **Expected:** `deriveDisplayState(state, wsReadyState)` returns a
  `DisplayState` discriminated union. Centralizes the status-dot / status-text
  logic currently duplicated across StatusBar, SessionListItem, and tab-bar.
- **Verify:** Unit test covers all variants. All three surfaces (StatusBar,
  sidebar, tab bar) show identical status indicators for a running session.
- **Source:** New file: `apps/orchestrator/src/lib/display-state.ts`

#### Data Layer

```typescript
type DisplayState =
  | { status: 'running';      label: 'Running';       color: 'green';  icon: 'spinner';  isInteractive: true }
  | { status: 'idle';         label: 'Idle';           color: 'gray';   icon: 'circle';   isInteractive: true }
  | { status: 'waiting_gate'; label: 'Needs Attention'; color: 'amber'; icon: 'alert';    isInteractive: true }
  | { status: 'error';        label: 'Error';          color: 'red';    icon: 'x-circle'; isInteractive: false }
  | { status: 'archived';     label: 'Archived';       color: 'gray';   icon: 'archive';  isInteractive: false }
  | { status: 'disconnected'; label: 'Disconnected';   color: 'gray';   icon: 'wifi-off'; isInteractive: false }
  | { status: 'unknown';      label: 'Unknown';        color: 'gray';   icon: 'circle';   isInteractive: false }
```

`disconnected` is returned when `wsReadyState !== 1` and state is non-null.
`unknown` is returned when `state` is null (never-connected session).

### B11: use-coding-agent.ts Shrink

**Core:**
- **ID:** coding-agent-shrink
- **Trigger:** Spec implementation (after B1, B7).
- **Expected:** `use-coding-agent.ts` no longer has `useState` for `state`,
  `sessionResult`, `kataState`, `contextUsage`. These values are read from
  `sessionLiveStateCollection` via `useSessionLiveState`. `events` retains
  its `useState` (debug log accumulator, not server-authoritative state). The
  agentName-change reset block is reduced (no need to reset server-data
  state). Hook is under 650 LOC.
- **Verify:** `wc -l` on `use-coding-agent.ts` is < 650. `grep 'useState'`
  shows exactly `branchInfo` and `events`. No `useState` for `state`,
  `sessionResult`, `kataState`, `contextUsage`.
- **Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:137-165`

## Non-Goals

1. **No DO protocol changes** — `onStateUpdate` still delivers full
   `SessionState`, `onMessage` still delivers `gateway_event`. The change is
   purely where the client writes that data. DO protocol can evolve separately.
2. **No `useAgent` command-plane changes** — `spawn`, `stop`, `interrupt`,
   `resolveGate`, `sendMessage` stay as RPC calls on the `useAgent` connection.
3. **No `useCachedLiveQuery` helper** — raw `useLiveQuery` is sufficient for
   the pilot. Extract a helper only if 3+ consumers repeat a fallback pattern.
4. **No sync middleware** — direct collection writes from WS handlers. Add
   batching/middleware only if write contention surfaces.
5. **No worktree push channel** — `projectsCollection` polls at 30s staleTime.
   A nudge channel is a gateway-side concern for a separate issue.
6. **No messages collection changes** — already collection-native. Write path
   stays in `use-coding-agent.ts`.
7. **No OPFS schema migration tooling** — schema version bump on
   `sessionLiveStateCollection` (v1) drops stale `sessionStatusCollection`
   rows automatically. Acceptable because it's a cache.

## Implementation Phases

### Phase 1: sessionLiveStateCollection + StatusBar Migration

**Goal:** Replace the 5-channel data flow for session live state with a
single collection. Delete the Zustand server-data bridge and the OPFS cache.

**Behaviors:** B1, B2, B3, B4, B5, B6

**Estimated effort:** 4-6 hours

**Done when:**
- StatusBar reads from `sessionLiveStateCollection` via `useLiveQuery`
- `useStatusBarStore` has only `onStop`/`onInterrupt`
- `sessionStatusCollection` is deleted
- `projectsCollection` replaces the 30s setInterval
- Tab switch has no blank flash
- Adding a new field touches 2 files

### Phase 2: use-coding-agent.ts Cleanup + Sidebar Live Status

**Goal:** Remove duplicate React state from the hook and bring live status
to the sidebar.

**Behaviors:** B7, B8, B9, B11

**Estimated effort:** 2-3 hours

**Done when:**
- `useSessionLiveState` hook exists and is used by sidebar and notifications (StatusBar switches from raw `useLiveQuery` to `useSessionLiveState` for consistency)
- `use-coding-agent.ts` is under 650 LOC
- Sidebar shows real-time session status
- Notifications fire on status transitions

### Phase 3: Display-State Derivation + Cleanup

**Goal:** Centralize status display logic and clean up dead code.

**Behaviors:** B10 + cleanup

**Estimated effort:** 1-2 hours

**Done when:**
- `deriveDisplayState` is used by all status-rendering surfaces
- No dead imports/files remain
- `sessions-collection.ts` (shim) is deleted
- CLAUDE.md updated

## Verification Plan

### VP1: Collection persistence survives reload
```bash
# 1. Open a session, verify status bar renders
chrome-devtools-axi open http://localhost:43173
chrome-devtools-axi snapshot  # Find a session link, click it
chrome-devtools-axi snapshot  # Status bar should show session state

# 2. Block WS reconnection (simulate offline for WS only)
chrome-devtools-axi eval "window.__blockWS = true; const orig = WebSocket; window.WebSocket = function() { if (window.__blockWS) throw new Error('blocked'); return new orig(...arguments); }"

# 3. Reload and verify OPFS hydration without WS
chrome-devtools-axi eval 'location.reload()'
chrome-devtools-axi snapshot  # Status bar should render from OPFS

# 4. Unblock WS
chrome-devtools-axi eval "delete window.__blockWS; window.WebSocket = WebSocket"
```
**Expected:** Status bar elements visible in snapshot after reload even with WS blocked. This proves the OPFS-persisted collection provides the data, not a fast WS reconnect.

### VP2: Tab-switch no blank flash
```bash
# 1. Open session A
chrome-devtools-axi open http://localhost:43173/session/SESSION_A_ID
chrome-devtools-axi snapshot  # Note status bar content
# 2. Switch to session B (click tab)
chrome-devtools-axi click @tab-b-ref
chrome-devtools-axi snapshot  # Status bar shows B's data
# 3. Switch back to A
chrome-devtools-axi click @tab-a-ref
chrome-devtools-axi snapshot  # Status bar shows A's data instantly
```
**Expected:** Every snapshot shows populated status bar. No "null" or empty state visible.

### VP3: Field-count verification
```bash
# Count files that need changing to add a hypothetical "runner_uptime_ms" field:
# 1. session-live-state-collection.ts (add to SessionLiveState interface)
# 2. status-bar.tsx (read and render the new field)
# That's it. No Zustand type, no cache schema, no write-through effect, no synthesize fallback.
rg 'runner_uptime_ms' apps/orchestrator/src/ --count
# Expected: exactly 2 files
```

### VP4: Dead code verification
```bash
rg 'session-status-collection' apps/orchestrator/src/
# Expected: 0 matches

rg 'sessionStatusCollection' apps/orchestrator/src/
# Expected: 0 matches

rg 'readSessionStatusCache' apps/orchestrator/src/
# Expected: 0 matches

rg 'writeSessionStatusCache' apps/orchestrator/src/
# Expected: 0 matches

rg 'setInterval' apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx
# Expected: 0 matches

wc -l apps/orchestrator/src/stores/status-bar.ts
# Expected: < 25 lines (callbacks only)
```

### VP5: Sidebar live status
```bash
# 1. Start a session via the UI
# 2. Observe sidebar
chrome-devtools-axi snapshot
# Expected: session card shows "running" with live status dot
# 3. Stop the session
# 4. Observe sidebar within 2 seconds
chrome-devtools-axi snapshot
# Expected: session card shows "idle"
```

### VP6: Notification watcher
```bash
# 1. Start a session, let it complete
# 2. Check notification bell
chrome-devtools-axi snapshot
# Expected: notification bell shows unread count > 0
# 3. Open notification drawer
chrome-devtools-axi click @notification-bell-ref
chrome-devtools-axi snapshot
# Expected: notification with session name and "completed" type
```

### VP7: Display state consistency
```bash
# With a running session open:
chrome-devtools-axi snapshot
# Compare: status bar status text, sidebar card status dot, tab bar indicator
# Expected: all three show "running" with consistent color/label
```

### VP8: Hook size
```bash
wc -l apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
# Expected: < 650

grep -c 'useState' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
# Expected: exactly 2 (branchInfo + events)

grep 'useState.*state\b\|useState.*sessionResult\|useState.*kataState\|useState.*contextUsage' \
  apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
# Expected: 0 matches
```

### VP9: Build + typecheck
```bash
cd /data/projects/duraclaw-dev1
pnpm typecheck
pnpm build
pnpm test
# Expected: all pass
```

## Implementation Hints

### Key Imports
```typescript
// TanStack DB
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { useLiveQuery } from '@tanstack/react-db'  // confirmed in use-messages-collection.ts:7

// Existing patterns
import { dbReady, queryClient } from '~/db/db-instance'
```

### Code Patterns

**Collection creation (copy from messages-collection.ts):**
```typescript
const persistence = await dbReady

function createSessionLiveStateCollection() {
  const localOpts = localOnlyCollectionOptions<SessionLiveState, string>({
    id: 'session_live_state',
    getKey: (item: SessionLiveState) => item.id,
  })

  if (persistence) {
    const opts = persistedCollectionOptions({
      ...localOpts,
      persistence,
      schemaVersion: 1,
    })
    return createCollection(opts as any)
  }

  return createCollection(localOpts)
}

export const sessionLiveStateCollection = createSessionLiveStateCollection()
```

**Upsert pattern (copy from session-status-collection.ts writeSessionStatusCache):**
```typescript
export function upsertSessionLiveState(
  sessionId: string,
  patch: Partial<Omit<SessionLiveState, 'id' | 'updatedAt'>>,
): void {
  const updatedAt = new Date().toISOString()
  try {
    const coll = sessionLiveStateCollection as any
    if (coll.has?.(sessionId)) {
      coll.update(sessionId, (draft: SessionLiveState) => {
        Object.assign(draft, patch, { updatedAt })
      })
    } else {
      coll.insert({
        id: sessionId,
        state: null,
        contextUsage: null,
        kataState: null,
        worktreeInfo: null,
        sessionResult: null,
        wsReadyState: 3,
        ...patch,
        updatedAt,
      } as SessionLiveState)
    }
  } catch {
    // collection may not be ready; swallow
  }
}
```

**useLiveQuery in StatusBar (new pattern):**
```typescript
// In status-bar.tsx — replace useStatusBarStore() server-data reads
// Uses the established query-builder API from @tanstack/react-db
const { data } = useLiveQuery((q) =>
  q.from({ live_state: sessionLiveStateCollection as any })
)
const liveState = useMemo(() => {
  if (!data || !activeSessionId) return null
  return (data as unknown as SessionLiveState[])
    .find((r) => r.id === activeSessionId) ?? null
}, [data, activeSessionId])

const { onStop, onInterrupt } = useStatusBarStore()

if (!liveState?.state) return null
// ... render using liveState.state, liveState.contextUsage, etc.
```

### Gotchas

1. **Top-level await** — every collection module must `await dbReady` at the
   top level. Missing this silently falls back to memory-only (B-CLIENT-1 bug).
2. **`as any` casts** — TanStack DB beta `persistedCollectionOptions` return
   type doesn't satisfy `createCollection` overloads. Runtime is correct.
   Keep the eslint-disable comment.
3. **`sanitizeState`** — must strip `active_callback_token` before OPFS
   persistence. Currently in `session-status-collection.ts`; move to
   `session-live-state-collection.ts` (co-located with the collection it
   serves) before deleting the old file.
4. **`sessionsCollection.utils.writeUpdate()`** — `use-coding-agent.ts:274`
   mirrors WS state into the query collection. This stays — it's a local-only
   mirror write, not the render path we're changing.
5. **`useLiveQuery` import and API** — the established import is
   `import { useLiveQuery } from '@tanstack/react-db'` (see
   `hooks/use-messages-collection.ts:7`). The API is query-builder style:
   `useLiveQuery((q) => q.from({ name: collection as any }))` — returns
   `{ data, isLoading }`. For single-key lookup, filter `data` client-side
   by `sessionId` (same pattern as `useMessagesCollection`). The `as any`
   cast is required due to TanStack DB beta type mismatches.
6. **Active session ID** — StatusBar needs the active sessionId to query
   `sessionLiveStateCollection`. Use `useParams()` from TanStack Router —
   the session route is `/session/$sessionId`. When no session is active
   (dashboard view), sessionId is undefined and StatusBar renders nothing.

### Reference Docs
- TanStack DB docs: https://tanstack.com/db/latest — collection creation, useLiveQuery API
- Existing collection examples in `apps/orchestrator/src/db/` — all 5 files are reference implementations
- Prior research: `planning/research/2026-04-19-gh12-client-data-layer-unification.md`
- Issue: https://github.com/baseplane-ai/duraclaw/issues/12
