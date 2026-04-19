---
date: 2026-04-19
topic: Client data-layer consolidation — current state for GH#12
type: feature
status: complete
github_issue: 12
depends_on:
  - planning/research/2026-04-16-state-management-audit.md
  - planning/research/2026-04-18-runner-status-ui-surfaces.md
  - planning/research/2026-04-18-session-tab-loading-trace.md
---

# Research: Issue #12 — client data-layer consolidation (delta)

## Purpose

The 2026-04-16 audit is the architectural baseline for Duraclaw's state
surface. It already inventories Zustand stores, TanStack DB collections, and
the DO↔client WS channel. Two subsequent research files (`session-tab-loading-
trace`, `runner-status-ui-surfaces`) document message-body lag and
tab-vs-status-bar divergence.

This delta captures the **current code state** after commits `8bcda2d` +
`7f5ea73` (the "status-bar blank flash on tab switch" fix) so the GH#12 spec
can plan the consolidation without re-deriving the ground truth.

The previous research recommends a direction. This file confirms the direction
is still right, documents the new cache layer that was added between then and
now, and surfaces the concrete spec-level questions the interview needs to
close.

## Executive summary

- **Four channels still reach the UI for session state.** WS state sync, WS
  events (gateway_event), RPC (`getContextUsage`, `hydrateMessages`,
  `forkWithHistory`), and REST (`/api/sessions`, `/api/gateway/projects/all`).
  No consumer reads from all of them; every consumer has its own reconciliation
  policy.
- **A fifth surface was added in the fix:** `sessionStatusCollection` — a
  LocalOnly OPFS-persisted cache the status bar reads synchronously on mount
  to avoid the blank-flash. It is **write-through only** — not a render
  source. The render source is still Zustand (`useStatusBarStore`).
- **"Adding one status-bar field" currently touches 5 sites**, exactly as the
  issue claims: Zustand store type, AgentDetailView populator effect,
  `CachedSessionStatus` schema, `synthesizeStateFromSessionRecord` fallback,
  and the write-through effect. File:line citations below.
- **`use-coding-agent.ts` is 741 LOC** and owns 9 distinct responsibilities.
  Orphan-recovery (`forkWithHistory`) is already collection-native — that's
  the shape the rest of the hook should match.
- **`/api/gateway/projects/all` is polled every 30 s in `AgentDetailView`**.
  A query collection with staleTime would match the rest of the stack.

## Current state (post 8bcda2d + 7f5ea73)

### The four (now five) channels

| # | Channel | What it carries | Where it lands |
|---|---|---|---|
| 1 | Agents-SDK `useAgent.state` (WS state sync) | Full `SessionState` on every DO `setState` | `useCodingAgent` React state → Zustand `useStatusBarStore` |
| 2 | WS `{type:'gateway_event', event}` | `partial_assistant`, `kata_state`, `context_usage`, `result`, gates | `useCodingAgent` React state (`events`, `kataState`, `contextUsage`, `sessionResult`) → Zustand |
| 3 | RPC (`conn.call(...)`) | `getContextUsage`, `hydrateMessages`, `sendMessage`, `forkWithHistory`, `resubmitMessage`, `navigateBranch` | React state + `messagesCollection` writes |
| 4 | REST queryCollection | `GET /api/sessions` (30 s refetch, 15 s stale) | `agentSessionsCollection` (OPFS-backed) |
| 5 | REST fetch (manual poll) | `GET /api/gateway/projects/all` every 30 s | Zustand `useStatusBarStore.worktreeInfo` **and** `sessionStatusCollection.worktreeInfo` (write-through) |

Plus the new cache surface:

| # | Surface | Purpose |
|---|---|---|
| 6 | `sessionStatusCollection` (LocalOnly, OPFS, `db/session-status-collection.ts`) | Cache of `{state, contextUsage, kataState, worktreeInfo, sessionResult}` per sessionId. Hydrated synchronously in `AgentDetailView` `useLayoutEffect` to eliminate the tab-switch blank flash. Written-through on every live update. **Not the render source — Zustand is.** |

### `sessionStatusCollection` — anatomy

`apps/orchestrator/src/db/session-status-collection.ts`

- `CachedSessionStatus` shape (lines 21–29): `id`, `state`, `contextUsage`,
  `kataState`, `worktreeInfo`, `sessionResult`, `updatedAt`.
- Backed by `localOnlyCollectionOptions` + `persistedCollectionOptions` (OPFS
  schema v1). Strips `active_callback_token` before round-tripping (lines
  61–69).
- `writeSessionStatusCache(sessionId, patch)` (lines 75–106) — patch-style
  upsert; merges `patch` into existing row or inserts new.
- `readSessionStatusCache(sessionId)` (lines 114–123) — synchronous read for
  pre-paint hydration.

### `useStatusBarStore` — the domain-state mirror the audit flagged

`apps/orchestrator/src/stores/status-bar.ts`

- Fields (lines 19–30): `state`, `wsReadyState`, `contextUsage`,
  `sessionResult`, `onStop`, `onInterrupt`, `kataState`, `worktreeInfo`.
