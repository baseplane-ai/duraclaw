---
initiative: tanstackdb-session-state
type: project
issue_type: feature
status: approved
priority: high
github_issue: 33
created: 2026-04-13
updated: 2026-04-13
review_rounds: 3
final_score: 84
phases:
  - id: p1
    name: "Session List Collection"
    tasks:
      - "Install @tanstack/db, @tanstack/react-db, @tanstack/query-db-collection, @tanstack/browser-db-sqlite-persistence"
      - "Create db/db-instance.ts — TanStackDB + SQLite OPFS persistence init with memory-only fallback"
      - "Create db/sessions-collection.ts — QueryCollection wrapping /api/sessions"
      - "Create hooks/use-sessions-collection.ts — React hook wrapping useLiveQuery for sessions"
      - "Wire DB init into entry-client.tsx (non-blocking, async)"
      - "Add WS bridge: onStateUpdate in useCodingAgent writes status changes to sessions collection"
      - "Replace useAgentOrchSessions in AgentOrchPage, nav-sessions, and session.$id route"
      - "Wire useNotificationWatcher(sessions) inside useSessionsCollection hook (currently called inside useAgentOrchSessions)"
      - "Delete use-agent-orch-sessions.ts and its test file"
      - "Verify: sidebar + session cards + session page all render from collection"
      - "Write unit tests for useSessionsCollection: mock fetch, verify reactive updates, verify optimistic rollback"
      - "Write unit test for WS bridge: mock onStateUpdate, verify sessionsCollection.update is called with correct fields"
    test_cases:
      - "Session list renders from OPFS cache before network response completes (verify: throttle to Slow 3G, hard refresh, sidebar populates while /api/sessions is still pending)"
      - "Creating a new session via UI appears in sidebar without manual refresh"
      - "Session status changes (idle -> running) update sidebar within 2s via WS bridge"
      - "Archiving a session removes it from the active list with optimistic rollback on failure"
      - "Firefox: app loads with memory-only fallback, console warns about missing OPFS"
  - id: p2
    name: "Session History with Client-Side Sort/Filter/Search"
    tasks:
      - "Replace SessionHistory.tsx fetch logic with useLiveQuery against the existing sessions collection from P1"
      - "Remove server-side pagination/sort/filter calls — all data is already in the local collection via /api/sessions"
      - "Implement client-side search via useLiveQuery .where() with case-insensitive substring matching (JS predicate: field.toLowerCase().includes(query.toLowerCase())) on title, prompt, and summary fields"
      - "Remove pagination controls (all sessions loaded locally)"
      - "Verify: sorting, filtering, and search all work client-side without network calls"
    test_cases:
      - "History page renders from sessions collection — no /api/sessions/history call in Network tab"
      - "Sorting by cost/duration/turns re-orders rows client-side (no network request on column click)"
      - "Status filter narrows results client-side"
      - "Search filters sessions by title/prompt/summary client-side"
      - "Navigating away and back to history page shows cached data immediately"
  - id: p3
    name: "Message Cache-Behind Pattern"
    tasks:
      - "Extract ChatMessage interface from ChatThread.tsx into ~/lib/types.ts (shared between UI and collection)"
      - "Create db/messages-collection.ts — LocalOnlyCollection for ChatMessage (with added sessionId: string field, id narrowed to string)"
      - "Create hooks/use-messages-collection.ts — hook that reads from collection for a given sessionId"
      - "In useCodingAgent, write incoming WS messages to the messages collection (cache-behind)"
      - "On session open, hydrate from local collection first (cache-first), then WS hydration fills gaps"
      - "Add 30-day age-based eviction for messages on DB init (delete messages with created_at > 30 days old)"
      - "Verify: switching tabs shows cached messages instantly, then WS hydration syncs"
      - "Write unit tests for message cache-behind: mock WS events, verify only final assistant/tool/user messages are cached (not partial_assistant or file_changed)"
      - "Write unit test for cache-first hydration: pre-populate collection, verify messages render before hydrateMessages RPC completes"
    test_cases:
      - "Open session A, receive messages, switch to session B, switch back to A — messages appear from cache before WS hydration RPC call completes (verify: throttle to Slow 3G, observe messages render while getMessages RPC is still pending)"
      - "Close browser, reopen — previously viewed session shows cached messages before WS connection establishes"
      - "Messages older than 30 days are evicted on next app start regardless of session status"
      - "Streaming partial_assistant content is NOT written to cache (only final assistant messages)"
      - "Dedup: WS hydration does not create duplicate messages when cache already has them"
