---
date: 2026-04-19
topic: Client data-layer unification — full inventory for GH#12
type: feature
status: complete
github_issue: 12
items_researched: 9
depends_on:
  - planning/research/2026-04-16-state-management-audit.md
  - planning/research/2026-04-18-runner-status-ui-surfaces.md
  - planning/research/2026-04-18-session-tab-loading-trace.md
  - planning/research/2026-04-19-issue-12-client-data-layer-delta.md
---

# Research: GH#12 — Client Data-Layer Unification (Full Inventory)

## Context

Issue #12 proposes committing to TanStack DB collections as the single
client-side data layer, retiring the parallel Zustand stores and ad-hoc
caches where they overlap with server data. This research inventories
every data channel, store, collection, and consumer to inform the spec.

D1 migration (issue #6) is **complete** — D1 is the single persistent
server store. Issue #6 is now closed.

Prior research:
- `2026-04-16-state-management-audit.md` — architectural baseline
- `2026-04-19-issue-12-client-data-layer-delta.md` — post-fix delta with
  11 open questions for interview

This document synthesises findings from 9 parallel Explore agents across
the full codebase.

## Scope

**Items researched:** Zustand stores, TanStack DB collections, WebSocket/
useAgent.state usage, REST/RPC fetch channels, StatusBar + AgentDetailView
(pilot), other consumers, use-coding-agent.ts anatomy, TanStack DB
patterns, server authority model.

## 1. Zustand Stores Inventory

4 stores in `apps/orchestrator/src/stores/`:

| Store | File | Fields | Classification | TanStack DB Candidate |
|-------|------|--------|----------------|----------------------|
| **Auth** | `auth-store.ts` (52 LOC) | `user`, `accessToken`, setters | Server-data (credentials) | ❌ No — sensitive, cookie-backed |
| **Notifications** | `notifications.ts` (65 LOC) | `notifications[]`, add/mark/clear | UI-ephemeral | ⚠️ Maybe — but localStorage + persist middleware works fine |
| **StatusBar** | `status-bar.ts` (53 LOC) | `state`, `wsReadyState`, `contextUsage`, `sessionResult`, `onStop`, `onInterrupt`, `kataState`, `worktreeInfo` | **Mixed** — 6/8 fields are server data | ✅ **Yes** — primary migration target |
| **Workspace** | `workspace.ts` (46 LOC) | `activeWorkspace`, `workspaceProjects` | UI-ephemeral (filter) | ❌ No — localStorage sufficient |

**Key finding:** Only `useStatusBarStore` carries server-authoritative
state. `onStop` and `onInterrupt` are callbacks (not data) and belong in
component-local state or a ref.

**Consumers:**
- StatusBar: sole reader of `useStatusBarStore` (`status-bar.tsx:225`)
- AgentDetailView: sole writer (`AgentDetailView.tsx:83–182`)
- Notification drawer/bell: reads `notifications` store
- Workspace selector, SessionSidebar, SessionCardList, FilterChipBar: read workspace store

## 2. TanStack DB Collections Inventory

6 collections in `apps/orchestrator/src/db/`:

| Collection | File | Type | Backing | OPFS | Schema Version | Consumers |
|------------|------|------|---------|------|----------------|-----------|
| **agentSessionsCollection** | `agent-sessions-collection.ts` | `queryCollectionOptions` | `GET /api/sessions` (30s refetch, 15s stale) | Yes | v3 | Sidebar, session cards, AgentDetailView fallback |
| **messagesCollection** | `messages-collection.ts` | `localOnlyCollectionOptions` | WS delivery + RPC hydration | Yes | v2 | ChatThread via `useMessagesCollection`, use-coding-agent |
| **sessionStatusCollection** | `session-status-collection.ts` | `localOnlyCollectionOptions` | Write-through from AgentDetailView | Yes | v1 | AgentDetailView (cache-first hydration only) |
| **userTabsCollection** | `user-tabs-collection.ts` | `queryCollectionOptions` | `GET /api/user-settings/tabs` | Yes | v1 | Tab bar — with onInsert/onUpdate/onDelete mutation handlers |
| **userPreferencesCollection** | `user-preferences-collection.ts` | `queryCollectionOptions` | `GET /api/preferences` | Yes | v1 | Settings — with onInsert/onUpdate mutation handlers |
| **sessionsCollection** | `sessions-collection.ts` (shim) | Re-export | Alias for `agentSessionsCollection` | — | — | Legacy imports (TODO: delete in #7 p5) |

**DB Instance:** `db-instance.ts` — shared OPFS SQLite database
(`duraclaw`), `QueryClient` instance, `dbReady` promise pattern. Every
collection module `await`s `dbReady` at top level.

**Patterns in use:**
- `queryCollectionOptions` for server-backed (agent_sessions, user_tabs, user_preferences)
- `localOnlyCollectionOptions` for client-side (messages, session_status)
- `persistedCollectionOptions` wrapper for OPFS persistence
- `useMessagesCollection` custom hook with `useLiveQuery` filtering by sessionId
- `sessionsCollection.utils.writeUpdate()` for local mirror of WS state (no server round-trip)
- `collection.has()` / `.insert()` / `.update()` / `.delete()` for direct mutation
- Schema versioning on every persisted collection

**Missing collections (proposed in issue):**
- `sessionLiveStateCollection` — union of session_status + status-bar Zustand
- `projectsCollection` — replace 30s setInterval poll of `/api/gateway/projects/all`

## 3. WebSocket / useAgent.state Usage

**useAgent call site:** `use-coding-agent.ts:251` — single call via
`useAgent<SessionState>({ agent: 'session-agent', name: agentName })`.

**onStateUpdate (line 254):** Receives full `SessionState` on every DO
`setState()`. Writes to:
1. React state (`setState(newState)`)
2. `sessionsCollection.utils.writeUpdate()` — mirrors status/numTurns/cost/duration to the query collection (lines 265–275)
3. Triggers `hydrateMessages` RPC on first state sync (lines 281–306)

**onMessage (line 312):** Handles three wire formats:
- `{type: 'message', message}` — single message → `upsert()` into messagesCollection
- `{type: 'messages', messages}` — bulk replay → `replaceAllMessages()` in collection
- `{type: 'gateway_event', event}` — non-message events:
  - `kata_state` → React state (`setKataState`)
  - `context_usage` → React state (`setContextUsage`)
  - `result` → React state (`setSessionResult`)
  - All events → `setEvents` accumulator

**Flow to render:** WS → React state in `useCodingAgent` → returned to `AgentDetailView` → written to `useStatusBarStore` (Zustand) → read by `StatusBar`.

**kataState path:** `gateway_event.kata_state` → `setKataState` (React) → AgentDetailView effect → `useStatusBarStore.set({kataState})` → StatusBar reads `kataState`.

## 4. REST + RPC Fetch Channels

| Channel | URL | Method | Consumer | Polling | Cache Strategy |
|---------|-----|--------|----------|---------|----------------|
| Sessions list | `/api/sessions` | GET | `agentSessionsCollection` queryFn | 30s refetch, 15s stale | OPFS (queryCollection) |
| User tabs | `/api/user-settings/tabs` | GET | `userTabsCollection` queryFn | None (invalidation-driven) | OPFS |
| User preferences | `/api/preferences` | GET | `userPreferencesCollection` queryFn | None (invalidation-driven) | OPFS |
| Worktree info | `/api/gateway/projects/all` | GET | `AgentDetailView.tsx:154` | **30s setInterval** (manual) | None — raw fetch |
| Tab mutations | `/api/user-settings/tabs[/:id]` | POST/PATCH/DELETE | `userTabsCollection` onInsert/onUpdate/onDelete | — | Optimistic via collection |
| Preferences mutations | `/api/preferences` | PUT | `userPreferencesCollection` onInsert/onUpdate | — | Optimistic via collection |
| Context usage | RPC `getContextUsage` | WS call | `use-coding-agent.ts` | On-demand | None |
| Messages | RPC `getMessages` | WS call | `use-coding-agent.ts` → messagesCollection | On hydrate/resume | OPFS |
| Send message | RPC `sendMessage` | WS call | `use-coding-agent.ts` | — | Optimistic insert |

**Key finding:** `/api/gateway/projects/all` is the only REST endpoint
still using raw `fetch` + `setInterval` instead of a queryCollection.
This is the natural carrier for a `projectsCollection`.

## 5. Pilot Consumer: StatusBar + AgentDetailView

Fully mapped in the delta doc. Summary of the three-tier resolution:

```
mount
  ├─ useLayoutEffect (83–108)
  │    ├─ readSessionStatusCache(sessionId) ────► Zustand (pre-paint)
  │    └─ miss?  agentSessionsCollection.get() ─► synthesize ─► Zustand
  ├─ useEffect (114–124)   live WS values ────► Zustand, null-guarded
  ├─ useEffect (129–137)   write-through ────► sessionStatusCollection
  ├─ useEffect (147–182)   /api/gateway/projects/all ────► Zustand + cache
  └─ unmount (139–141)     statusBarClear()
```

**What changes with sessionLiveStateCollection:**
- The three-tier resolution collapses to: WS handler writes collection → `useLiveQuery` reads it.
- OPFS persistence is built-in — no separate write-through effect.
- Null-guards are eliminated — collection holds prior values until overwritten.
- `useStatusBarStore` drops 6 server-data fields, keeps only `onStop`/`onInterrupt` (or moves those to refs).
- `synthesizeStateFromSessionRecord` fallback moves into the collection's initial population or a read-time merge.

## 6. Other Consumers

| Consumer | File | Data Sources | Coping Strategy |
|----------|------|--------------|-----------------|
| **ChatThread / MessageList** | `features/agent-orch/` | `useMessagesCollection(agentName)` via `useLiveQuery` | Already collection-native ✅ |
| **Sidebar / SessionCardList** | `features/agent-orch/SessionCardList.tsx` | `agentSessionsCollection` via live query + workspace filter | Collection-native for list; no live status updates for non-active sessions |
| **SessionListItem** | `features/agent-orch/SessionListItem.tsx` | `agentSessionsCollection` row | Reads status/cost/turns from collection row; stale until 30s refetch |
| **Tab bar** | `components/tab-bar.tsx` | `userTabsCollection` + `agentSessionsCollection` join | D1-backed, invalidation-driven ✅ |
| **Notification drawer/bell** | `components/notification-drawer.tsx`, `notification-bell.tsx` | `notifications` Zustand store | Driven by `use-notification-watcher` hook watching session status transitions |
| **SessionHistory** | `features/agent-orch/SessionHistory.tsx` | `agentSessionsCollection` (sort + display) | Collection-native ✅ |

**Key finding:** ChatThread, tab bar, session cards, and session history
are already collection-native. The main gaps are:
1. StatusBar (Zustand bridge) — pilot target
2. Sidebar status indicators (stale until 30s refetch, no live push for non-active sessions)
3. Notifications (could read from sessionLiveStateCollection instead of its own watcher)

## 7. use-coding-agent.ts Anatomy

**File:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`
**Size:** 741 LOC

**9 responsibilities:**

| # | Responsibility | Lines | Collection-ready? | Migrates in #12? |
|---|---------------|-------|-------------------|-----------------|
| 1 | Message collection mutation (upsert/delete/optimistic) | 173–249 | ✅ Already collection-native | No change needed |
| 2 | State sync (state, events, sessionResult, kataState, contextUsage) | 137–165, 254–311, 338–377 | ❌ React useState | **Yes** → write to sessionLiveStateCollection |
| 3 | WS lifecycle (useAgent, onStateUpdate, onMessage) | 251–378 | Stays | Stays (command plane, per issue) |
| 4 | Message hydration RPC | 381–391 | ✅ Writes to collection | No change needed |
| 5 | Branch navigation (rewind/resubmit/navigate) | 448–553 | ✅ Uses replaceAllMessages | No change needed |
| 6 | Draft submission (Y.Text → optimistic → RPC) | 595–684 | ✅ Writes to collection | No change needed |
| 7 | Orphan recovery (forkWithHistory) | 686–714 | ✅ Already collection-native | No change needed |
| 8 | Context usage polling (RPC) | 418–420 | ❌ React state | **Yes** → write to collection |
| 9 | Gate resolution (RPC) | 422–427 | Stays | Stays (command plane) |

**Estimated shrink:** Responsibilities 2 and 8 move to collection writes
inside `onStateUpdate`/`onMessage`. The `useState` declarations for
`state`, `events`, `sessionResult`, `kataState`, `contextUsage` and their
reset logic (lines 137–165) are eliminated. The hook would drop to ~600
LOC and shed 4 `useState` + the agentName-change reset block.

## 8. TanStack DB Patterns in Use

**Version:** `@tanstack/db` (beta) with `@tanstack/browser-db-sqlite-persistence` and `@tanstack/query-db-collection`.

**Established conventions:**
- Every collection module top-level `await`s `dbReady`
- Factory function pattern: `createXxxCollection()` with OPFS/memory fallback
- `persistedCollectionOptions` wrapping for OPFS
- Schema versioning for OPFS migrations (bump version → stale rows dropped, repopulated)
- `// eslint-disable-next-line` for TanStack DB beta type mismatches
- `queryCollectionOptions` for server-backed data with `getKey`, `refetchInterval`, `staleTime`
- `localOnlyCollectionOptions` for client-side-only data
- Mutation handlers (`onInsert`/`onUpdate`/`onDelete`) for write-back to server (user_tabs, user_preferences)
- `collection.utils.writeUpdate()` for local-only mirrors of server state (no round-trip)
- `useLiveQuery` for reactive reads (used in `useMessagesCollection`)
- Direct `.has()` / `.insert()` / `.update()` / `.delete()` for imperative writes

**What a `useCachedLiveQuery` helper would look like:**

```typescript
function useCachedLiveQuery<T>(
  collection: Collection<T>,
  key: string,
  opts?: {
    fallbackCollection?: Collection<any>
    synthesize?: (record: any) => Partial<T>
  }
): { data: T | null; isLive: boolean }
```

This replaces the three-tier pattern in AgentDetailView. The hook would:
1. Read from collection (OPFS-persisted → instant on mount)
2. Return `isLive: false` if the row exists but hasn't been updated by WS yet
3. If row doesn't exist, optionally synthesize from `fallbackCollection` (agentSessionsCollection)
4. Mark `isLive: true` once WS-driven update lands

Fits naturally into the existing `useLiveQuery` patterns.

## 9. Server Authority Model (D1 ↔ DO)

### D1 Schema (canonical store)

`apps/orchestrator/src/db/schema.ts` — 5 tables:

| Table | Columns | Purpose |
|-------|---------|---------|
| `agent_sessions` | 23 cols (id, userId, project, status, model, sdkSessionId, timestamps, numTurns, prompt, summary, title, tag, origin, agent, archived, durationMs, totalCostUsd, messageCount, kataMode, kataIssue, kataPhase) | Session metadata — canonical |
| `user_tabs` | 5 cols (id, userId, sessionId, position, createdAt) | Tab state — bare refs, no FK to sessions |
| `user_preferences` | 7 cols (userId, permissionMode, model, maxBudget, thinkingMode, effort, hiddenProjects, updatedAt) | User settings |
| `users` / `sessions` / `accounts` / `verifications` | Better Auth tables | Auth (managed by Better Auth) |
| `push_subscriptions` | 6 cols | Web push |

### DO State

- **SessionDO:** In-memory state for live sessions (`setState`/`getState`
  via Agents SDK). Writes status/summary/messages to D1. Has `active_callback_token` for runner auth. Still uses DO SQLite for message history (MessageStorageManager).
- **UserSettingsDO:** D1-backed (not TinyBase — TinyBase sync from issue #6 was proposed but D1 migration superseded it). Handles tab CRUD, preferences CRUD via HTTP routes.
- **ProjectRegistry:** **Eliminated** — `sessions-collection.ts` is a re-export shim (`TODO: delete in #7 p5`). Session list is now a D1 query.

### Authority Boundaries

| Entity | Canonical Store | Live Source | Client Contract |
|--------|----------------|-------------|-----------------|
| Session metadata (list) | D1 `agent_sessions` | `/api/sessions` → `agentSessionsCollection` | 30s eventual consistency |
| Session live state | SessionDO in-memory | WS `onStateUpdate` | Real-time while connected |
| Messages | SessionDO SQLite | WS + RPC `getMessages` | Hydrate on connect, stream live |
| Tabs | D1 `user_tabs` | `/api/user-settings/tabs` → `userTabsCollection` | Invalidation-driven |
| Preferences | D1 `user_preferences` | `/api/preferences` → `userPreferencesCollection` | Invalidation-driven |
| Worktree info | VPS (gateway) | `/api/gateway/projects/all` | 30s poll (no push channel) |

**Client contract:** Collections mirror D1 (eventual consistency via
refetch/invalidation). WS deltas are derived from DO in-memory state,
which is the live authority for running sessions. D1 is always the
recovery authority (DO state is ephemeral).

## Channels → Entities Matrix

The issue's core ask — which channels carry which entities:

| Entity | WS State | WS Events | RPC | REST Query | Manual Poll | Zustand | OPFS Cache |
|--------|----------|-----------|-----|------------|-------------|---------|------------|
| Session status | ✅ `onStateUpdate` | | | ✅ `/api/sessions` | | ✅ `useStatusBarStore.state` | ✅ `sessionStatusCollection` |
| Context usage | | ✅ `context_usage` | ✅ `getContextUsage` | | | ✅ `useStatusBarStore.contextUsage` | ✅ `sessionStatusCollection` |
| Kata state | | ✅ `kata_state` | | | | ✅ `useStatusBarStore.kataState` | ✅ `sessionStatusCollection` |
| Session result | | ✅ `result` | | | | ✅ `useStatusBarStore.sessionResult` | ✅ `sessionStatusCollection` |
| Worktree info | | | | | ✅ 30s `/api/gateway/projects/all` | ✅ `useStatusBarStore.worktreeInfo` | ✅ `sessionStatusCollection` |
| Messages | | ✅ `message`/`messages` | ✅ `getMessages` | | | | ✅ `messagesCollection` |
| Sessions list | | | | ✅ `/api/sessions` | | | ✅ `agentSessionsCollection` |
| Tabs | | | | ✅ `/api/user-settings/tabs` | | | ✅ `userTabsCollection` |
| Preferences | | | | ✅ `/api/preferences` | | | ✅ `userPreferencesCollection` |
| Notifications | | | | | | ✅ `notifications` store | localStorage |
| Workspace filter | | | | | | ✅ `workspace` store | localStorage |
| Auth | | | | | | ✅ `auth` store | Cookie |

**The problem row:** Session live state (status, context usage, kata state,
session result, worktree info) is the only entity that flows through **all
7 columns**. Every other entity has at most 2–3 sources. This is why the
pilot targets session live state.

## Comparison: Current vs Target

| Aspect | Current | Target |
|--------|---------|--------|
| Session live state sources | 5 (WS state, WS events, RPC, manual poll, Zustand cache, OPFS cache) | 1 (`sessionLiveStateCollection` with OPFS) |
| StatusBar data path | WS → React state → Zustand → render | WS → collection write → `useLiveQuery` → render |
| Tab-switch hydration | `useLayoutEffect` reads OPFS cache → writes Zustand → null-guard effects | Collection has OPFS data on mount → `useLiveQuery` returns it |
| Adding a new status-bar field | 5–6 file touches | 2 files (collection schema + consumer) |
| `use-coding-agent.ts` size | 741 LOC, 9 responsibilities | ~600 LOC, 7 responsibilities (state sync moves to collection) |
| `/api/gateway/projects/all` | Raw fetch + 30s setInterval, per-session duplication | `projectsCollection` with staleTime, shared across tabs |
| Zustand server-data fields | 6 (state, wsReadyState, contextUsage, sessionResult, kataState, worktreeInfo) | 0 (moved to collections) |

## Recommendations

1. **Pilot on StatusBar** — migrate `useStatusBarStore`'s 6 server-data
   fields to `sessionLiveStateCollection`. Delete `sessionStatusCollection`
   (merged in). Delete the three `useEffect` chains in AgentDetailView.
   This is the highest-leverage change with the smallest blast radius.

2. **`projectsCollection`** — immediate follow-up after pilot. Replaces
   the only remaining raw-fetch + setInterval pattern. Trivial to
   implement given existing queryCollection conventions.

3. **Keep messages and tabs as-is** — already collection-native. No
   migration needed, just formalize the write path in documentation.

4. **Keep Zustand for UI-only state** — workspace filter, notification
   drawer, auth. Draw a hard line: no server-authoritative data in Zustand.

5. **`useCachedLiveQuery` helper** — extract after the pilot proves the
   pattern. Don't over-abstract up front.

6. **`sessionStatusCollection` → merge into `sessionLiveStateCollection`**
   — same schema, same persistence, but now it's the render source (via
   `useLiveQuery`) not just a cache. Schema version bump, OPFS migration
   is automatic.

## Open Questions (for interview)

Carried forward from the delta doc, refined:

1. **Scope:** client-only or does #12 include DO protocol changes?
2. **Migration shape:** pilot-first (status bar) then expand, or big-bang?
3. **Collection vs store split:** exact line — what stays in Zustand?
4. **`sessionStatusCollection` fate:** merge vs keep alongside?
5. **`useCachedLiveQuery` API:** fallback shape, one-per-call vs registered?
6. **Write path:** WS handler → direct collection write, or middleware?
7. **Multi-tab semantics:** last-write-wins or sequence-number guard?
8. **Worktree invalidation:** 30s staleTime or add a nudge channel?
9. **`use-coding-agent.ts` shrink target:** which responsibilities stay?
10. **Sidebar live status:** phase 1 or later? (non-active sessions)
11. **Display-state derivation:** fold into this spec or separate?

## Next Steps

1. **Interview** — close the 11 open questions with the user
2. **Spec** — behaviors with B-IDs, phased implementation, verification plan
3. **Pilot implementation** — `sessionLiveStateCollection` + StatusBar migration

## Sources

All files read during this research:

- `apps/orchestrator/src/db/*.ts` (all 7 collection/instance files)
- `apps/orchestrator/src/stores/*.ts` (all 4 store files)
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (741 LOC, full read)
- `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx` (full read)
- `apps/orchestrator/src/components/status-bar.tsx` (full read)
- `apps/orchestrator/src/db/schema.ts` (D1 schema, full read)
- `planning/research/2026-04-19-issue-12-client-data-layer-delta.md` (prior delta)
- `planning/research/2026-04-16-state-management-audit.md` (baseline audit)
- `planning/research/2026-04-18-runner-status-ui-surfaces.md` (tab vs bar)
- `planning/research/2026-04-18-session-tab-loading-trace.md` (messages lag)
- GitHub issue #12 (full body)
- GitHub issue #6 (closed — D1 migration complete)
