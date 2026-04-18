---
initiative: d1-tinybase-unified-storage
type: project
issue_type: feature
status: approved
priority: high
github_issue: 6
created: 2026-04-18
updated: 2026-04-18
review_score: 84
phases:
  - id: p1
    name: "D1 schema — sessions table + migration from ProjectRegistry"
    tasks:
      - "Add Drizzle schema for `agent_sessions` table in apps/orchestrator/src/db/schema.ts (mirrors ProjectRegistry's sessions columns: id, user_id, project, status, model, prompt, summary, title, archived, num_turns, total_cost_usd, duration_ms, sdk_session_id, created_at, updated_at, plus kata_* fields)"
      - "Generate and apply D1 migration via `drizzle-kit generate` + `wrangler d1 migrations apply`"
      - "Add Worker API routes for session CRUD: GET /api/d1/sessions (list), GET /api/d1/sessions/:id, POST /api/d1/sessions, PATCH /api/d1/sessions/:id"
      - "Wire SessionDO to write status/summary/result to D1 via env.DB on state changes (onSpawn, onResult, onStatusChange)"
      - "Migrate existing ProjectRegistry session data to D1 via one-time migration script: Worker route `POST /api/d1/migrate-sessions` reads sessions from ProjectRegistry DO in batches of 100 (paginated via listSessionsPaginated) and inserts into D1 using batched INSERT statements (100 rows per statement, within D1's bind limit); idempotent (ON CONFLICT DO NOTHING); returns {migrated, skipped, total}; run once, verify counts match, then proceed to P4 for ProjectRegistry deletion"
      - "Verify miniflare D1 test setup: ensure vitest.config.ts has miniflare environment with D1 binding for AUTH_DB (if not configured, add it — follows existing pattern for DO tests)"
      - "Unit test: SessionDO status change → D1 row updated; Worker route returns fresh data"
    test_cases:
      - id: "d1-session-crud"
        description: "POST /api/d1/sessions creates row; GET returns it; PATCH updates status; row persists across requests"
        type: "integration"
      - id: "session-do-d1-write"
        description: "SessionDO spawn → D1 sessions row status='running'; result → status='idle' + summary set"
        type: "integration"
      - id: "d1-migration-idempotent"
        description: "POST /api/d1/migrate-sessions run twice: second run inserts zero rows (ON CONFLICT DO NOTHING); row count matches ProjectRegistry source; all columns transferred correctly"
        type: "integration"
      - id: "d1-api-error-paths"
        description: "POST with missing project → 400; GET nonexistent ID → 404; PATCH nonexistent → 404"
        type: "unit"
  - id: p2
    name: "UserSettingsDO — TinyBase WsServerDurableObject + DO SQLite persistence"
    tasks:
      - "Install tinybase (v8.1) as dependency in apps/orchestrator"
      - "Create new UserSettingsTinyBaseDO class extending WsServerDurableObject"
      - "Override createPersister() → createDurableObjectSqlStoragePersister with fragmented mode"
      - "Define TinyBase tables: `tabs` (sessionId, position), `drafts` (text, updatedAt) — both keyed by tabId"
      - "No TinyBase value for activeTabId — it lives in a separate localStorage key outside TinyBase (per-browser, not synced)"
      - "Implement onConnect lifecycle: load session metadata from D1 into TinyBase `sessions` table for all user's sessions"
      - "Implement /notify endpoint: SessionDO pokes → read fresh D1 row → setRow('sessions', sessionId, {...}) → TinyBase auto-broadcasts"
      - "Add wrangler.toml migration: new_sqlite_classes for UserSettingsTinyBaseDO (or rename existing)"
      - "Migrate existing UserSettingsDO data (tabs, drafts) into TinyBase format on first load"
      - "Unit test: poke with sessionId → TinyBase store updated → connected client receives sync message"
    test_cases:
      - id: "tinybase-do-persister"
        description: "UserSettingsTinyBaseDO createPersister returns DurableObjectSqlStoragePersister; data survives DO restart"
        type: "unit"
      - id: "tinybase-do-poke"
        description: "POST /notify with {sessionId, status:'running'} → TinyBase sessions table updated → WS broadcast sent"
        type: "integration"
      - id: "tinybase-do-migration"
        description: "Existing tabs/drafts from old UserSettingsDO format are readable after migration to TinyBase format"
        type: "integration"
  - id: p3
    name: "Browser — TinyBase MergeableStore + LocalPersister + WsSynchronizer"
    tasks:
      - "Create apps/orchestrator/src/stores/workspace-store.ts: createMergeableStore() with tables schema matching DO (tabs, sessions, drafts)"
      - "Wire createLocalPersister for instant cold-start hydration from localStorage"
      - "Wire createWsSynchronizer connecting to UserSettingsTinyBaseDO WS endpoint"
      - "Create React hooks: useWorkspaceTabs(), useSessionMeta(sessionId), useWorkspaceDraft(tabId)"
      - "Implement activateSession(sessionId) — setRow('tabs', newId, {sessionId}) + setValue('activeTabId', newId)"
      - "Implement URL-as-hint: module-init reads ?session=X → activateSession; store subscription → history.replaceState"
      - "SSR guard (typeof window) + HMR guard (globalThis sentinel)"
      - "Unit test: store hydrates from localStorage synchronously; activateSession creates tab; URL subscription fires"
    test_cases:
      - id: "browser-sync-hydrate"
        description: "MergeableStore populated from localStorage before first React render"
        type: "unit"
      - id: "browser-ws-sync"
        description: "WsSynchronizer connects to UserSettingsTinyBaseDO; tab added on client appears on DO; session poke on DO appears on client"
        type: "integration"
      - id: "browser-url-hint"
        description: "Page load with ?session=X activates session synchronously; URL updates on tab switch via replaceState"
        type: "unit"
  - id: p4
    name: "Wire consumers — AgentOrchPage, TabBar, NavSessions, keyboard shortcuts"
    tasks:
      - "Rewrite AgentOrchPage.tsx: delete all URL/tab/session sync effects; selectedSessionId from TinyBase selector; handleSpawn/handleSelectSession call store actions"
      - "Rewrite TabBar: read tabs from useWorkspaceTabs(); project/status badges from useSessionMeta(tab.sessionId)"
      - "Rewrite NavSessions: session list from D1 API route (GET /api/d1/sessions) instead of sessions collection"
      - "Keyboard shortcuts (Cmd+T/W/1-9): read/write via store.getTable/setRow/delRow (synchronous)"
      - "Wire useCodingAgent onStateUpdate to poke UserSettingsTinyBaseDO (or update TinyBase store directly)"
      - "Delete old files: tabs-collection.ts, sessions-collection.ts, use-user-settings.tsx (old), stores/tabs.ts"
      - "Delete ProjectRegistry DO class and its migrations (after D1 migration confirmed)"
      - "Update wrangler.toml: remove SESSION_REGISTRY binding"
      - "Grep-audit: zero references to tabsCollection, sessionsCollection, lookupSessionInCache, seedFromCache, getUserSettings (old), ProjectRegistry"
    test_cases:
      - id: "agent-orch-no-effects"
        description: "AgentOrchPage has zero useEffect calls for URL/tab/session sync"
        type: "unit"
      - id: "tab-bar-tinybase"
        description: "TabBar reads from TinyBase hooks; no TanStack DB imports remain"
        type: "unit"
      - id: "grep-cleanup"
        description: "Zero references to deleted symbols across apps/orchestrator/src"
        type: "unit"
  - id: p5
    name: "Verification — vitest + chrome-devtools-axi smoke"
    tasks:
      - "Vitest: 6 race scenarios (push-tap cold-load, archived deep-link, rapid tab switch, close-last, quick-prompt hint race, PWA wake)"
      - "Vitest: TinyBase sync round-trip (client write → DO persist → new client sync → same data)"
      - "Chrome-devtools-axi smoke: login → spawn session → verify tab badge → Cmd+T/W → drag-reorder → reload → confirm persistence"
      - "Chrome-devtools-axi smoke: deep-link /?session=X → first-paint has correct badge (never 'unknown')"
      - "Run pnpm typecheck + pnpm test + pnpm build — zero failures"
    test_cases:
      - id: "vp-push-tap"
        description: "Push notification deep-link with cached metadata: first paint shows correct project badge"
        type: "smoke"
      - id: "vp-cache-miss"
        description: "Clear localStorage, deep-link: skeleton shown first, badge resolves within 1500ms"
        type: "smoke"
      - id: "vp-tinybase-roundtrip"
        description: "Add tab on device A → appears on device B (via DO sync) within 2s"
        type: "integration"
      - id: "vp-band-aids-gone"
        description: "grep for lookupSessionInCache, seedFromCache, updateTabProject, didRestoreRef returns zero matches"
        type: "unit"