---

## Overview

The Duraclaw orchestrator currently manages session data through raw fetch polling (5-second intervals), manual useState management, and separate server-side pagination/search endpoints. This causes stale data, no offline support, redundant network traffic, and slow tab switches that re-fetch everything. TanStackDB replaces this with reactive collections backed by browser SQLite (OPFS), giving instant renders from local cache, event-driven freshness via WebSocket bridges, and client-side sort/filter/search that eliminates server round-trips.

## Feature Behaviors

### B1: DB Instance Initialization

**Core:**
- **ID:** db-init
- **Trigger:** App mounts in browser (entry-client.tsx renders)
- **Expected:** TanStackDB initializes with OPFS SQLite persistence. If OPFS is unavailable (Firefox, insecure context), falls back to memory-only storage and logs a console warning. App renders immediately without waiting for DB init to complete. Collections populate asynchronously once the DB is ready.
- **Verify:** In Chrome DevTools Application tab, OPFS shows `duraclaw.db` file. In Firefox, console shows `[duraclaw-db] OPFS not available, using memory-only storage`. App renders login/dashboard before DB init resolves.

#### Data Layer
- New file: `apps/orchestrator/src/db/db-instance.ts`
- Exports: `db` (TanStackDB instance), `persistence` (SQLitePersistence or null), `dbReady` (Promise that resolves when init completes)
- OPFS detection: check `navigator.storage?.getDirectory` existence
- Schema version: starts at 1, bump on breaking collection changes. When `schemaVersion` is bumped, `persistedCollectionOptions` drops the local table and re-fetches from the server (full re-sync). No incremental migration — this is intentional for a client-side cache where the server is the source of truth. Data loss on version bump is acceptable since the cache rebuilds automatically.
- No new server-side schema changes

---

### B2: Sessions QueryCollection

**Core:**
- **ID:** sessions-collection
- **Trigger:** DB init completes; any component subscribes to sessions data
- **Expected:** A single QueryCollection fetches `/api/sessions`, caches results in OPFS SQLite, and serves all subscribers reactively. Background refetch every 30 seconds keeps data fresh. Stale data renders immediately while refresh happens in background.
- **Verify:** Open Network tab, observe single `/api/sessions` call on page load, then one call every 30s. Multiple components (sidebar, session cards) all render the same data without separate fetch calls.

**Population timing:** The QueryCollection begins fetching immediately when a component first subscribes (via `useLiveQuery`), regardless of whether `dbReady` has resolved. If OPFS persistence is still initializing, the collection operates in memory-only mode — data is fetched from the server and rendered normally. Once `dbReady` resolves and the persistence layer becomes available, subsequent data is persisted to OPFS. On future visits, the persistence layer loads cached data first (instant render), then the refetch cycle updates it. There is no double-fetch — the `queryFn` fires once per subscription, and the persistence layer reads/writes are transparent.
**Source:** `apps/orchestrator/src/features/agent-orch/use-agent-orch-sessions.ts:40-60` (replaced)

