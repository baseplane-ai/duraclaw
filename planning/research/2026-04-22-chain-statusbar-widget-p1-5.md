---
date: 2026-04-22
topic: Chain StatusBar widget — replace chain tabs with inline chain context (p1.5)
type: feature
status: complete
github_issue: 58
items_researched: 5
---

# Research: Chain StatusBar Widget (p1.5 amendment to spec #16)

## Context

Spec #16 phase p1 shipped "chain tab surface" — a dedicated `kind: 'chain'` tab
that navigates to `/chain/:issueNumber` and renders a timeline of sessions for
that issue. In practice the chain page is mostly empty (sessions must exist first)
and the dedicated route adds a navigation dead-end. The user proposed replacing
chain tabs with a **StatusBar widget on the current session's tab** that shows
chain context inline and supports auto-advance between chain rungs.

This research grounds the p1.5 spec amendment in the codebase.

## Scope

| # | Item | Sources |
|---|------|---------|
| A | Spec #16 full text + prior research doc | `planning/specs/16-chain-ux.md`, `planning/research/2026-04-19-kata-mode-chain-ux.md` |
| B | StatusBar component + tap-for-menu + kata status | `apps/orchestrator/src/components/status-bar.tsx` |
| C | Worktree reservation lifecycle across mode transitions | `apps/orchestrator/src/db/schema.ts`, `src/api/index.ts` checkout/release handlers |
| D | `user_preferences` SyncedCollection shape | `src/db/user-preferences-collection.ts`, `src/api/index.ts` prefs endpoint |
| E | Tab↔session identity + auto-spawn mechanics | `src/hooks/use-tab-sync.ts`, `src/features/agent-orch/AgentOrchPage.tsx`, `src/agents/session-do.ts` |

## Findings

### A. Spec #16 p1 behaviors being replaced

**Superseded behaviors:**

| B-ID | Summary | Disposition |
|------|---------|-------------|
| B1 (chain tab creation) | `kind: 'chain'` tab, `issueNumber` cluster key, one-chain-per-issue | SUPERSEDED — chain context moves to StatusBar widget |
| B2 (chain route + timeline) | `/chain/:issueNumber` route, vertical session timeline, live transcript | REPLACED-BY — rung navigation via StatusBar popover menu; jump-to-session rebinds the tab |
| B3 (chain-aware sidebar) | Sessions grouped under chain node with pipeline dots | PRESERVED — sidebar grouping stays; no dependency on chain tab/route |

**Verification plan steps** — VP1 (chain tab groups sessions) → SUPERSEDED. VP3 (kanban column placement) → PRESERVED. VP4 (mode transition context reset) → PRESERVED.

**p3D (kanban home) dependency on p1:**
- `chainsCollection` and `GET /api/chains` are consumed by kanban, NOT by p1.5 — unchanged.
- **Broken link:** Card "Open" action (`KanbanCard.tsx:71-74`) navigates to `/chain/:issueNumber`. After route deletion, replacement is: navigate to the chain's latest session tab. StatusBar widget provides the overview surface.
- No other p3D behavior assumes chain tabs exist.

