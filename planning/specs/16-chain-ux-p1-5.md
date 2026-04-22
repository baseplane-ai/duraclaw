---
initiative: chain-ux
type: project
issue_type: feature
status: draft
priority: high
github_issue: 16
created: 2026-04-22
updated: 2026-04-22  # Review round 1 fixes applied
supersedes: "16-chain-ux.md phase p1 (Chain tab surface / Feature 3B)"
phases:
  - id: p1
    name: "Delete chain tabs + route"
    tasks:
      - "Remove /chain/:issueNumber route and ChainPage.tsx"
      - "Remove kind:'chain' from TabMeta union in types.ts"
      - "Remove chain tab render branch in tab-bar.tsx:264-279"
      - "Remove all openTab('chain:' + ...) call sites (5 locations)"
      - "Update kanban card 'Open' action to navigate to latest session tab"
      - "D1 migration: soft-delete existing kind:'chain' tab rows"
    test_cases:
      - id: "chain-tab-gone"
        description: "Opening a kata-linked session no longer creates a chain tab — only a session tab appears in the tab bar"
        type: "integration"
      - id: "chain-route-404"
        description: "Navigating to /chain/42 returns 404 or redirects to /"
        type: "smoke"
      - id: "kanban-open-session"
        description: "Kanban card 'Open' action navigates to the chain's latest session tab with StatusBar visible"
        type: "integration"
      - id: "kanban-zero-sessions"
        description: "Kanban card for a backlog chain (zero sessions) hides 'Open' button and shows only 'Start research' CTA"
        type: "integration"
      - id: "migration-cleanup"
        description: "After deploy, SELECT count(*) FROM user_tabs WHERE deleted_at IS NULL AND JSON_EXTRACT(meta,'$.kind')='chain' returns 0"
        type: "unit"
  - id: p2
    name: "ChainStatusItem in StatusBar"
    tasks:
      - "Build ChainStatusItem component with rung ladder visualization"
      - "Wire into StatusBar: render ChainStatusItem instead of KataStatusItem when session.kataIssue != null"
      - "Build popover menu: rung jump links, issue/PR link, auto-advance toggle"
      - "Implement rung-jump via replaceTab (rebind current tab to clicked session)"
      - "Add chainsJson + defaultChainAutoAdvance columns to user_preferences (D1 migration)"
      - "Extend PUT /api/preferences to accept chains and defaultChainAutoAdvance fields"
    test_cases:
      - id: "chain-widget-render"
        description: "Session with kataIssue shows chain rung ladder in StatusBar instead of plain kata status"
        type: "integration"
      - id: "chain-widget-absent"
        description: "Session without kataIssue shows KataStatusItem as before (no regression)"
        type: "integration"
      - id: "rung-jump"
        description: "Clicking a completed rung in the popover rebinds the tab to that session; URL updates"
        type: "integration"
      - id: "prefs-roundtrip"
        description: "PUT /api/preferences {chains: {'42': {autoAdvance: true}}} persists and GET returns it"
        type: "unit"
      - id: "prefs-default"
        description: "PUT /api/preferences {defaultChainAutoAdvance: true} persists; chains without per-chain override inherit it"
        type: "unit"
  - id: p3
    name: "Auto-advance trigger + tab rebind"
    tasks:
      - "Add server-side checkPrecondition to SessionDO (port from client-side use-chain-preconditions.ts)"
      - "Add auto-advance handler in SessionDO: on session completed + kataIssue set, read prefs, check gate, spawn successor"
      - "Implement server-driven tab rebind: find user's tab for old session, PATCH sessionId to new session"
      - "Add 'stalled' display state for gate-failure UI signal"
      - "Emit chain_advance / chain_stalled events on session WS for client notification"
    test_cases:
      - id: "auto-advance-fires"
        description: "Session with kataIssue + autoAdvance=true completes -> successor session spawned for next mode"
        type: "integration"
      - id: "auto-advance-gate-fail"
        description: "Session completes but precondition fails -> no spawn, session status includes stall reason"
        type: "integration"
      - id: "auto-advance-off"
        description: "Session with autoAdvance=false completes -> no successor spawn, session stays in completed state"
        type: "integration"
      - id: "tab-rebind"
        description: "After auto-advance, user's tab sessionId updated to successor; multi-device broadcast confirms"
        type: "integration"
      - id: "debug-no-advance"
        description: "Debug-mode session with kataIssue completes -> no auto-advance (debug is not a core rung)"
        type: "integration"
      - id: "chain-complete"
        description: "Final rung (close) session completes -> StatusBar shows 'chain complete' badge, no successor spawn"
        type: "integration"
      - id: "try-auto-advance-none"
        description: "tryAutoAdvance returns {action:'none'} when auto-advance disabled for chain"
        type: "unit"
      - id: "try-auto-advance-stalled"
        description: "tryAutoAdvance returns {action:'stalled',reason} when gate fails (e.g., spec not approved)"
        type: "unit"
      - id: "try-auto-advance-error"
        description: "tryAutoAdvance returns {action:'error'} when createSession throws"
        type: "unit"
      - id: "try-auto-advance-idempotent"
        description: "tryAutoAdvance returns {action:'none'} when successor session for nextMode already exists (idempotency guard)"
        type: "unit"
      - id: "check-precondition-server-parity"
        description: "checkPreconditionServer returns same canAdvance/reason as client checkPrecondition for all 6 column states"
        type: "unit"