#### Data Layer
- New file: `apps/orchestrator/src/db/sessions-collection.ts`
- Collection key: `sessions`
- Item type: `SessionRecord` (extends `SessionSummary` with `archived: boolean`). The collection is typed as `SessionRecord`, NOT `SessionSummary`. The `archived` field exists in the SQL response but is NOT on the `SessionSummary` TypeScript interface — the `queryFn` must coerce it: `json.sessions.map(s => ({ ...s, archived: !!s.archived }))`.
- Item key: `id` field (string)
- Refetch interval: 30000ms (30s, up from 5s polling — WS bridge handles real-time)
- Stale time: 15000ms
- Persistence: schema version 1, table `sessions_metadata`

---

### B3: Sessions React Hook

**Core:**
- **ID:** use-sessions-hook
- **Trigger:** Component calls `useSessionsCollection()`
- **Expected:** Returns `{ sessions, isLoading, createSession, updateSession, archiveSession, refresh }` with the same interface as the current `useAgentOrchSessions` hook. Sessions are sorted by `updated_at` desc. Archived sessions are excluded by default. Mutations use optimistic updates with automatic rollback on server failure.
- **Verify:** Replace `useAgentOrchSessions` import with `useSessionsCollection` in AgentOrchPage — page renders identically. Archive a session while offline (simulate with DevTools offline mode) — optimistic removal occurs, then rolls back when reconnected. On rollback, the item silently reappears in the list (no toast or error banner — matches current behavior where errors are console-logged only).
**Source:** `apps/orchestrator/src/features/agent-orch/use-agent-orch-sessions.ts:34-120` (replaced entirely)

**Error handling:** Optimistic mutation failures (network error, server 4xx/5xx) trigger automatic rollback — the collection reverts the item to its pre-mutation state. Errors are logged to `console.error` (matching current pattern in `useAgentOrchSessions`). No user-facing toast or error UI is added — this matches the existing silent-retry pattern. If a richer error UX is desired later, it can be added as a follow-up.

#### UI Layer
- No UI changes — the hook provides the same interface
- Components affected: `AgentOrchPage.tsx`, `nav-sessions.tsx`, `session.$id.tsx`
- `useNotificationWatcher` continues to receive sessions array from the new hook. It expects `SessionSummary[]` which is a subset of the collection's fields — no mapping needed since `SessionSummary` is structurally compatible (TypeScript structural typing).

#### API Layer
- No API changes — the hook calls the same `POST /api/sessions`, `PATCH /api/sessions/:id` endpoints for mutations
- Read path changes from direct fetch to QueryCollection (which wraps fetch internally)

---

### B4: WebSocket Bridge for Session Status

**Core:**
- **ID:** ws-status-bridge
- **Trigger:** `useCodingAgent` receives an `onStateUpdate` callback with new session state (status change, cost update, etc.)
- **Expected:** The bridge writes the updated session metadata into the sessions collection, so the sidebar/card list reflects status changes (idle -> running -> idle) within 1-2 seconds without waiting for the next 30s background refetch.
- **Verify:** Start a session, observe sidebar badge changes from "idle" to "running" within 2 seconds. No additional `/api/sessions` fetch is triggered by the status change.