---

# Unified D1 Storage + TinyBase Real-Time Sync (Issue #6)

> GitHub Issue: [#6](https://github.com/baseplane-ai/duraclaw/issues/6)
> Supersedes: [#5](https://github.com/baseplane-ai/duraclaw/issues/5) (tab state race conditions)
> Research: [`planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md`](../research/2026-04-17-issue-5-session-tab-state-root-cause.md)

## Overview

Unify the fragmented storage architecture (SessionDO SQLite + ProjectRegistry DO SQLite + UserSettingsDO SQLite + TanStack DB collections + localStorage band-aids) into two clear layers:

1. **D1** — all session metadata (project, status, summary, archived, messages). Queryable from any Worker route. Written by SessionDO (`env.DB`) and Worker API routes.
2. **UserSettingsDO as TinyBase `WsServerDurableObject`** — UI state (tabs, drafts) persisted to DO SQLite; session metadata cached from D1. Real-time CRDT sync to all browser tabs via `WsSynchronizer`.

This eliminates the root cause of issue #5's race conditions (no synchronous metadata source at first render) while also eliminating ProjectRegistry DO, TanStack DB collections, and all localStorage band-aids.

## Feature Behaviors

### B1: D1 as authoritative session metadata store

**Core:**
- **ID:** `d1-session-store`
- **Trigger:** Session creation, status change, result, archive.
- **Expected:** All session metadata lives in D1 `agent_sessions` table. SessionDO writes status/summary/result directly via `env.DB.prepare().run()` on every state change. Worker API routes handle creation and archival. No DO-to-DO sync needed for session data — any Worker request can query D1 directly.
- **Verify:** Create session via POST → row exists in D1; SessionDO status change → D1 row updated within same request; GET /api/d1/sessions returns fresh list.
- **Source:** New D1 table via Drizzle schema at `apps/orchestrator/src/db/schema.ts`; SessionDO writes at `apps/orchestrator/src/agents/session-do.ts`.

#### UI Layer
N/A — backend only.

#### API Layer
New Worker routes (coexist with existing `/api/sessions` during migration, then replace):

- `GET /api/d1/sessions?userId=X&limit=100&offset=0&archived=false` → `200 { sessions: AgentSession[], total: number }`. Pagination via `limit`/`offset` (default 100/0). `archived` filter defaults to `false`. Ordered by `updated_at DESC`.
- `GET /api/d1/sessions/:id` → `200 { session: AgentSession }` | `404 { error: "Session not found" }`
- `POST /api/d1/sessions` — body: `{ project: string (required), prompt?: string, model?: string, agent?: string, userId: string (required) }` → `201 { session: AgentSession }` | `400 { error: string }` on missing required fields.
- `PATCH /api/d1/sessions/:id` — body: partial `AgentSession` (any subset of mutable fields: `status`, `summary`, `title`, `archived`, `num_turns`, `total_cost_usd`, `duration_ms`, `sdk_session_id`, `kata_*`). → `200 { session: AgentSession }` | `404 { error }`. **Important:** PATCH routes that change `status` or `summary` MUST also poke UserSettingsDO. To get the `userId` for the poke, the route first reads the D1 row (`SELECT user_id FROM agent_sessions WHERE id = ?`), then calls `env.USER_SETTINGS.get(env.USER_SETTINGS.idFromName(userId)).fetch('/notify', ...)`. If the session doesn't exist (404), no poke is needed.

All endpoints return `Content-Type: application/json`. Error responses: `{ error: string }`. Internal errors: `500 { error }`.

**Authentication:** All D1 session routes use the existing Better Auth middleware (same as current `/api/sessions`). `userId` is **extracted from the authenticated session cookie** — never trusted from query params or request body. The `?userId=X` param in GET is removed; the route reads `userId` from `auth.api.getSession(request)`. POST body does NOT include `userId` — it's injected server-side. This matches the existing auth pattern in `apps/orchestrator/src/server.ts`.

#### Data Layer
D1 table `agent_sessions` (named to avoid collision with auth `sessions` table):
```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  model TEXT,
  prompt TEXT,
  summary TEXT,
  title TEXT,
  archived INTEGER DEFAULT 0,
  num_turns INTEGER DEFAULT 0,
  total_cost_usd REAL,
  duration_ms INTEGER,
  sdk_session_id TEXT,
  agent TEXT,
  origin TEXT,              -- set by migration from ProjectRegistry; new sessions default NULL
  kata_mode TEXT,
  kata_issue TEXT,
  kata_phase TEXT,
  message_count INTEGER DEFAULT 0,
  last_activity TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_sessions_user ON agent_sessions(user_id, archived);
CREATE UNIQUE INDEX idx_agent_sessions_sdk ON agent_sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL;
```

---

### B2: SessionDO writes to D1 on state changes

**Core:**
- **ID:** `session-do-d1-write`
- **Trigger:** SessionDO processes a runner event that changes status, summary, cost, or turns.
- **Expected:** SessionDO calls `env.DB.prepare("UPDATE agent_sessions SET status=?, summary=?, updated_at=datetime('now') WHERE id=?").run(...)` directly. **D1 write failure strategy:** wrap in try/catch; on failure, log `[SessionDO] D1 write failed for ${sessionId}: ${err}` and continue — the session proceeds regardless. The DO's in-memory state is the real-time truth; D1 is the persistent record. A transient D1 failure means the persistent record is stale until the next successful write (status change, result, or keepalive). No retry loop in the hot path; the next state-change write will naturally update the row.
  
  Then pokes UserSettingsDO via `env.USER_SETTINGS.get(env.USER_SETTINGS.idFromName(this.state.userId)).fetch('/notify', {body: JSON.stringify({sessionId})})`. The `userId` is read from SessionDO's own state (`this.state.userId`, set at spawn time). The poke is **fire-and-forget** (`catch(() => console.error(...))`): if it fails, D1 has the correct data and browsers will see it on next reconnect.
- **Verify:** Integration test: spawn session → verify D1 row status='running'; complete → status='idle' + summary set; poke received by UserSettingsDO.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` — add `env.DB` writes to `onGatewayEvent` handler and `onResult` handler.

#### UI Layer
N/A — SessionDO is backend. Browser receives updates via TinyBase sync from UserSettingsDO.

#### API Layer
Internal DO-to-DO fetch:
- `POST /notify` on UserSettingsDO — body: `{ sessionId: string }` — triggers D1 read + TinyBase store update.

#### Data Layer
SessionDO no longer persists session metadata to DO SQLite. Keeps only: `kv` table (gateway_conn_id, kata_state), and Session class tables (messages, assistant_config) for the active conversation. Message history stays on SessionDO for now (out of scope to migrate to D1).

---

### B3: UserSettingsDO as TinyBase WsServerDurableObject

**Core:**
- **ID:** `user-settings-tinybase`
- **Trigger:** Browser connects via WebSocket; UserSettingsDO lifecycle.
- **Expected:** UserSettingsDO extends `WsServerDurableObject` (replaces `Agent` base class). Overrides `createPersister()` → `createDurableObjectSqlStoragePersister(store, this.ctx.storage.sql, {mode: 'fragmented'})`. The internal MergeableStore holds three TinyBase tables:
  - `tabs` — rows: `{sessionId: string, position: number}` keyed by tabId
  - `drafts` — rows: `{text: string, updatedAt: number}` keyed by tabId
  - `sessions` — rows: `{project, title, status, summary, archived, ...}` keyed by sessionId (cache of D1, populated on connect + poke)
  
  `activeTabId` is **NOT** stored in TinyBase — it lives in a separate `localStorage` key (`duraclaw-active-tab`) outside TinyBase, so each browser has its own active tab without cross-device interference.
  
  On client connect (override `onClientId(pathId, clientId, 1)`): read all user's non-archived sessions from D1 (`env.DB`) and populate the `sessions` table via `setTable('sessions', {...})` — this **replaces** the entire table, cleaning up any stale/deleted rows from previous cache. The connecting browser gets full metadata on first sync. On `/notify` poke: read the specific D1 row and `setRow('sessions', sessionId, ...)` — TinyBase auto-broadcasts to all connected browsers. If the D1 row is missing (session deleted), `delRow('sessions', sessionId)` removes it from the cache.
  
  DO SQLite (via TinyBase persister) is the source of truth for `tabs` and `drafts`. `sessions` table is a D1 cache that's refreshed on connect and on poke.
- **Verify:** Connect browser → receives tabs + sessions immediately; poke with sessionId → browser receives updated session within 100ms; restart DO → tabs/drafts survive (DO SQLite); sessions re-populated from D1 on next connect.
- **Source:** New file `apps/orchestrator/src/agents/user-settings-tinybase-do.ts`; replaces `apps/orchestrator/src/agents/user-settings-do.ts`.

#### UI Layer
N/A — DO is backend. Browser interacts via TinyBase sync protocol.

#### API Layer
WebSocket endpoint (same path `api/user-settings/ws` but **different protocol** — TinyBase sync messages, not Agents SDK state broadcasts).
HTTP endpoint: `POST /notify` — internal, called by SessionDO.
`getWsServerDurableObjectFetch` wires the WS upgrade routing in the Worker.

Binding name: **`USER_SETTINGS`** (same as existing wrangler.toml binding). The class name changes from `UserSettingsDO` to `UserSettingsTinyBaseDO` (or keep the name and replace the implementation — simpler). Add a `renamed_class` migration in wrangler.toml if the class name changes, or simply update the `class_name` field in the binding if reusing the name.

Existing HTTP endpoints (`GET /tabs`, `POST /tabs`, etc.) are **removed** — TinyBase sync replaces them. Tabs are mutated by the browser's `MergeableStore`, synced via `WsSynchronizer`.

#### Data Layer
DO SQLite tables managed by TinyBase (fragmented mode creates its own internal tables — `tinybase_tables`, `tinybase_values`). No manual SQL schema.

Old UserSettingsDO SQL tables (`tabs`, `tab_state`, `drafts`) are migrated on first load of the new DO, then dropped.

---

### B4: Browser — MergeableStore + LocalPersister + WsSynchronizer

**Core:**
- **ID:** `browser-tinybase-store`
- **Trigger:** App module load (before React renders).
- **Expected:** Browser creates a TinyBase `MergeableStore` and wires:
  1. `createLocalPersister(store, 'duraclaw-workspace')` — hydration from localStorage. **Important:** `load()` is async (JSON.parse is sync, but the persister API is promise-based). To block first render: call `await localPersister.load()` at module top level inside an async IIFE, and gate React rendering behind a `<StoreProvider loaded>` wrapper that renders children only after the load promise resolves. Since `load()` from localStorage completes in <1ms, there is no visible flash — but the gate prevents the empty-store race.
  2. `createWsSynchronizer(store, wsUrl)` — connects to UserSettingsDO. CRDT sync merges local and server state automatically. Reconnects on disconnect.
  
  React hooks read from the store:
  - `useWorkspaceTabs()` → `useTable('tabs')` ordered by tab order value
  - `useSessionMeta(sessionId)` → `useRow('sessions', sessionId)`
  - `useWorkspaceDraft(tabId)` → `useRow('drafts', tabId)`
  
  `activateSession(sessionId)`: generate `newId` via `crypto.randomUUID().slice(0,8)` (same pattern as current codebase), compute `nextPosition` as `Math.max(...Object.values(store.getTable('tabs')).map(t => t.position ?? 0)) + 1`, then `setRow('tabs', newId, {sessionId, position: nextPosition})` + `localStorage.setItem('duraclaw-active-tab', newId)` + notify active-tab listeners via `useSyncExternalStore` pattern. Synchronous. No effects. If a tab for this sessionId already exists, just set it active (no new row).
  
  URL is a hint consumed once at module init; store subscription pushes URL changes via `history.replaceState`.
- **Verify:** Cold start from localStorage: tabs render on first frame. WS connects → D1 session metadata merges in. Tab added → synced to DO → synced to other browser tab.
- **Source:** New `apps/orchestrator/src/stores/workspace-store.ts`.

#### UI Layer
React hooks from `tinybase/ui-react`:
- `useTable`, `useRow`, `useCell`, `useValue` — granular reactivity.
- `useHasRow('sessions', sessionId)` — skeleton vs. real badge.
- No `useLiveQuery`, no `useSyncExternalStore` wrappers.

#### API Layer
WebSocket to `wss://<host>/api/user-settings/ws/<userId>` — TinyBase sync protocol.
No HTTP API calls for tab mutations (all via WS sync).
NavSessions still calls `GET /api/d1/sessions` for the full session list (may include sessions not in the TinyBase `sessions` cache).

#### Data Layer
localStorage key `duraclaw-workspace` — TinyBase `LocalPersister` manages serialization (MergeableStore format with HLC metadata).
Legacy localStorage keys (`agent-tabs`, `duraclaw-active-tab`, `duraclaw-tab-order`, `duraclaw-sessions`, `draft:*`) are migrated on first load then deleted.

---

### B5: Tabs as bare refs, metadata from sessions table

**Core:**
- **ID:** `tab-bare-ref`
- **Trigger:** Tab render in TabBar or any UI that shows tab badges.
- **Expected:** A tab is a TinyBase row `{sessionId: string}` in the `tabs` table. Project badge, title, status dot all come from `useRow('sessions', tab.sessionId)`. If `sessions[sessionId]` is not yet populated (cache miss), UI shows "Session <first 8 chars>" skeleton — never "unknown". Once D1 data arrives via sync, badge resolves reactively.
- **Verify:** Render TabBar with a tab pointing to a session not in `sessions` table → skeleton shown. Add session row → badge appears reactively. No `updateTabProject` or `updateTabTitle` anywhere in codebase.
- **Source:** `apps/orchestrator/src/components/tab-bar.tsx`.

#### UI Layer
TabBar: `const meta = useRow('sessions', tab.sessionId)`. Project badge = `meta.project ?? undefined`. If falsy, show skeleton. StatusDot = `meta.status`.

#### API Layer
N/A.

#### Data Layer
Tab rows contain only `sessionId`. No `project`, `title`, `status` fields on the tab.

---

### B6: ProjectRegistry elimination

**Core:**
- **ID:** `eliminate-project-registry`
- **Trigger:** Completion of D1 migration (P1) + consumer rewiring (P4).
- **Expected:** ProjectRegistry DO class is deleted. All its responsibilities move to:
  - Session CRUD → D1 `agent_sessions` table + Worker API routes
  - Session discovery sync from gateway → Worker route that writes D1 directly
  - User preferences → separate D1 table or UserSettingsDO TinyBase values
  - `SESSION_REGISTRY` binding removed from wrangler.toml
- **Verify:** Zero imports of `ProjectRegistry` in codebase. `SESSION_REGISTRY` binding absent from wrangler.toml. All session list UI reads from D1 API route.
- **Source:** Delete `apps/orchestrator/src/agents/project-registry.ts` and `apps/orchestrator/src/agents/project-registry-migrations.ts`.

#### UI Layer
NavSessions sidebar fetches from `GET /api/d1/sessions` instead of going through ProjectRegistry.

#### API Layer
Existing `/api/sessions` route rewired to query D1 directly (no DO stub.fetch to ProjectRegistry).
Gateway discovery route (`/api/gateway/discovery-sync`) writes to D1 directly.

#### Data Layer
ProjectRegistry DO SQLite data migrated to D1 in P1. After migration confirmed, DO class deleted and wrangler.toml binding removed.

---

### B7: Feature preservation (F1–F16)

**Core:**
- **ID:** `feature-parity`
- **Trigger:** All existing user-facing workflows.
- **Expected:** Every feature from issue #5 research doc §3 preserved:

  | # | Feature | Mechanism |
  |---|---|---|
  | F1 | Tabs persist cross-device | TinyBase sync via UserSettingsDO → DO SQLite |
  | F2 | Active tab restore on cold launch | `localStorage.getItem('duraclaw-active-tab')` read via `useSyncExternalStore` on mount |
  | F3 | Push deep-link first frame | Module-init URL → `activateSession` → LocalPersister has cached sessions |
  | F4 | Archived session deep-link | `sessions` table includes archived rows (loaded on connect from D1) |
  | F5 | Quick-prompt hints | URL params consumed at init, stored in React state (not TinyBase) |
  | F6 | Cmd+T/W/1-9 | `store.setRow`/`store.delRow`/`store.getTable` — synchronous |
  | F7 | Drag-reorder tabs | Tab order stored as TinyBase cell on each tab row (position integer) |
  | F8 | Per-tab draft | `drafts` TinyBase table, debounced writes (500ms) |
  | F9 | Switch session in tab | `store.setCell('tabs', tabId, 'sessionId', newId)` |
  | F10 | Sidebar click | `activateSession(id)` |
  | F11 | StatusDot | `useCell('sessions', id, 'status')` — reactive |
  | F12 | Title from summary | `sessions` row updated via DO poke → auto-broadcast |
  | F13 | Project badge | Rendered from `sessions` row, not tab row |
  | F14 | Close-last-tab → composer | `delRow` sets `activeTabId=null` → URL clears |
  | F15 | Swipe tabs | `activateSession` on swipe handler |
  | F16 | Multi-browser-tab | TinyBase WsSynchronizer fans out to all connected clients |

- **Verify:** Chrome-devtools-axi smoke covers F1–F16.
- **Source:** see Verification Plan.

#### UI Layer
All existing components work with TinyBase hooks replacing `useUserSettings` + `useSessionsCollection`.

#### API Layer
No breaking external API changes.

#### Data Layer
N/A.

---

## Non-Goals

- **Messages to D1** — SessionDO message history stays in DO SQLite for now. Migrating messages is a separate effort (volume, latency, cost concerns).
- **User preferences to D1** — `user_preferences` from ProjectRegistry can stay as TinyBase values on UserSettingsDO or move to D1 later. Not blocking.
- **BroadcastChannel** — TinyBase WsSynchronizer handles cross-tab via the DO; no additional BroadcastChannel needed.
- **Yjs/CRDT for collaborative editing** — Issue #3 is separate; TinyBase's CRDT is for state sync, not document collaboration.
- **D1 for auth changes** — Auth stays on existing D1 `duraclaw-auth` database via Better Auth.

## Open Questions

- [x] Where does session metadata live? — **D1** `agent_sessions` table.
- [x] What base class for UserSettingsDO? — **`WsServerDurableObject`** from TinyBase.
- [x] How does SessionDO notify browsers? — **Internal DO-to-DO fetch** to UserSettingsDO `/notify`.
- [x] D1 role vs DO SQLite? — **Split**: D1 for session metadata, DO SQLite (via TinyBase) for UI state (tabs, drafts).
- [x] Tabs shape? — **`{sessionId}`** bare ref.
- [x] Active tab sync? — **Per-browser** (separate `localStorage` key outside TinyBase, NOT a TinyBase value — avoids cross-device active-tab interference).

## Implementation Phases

See YAML frontmatter `phases:` above. P1 → P2 → P3 → P4 → P5 strictly sequential. P1–P2 are ~4 hours each; P3–P4 are ~3 hours each; P5 is ~2 hours.

## Verification Strategy

### Test Infrastructure
- **Vitest** — `apps/orchestrator/vitest.config.ts` (jsdom). New test files for TinyBase store, DO poke handler, D1 routes.
- **chrome-devtools-axi** — smoke scripts.
- **D1 testing** — `wrangler d1 execute` for migration verification; miniflare for local D1 in vitest.

### Build Verification
`pnpm typecheck && pnpm test && pnpm build` at repo root. TanStack Start route types generated at build time.

### Timing-based assertions
Smoke tests with wall-clock thresholds (200ms, 1500ms, 2s) are **local-only** — not run in CI. Vitest unit/integration tests use mocked timers and deterministic assertions. The smoke scripts use `chrome-devtools-axi` poll-snapshot with a generous timeout (3x the target) and log actual elapsed time for diagnosis.

### Cache staleness policy
The TinyBase `sessions` table on UserSettingsDO is a cache of D1, refreshed on:
1. Browser connects (full D1 read for user's sessions)
2. SessionDO pokes `/notify` (single-row refresh)
3. Worker PATCH routes that modify status/summary MUST also poke UserSettingsDO (same as SessionDO does)

If a D1 write happens without a poke (e.g., background job, direct SQL), the cache is stale until the next browser connect. This is acceptable — background jobs should call the poke endpoint. The spec does NOT add polling or TTL-based invalidation.

## Verification Plan

### VP1: Push-notification deep-link (cache hit)
Steps:
1. Login, spawn a session in project `demo`.
2. `chrome-devtools-axi open "http://localhost:43173/?session=<sessionId>"` (simulates push tap).
3. `chrome-devtools-axi snapshot` within 200ms.
   Expected: `demo` badge visible on tab; no "unknown" in accessibility tree.

### VP2: Push-notification deep-link (cache miss)
Steps:
1. `chrome-devtools-axi eval "localStorage.clear(); location.reload()"`.
2. `chrome-devtools-axi open "http://localhost:43173/?session=<sessionId>"`.
3. `chrome-devtools-axi snapshot` immediately.
   Expected: skeleton ("Session <8 chars>"), never "unknown".
4. Poll-snapshot until badge resolves or 1500ms elapses.
   Expected: `demo` badge resolves within 1500ms.

### VP3: TinyBase round-trip sync
Steps:
1. Add tab in browser tab A.
2. Open browser tab B to same URL.
3. `chrome-devtools-axi snapshot` on tab B.
   Expected: new tab visible within 2s (synced via UserSettingsDO TinyBase).

### VP4: SessionDO → D1 → browser update
Steps:
1. Spawn session. Verify status='running' in TabBar StatusDot.
2. Wait for session to complete.
3. `chrome-devtools-axi snapshot`.
   Expected: StatusDot shows idle; summary visible as tab title.
4. `wrangler d1 execute duraclaw-auth --command "SELECT status FROM agent_sessions WHERE id='<id>'"`.
   Expected: status='idle'.

### VP5: Keyboard shortcuts
Steps:
1. Cmd+T → new tab. Cmd+W → close. Cmd+1 → activate first.
2. Each takes effect on first keypress (synchronous store access).

### VP6: Band-aid grep
```bash
git grep -nE 'lookupSessionInCache|seedFromCache|updateTabProject|didRestoreRef|ProjectRegistry' apps/orchestrator/src
```
Expected: zero matches.

### VP7: D1 session list
```bash
curl http://localhost:43173/api/d1/sessions?userId=<userId>
```
Expected: JSON array of all user's sessions with current status.

## Implementation Hints

### Dependencies
```bash
pnpm --filter @duraclaw/orchestrator add tinybase
```

### Key Imports
| Module | Import | Used For |
|---|---|---|
| `tinybase` | `{ createMergeableStore }` | Browser-side store |
| `tinybase/synchronizers/synchronizer-ws-client` | `{ createWsSynchronizer }` | Browser → DO sync |
| `tinybase/persisters/persister-browser` | `{ createLocalPersister }` | localStorage hydration |
| `tinybase/synchronizers/synchronizer-ws-server-durable-object` | `{ WsServerDurableObject, getWsServerDurableObjectFetch }` | DO-side sync server |
| `tinybase/persisters/persister-durable-object-sql-storage` | `{ createDurableObjectSqlStoragePersister }` | DO SQLite persistence |
| `tinybase/ui-react` | `{ useTable, useRow, useCell, useValue }` | React hooks |

### Code Patterns

**UserSettingsDO (DO side):**
```ts
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object'
import { createMergeableStore } from 'tinybase'
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage'

export class UserSettingsTinyBaseDO extends WsServerDurableObject {
  createPersister() {
    const store = createMergeableStore()
    return createDurableObjectSqlStoragePersister(
      store, this.ctx.storage.sql, { mode: 'fragmented' }
    )
  }

  // Per-client connect: refresh sessions cache from D1
  // WsServerDurableObject exposes onClientId(pathId, clientId, addedOrRemoved)
  // addedOrRemoved = 1 on connect, -1 on disconnect
  onClientId(pathId: string, clientId: string, addedOrRemoved: number) {
    if (addedOrRemoved === 1) {
      // Full D1 read on connect — replaces entire sessions table (cleans stale rows)
      this.env.DB
        .prepare('SELECT * FROM agent_sessions WHERE user_id = ?')
        .bind(this.getPathId())  // pathId = userId (DO addressed via idFromName(userId))
        .all()
        .then(({ results }) => {
          const store = this.getPersister()?.getStore()
          if (store && results) {
            const sessionsObj: Record<string, Record<string, any>> = {}
            for (const row of results) sessionsObj[row.id as string] = row as any
            store.setTable('sessions', sessionsObj)
          }
        })
        .catch(err => console.error('[UserSettings] D1 load failed:', err))
    }
  }

  // Called by SessionDO on status change
  async fetch(request: Request) {
    if (new URL(request.url).pathname === '/notify') {
      const { sessionId } = await request.json() as { sessionId: string }
      const row = await this.env.DB
        .prepare('SELECT * FROM agent_sessions WHERE id = ?')
        .bind(sessionId).first()
      const store = this.getPersister()?.getStore()
      if (store) {
        if (row) {
          store.setRow('sessions', sessionId, row as any)
        } else {
          store.delRow('sessions', sessionId)  // session deleted from D1
        }
      }
      return new Response('ok')
    }
    return super.fetch(request)  // WsServerDurableObject handles WS upgrades
  }

  // Migration: on first load, check for old UserSettingsDO SQL tables
  // and convert to TinyBase format
  async onStart() {
    const store = this.getPersister()?.getStore()
    if (!store) return
    try {
      const oldTabs = this.ctx.storage.sql
        .exec('SELECT id, session_id, position FROM tabs ORDER BY position')
        .toArray() as any[]
      if (oldTabs.length > 0 && !store.hasTable('tabs')) {
        for (const t of oldTabs) {
          store.setRow('tabs', t.id, { sessionId: t.session_id, position: t.position })
        }
        // Read old drafts
        const oldDrafts = this.ctx.storage.sql
          .exec('SELECT tab_id, text FROM drafts WHERE text != ""')
          .toArray() as any[]
        for (const d of oldDrafts) {
          store.setRow('drafts', d.tab_id, { text: d.text, updatedAt: Date.now() })
        }
        // Mark migration done — old tables are dropped on NEXT load
        // (after TinyBase persister has confirmed flush to DO SQLite)
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO kv (key, value) VALUES ('tb_migrated', '1')"
        )
      }
    } catch {
      // Old tables don't exist — fresh DO, nothing to migrate
    }
    // On second+ load: if migration was done AND TinyBase has data, drop old tables
    try {
      const migrated = this.ctx.storage.sql
        .exec("SELECT value FROM kv WHERE key = 'tb_migrated'")
        .toArray()
      if (migrated.length > 0 && store.hasTable('tabs')) {
        this.ctx.storage.sql.exec('DROP TABLE IF EXISTS tabs')
        this.ctx.storage.sql.exec('DROP TABLE IF EXISTS tab_state')
        this.ctx.storage.sql.exec('DROP TABLE IF EXISTS drafts')
      }
    } catch { /* kv table may not exist on fresh DOs */ }
  }
}
```

**Browser (client side):**
```ts
import { createMergeableStore } from 'tinybase'
import { createLocalPersister } from 'tinybase/persisters/persister-browser'
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client'

export const store = createMergeableStore()

// Hydration from localStorage (<1ms, gates React render)
const localPersister = createLocalPersister(store, 'duraclaw-workspace')
// Top-level await (Vite ESM supports this) — React tree renders only after
export const storeReady = localPersister.load().then(() => {
  localPersister.startAutoSave()  // persist future changes back to localStorage
})

// Real-time sync to UserSettingsDO (started after React mounts, inside a useEffect)
export async function startSync(wsUrl: string) {
  const synchronizer = createWsSynchronizer(store, new WebSocket(wsUrl))
  await synchronizer.startSync()
  return synchronizer
}

// URL hint (one-shot)
if (typeof window !== 'undefined' && !globalThis.__duraclaw_url_consumed) {
  globalThis.__duraclaw_url_consumed = true
  const sessionId = new URL(location.href).searchParams.get('session')
  if (sessionId) activateSession(sessionId)
}
```

**React hooks:**
```tsx
import { useRow, useTable, useValue } from 'tinybase/ui-react'

function TabBar() {
  const tabs = useTable('tabs', store)  // reactive, re-renders on change
  const activeTabId = useActiveTabId()   // useSyncExternalStore reading localStorage
  
  return Object.entries(tabs).map(([tabId, tab]) => (
    <Tab key={tabId} active={tabId === activeTabId}>
      <SessionBadge sessionId={tab.sessionId} />
    </Tab>
  ))
}

function SessionBadge({ sessionId }: { sessionId: string }) {
  const meta = useRow('sessions', sessionId, store)
  if (!meta.project) return <Skeleton />
  return <Badge project={meta.project} status={meta.status} />
}
```

### Gotchas

- `WsServerDurableObject` extends `DurableObject`, not `Agent`. The Agents SDK `useAgent` hook is incompatible — must replace with TinyBase's `createWsSynchronizer` on the client.
- TinyBase `createLocalPersister.load()` is async but fast (<1ms from localStorage). Gate the React tree behind a `<StoreProvider>` that renders children only after `load()` resolves. Since `load()` from localStorage completes before the first paint, there is no visible flash. Do NOT use `startAutoLoad` alone — it applies on the next microtask, which may be after first render.
- `WsServerDurableObject` uses Cloudflare's hibernatable WebSocket API (`ctx.acceptWebSocket`). This requires `new_sqlite_classes` in wrangler.toml migrations — already done for the existing UserSettingsDO.
- TinyBase's fragmented mode creates internal tables (`tinybase_tables`, `tinybase_values`). Don't create conflicting table names in the same DO SQLite.
- The `env.DB` binding is available inside DurableObjects — same as in Workers. No special wiring needed for SessionDO to write to D1.
- Draft debounce: TinyBase syncs on every `setCell`. Use `store.startTransaction()` / `store.finishTransaction()` or a client-side debounce wrapper that only calls `setRow('drafts', ...)` after 500ms of inactivity, to avoid DO write amplification.
- `activeTabId` is stored in `localStorage` only — NOT as a TinyBase value. This is intentional: each device/browser has its own active tab. The app uses a `useSyncExternalStore` pattern (same as current codebase) for reactivity. TinyBase syncs tabs and drafts cross-device; active selection is per-browser.

### Reference Docs
- [TinyBase WsServerDurableObject source](https://github.com/tinyplex/tinybase) — lines 750-856 of `synchronizer-ws-server-durable-object/index.js`
- [TinyBase DO SQL Persister docs](https://tinybase.org/api/persisters/persister-durable-object-sql-storage/) — fragmented vs JSON mode
- [TinyBase ui-react hooks](https://tinybase.org/api/ui-react/) — `useTable`, `useRow`, `useCell`, `useValue`
- [Cloudflare D1 docs](https://developers.cloudflare.com/d1/) — SQL API, bindings, transactions
- Research doc: `planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md` — feature table F1–F16, race scenarios, band-aid analysis

---