---

# Chain StatusBar Widget (p1.5)

**Supersedes:** spec #16 phase p1 (Feature 3B — chain tab surface).

## Overview

Chain tabs route to an empty page and add navigation dead-ends. This spec
replaces them with a **StatusBar widget** that renders chain context inline on
the current session's tab. The widget shows a rung ladder
(research -> planning -> impl -> verify -> close), lets users jump between
chain sessions, and optionally auto-advances to the next rung when the
current session completes cleanly.

## Feature Behaviors

### B1: Delete chain tabs and route

**Core:**
- **ID:** delete-chain-tabs
- **Trigger:** Deploy of this spec's p1 phase
- **Expected:** The `/chain/:issueNumber` route no longer exists. `kind: 'chain'` tabs are not created, rendered, or navigable. Existing chain tab rows in `user_tabs` are soft-deleted by migration.
- **Verify:** Navigate to `/chain/42` -> 404 or redirect to `/`. Open a session with `kataIssue=42` -> only a session tab appears in the tab bar; no chain tab is created alongside it.
**Source:** `apps/orchestrator/src/features/chain/ChainPage.tsx` (delete), `apps/orchestrator/src/components/tab-bar.tsx:264-279` (delete branch)

#### UI Layer
- Remove the `<Layers/>` icon chain tab variant from `tab-bar.tsx:264-279` and the `isChain` branch in `SortableProjectTab`.
- Remove chain-specific menu suppression in `tab-bar.tsx:586-587`.
- Remove `ChainPage.tsx` and its route registration.

#### Data Layer
- Remove `kind: 'chain'` from the `TabMeta` interface (`apps/orchestrator/src/lib/types.ts:131`).
- D1 migration: `UPDATE user_tabs SET deleted_at = datetime('now') WHERE JSON_EXTRACT(meta, '$.kind') = 'chain' AND deleted_at IS NULL`.
- Remove all `openTab('chain:' + ...)` call sites:
  1. `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:76-82` (deep-link effect)
  2. `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:234-239` (sidebar select)
  3. `apps/orchestrator/src/features/kanban/KanbanCard.tsx:71-74` (kanban Open action)
  4. `apps/orchestrator/src/features/chain/ChainPage.tsx:61` (chain page deep-link)
  5. `apps/orchestrator/src/components/nav-sessions.tsx:351` (nav sidebar)

---

### B2: Kanban card "Open" navigates to latest session

**Core:**
- **ID:** kanban-open-session
- **Trigger:** User clicks "Open" on a kanban chain card
- **Expected:** Browser navigates to the chain's most recent session tab (opens it if not already open via `openTab(latestSessionId, {project})`). StatusBar on that session provides the chain overview surface.
- **Verify:** Click "Open" on a chain card with 3 sessions -> tab bar shows the latest session, StatusBar renders chain widget.
**Source:** `apps/orchestrator/src/features/kanban/KanbanCard.tsx:71-74` (modify)

#### UI Layer
- Replace `openTab('chain:' + chain.issueNumber, {...})` with `openTab(latestSessionId, {project: chainProject(chain)})`.
- `latestSessionId` is the most-recent session in `chain.sessions` sorted by `lastActivity` descending.
- If chain has zero sessions (backlog card), "Open" is hidden; only "Start research" CTA shows. "Start research" behavior is unchanged from the existing kanban implementation — it calls `advanceChain()` which creates a research session and opens its tab directly (no chain tab involved). No new code needed for this path.