#### Data Layer
- Modification in: `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (onStateUpdate callback)
- The bridge calls `sessionsCollection.update(sessionId, { status, updated_at, ... })` or equivalent TanStackDB mutation API
- Only metadata fields are updated (status, updated_at, total_cost_usd, duration_ms, num_turns) — not messages

---

### B5: Session History Client-Side Query

**Core:**
- **ID:** history-client-query
- **Trigger:** User navigates to the session history page
- **Expected:** All session metadata is already in the local sessions collection (synced by B2 via `GET /api/sessions`, which returns ALL sessions including archived). History page renders instantly from cache. Sort, filter, and search all operate client-side via `useLiveQuery` with different predicates than the sidebar (no `!archived` filter, custom sort/filter/search). No separate `/api/sessions/history` or `/api/sessions/search` calls needed — the single collection serves both sidebar and history views with different queries.
- **Verify:** Open history page with DevTools Network tab — no `/api/sessions/history` call. Click "Cost" column header — rows re-sort instantly (verify by observing no Fetch/XHR entry in Network tab on click). Type in search box — results filter as you type with no network activity.
**Source:** `apps/orchestrator/src/features/agent-orch/SessionHistory.tsx:83-105` (replaced)

#### Clarification: One Collection, Two Views
The sessions collection from B2 fetches `GET /api/sessions` which calls `ProjectRegistry.listSessions()` — this returns ALL sessions (active, idle, archived). The sidebar uses `useLiveQuery` with `.where(({ s }) => !s.archived)` to show only active sessions. The history page uses the SAME collection with different query predicates (no archived filter, sort by user-selected column, filter by status/project, search by title/prompt/summary). No second collection or endpoint is needed.

#### UI Layer
- `SessionHistory.tsx`: remove `fetchHistory`, `fetchSearch`, pagination state, server-side params
- Keep sort/filter UI controls but wire them to `useLiveQuery` predicates instead of URL params
- Remove pagination controls (all data is local)
- Keep the Resume button logic (POST /api/sessions) unchanged

#### Data Layer
- The sessions collection from B2 already contains all session data (including archived)
- Live query applies `.where()` for status filter, `.orderBy()` for sort, and string matching for search
- The server-side endpoints (`/api/sessions/history`, `/api/sessions/search`) are NOT deleted but are no longer called from the client
- If total sessions exceed 5000 in the future, re-evaluate with server-side pagination

---

### B6: Message Cache-Behind

**Core:**
- **ID:** message-cache-behind
- **Trigger:** `useCodingAgent` receives assistant, tool_result, or user_message events via WebSocket
- **Expected:** Final messages (not streaming partials) are written to a LocalOnlyCollection keyed by `id`. On session open, the collection is read first for instant display, then WS hydration (`getMessages` RPC) fills any gaps and deduplicates. Switching tabs shows cached messages immediately without waiting for WS reconnect and hydration.

**Dedup strategy by message role:**
- **assistant/tool messages:** Dedup by `event_uuid` field (always present, globally unique UUID). Both the WS cache-behind write and the `hydrateMessages` RPC return messages with `event_uuid`. If a message with the same `event_uuid` already exists in the collection, skip the insert.
- **user messages:** Client generates `user-{timestamp}-{random}` as `id`. The server stores user messages with the same content but potentially a different server-assigned ID. Dedup for user messages uses `role + content` matching (same strategy as the existing `hydrateMessages` function at line 264-269 of `use-coding-agent.ts` which deduplicates by `hydratedUserContent` set). When hydration returns a user message whose content matches a cached user message, the cached version is kept.
- **Verify:** Open session, send a message, receive response. Close tab entirely. Reopen tab, navigate to same session — cached messages appear within 100ms, before WS connection establishes. WS hydration then silently merges any missing messages.
**Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:244-275` (hydration logic modified)

#### Data Layer
- New file: `apps/orchestrator/src/db/messages-collection.ts`
- Collection type: LocalOnlyCollection (no server sync adapter — WS is source of truth)
- Item key: `id` field (string) — for assistant/tool messages this is `event_uuid`, for user messages this is the optimistic ID (`user-{timestamp}-{random}`). Keys are globally unique (UUIDs) so no composite key needed. The `sessionId` field is stored on each message for filtering but is NOT part of the primary key.
- Schema: extends `ChatMessage` from `ChatThread.tsx` with added `sessionId: string` field. Note: `ChatMessage.id` is typed as `number | string` — the collection narrows this to `string` only (all IDs generated by the WS hook are strings). Extract `ChatMessage` interface from `ChatThread.tsx` into a shared types file (`~/lib/types.ts` or `~/db/types.ts`) so both the UI and collection can import it.
- The `useSessionsCollection` hook must return `SessionRecord[]` (not raw `SessionSummary[]`) to match the existing contract — this means coercing `archived` to boolean via `!!` as the current hook does.
- Persistence: OPFS SQLite, schema version 1, table `session_messages`
- NOT cached: `partial_assistant` events, `file_changed` transient events
- Eviction: on DB init, delete messages where `created_at` is older than 30 days. "Active" is not a factor — eviction is purely age-based. Any session's messages older than 30 days are evicted regardless of session status. This is simple, predictable, and avoids needing to define "active" (which would require cross-referencing the sessions collection during init, adding complexity).