- Everything except `onStop` / `onInterrupt` is server-authoritative session
  state. (This is the domain leak the audit called out, unchanged.)
- Write sites — **all four in `AgentDetailView.tsx`**:
  1. Line 86: cache-first hydration (reads `sessionStatusCollection`, writes
     `{state, contextUsage, kataState, worktreeInfo, sessionResult}`).
  2. Lines 115–124: live-overlay effect; spreads non-null fields only so
     cached values aren't clobbered by null during connect.
  3. Line 149: `worktreeInfo: null` when projectName changes.
  4. Line 167: worktreeInfo after `/api/gateway/projects/all` poll.
- Read sites:
  - `status-bar.tsx:216–225` — the only real reader (WS dot, status text,
    project/branch/PR, context bar, kata popover, elapsed timer, cost,
    stop/interrupt buttons).
- `AgentDetailView` unmount cleanup calls `statusBarClear()` (line 140).

### `AgentDetailView.tsx` — the cache-first + live-overlay pattern

```
mount
  ├─ useLayoutEffect (83–108)
  │    ├─ readSessionStatusCache(sessionId) ────► Zustand (pre-paint)
  │    └─ miss?  agentSessionsCollection.get() ─► synthesize ─► Zustand
  ├─ useEffect (114–124)   live WS values (state, wsReadyState, contextUsage,
  │                         sessionResult, kataState, onStop, onInterrupt)
  │                         ────► Zustand, null-guarded
  ├─ useEffect (129–137)   write-through: live values ────► sessionStatusCollection
  ├─ useEffect (147–182)   /api/gateway/projects/all fetch + 30 s setInterval
  │                         ────► Zustand worktreeInfo + sessionStatusCollection
  └─ unmount
       └─ useEffect (139–141)   statusBarClear()
```

The null-guards on the live-overlay effect exist precisely because the cache
holds the truth during the WS-connect window; writing a fresh `null` would
clobber it. This is the bug-class the issue wants to eliminate by
construction.

### `synthesizeStateFromSessionRecord` — the third code path for "SessionState"

`AgentDetailView.tsx:29–51` synthesizes a minimal `SessionState` from
`SessionRecord` when the cache misses *and* the session was seen via
`/api/sessions` but never connected (e.g. deep-linked from another device
before WS init). Populates `project`, `status`, `model`, `num_turns`,
`created_at`, `updated_at`, `sdk_session_id`, `completed_at`. Leaves
`context_usage`, `kata_state`, `worktree_info` as null. This is a fourth
in-code schema for "session state that renders in the status bar" (the others
being WS state, Zustand slice, cache schema).

### `/api/gateway/projects/all` — the polled REST source

Only call site: `AgentDetailView.tsx:147–182`. `fetchWorktreeInfo` runs on
mount and every 30 s via `setInterval`. No staleTime, no dedup across tabs,
no React Query. Every open session view fires its own polling loop; two
tabs on the same session = 2× poll rate for identical data.

### `use-coding-agent.ts` — the hook that's load-bearing because everything else is fragmented

741 LOC. Responsibilities:

1. messagesCollection mutation (upsert/delete, optimistic ID reconcile)
2. State sync (`state`, `events`, `sessionResult`, `kataState`,
   `contextUsage`, `branchInfo`)
3. WS connection lifecycle (`useAgent` / `onStateUpdate` / `onMessage`)
4. Message hydration RPC (`hydrateMessages` → collection)
5. Branch navigation (rewind / resubmit / navigate via
   `replaceAllMessages`)
6. Draft submission (Y.Text snapshot → optimistic insert → RPC → rollback)
7. Orphan recovery (`forkWithHistory` — optimistic insert + RPC + rollback)
8. Context-usage polling (RPC, exposed via return value)
9. Gate resolution (RPC for `ask_user` / `permission_request`)

(1) and (7) are already the pattern we want to generalise: write through the
collection, let the DO echo reconcile. (2) is what needs to move onto a
`sessionLiveStateCollection` so the hook can shrink.

### "Adding one field" currently costs five file touches

Confirmed. Say we add `runner_uptime_ms` to the status bar:

1. `packages/shared-types/src/index.ts` — field on `SessionState`.
2. `apps/orchestrator/src/stores/status-bar.ts:19–30` — field on Zustand slice.
3. `apps/orchestrator/src/db/session-status-collection.ts:21–29` —
   `CachedSessionStatus` schema + schemaVersion bump + migration.
4. `AgentDetailView.tsx:29–51` — `synthesizeStateFromSessionRecord` fallback.
5. `AgentDetailView.tsx:86,115–124,129–137` — populator, live-overlay,
   write-through effects.

Plus the read site in `status-bar.tsx`. Six sites for one field.

## What the target shape looks like (from audit + issue, confirmed)

The audit's end-state direction (section "Target architecture") is still the
right one; issue #12 is effectively **phase 1b of the audit's "unify client
storage" thesis**, scoped to client-only.

- `sessionLiveStateCollection` — one row per sessionId, union of everything
  the status bar / detail view / sidebar currently read from Zustand and
  the three ad-hoc caches. Written from the WS handler; read via
  `useLiveQuery`.