---

### B3: ChainStatusItem in StatusBar

**Core:**
- **ID:** chain-status-widget
- **Trigger:** StatusBar renders for a session where `session.kataIssue != null`
- **Expected:** The `KataStatusItem` slot is replaced by a `ChainStatusItem` that shows: (a) issue number pill (`#42`), (b) rung ladder with filled/current/future states, (c) current mode highlighted. Tapping opens a popover menu.
- **Verify:** Open session S1 with `kataIssue=42` (chain has research=completed, planning=active). StatusBar shows `#42 [● research] -> [◐ planning] -> [ impl ] -> [ verify ] -> [ close ]`. Tap -> popover opens.
**Source:** `apps/orchestrator/src/components/status-bar.tsx:287` (conditional render)

#### UI Layer

**Component:** `ChainStatusItem` (new file: `apps/orchestrator/src/components/chain-status-item.tsx`)

**Rung ladder visualization:**
```
#42  [● research] → [◐ planning] → [  impl  ] → [ verify ] → [ close ]
```
- `●` = completed rung (has a completed session for that mode)
- `◐` = current rung (current session's `kataMode`)
- `[ ]` = future rung (no session yet)
- Rungs are the 5 core modes: `research`, `planning`, `implementation`, `verify`, `close`
- `debug` and `freeform` sessions attached to the chain are NOT shown as rungs

**States:**
- No chain (session.kataIssue == null): render `KataStatusItem` as today (no change)
- Chain active, session running: current rung pulsates or shows spinner
- Chain active, session idle: current rung solid
- Chain stalled (gate failure after auto-advance attempt): current rung shows warning icon + stall reason on hover
- Chain complete (close rung done): all rungs filled, "complete" badge

**Props:**
```typescript
interface ChainStatusItemProps {
  kataState: KataSessionState
  kataIssue: number
  sessionId: string
  // Chain data fetched from chainsCollection inside the component
}
```

**Popover menu (on tap):**
- **Rung jump links:** One row per completed rung -> clicking calls `replaceTab` to rebind the current tab to that rung's session. Shows mode name + session status badge.
- **Auto-advance toggle:** Checkbox + label "Auto-advance this chain". Reads/writes `user_preferences.chainsJson[issueNumber].autoAdvance`. Falls back to `defaultChainAutoAdvance` when unset.
- **Issue link:** `#42 issue title` -> opens GitHub issue in new tab (`https://github.com/{repo}/issues/{n}`)
- **PR link:** If `chain.prNumber` exists, shows `PR #N` -> opens GitHub PR in new tab
- **Worktree:** Shows reserved worktree name if reservation exists for this chain

**Popover pattern:** Reuse the existing `KataStatusItem` popover pattern — `useState(showPopover)` + absolute-positioned `<div>` with `bottom-full left-0`. Width: `w-72` (wider than kata's `w-64` to fit rung jump links).

---

### B4: Rung jump (tab rebind)

**Core:**
- **ID:** rung-jump
- **Trigger:** User clicks a completed rung in the ChainStatusItem popover
- **Expected:** The current tab rebinds to the clicked rung's session ID. URL updates to `/?session=<sessionId>`. StatusBar re-renders for the new session. The popover closes.
- **Verify:** On chain #42 with research (S1, completed) and planning (S2, active): click research rung -> tab URL changes to S1, StatusBar shows S1's data. The rung ladder still shows **chain progress** (research=completed, planning=current) — it does NOT change to reflect the viewed session's position. Click planning rung -> back to S2.
**Source:** `apps/orchestrator/src/hooks/use-tab-sync.ts:522-589` (`replaceTab`)

#### UI Layer
- **Rung ladder always reflects chain progress, not viewed-session position.** The ladder shows which rungs have completed sessions and which is the chain's active frontier — regardless of which session the user is currently viewing. This prevents confusion: "where is the chain" is always visible, even when reviewing an older rung.
- Each completed rung in the popover renders as a `<button>` with `onClick` -> calls `replaceTab(currentTabId, targetSessionId)` from the `useTabSync` hook. The currently-viewed rung gets a subtle "viewing" indicator (e.g., underline) distinct from the chain-progress indicators (●/◐).
- The chain's active frontier rung is visually distinguished (bold, highlighted).
- Future rungs are grayed out and not clickable.

**Rung clickability state table:**

| Rung State | Currently Viewing? | Clickable? | Visual |
|---|---|---|---|
| Completed | Yes (viewing this rung's session) | No | ● + "viewing" underline |
| Completed | No (viewing a different rung) | Yes (jump link) | ● clickable button |
| Active frontier | Yes (viewing this rung's session) | No | ◐ bold, highlighted |
| Active frontier | No (viewing a different rung) | Yes (jump link) | ◐ clickable button |
| Future | N/A | No | [ ] grayed out |

#### API Layer
- Uses existing `PATCH /api/user-settings/tabs/:id` with `{sessionId: targetSessionId}` body.
- Broadcast via `broadcastSyncedDelta` ensures all devices sync the tab change.

---

### B5: Per-chain auto-advance preference

**Core:**
- **ID:** chain-auto-advance-pref
- **Trigger:** User toggles "Auto-advance this chain" in the ChainStatusItem popover, OR sets a global default in user preferences
- **Expected:** The preference is persisted to `user_preferences.chainsJson` (per-chain) or `user_preferences.defaultChainAutoAdvance` (global default). Per-chain overrides global. The toggle reflects the effective value.
- **Verify:** Toggle auto-advance ON for chain #42 -> `PUT /api/preferences {chains: {"42": {"autoAdvance": true}}}` returns 200. Reload page -> toggle still ON. Disable per-chain -> toggle falls back to global default.
**Source:** `apps/orchestrator/src/db/schema.ts:262-277` (add columns), `apps/orchestrator/src/api/index.ts:1101-1152` (extend handler)

#### API Layer
- `PUT /api/preferences` accepts two new fields:
  - `chains: Record<string, { autoAdvance?: boolean }>` — per-chain settings keyed by issue number (stringified)
  - `defaultChainAutoAdvance: boolean` — global default (false if absent)
- Add `'chains'` and `'defaultChainAutoAdvance'` to `PREF_PATCH_KEYS` allowlist (`api/index.ts:81-88`).
- Validation: `chains` values must be objects with only `autoAdvance: boolean`. Reject unknown nested keys with 400.

#### Data Layer
- D1 migration: add two columns to `user_preferences`:
  ```sql
  ALTER TABLE user_preferences ADD COLUMN chains_json TEXT;
  ALTER TABLE user_preferences ADD COLUMN default_chain_auto_advance INTEGER DEFAULT 0;
  ```
- Drizzle schema: add `chainsJson: text('chains_json')` and `defaultChainAutoAdvance: integer('default_chain_auto_advance').default(0)` to `userPreferences` table definition.
- Read path: `parseJsonField<Record<string, {autoAdvance?: boolean}>>()` on the client; null/missing treated as empty `{}`.

---

### B6: Auto-advance trigger (server-side)

**Core:**
- **ID:** auto-advance-trigger
- **Trigger:** SessionDO observes session transition to `completed` status AND `session.kataIssue != null`
- **Expected:** The DO reads the user's chain auto-advance preference from D1. If enabled for this chain, it runs the precondition gate check. If the gate passes, it spawns a successor session for the next mode (using `advanceChain` logic — checkout if code-touching + spawn). If the gate fails, it persists a stall reason. If auto-advance is disabled, no action.
- **Verify:** Complete a research session with auto-advance ON and kataIssue=42 -> a planning session is spawned within 5s. Complete with auto-advance OFF -> no successor. Complete with gate failure (spec not approved) -> no spawn, stall reason persisted.
**Source:** `apps/orchestrator/src/agents/session-do.ts` (new handler in status-transition path)

#### API Layer

**New server-side function:** `tryAutoAdvance(sessionId, userId, kataIssue)` in `apps/orchestrator/src/lib/auto-advance.ts`:

1. Read `user_preferences.chains_json` and `default_chain_auto_advance` from D1 for `userId`.
2. Compute effective auto-advance: `chainsJson[kataIssue]?.autoAdvance ?? defaultChainAutoAdvance`.
3. If disabled, return `{ action: 'none' }`.
4. Fetch `ChainSummary` for this issue via the existing `buildChainRow()` logic.
5. Run `checkPreconditionServer(chain, sessions, db)` — a server-side port of `use-chain-preconditions.ts`'s `checkPrecondition()`. No React hooks, no HTTP fetch. Gate checks that need spec-status / vp-status use direct D1 queries against the same database handle (e.g., `SELECT 1 FROM ... WHERE issue_number = ? AND status = 'approved'`), not same-worker `fetch()` calls (which would deadlock inside a DO).
6. If `!canAdvance`, return `{ action: 'stalled', reason }`.
7. If `canAdvance`:
   a. If next mode is code-touching (`CODE_TOUCHING_MODES`), call the worktree checkout logic directly via an extracted `checkoutWorktree(db, issueNumber, worktree, ownerId)` function (shared between the REST handler and auto-advance). Do NOT use `fetch()` to call the same worker's REST endpoint from inside a DO — this risks deadlock under load.
   b. Create new session via an extracted `createSession(env, params)` function (shared between `POST /api/sessions` handler and auto-advance). This function handles: D1 insert, SessionDO creation, `triggerGatewayDial`. The REST handler becomes a thin wrapper around `createSession`.
   c. Return `{ action: 'advanced', newSessionId, nextMode }`.

**Architecture note:** The key refactor is extracting `checkoutWorktree()` and `createSession()` as pure functions that accept `(db, env, params)` rather than `(req, res)`. Both the REST handlers and `tryAutoAdvance` call the same extracted functions. This avoids DO-to-same-worker `fetch()` calls entirely.

**Core rung sequence:** `research -> planning -> implementation -> verify -> close`. Only these modes trigger auto-advance on completion. Sessions with `kataMode` in `['debug', 'freeform', 'task', 'onboard']` are NOT eligible — the DO skips auto-advance for non-core modes.

**SessionDO integration point:** In the status-transition handler where `status` becomes `completed` (after `type=result` + runner exit → terminal state):
```typescript
if (this.state.kataIssue != null && CORE_RUNGS.has(this.state.kataMode)) {
  const result = await tryAutoAdvance(this.state.id, this.state.userId, this.state.kataIssue)
  if (result.action === 'advanced') {
    await this.rebindUserTab(result.newSessionId)
    this.broadcastToClients({ type: 'chain_advance', newSessionId: result.newSessionId, nextMode: result.nextMode })
  } else if (result.action === 'stalled') {
    this.state.stallReason = result.reason
    this.broadcastToClients({ type: 'chain_stalled', reason: result.reason })
  }
}
```

**`CORE_RUNGS` constant:**
```typescript
const CORE_RUNGS = new Set(['research', 'planning', 'implementation', 'verify', 'close'])
```

**Return type:**
```typescript
type AutoAdvanceResult =
  | { action: 'none' }
  | { action: 'stalled'; reason: string }
  | { action: 'advanced'; newSessionId: string; nextMode: string }
  | { action: 'error'; error: string }
```

**Error handling:** If `checkoutWorktree()` or `createSession()` throws (D1 contention, gateway unreachable, checkout conflict), catch the error and return `{ action: 'error', error: message }`. The SessionDO logs the error, broadcasts `{ type: 'chain_stalled', reason: 'Auto-advance failed: <message>' }` to the client (same UX as gate stall — user sees the warning indicator), and does NOT retry. The user can manually trigger advance via the kanban "Start next" button or by toggling auto-advance off/on. This avoids silent-swallowed failures (per project memory: always surface write-path errors).

**Idempotency guard:** Before spawning a successor, `tryAutoAdvance` queries D1: `SELECT id FROM agent_sessions WHERE kata_issue = ? AND kata_mode = ? AND status NOT IN ('stopped', 'failed', 'crashed') LIMIT 1`. If a session for `nextMode` already exists (e.g., from a concurrent completion race), return `{ action: 'none' }` — skip the spawn silently. This prevents duplicate successor sessions.

#### Data Layer
- No new tables. Auto-advance reads from `user_preferences` (D1) and `agent_sessions` (D1).
- New transient state on SessionDO: `stallReason: string | null` — not persisted to D1, only lives in DO memory and is broadcast to clients.

#### WS Event Types
Add two new event types to the session WS protocol (extend the discriminated union in `packages/shared-types/src/index.ts` alongside existing `GatewayEvent` types):

```typescript
interface ChainAdvanceEvent {
  type: 'chain_advance'
  newSessionId: string
  nextMode: string
  issueNumber: number
}

interface ChainStalledEvent {
  type: 'chain_stalled'
  reason: string
  issueNumber: number
}
```

These are broadcast via `this.broadcastToClients()` on SessionDO (same path as existing `session.init`, `result`, etc.). The client message handler in `use-coding-agent.ts` dispatches them:
- `chain_advance`: invalidate `chainsCollection` query, toast "Auto-advanced to {nextMode}" (informational, auto-dismiss 3s).
- `chain_stalled`: store `reason` in a local ref for `ChainStatusItem` to render the `⚠` indicator, invalidate `chainsCollection` query.

---

### B7: Server-driven tab rebind on auto-advance

**Core:**
- **ID:** tab-rebind
- **Trigger:** Auto-advance successfully spawns a successor session (B6 result = `advanced`)
- **Expected:** The user's tab that pointed at the old session is PATCH'd to point at the new session. All devices receive the update via `broadcastSyncedDelta`. The active tab on the device that was viewing the old session now shows the new session.
- **Verify:** User has session S1 open on phone and laptop. S1 auto-advances to S2. Both devices' tabs update to show S2 within 5s.
**Source:** `apps/orchestrator/src/hooks/use-tab-sync.ts` (existing `replaceTab` server path)

#### API Layer

**New DO method:** `rebindUserTab(newSessionId)` on SessionDO:
1. Query D1: `SELECT * FROM user_tabs WHERE session_id = ? AND deleted_at IS NULL` (using old session's ID).
2. For each matching tab row: direct D1 `UPDATE user_tabs SET session_id = ? WHERE id = ?` (do NOT use `fetch()` to call `PATCH /api/user-settings/tabs/:id` — same deadlock risk as B6).
3. After D1 update, call `broadcastSyncedDelta(env, userId, 'user_tabs', [{type: 'update', value: updatedRow}])` directly to push the change to all connected clients.

**Architecture note:** This follows the same extracted-function pattern as B6. Extract `updateTabSession(db, env, userId, tabId, newSessionId)` as a shared function callable from both the REST PATCH handler and `rebindUserTab`. The REST handler wraps it with request parsing; the DO calls it directly with its D1 handle.

Edge cases:
- **No tab found** (user closed the tab before session completed): no-op, successor session exists but has no tab. User can open it from sidebar.
- **Multiple tabs for same session** (shouldn't happen due to one-tab-per-project dedup, but defensive): all tabs get rebound.

---

### B8: Chain complete state

**Core:**
- **ID:** chain-complete
- **Trigger:** The final core rung (`close`) session reaches `completed` status
- **Expected:** Auto-advance does not fire (no successor mode after `close` — `nextFor('done')` returns `null`). ChainStatusItem shows all rungs filled with a "Complete" badge. The chain's kanban column is already derived as `done` by the existing `buildChainRow()` column-derivation logic (no new code required — this is existing behavior from spec #16 p3D).
- **Verify:** Complete a close-mode session on chain #42 -> StatusBar shows all 5 rungs filled + "Complete" text. Kanban card is in `done` column (existing behavior, not new to this spec).
**Source:** `apps/orchestrator/src/components/chain-status-item.tsx` (new), `apps/orchestrator/src/hooks/use-chain-preconditions.ts:77-91` (`nextFor` returns null for done column)

#### UI Layer
- Rung ladder: all 5 circles show `●` (completed).
- Right of the ladder: green "Complete" text badge.
- Popover menu: all 5 rungs are jump-links. Auto-advance toggle hidden (chain is done). Archive action shown (future — not in this spec's scope).

---

### B9: Stalled display state

**Core:**
- **ID:** stalled-display
- **Trigger:** Auto-advance fires but precondition gate fails (B6 result = `stalled`)
- **Expected:** ChainStatusItem shows a warning indicator on the current rung with the stall reason. The session remains in `completed` status (no special DB state). Client receives a `chain_stalled` WS event with the reason string.
- **Verify:** Complete a planning session with auto-advance ON but spec not approved -> StatusBar shows `[● research] -> [● planning ⚠] -> [ impl ] -> [ verify ] -> [ close ]` with hover tooltip "Stalled: Spec not yet approved".
**Source:** `apps/orchestrator/src/components/chain-status-item.tsx` (new)

#### UI Layer
- Current (just-completed) rung shows `⚠` icon overlay.
- Hover/tap on the `⚠` shows the stall reason text (e.g., "Spec not yet approved", "No completed implementation session").
- The stall is transient — if the user manually resolves the condition and re-triggers advance (via kanban "Start next" or by toggling auto-advance off/on), the stall clears.
- Stall reason is received via `chain_stalled` WS event and stored in a local ref.
- **Stall re-evaluation on mount:** On `ChainStatusItem` mount (and on page reload), if the current session is `completed` and auto-advance is enabled for this chain, the component calls `checkPrecondition()` (client-side, existing hook) to reconstruct the stall state. If the gate still fails, the `⚠` indicator renders with the reason. If the gate now passes (user resolved the condition between page loads), no stall indicator shows — the user can manually advance via the kanban "Start next" button. This ensures the diagnostic signal survives page reloads without persisting stall state to D1.

---

## Non-Goals

1. **Kanban board changes (p3D)** — the kanban continues to work as-is; only the card "Open" action target changes. Column logic, drag-to-advance, swim lanes are not in scope.
2. **Sidebar chain grouping changes** — B3 from original spec #16 is preserved; no visual changes to sidebar chain nodes.
3. **Worktree reservation changes** — the reservation system (checkout/release/force-release/GC) is unchanged. Auto-advance reuses existing checkout idempotency.
4. **Mode-enter session reset (3C)** — intra-session mode transitions (`handleModeTransition`) are unchanged. Auto-advance creates NEW sessions, not mode transitions within a session.
5. **Chain archival** — the "archive chain" action on complete chains is deferred. Complete chains stay in the `done` kanban column.
6. **Background retry on gate failure** — stalled chains require manual user action. Automatic retry on gate-condition change is a future enhancement.
7. **Concurrent chains per issue** — one chain per issue is preserved. The spec does not address multi-chain-per-issue.
8. **User settings UI for global default** — `defaultChainAutoAdvance` is settable via API and the ChainStatusItem toggle inherits it, but a dedicated settings page toggle is not in scope.

## Implementation Phases

See frontmatter `phases` block. Summary:

**P1 (Delete chain tabs + route):** Pure removal. ~200 LOC deleted across 7 files, 1 migration. Independent of P2/P3 — can ship alone as a cleanup.

**P2 (ChainStatusItem in StatusBar):** New component + preference columns. ~400 LOC new. Depends on P1 (chain tabs gone so the widget is the sole chain surface).

**P3 (Auto-advance trigger + tab rebind):** Server-side logic in SessionDO + server-callable precondition check. ~300 LOC new. Depends on P2 (preferences must exist for the toggle to read/write).

## Verification Plan

### VP1: Chain tab deletion (P1)

1. Start local dev stack: `scripts/verify/dev-up.sh`
2. Seed test user: `scripts/verify/axi-login a`
3. Create a session with `kataIssue=42` (via kanban "Start research" or direct API call)
4. Verify tab bar: only a session tab appears — no `<Layers/>` icon chain tab
5. Navigate to `/chain/42` in the URL bar -> expect 404 page or redirect to `/`
6. Check D1 after migration: `SELECT count(*) FROM user_tabs WHERE deleted_at IS NULL AND JSON_EXTRACT(meta, '$.kind') = 'chain'` -> 0

### VP2: ChainStatusItem renders (P2)

1. With a session that has `kataIssue=42` and `kataMode='planning'`, and a prior completed research session for the same issue:
2. StatusBar should show: issue pill `#42` + rung ladder with research=filled, planning=current, impl/verify/close=empty
3. Tap the chain widget -> popover opens with:
   - Research rung (clickable jump link)
   - Planning rung (current, highlighted, not clickable)
   - Impl, Verify, Close rungs (grayed, not clickable)
   - Auto-advance toggle
   - Issue link
4. Click the research rung -> tab rebinds to research session, URL updates, StatusBar re-renders for that session
5. Click planning rung (now a jump link since we navigated away) -> tab rebinds back

### VP3: Auto-advance preference roundtrip (P2)

1. `PUT /api/preferences` with `{chains: {"42": {"autoAdvance": true}}}` -> 200
2. `GET /api/preferences` -> response includes `chainsJson` containing `{"42":{"autoAdvance":true}}`
3. `PUT /api/preferences` with `{defaultChainAutoAdvance: true}` -> 200
4. Open ChainStatusItem popover for chain #42 -> auto-advance toggle is ON
5. Toggle OFF -> `PUT` fires with `{chains: {"42": {"autoAdvance": false}}}` -> toggle updates

### VP4: Auto-advance fires (P3)

1. Set auto-advance ON for chain #42
2. Have a completed research session for issue #42
3. Start a planning session for issue #42 with the spec already approved
4. When the planning session completes (`status: completed`):
   - Within 5s, a new implementation session should appear in `agent_sessions` with `kataIssue=42`
   - The user's tab should rebind from the planning session to the implementation session
   - StatusBar should show `[● research] -> [● planning] -> [◐ implementation] -> [ verify ] -> [ close ]`

### VP5: Auto-advance gate failure (P3)

1. Set auto-advance ON for chain #42
2. Have a completed research session; NO approved spec
3. Complete a planning session for issue #42
4. Auto-advance attempts to advance to implementation
5. Gate check: spec-status returns `{exists: false}` or `{status: 'draft'}`
6. No successor session spawned
7. StatusBar shows warning indicator on planning rung with hover text "Stalled: Spec not yet approved"

### VP6: Debug does not trigger auto-advance (P3)

1. Set auto-advance ON for chain #42
2. Start a debug session with `kataIssue=42`
3. Complete the debug session
4. No successor session is spawned (debug is not a core rung)
5. StatusBar shows chain widget normally; debug session does not appear as a rung

### VP7: Chain complete (P3)

1. Chain #42 has completed sessions for research, planning, implementation, verify
2. Start a close session with `kataIssue=42`
3. Complete the close session
4. StatusBar shows all 5 rungs filled + "Complete" badge
5. No successor session is spawned
6. Kanban card moves to `done` column

## Implementation Hints

### Key Imports

```typescript
// Chain data (already exists)
import { chainsCollection } from '~/db/chains-collection'
import type { ChainSummary } from '~/lib/types'

// Tab rebind (already exists)
import { useTabSync } from '~/hooks/use-tab-sync' // replaceTab method

// Preferences (extend existing)
import { userPreferencesCollection } from '~/db/user-preferences-collection'

// Precondition check (port to server-callable)
import { checkPrecondition, type NextMode } from '~/hooks/use-chain-preconditions'

// Advance chain (reuse logic server-side)
import { advanceChain, chainProject } from '~/features/kanban/advance-chain'
```

### Code Patterns

**StatusBar conditional render (existing pattern at status-bar.tsx:287):**
```tsx
// Current:
{kataState && <KataStatusItem kataState={kataState} />}

// New:
{kataState && session?.kataIssue != null
  ? <ChainStatusItem kataState={kataState} kataIssue={session.kataIssue} sessionId={sessionId!} />
  : kataState && <KataStatusItem kataState={kataState} />}
```

**Popover pattern (reuse from KataStatusItem, status-bar.tsx:171-229):**
```tsx
const [showPopover, setShowPopover] = useState(false)
// ... button with onClick toggle ...
{showPopover && (
  <div className="absolute bottom-full left-0 mb-1 w-72 rounded border bg-popover p-3 text-popover-foreground shadow-md text-xs">
    {/* menu content */}
  </div>
)}
```

**Tab rebind (existing at use-tab-sync.ts):**
```typescript
// Client-side rung jump:
const { replaceTab, tabs, activeSessionId } = useTabSync()
const currentTab = tabs.find(t => t.sessionId === currentSessionId)
if (currentTab) {
  replaceTab(currentTab.id, targetSessionId)
}
```

**User preferences write (existing pattern):**
```typescript
await fetch(apiUrl('/api/preferences'), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chains: { [issueNumber]: { autoAdvance: value } } }),
})
```

### Gotchas

1. **`chainsCollection` must be invalidated on `chain_advance` / `chain_stalled` WS events** — it's poll-based (30s refresh), so without invalidation the rung ladder shows stale data for up to 30s after auto-advance. The client WS handler for these events must call `queryClient.invalidateQueries({queryKey: chainsCollection.queryKey})`. This is captured in P3 tasks via "Emit chain_advance / chain_stalled events on session WS for client notification" — the client handler invalidation is part of that task.
2. **`replaceTab` requires the tab's surrogate `id`, not the `sessionId`** — the hook exposes tabs as a list; find the matching tab by `sessionId` first.
3. **Server-side precondition check cannot use `fetch()` for spec-status/vp-status** — these are same-worker endpoints. Use direct D1 queries or the internal function that backs those endpoints.
4. **`type=result` does NOT mean session is completed** — runner stays alive. The actual `completed` status transition happens when the runner exits cleanly (process exit after last result). Look for the terminal status handler in SessionDO, not the `result` event handler.
5. **Migration order matters** — the chain-tab soft-delete migration (P1) must run before any code that removes the `kind: 'chain'` type from TabMeta, otherwise TypeScript will reject rows that still have that kind in D1.
6. **`PREF_PATCH_KEYS` is a strict allowlist** — forgetting to add `'chains'` and `'defaultChainAutoAdvance'` to the set causes 400 errors on all preference writes that include those fields.