---

### B7: Cache-First Session Hydration

**Core:**
- **ID:** cache-first-hydration
- **Trigger:** User opens/switches to a session tab
- **Expected:** Messages from the local messages collection for that sessionId are displayed immediately (cache-first). The existing `hydrateMessages` RPC call still runs in the background to fetch any messages not in cache. The merge logic deduplicates by `event_uuid`. The user sees cached messages instantly and any new/missing messages appear seamlessly as hydration completes.
- **Verify:** Open a previously-viewed session — messages render from cache before WS hydration completes (verify with Slow 3G throttle). Check that `hydrateMessages` still runs (network tab shows RPC call). After hydration, message count may increase if server has messages not in local cache. No duplicates appear.
**Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:96-108` (hydration trigger modified)

**Hydration rewrite detail:**
The existing `hydrateMessages` function pages through `conn.call('getMessages', [{ offset, limit: 200 }])` in a loop. In the cache-first flow:
1. **On session open**, read messages from the local collection for this `sessionId` and set them as initial `messages` state (replacing the empty `[]` default).
2. **Then run `hydrateMessages`** as before — it fetches pages from the server via RPC.
3. **Merge strategy**: For each hydrated message, check if it already exists in the collection by `event_uuid` (for assistant/tool) or `role + content` (for user). If not, insert into the collection AND append to React `messages` state.
4. **React `messages` state still exists** — it is NOT replaced by the collection. The collection is a persistence layer (cache-behind); React state remains the rendering source of truth. This preserves the existing streaming/dedup ref logic without refactoring.
5. **Batch writes**: Hydrated messages are written to the collection in a single batch after each page, not one-by-one, to minimize OPFS write overhead.

#### UI Layer
- No visible UI change — messages appear faster
- Loading skeleton may flash briefly if cache is empty (first-ever visit to a session)

---

## Non-Goals

- **No feature flag / gradual rollout**: This is a hard switch. Old hooks are deleted, not kept behind a flag. The research recommended a feature flag, but the interview decision was to skip it for simplicity.
- **No tab state migration**: Zustand + localStorage for tab management stays as-is.
- **No server-side API changes**: All existing API endpoints remain unchanged. TanStackDB wraps the existing REST calls.
- **No TanStack Query installation**: TanStackDB's QueryCollection has its own internal fetch management; we do not add `@tanstack/react-query` as a separate dependency.
- **No message sync adapter**: Messages use LocalOnlyCollection (write-only from WS events), not a QueryCollection with server sync. The WS hook remains the source of truth for real-time messages.
- **No offline mutation queue**: Mutations (create, update, archive) require network connectivity. Optimistic UI reverts on failure. Full offline write support is out of scope.
- **No server-side endpoint deletion**: The server-side endpoints (`/api/sessions/history`, `/api/sessions/search`) are preserved in the API but are no longer called from the client. They remain available for future use (e.g., admin tools, external integrations). No server code is modified or removed.
- **No session count cap handling**: If sessions exceed 5000, performance may degrade. This is tracked as a future concern, not addressed in this spec.
- **No OPFS data isolation on logout**: The OPFS database is not cleared or user-scoped on logout. A second user logging in on the same browser would see cached session data from the previous user. This is acceptable because Duraclaw is a single-user dev tool — shared-machine multi-user access is not a supported scenario. If multi-user support is added later, scope the DB filename by userId (e.g., `duraclaw-{userId}.db`).
- **No cross-tab sync**: Each browser tab creates its own TanStackDB instance and connection to OPFS SQLite. wa-sqlite handles OPFS locking internally (serialized writes via the Web Worker's `FileSystemSyncAccessHandle`), so concurrent tab writes won't corrupt data. However, tabs do NOT reactively sync — if Tab A receives a WS status update and writes to the collection, Tab B won't see it until its own 30s refetch fires. This is acceptable for a single-user dev tool where one tab is typically active at a time. If cross-tab reactivity is needed later, add `BroadcastChannel` notifications between tabs.

## Implementation Phases

See frontmatter `phases` for task lists and test cases. Phase ordering rationale:

**Phase 1 (Session List Collection)** is the foundation. It installs all dependencies, sets up the DB instance, and validates the core pattern (QueryCollection + OPFS + WS bridge) against the most-used data flow (session sidebar). Every subsequent phase depends on the DB instance and persistence layer created here. P1 is the largest phase (~12 tasks). If it proves too large for a single implementation session, split into P1a (DB init + collection + hook + entry-client wiring) and P1b (WS bridge + component replacement + old hook deletion + tests).

**Phase 2 (Session History)** extends the sessions collection to the history page, replacing server-side sort/filter/search with client-side queries. This is lower risk because it reuses the collection from P1 and only changes the query/rendering layer in one component.

**Phase 3 (Message Cache-Behind)** is the most complex phase, touching the real-time WS hook and introducing a second collection type (LocalOnlyCollection). It is last because it has the highest risk of cache/WS conflicts and benefits from the patterns established in P1-P2.

## Verification Plan

### Phase 1 Verification

1. Run `cd /data/projects/duraclaw/apps/orchestrator && pnpm dev`
2. Open Chrome to `http://localhost:43173/login`
3. Log in with email `agent.verify+duraclaw@example.com`, password `duraclaw-test-password`
4. Open DevTools > Application > Storage > OPFS — verify `duraclaw.db` file exists
5. Open DevTools > Network tab, filter by `Fetch/XHR`
6. Navigate to dashboard — observe single `/api/sessions` call, then calls at 30s intervals (not 5s)
7. Verify sidebar shows session list (same data as before migration)
8. Open a session, observe sidebar badge updates to "running" when session starts — no extra `/api/sessions` fetch triggered
9. Hard refresh (Ctrl+Shift+R) — session list renders from cache before network response arrives (verify by throttling network to Slow 3G)
10. Archive a session via UI — session disappears from sidebar immediately (optimistic)
11. Create a new session — session appears in sidebar after creation without waiting for 30s refetch
12. Open Firefox, navigate to same URL — verify console warning about OPFS fallback, app still functional
13. Run `pnpm typecheck` — no type errors
14. Run `pnpm test` — all tests pass (old test file deleted, new tests cover collection hook)