- `agentSessionsCollection` keeps its current role (list metadata, 30 s
  refetch + 15 s stale).
- `messagesCollection` keeps its current role (LocalOnly, WS-driven). The
  `session-tab-loading-trace` R1 recommendation (make it the render source)
  is orthogonal to #12 but fits in the same phase if we want it.
- `projectsCollection` — new query collection over
  `/api/gateway/projects/all`, staleTime 30 s. Replaces the 30-s setInterval.
  Read via `useLiveQuery` filtered to the active project.
- `userPreferencesCollection` (new) — already sketched in audit Phase 1.
- `useStatusBarStore` keeps only ephemeral UI-only fields (modal open,
  active popover, etc.) — no server data.
- A `useCachedLiveQuery` helper encapsulates the cache-first + live-overlay
  pattern so components don't hand-roll the `useLayoutEffect` dance.

## Open questions the interview needs to close

These are the decisions the audit and prior research files don't settle,
and that will shape the spec's phase breakdown:

1. **Scope boundary** — is GH#12 strictly the client consolidation, or does
   it include the server-side half (DO pushing into the collection vs.
   WS-state-sync) in the same issue? The issue text says out-of-scope for
   `useAgent` command-plane, but says nothing about whether the DO protocol
   changes.
2. **Migration shape** — pilot on status bar first (as the issue proposes)
   and expand, or big-bang swap every consumer at once? The pilot needs a
   clear success criterion to justify expansion.
3. **Collection vs. store split** — what *exactly* stays in Zustand? The
   audit says "UI ephemera only." The issue implies the same. We need a
   written line in the spec so we don't slide back.
4. **`sessionStatusCollection` fate** — delete outright (merged into
   `sessionLiveStateCollection`), keep as the persistence layer of the new
   collection, or keep as a distinct cache-of-cache? Has implications for
   the OPFS schema migration story.
5. **`useCachedLiveQuery` API** — what does the fallback signature look like
   when the cached row is absent *and* the live source hasn't populated yet?
   The issue sketches `fallback: (rec) => synthesize(rec)` — where does
   `rec` come from (agentSessionsCollection)? Is it one fallback per call or
   a registered resolver per collection?
6. **Write-through write-path** — in the target, does the WS handler write
   directly to `sessionLiveStateCollection`, or does it go through a
   middleware/transaction so we can move reconciliation out of
   `use-coding-agent`? The audit's phase-2 "one-way sync" answer is
   middleware-shaped.
7. **Multi-tab semantics** — two tabs on the same session both writing
   into `sessionLiveStateCollection` from their own WS: does the last write
   win (current behaviour), or is there a sequence-number guard? Minor for
   OPFS but worth naming.
8. **`/api/gateway/projects/all` invalidation** — the VPS can only push
   updates via WS, not D1/PartyKit. A query collection with 30 s
   staleTime works today, but we may want a nudge channel. Is that in #12
   or deferred to the gateway-side work?
9. **`use-coding-agent.ts` shrink target** — the issue's acceptance
   criterion says "shrinks". By how much? Responsibilities 1, 2, 4, 7 all
   arguably move. Do 5 (branch navigation) and 6 (draft submission) stay?
10. **Sidebar / nav-sessions / ChatThread consumers** — currently read
    from `agentSessionsCollection` or synthesize from `useCodingAgent`.
    Which consumers migrate in the pilot vs. later phases?
11. **`StatusDot` + display-state derivation** — the 2026-04-18
    `runner-status-ui-surfaces` research proposed a shared display-state
    derivation. Does it land in this spec or stay separate? Reading from
    `sessionLiveStateCollection` is the natural carrier for it.

## Files the spec will touch (preview)

- New: `apps/orchestrator/src/db/session-live-state-collection.ts`
- New: `apps/orchestrator/src/db/projects-collection.ts`
- New: `apps/orchestrator/src/db/user-preferences-collection.ts` *(if in scope)*
- New: `apps/orchestrator/src/hooks/use-cached-live-query.ts`
- Edit: `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (shrink)
- Edit: `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx` (delete cache-first effects)
- Edit: `apps/orchestrator/src/components/status-bar.tsx` (read via `useLiveQuery`)
- Edit: `apps/orchestrator/src/components/tab-bar.tsx`, `layout/nav-sessions.tsx` (adopt display-state if folded in)
- Delete: `apps/orchestrator/src/stores/status-bar.ts` (or reduce to UI-only)
- Delete/Collapse: `apps/orchestrator/src/db/session-status-collection.ts` (merged into new collection)

## Sources (read for this delta)

- `apps/orchestrator/src/db/session-status-collection.ts` (read)
- `apps/orchestrator/src/db/agent-sessions-collection.ts` (read)
- `apps/orchestrator/src/stores/status-bar.ts` (read)
- `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx` (read)
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (read, 741 LOC)
- `apps/orchestrator/src/components/status-bar.tsx` (read)
- `planning/research/2026-04-16-state-management-audit.md` (baseline)
- `planning/research/2026-04-18-runner-status-ui-surfaces.md` (tab vs bar)
- `planning/research/2026-04-18-session-tab-loading-trace.md` (messages lag)