**Prior research doc (2026-04-19) rationale:**
- Core problems: context bloat across modes, worktree stomps, no chain overview surface.
- The doc proposed `/chain/:issueNumber` as a timeline route (lines 131-147) — p1.5 is a late pivot.
- The doc did NOT explicitly reject an inline StatusBar approach. It described composable moves: "Each is usable on its own; together they enable auto-advance" (line 65).
- Open questions still relevant: which modes qualify as rungs (debug attaches but doesn't advance), concurrent chains on one issue (spec says one-per-issue), chain end conditions (close mode, PR merge, issue close webhook).

### B. StatusBar component

**File:** `apps/orchestrator/src/components/status-bar.tsx`

**Layout:** Single horizontal flex row with wrap support. Two logical groups:
- Left: WS dot, status label, project name, worktree branch, model name
- Right (wraps on mobile): turn count, cost, context usage bar, **kata status indicator**, elapsed timer

**Kata status tap-for-menu CONFIRMED:**
- `KataStatusItem` component (lines 171-229): `useState(showPopover)` with `onClick` toggle.
- Popover is a custom absolute-positioned `<div>` (not a library Popover/Sheet).
- Menu items: mode, phase, issue#, session type, completed phases badges, progress bar.

**Session awareness:** StatusBar reads one session via `useSession(sessionId)` prop (line 235). Has access to `session.kataIssue` via `SessionSummary` but **does not use it today**.

**Chain widget insertion point:** When `session.kataIssue != null`, render `ChainStatusItem` that either replaces or augments `KataStatusItem`. The `KataStatusItem`'s popover pattern (custom toggle + absolute div) is the reuse target.

### C. Worktree reservation lifecycle

**Schema:** `worktreeReservations` table (`schema.ts:213-229`):
- `worktree` (TEXT, PRIMARY KEY)
- `issueNumber` (INTEGER, FK)
- `ownerId` (TEXT, FK → users)
- `heldSince`, `lastActivityAt` (ISO timestamps)
- `modeAtCheckout` (TEXT)
- `stale` (INTEGER 0/1)

**Critical finding: reservations are per-CHAIN (issue), not per-session.**
- Same-chain re-entry is idempotent (`api/index.ts:2218-2236`): if `existing.issueNumber === issueNumber`, refreshes `lastActivityAt` and returns the existing reservation.
- Mode transitions within a chain do NOT touch the reservation.
- Release: explicit `/api/chains/:issue/release`, force-release (stale >7d), or GH webhook (issue.closed / PR.merged).

**Implication for auto-advance:** Successor session S2 spawning on the same `kataIssue` just calls checkout again — idempotent refresh. No new worktree plumbing needed.

**Code-touching modes gate:** `advance-chain.ts:25` defines `CODE_TOUCHING_MODES = new Set(['implementation', 'verify', 'debug', 'task'])`. Research and planning skip the checkout gate (read-only, no worktree needed).

### D. `user_preferences` SyncedCollection

**Schema:** Columnar single-row-per-user table (`schema.ts:262-277`). Migration 0008 replaced original KV shape with typed columns: `permissionMode`, `model`, `maxBudget`, `thinkingMode`, `effort`, `hiddenProjectsJson`.

**Write path:** `PUT /api/preferences` (`api/index.ts:1101-1152`) — whole-row upsert with strict allowlist (`PREF_PATCH_KEYS` at line 81-88). Unknown keys return HTTP 400.

**Adding chain prefs:** Add `chainsJson: text` column to `user_preferences`. Store as `{"<issueNumber>": {"autoAdvance": boolean}}`. Add `'chains'` to `PREF_PATCH_KEYS`. ~60 LOC delta.

**Alternative (rejected):** New `chain_preferences` D1 table + SyncedCollection (~350 LOC). Over-engineered for one boolean. Reconsider if per-chain settings expand.

**Also rejected:** Storing on `agentSessions.chainAutoAdvance` — couples session lifecycle to settings; user loses setting when session terminates.

**Global default:** Add `defaultChainAutoAdvance: boolean` column to `user_preferences` (default `false`). Per-chain `chainsJson` entries override when present.

### E. Tab↔session identity + auto-spawn

**Tab model:** `user_tabs` SyncedCollection. Key fields: `id` (stable surrogate), `sessionId` (mutable — supports draft→real swap), `meta` (JSON: `{kind, project, issueNumber, activeSessionId}`).

**Mutable sessionId confirmed:** `replaceTab()` at `use-tab-sync.ts:522-589` already exists. `PATCH /api/user-settings/tabs/:id` accepts `{sessionId}` updates with `broadcastSyncedDelta` fanout.

**Chain tab creation call site (to delete):** `AgentOrchPage.tsx:76-82`:
```typescript
if (session?.kataIssue != null) {
  openTab(`chain:${session.kataIssue}`, { kind: 'chain', issueNumber: session.kataIssue })
}
```
Chain tab opened IN ADDITION TO session tab. All `openTab('chain:' + ...)` call sites: `AgentOrchPage.tsx:76`, `AgentOrchPage.tsx:234`, `KanbanCard.tsx:71`, `ChainPage.tsx:61`, `nav-sessions.tsx:351`.

**Auto-spawn trigger does NOT exist today:** `type=result` puts session in `idle` (runner stays alive for more turns). No hook watches `kataIssue + idle + clean-kata-exit` to spawn successor. This is net-new SessionDO behavior.

**Recommended rebind mechanism (server-driven):** On successor spawn, SessionDO calls `PATCH /api/user-settings/tabs/:id` to swap `sessionId` from S1 to S2 on the matching tab. Normal `broadcastSyncedDelta` flow ensures all devices sync. Consistent with existing tab mutation patterns.

## Decisions (confirmed by user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Kanban "Open" action after route deletion | Navigate to chain's latest session tab |
| 2 | Debug/freeform in auto-advance sequence | Core rungs only (research→planning→impl→verify→close); debug/freeform attach but don't advance |
| 3 | Gate failure behavior | Stall with clear UI signal in StatusBar; no spawn; re-check on gate change |
| 4 | Existing `kind:'chain'` tab rows | Soft-delete via migration on deploy |
| 5 | Rebind mechanism | Server-driven (SessionDO → PATCH tab) |
| 6 | Settings storage | `chainsJson` column on `user_preferences` |

## Recommendations

### Design — `ChainStatusItem` replaces `KataStatusItem` when chain active

When `session.kataIssue != null`, StatusBar renders a `ChainStatusItem` that:
- Shows the rung ladder: `[◐ research] → [● planning] → [ impl ] → [ verify ]`
- Filled rungs are completed sessions (tap to jump — calls `replaceTab` to rebind)
- Current rung highlighted
- Issue number pill + worktree indicator
- Tap opens popover menu with: jump-to-prior-rung, set next-mode target, auto-advance toggle (this chain), link to GH issue + PR

### Auto-advance trigger — net new, gated

SessionDO, on receiving a "clean kata exit" signal (distinct from `type=result`):
1. Check `kataIssue != null`
2. Read user's chain pref (from D1 `user_preferences.chainsJson`) for this issue, fallback to `defaultChainAutoAdvance`
3. If enabled, check B9 precondition gate for next rung
4. If gate passes, call `advanceChain()` logic (checkout if code-touching mode + spawn successor)
5. Rebind the user's tab from S1 to S2 via `PATCH /api/user-settings/tabs/:id`
6. If gate fails, set session status to a new "stalled" display state with reason string; StatusBar renders "stalled: waiting for <condition>"

### Deletions

- `/chain/:issueNumber` route + `ChainPage.tsx`
- `kind: 'chain'` from `TabMeta` union
- `tab-bar.tsx:264-279` chain tab render branch
- All `openTab('chain:' + issueNumber, ...)` call sites (5 locations)
- Migration to soft-delete existing chain tab rows

### Preserved

- `chainsCollection` — consumed by kanban (p3D) and new `ChainStatusItem`
- `GET /api/chains` endpoint
- Sidebar chain grouping (B3)
- Worktree reservation system (unchanged)

## Open Questions

1. **"Clean kata exit" signal definition** — what exact event / field signals that a kata session has completed its mode successfully (vs. errored, vs. user-interrupted)? Needs investigation during spec phase.
2. **Kanban "Start <next>" button** — does it still exist after auto-advance? Probably yes (manual fallback when auto-advance is off). Spec must define coexistence.
3. **Multi-device tab rebind** — if user has the chain open on phone and laptop, both tabs should rebind. Server-driven approach handles this naturally via `broadcastSyncedDelta`, but edge cases (both devices have different tabs for the same chain) need spec.
4. **Chain end state** — when the final rung (close) completes, auto-advance has nowhere to go. StatusBar should show "chain complete" with archival action.

## Next Steps

1. **P1**: Brief interview to resolve open questions 1-4 above.
2. **P2**: Write spec `planning/specs/16-chain-ux-p1-5.md` (or amend `16-chain-ux.md` with a new phase block) with B-IDs, acceptance criteria, implementation phases, and verification plan.
3. **P3**: Review cycle.
4. **P4**: Commit and push.