### Phase 2 Verification

1. Navigate to session history page
2. Open DevTools > Network tab — verify no `/api/sessions/history` fetch call (data served from local collection)
3. Click "Cost" column header — rows re-sort instantly, no network activity
4. Click "Duration" column header — rows re-sort instantly
5. Select "Running" from status filter — table filters instantly, no network activity
6. Type a session title fragment in search box — results filter as you type
7. Clear search, verify all sessions reappear
8. Navigate away from history, navigate back — table renders instantly from cache
9. Verify Resume button still works (POST to `/api/sessions` endpoint)
10. Run `pnpm typecheck && pnpm test` — no regressions

### Phase 3 Verification

1. Open session A, send a message, receive assistant response
2. Open DevTools > Application > OPFS > `duraclaw.db` — verify messages table has entries
3. Switch to session B tab, then switch back to session A tab
4. Verify session A messages appear instantly (< 100ms) before WS hydration completes
5. Throttle network to Offline in DevTools, navigate to session A — cached messages still display
6. Restore network — WS reconnects, hydration runs, no duplicate messages appear
7. Close browser completely, reopen, navigate to session A — cached messages appear from OPFS before WS connects
8. Verify `partial_assistant` streaming text is NOT in the messages cache (only final `assistant` events)
9. Check that messages older than 30 days are evicted (simulate by setting `created_at` to 31 days ago in OPFS SQLite via DevTools console, reload app, verify those messages are gone regardless of session status)
10. Run `pnpm typecheck && pnpm test` — no regressions

## Implementation Hints

> **Note:** TanStackDB is beta (v0.6.x). All code patterns below are illustrative based on the v0.6.4 API. Verify imports and call signatures against the actually installed version's exports before use. Pin exact versions in package.json (`"@tanstack/db": "0.6.4"` not `"^0.6.4"`).

### Key Imports

```typescript
// Core DB
import { createCollection } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'

// QueryCollection adapter (wraps fetch into a collection)
import { queryCollectionOptions } from '@tanstack/query-db-collection'

// OPFS SQLite persistence
import {
  createSQLitePersistence,
  persistedCollectionOptions,
} from '@tanstack/browser-db-sqlite-persistence'

// LocalOnlyCollection (no sync adapter, manual writes)
// Note: LocalOnlyCollection is built into @tanstack/db core, no separate import
```

### Code Patterns

**DB Instance Init (non-blocking):**
```typescript
// db/db-instance.ts
let persistence: Awaited<ReturnType<typeof createSQLitePersistence>> | null = null

async function initPersistence() {
  if (typeof navigator === 'undefined') return null
  try {
    await navigator.storage?.getDirectory() // OPFS availability check
    return await createSQLitePersistence({ dbName: 'duraclaw' })
  } catch {
    console.warn('[duraclaw-db] OPFS not available, using memory-only storage')
    return null
  }
}

export const dbReady = initPersistence().then((p) => {
  persistence = p
  return p
})
export { persistence }
```

**Sessions Collection:**
```typescript
// db/sessions-collection.ts
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { dbReady, persistence } from './db-instance'

export const sessionsCollection = createCollection(
  persistedCollectionOptions({
    ...queryCollectionOptions({
      queryKey: ['sessions'],
      queryFn: async () => {
        const resp = await fetch('/api/sessions')
        const json = await resp.json() as { sessions: SessionSummary[] }
        return json.sessions
      },
      getId: (item) => item.id,
      refetchInterval: 30000,
      staleTime: 15000,
    }),
    persistence: () => persistence, // lazy — null until dbReady resolves
    schemaVersion: 1,
  })
)
```

**useLiveQuery for Sorted/Filtered Sessions:**
```typescript
// hooks/use-sessions-collection.ts
import { useLiveQuery } from '@tanstack/react-db'
import { sessionsCollection } from '~/db/sessions-collection'

export function useSessionsCollection() {
  const { data: sessions, isLoading } = useLiveQuery((q) =>
    q.from({ s: sessionsCollection })
      .where(({ s }) => !s.archived)
      .orderBy(({ s }) => s.updated_at, 'desc')
  )

  useNotificationWatcher(sessions ?? [])

  // Mutations: optimistic-first with server confirmation
  // This is a BEHAVIORAL CHANGE from the current hook:
  // - Current createSession: POST then refetch (no optimistic)
  // - Current updateSession/archiveSession: PATCH then setSessions (post-confirmation)
  // - New pattern: write to collection first (instant UI update), then POST/PATCH,
  //   then collection auto-reconciles on next refetch or rolls back on error
  const createSession = useCallback(async (data: { id: string; project: string; model: string; prompt: string }) => {
    // 1. Optimistic: insert into collection immediately
    sessionsCollection.insert({
      ...data, status: 'idle', archived: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    // 2. Server: POST to create session on server
    try {
      await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    } catch (err) {
      console.error('[useSessionsCollection] Failed to create session:', err)
      sessionsCollection.delete(data.id) // rollback
    }
  }, [])

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    sessionsCollection.update(sessionId, { archived }) // optimistic
    try {
      await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: archived ? 1 : 0 }), // integer for D1
      })
    } catch (err) {
      console.error('[useSessionsCollection] Failed to archive:', err)
      sessionsCollection.update(sessionId, { archived: !archived }) // rollback
    }
  }, [])

  return { sessions: (sessions ?? []).map(s => ({ ...s, archived: !!s.archived })) as SessionRecord[], isLoading, createSession, updateSession, archiveSession, refresh }
}
```

**WS Bridge in useCodingAgent (add to onStateUpdate):**
```typescript
// Inside useCodingAgent, after setState(newState):
onStateUpdate: (newState) => {
  setState(newState)
  // Bridge: update sessions collection with fresh status
  sessionsCollection.update(agentName, {
    status: newState.status,
    updated_at: new Date().toISOString(),
  })
}
```

**Message Cache-Behind Write:**
```typescript
// In useCodingAgent onMessage handler, after building a ChatMessage:
if (event.type === 'assistant' && event.uuid) {
  const msg = { id: event.uuid, role: 'assistant', ... }
  setMessages(prev => [...prev, msg])
  // Cache-behind: write to local collection
  messagesCollection.insert({ ...msg, sessionId: agentName })
}
```

### Gotchas

1. **OPFS requires secure context**: OPFS only works on HTTPS or localhost. The dev server at `localhost:43173` qualifies, but if testing on a LAN IP, OPFS will be unavailable. The fallback handles this.

2. **TanStackDB is beta (v0.6.x)**: Lock exact versions in package.json (`"@tanstack/db": "0.6.4"` not `"^0.6.4"`) to avoid breaking changes on minor bumps. Test after any version update.

3. **persistence must be lazy**: The `persistence` value is `null` until the async `dbReady` promise resolves. The `persistedCollectionOptions` helper accepts a function `() => persistence` to handle this. Collections work in memory-only mode until persistence is ready.

4. **QueryCollection needs a queryClient-like internal**: `@tanstack/query-db-collection` manages its own fetch lifecycle. Do NOT also install `@tanstack/react-query` — the two will conflict. The `queryCollectionOptions` API is self-contained.

5. **useLiveQuery must be called unconditionally**: Like React hooks, `useLiveQuery` cannot be called inside conditions or loops. If you need conditional data, use `.where()` predicates inside the query callback instead.

6. **Collection.update is optimistic by default**: When calling `sessionsCollection.update()` from the WS bridge, the change is reflected immediately in all `useLiveQuery` subscribers. If the next background refetch returns different data, TanStackDB reconciles automatically.

7. **LocalOnlyCollection has no sync**: The messages collection is write-only from the client. There is no server fetch adapter. The `hydrateMessages` RPC call in `useCodingAgent` writes results into the collection manually, it does not happen automatically.

8. **Bundle size**: TanStackDB JS packages add approximately 20-25kb gzipped. The wa-sqlite WASM binary adds an additional ~100-150kb gzipped (~300-400kb uncompressed) but loads asynchronously via the Web Worker and does NOT block initial render or affect JavaScript bundle size. Total additional download: ~120-175kb gzipped. The WASM binary is cached by the browser after first load. Measure actual impact after installation with `pnpm build && ls -la dist/`.

### Reference Docs

- [TanStackDB Docs — Collections](https://tanstack.com/db/latest/docs/guide/collections) — Collection types, options, and lifecycle
- [TanStackDB Docs — Live Queries](https://tanstack.com/db/latest/docs/guide/live-queries) — useLiveQuery API, query syntax, sorting/filtering
- [TanStackDB Docs — Persistence](https://tanstack.com/db/latest/docs/guide/persistence) — OPFS SQLite setup, schema versioning, migration
- [TanStackDB GitHub — QueryCollection adapter](https://github.com/TanStack/db/tree/main/packages/query-db-collection) — Source for queryCollectionOptions API
- [wa-sqlite OPFS VFS](https://rhashimoto.github.io/wa-sqlite/docs/guide/vfs.html) — Underlying OPFS virtual filesystem used by TanStackDB
