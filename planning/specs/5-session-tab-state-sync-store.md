---
initiative: session-tab-state-sync-store
type: project
issue_type: feature
status: draft
priority: high
github_issue: 5
created: 2026-04-17
updated: 2026-04-17
phases:
  - id: p1
    name: "UserSettingsDO — sessions slice + cross-device meta sync"
    tasks:
      - "Add `sessions` slice to UserSettingsDO state (Record<sessionId, SessionMeta>)"
      - "Add migration creating `session_meta` SQL table (id PK, project, title, summary, status, num_turns, error, archived, updated_at) — no per-row source column"
      - "Implement per-field source gate in patchSessionMeta: DO_ONLY={status,summary,num_turns,error} reject server writes; SERVER_ONLY={project,archived} reject DO writes; title LWW"
      - "Add RPC + HTTP endpoints: getSessions, patchSessionMeta(id, patch, source), pruneSessionMeta(keepIds)"
      - "Add 30-day prune: on DO onStart, delete session_meta rows where updated_at < now-30d AND id NOT IN (SELECT session_id FROM tabs)"
      - "Emit `sessions` in DO state broadcasts alongside existing `tabs`, `drafts` (note: activeTabId stays per-browser, not broadcast)"
      - "Unit test source gate: DO write to SERVER_ONLY field is rejected; server write to DO_ONLY field is rejected; interleaved writes do not clobber gated fields"
    test_cases:
      - id: "do-sessions-slice-persist"
        description: "patchSessionMeta writes through to session_meta SQL and survives DO restart"
        type: "unit"
      - id: "do-sessions-precedence"
        description: "'do' source status write overrides 'server' source status write regardless of updatedAt"
        type: "unit"
      - id: "do-sessions-broadcast"
        description: "onConnect sends full state including sessions; onStateUpdate delivers sessions diff"
        type: "integration"
  - id: p2a
    name: "Workspace store — slices, hydration, URL subscription"
    tasks:
      - "Create apps/orchestrator/src/stores/session-workspace.ts with tabs / activeTabId / tabOrder / drafts / sessions slices and selectActiveSessionId selector"
      - "Wire zustand persist middleware (localStorage, name='duraclaw-workspace', version 1, partialize includes all slices)"
      - "Write migrate() that reads legacy keys (agent-tabs, duraclaw-active-tab, duraclaw-tab-order, duraclaw-sessions, draft:*) into unified blob then deletes legacy keys"
      - "Implement activateSession(sessionId) — synchronous find-or-create tab, set active, no metadata requirement"
      - "Implement store→URL subscription via history.replaceState driven by selectActiveSessionId"
      - "Guard module-level window/localStorage access with typeof window !== 'undefined'; HMR-safe one-shot via globalThis.__duraclaw_url_consumed"
      - "Delete stores/tabs.ts (legacy unused)"
    test_cases:
      - id: "store-sync-hydrate"
        description: "Store state is populated before first React render; useWorkspace.getState() returns tabs synchronously after JSON.parse of 'duraclaw-workspace'"
        type: "unit"
      - id: "store-migration"
        description: "Legacy localStorage keys are read, merged, and deleted on first load; unified blob written"
        type: "unit"
      - id: "store-url-subscription"
        description: "Changing activeTabId causes selectActiveSessionId to change, which triggers history.replaceState with ?session=X; clearing the active tab removes the param"
        type: "unit"
      - id: "store-activate-session-no-meta"
        description: "On a hydrated store that has no sessions[X] entry, activateSession(X) creates {id, sessionId:X} tab and sets active synchronously; render falls back to 'Session <first 8>' skeleton"
        type: "unit"
      - id: "store-hmr-oneshot"
        description: "Re-importing the store module in the same test context does not re-run activateSession (globalThis sentinel honored)"
        type: "unit"
  - id: p2b
    name: "Workspace store — write-through + debounced drafts"
    tasks:
      - "Implement write-through to UserSettingsDO (addTab, removeTab, setActiveTab, reorderTabs, patchSessionMeta) — optimistic, fire-and-forget"
      - "Port the 500ms debounce for draft saves from use-user-settings.tsx:373-417 into store saveDraft action (per-tab timer Map, localStorage written synchronously, DO PATCH debounced)"
      - "On removeTab(id): clearTimeout any pending draft debounce for id, delete localStorage['draft:id'], delete drafts[id] from store, fire DELETE /api/user-settings/tabs/:id. No orphan PATCH should fire after removal."
      - "Implement mergeServerState: per-field gate for sessions slice; LWW for tabs/drafts/tabOrder; ignore server activeTabId (per-browser decision)"
    test_cases:
      - id: "store-do-writethrough"
        description: "addTab fires POST /api/user-settings/tabs; network failure does not revert optimistic state"
        type: "unit"
      - id: "draft-debounce-flush"
        description: "saveDraft writes localStorage immediately; DO PATCH fires 500ms after last keystroke; rapid typing coalesces to a single PATCH"
        type: "unit"
      - id: "draft-removetab-cancels-debounce"
        description: "saveDraft queued, then removeTab called before 500ms elapses → no DO PATCH for that tab fires, localStorage['draft:id'] is cleared, DELETE is sent"
        type: "unit"
      - id: "merge-server-gate"
        description: "mergeServerState rejects incoming DO_ONLY field value if the server broadcast is stale (source='server' on a DO-owned field)"
        type: "unit"
  - id: p3
    name: "Hook + DO sync — useWorkspace, useSessionMeta, remove effects"
    tasks:
      - "Rewrite apps/orchestrator/src/hooks/use-user-settings.tsx as a thin wrapper selecting from useWorkspace + useAgent for WS sync (no queryFn, no TanStack DB collection)"
      - "Add useSessionMeta(sessionId) selector hook returning {project, title, status, summary, archived} or undefined"
      - "Replace useSessionsCollection internals with direct fetch + store.hydrateSessionsFromServer; sidebar filtering stays client-side"
      - "Delete apps/orchestrator/src/db/sessions-collection.ts (seedFromCache, lookupSessionInCache) — move server-fetch logic into store"
      - "Delete apps/orchestrator/src/db/tabs-collection.ts and its TanStack DB dependencies"
      - "Wire useAgent onStateUpdate to call store.mergeServerState({tabs, activeTabId, drafts, sessions})"
      - "Wire SessionDO onStateUpdate (from use-coding-agent.ts) to call store.patchSessionMeta(sessionId, patch, 'do')"
    test_cases:
      - id: "hook-thin-wrapper"
        description: "useUserSettings returns same shape as today; existing call sites compile unchanged"
        type: "unit"
      - id: "useSessionMeta-reactivity"
        description: "Component using useSessionMeta re-renders when patchSessionMeta is called for that sessionId"
        type: "unit"
      - id: "do-ws-merge"
        description: "WS state broadcast merges into store without clobbering local optimistic writes (precedence)"
        type: "integration"
  - id: p4
    name: "AgentOrchPage — delete effect chain, use store"
    tasks:
      - "Delete Effects 2, 3, 4 from AgentOrchPage.tsx (lines 83-147, 388-413) and didRestoreRef/prevSearchRef refs"
      - "Replace useState init with module-level URL hint consumption: if URL has ?session=X, call activateSession(X) at module init"
      - "selectedSessionId becomes a store selector: useWorkspace(s => s.activeSessionId)"
      - "quickPromptHint consumed once from URL at init; URL params stripped via replaceState"
      - "Update handleSpawn / handleSelectSession / handleLastTabClosed to call store actions (no setState + navigate pairs)"
      - "Update nav-sessions.tsx and tab-bar.tsx to read useSessionMeta instead of sessions collection"
      - "Keyboard shortcuts (Cmd+T/W/1-9) use useWorkspace.getState() — same shape as today's getUserSettings()"
    test_cases:
      - id: "agent-orch-no-effects"
        description: "AgentOrchContent contains zero useEffect calls for URL/tab/session sync (only the projects fetch and keyboard listener remain)"
        type: "unit"
      - id: "tab-bar-meta-source"
        description: "TabBar reads project badge from useSessionMeta, not sessions collection; no sessions collection imports remain"
        type: "unit"
      - id: "cold-load-push-tap"
        description: "/?session=X with cached meta renders correct project badge on first paint (0 'unknown' visible in snapshot)"
        type: "smoke"
  - id: p5
    name: "Verification — vitest race scenarios + chrome-devtools-axi smoke"
    tasks:
      - "Write vitest suite covering 6 race scenarios from research §10 (push-tap cold-load, archived deep-link, rapid tab switch, close-last, quick-prompt-hint race, PWA wake)"
      - "Write chrome-devtools-axi smoke script: login → open /?session=<existing> → verify badge → Cmd+T → Cmd+W → drag-reorder → reload → confirm order"
      - "Grep-audit for removed symbols: lookupSessionInCache, seedFromCache, tabsCollection, updateTabProject — assert zero references"
      - "Run `pnpm typecheck` + `pnpm test` + build on main; zero failures"
    test_cases:
      - id: "vp-push-tap-cache-hit"
        description: "Push-notification tap with metadata in localStorage cache: first paint has correct project badge, never 'unknown'"
        type: "smoke"
      - id: "vp-push-tap-cache-miss"
        description: "Clear localStorage, deep-link to /?session=X: first paint shows 'Session abc123…' skeleton, never 'unknown'; badge target 500ms, hard-fail 1500ms"
        type: "smoke"
      - id: "vp-archived-deeplink"
        description: "Deep-link to an archived session opens tab with correct archived indicator and real project badge"
        type: "smoke"
      - id: "vp-grep-bandaids-gone"
        description: "No references to lookupSessionInCache, seedFromCache, updateTabProject, project='unknown', didRestoreRef, quickPromptHint guard"
        type: "unit"
---

# Session/Tab State Sync Store (Issue #5)

> GitHub Issue: [#5](https://github.com/baseplane-ai/duraclaw/issues/5)
> Research: [`planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md`](../research/2026-04-17-issue-5-session-tab-state-root-cause.md)

## Overview

Replace the URL → TanStack DB collections → effect chain that drives `AgentOrchPage` with a single synchronous zustand store, writing through to the existing `UserSettingsDO` for cross-device sync. Session metadata (project, title, summary, status, archived) moves into a new DO slice so tabs can be reduced to bare `{id, sessionId}` refs — eliminating the placeholder/backfill band-aids that cause race conditions on cold deep-link loads (push notifications, bookmarks, PWA wake).

**Root cause (per research doc §2):** tabs embed cached session metadata but there is no synchronous, authoritative source for that metadata at first render, so tab creation has to guess and backfill; the guess/backfill pair races every other async loader.

## Feature Behaviors

### B1: Synchronous workspace hydration on module load

**Core:**
- **ID:** `sync-hydrate-workspace`
- **Trigger:** Module import of `stores/session-workspace.ts` (runs before React renders)
- **Expected:** Store is populated from a single `duraclaw-workspace` localStorage key (via zustand `persist`) before any component reads it. Legacy keys (`agent-tabs`, `duraclaw-active-tab`, `duraclaw-tab-order`, `duraclaw-sessions`, `draft:*`) are migrated on first load then deleted.
- **Verify:** Unit test — `useWorkspace.getState()` returns non-default `tabs`/`activeTabId`/`sessions` immediately after `localStorage.setItem('duraclaw-workspace', …)` is set and the module is re-imported. Also: no references to legacy keys after migration.
- **Source:** new `apps/orchestrator/src/stores/session-workspace.ts`; migration replaces `apps/orchestrator/src/hooks/use-user-settings.tsx:108-146` and `apps/orchestrator/src/db/sessions-collection.ts:62-112`.

#### UI Layer
N/A — store is non-visual. Consumers read via `useWorkspace(selector)` and `useWorkspace.getState()`.

#### API Layer
N/A for hydration itself. The post-hydration `mergeServerState` receives DO WS broadcasts via `useAgent`.

#### Data Layer
Single localStorage key `duraclaw-workspace` holds: `{ tabs, activeTabId, tabOrder, drafts, sessions, _version: 1 }`. Migration is idempotent and runs once per browser.

---

### B2: Tab as bare reference (`{id, sessionId}`)

**Core:**
- **ID:** `tab-bare-ref`
- **Trigger:** Any tab-creation or tab-render path.
- **Expected:** Tab record shape is `{id, sessionId}` — no `project`, no `title`. Display badges and titles come from `useSessionMeta(sessionId)`. A tab with no matching `sessions[sessionId]` renders a neutral skeleton (`Session <first 8 chars>`) until meta arrives.
- **Verify:** Unit test — TabBar rendered with a `tabs: [{id:'x', sessionId:'s1'}]` and empty `sessions` map shows the skeleton; adding `sessions['s1'] = {project:'foo', title:'bar'}` causes a re-render with correct badge.
- **Source:** replaces `apps/orchestrator/src/db/tabs-collection.ts:17-24` (TabItem shape) and removes `updateTabProject` / `updateTabTitle` band-aids at `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:388-413`.

#### UI Layer
`TabBar` reads `useSessionMeta(tab.sessionId)` for each tab; `StatusDot` reads `.status` from the same selector; drag-reorder writes `tabOrder` through store.

#### API Layer
UserSettingsDO tabs table loses `project` and `title` columns (retained as nullable for one release during DO-side migration). RPC shape stays compatible — added fields are ignored.

#### Data Layer
DO SQL migration: `ALTER TABLE tabs DROP COLUMN project; ALTER TABLE tabs DROP COLUMN title;` run after two releases of reading-but-not-requiring them. In Phase 1 the columns persist; the store simply ignores them on read.

---

### B3: Session metadata slice on UserSettingsDO (cross-device)

**Core:**
- **ID:** `do-sessions-slice`
- **Trigger:** Any write to session metadata (from `/api/sessions` fetch, from `SessionDO` WS state, from a server-side session update event).
- **Expected:** UserSettingsDO stores `sessions: Record<sessionId, SessionMeta>`. Writes apply **per-field source-gating** (not per-record): `status`/`summary`/`num_turns`/`error` accept writes only when incoming `source === 'do'`; `project`/`archived` accept writes only when incoming `source === 'server'`; `title` is **last-write-wins** (either source may set it, never rejected). Newer `updatedAt` breaks ties within the same source. DO broadcasts the slice to all connected devices.
- **Verify:** Unit test — call `patchSessionMeta(id, {status:'running'}, 'do')` then `patchSessionMeta(id, {project:'foo'}, 'server')` then `patchSessionMeta(id, {status:'idle'}, 'server')`; expect `status='running'` (server write rejected on DO_WINS field) and `project='foo'` (server wins).
- **Source:** extends `apps/orchestrator/src/agents/user-settings-do.ts`; new migration in `apps/orchestrator/src/agents/user-settings-do-migrations.ts`.

#### UI Layer
N/A — slice is plumbing.

#### API Layer
New HTTP endpoints on UserSettingsDO. All return `Content-Type: application/json`.

- `GET /sessions` → `200 { sessions: SessionMeta[] }`. The wire format is a stable-ordered array (ordered by `updated_at DESC`). The client normalizes to `Record<sessionId, SessionMeta>` on receipt; array ordering is **not** semantic. Errors: `500` with `{error: string}`.

- `POST /sessions` — body: `{ patches: Array<{id: string, patch: Partial<SessionMeta>, source: 'do' | 'server'}> }` — batch upsert with per-field source gate.
  - `200 { applied: string[], rejected: Array<{id, field, reason}> }` — rejected fields (source-gate mismatches) are returned for client logging but are **not retryable** (retrying will re-reject deterministically). Client treats rejected fields as silently dropped.
  - `400 { error }` on malformed body.
  - `500 { error }` on persistence failure — client write-through is fire-and-forget so errors are logged, not surfaced to UI.

- `POST /sessions/prune` — body: `{ keepIds: string[] }` (may be empty to prune everything not referenced by a tab). `200 { pruned: number }`. Empty-list is valid.

WS state broadcast extended to include `sessions` (full record, as with `tabs`/`drafts`).

#### Data Layer
New SQL table `session_meta` — note: **no per-row `source` column** because source ownership is a per-field rule, not per-record. Each field's provenance is implicit in the DO's write-path (only `patchSessionMeta` with matching source can mutate gated fields):
```sql
CREATE TABLE session_meta (
  id         TEXT    PRIMARY KEY,
  project    TEXT,              -- NULLABLE: a DO-source insert creates the row; server fills project later
  title      TEXT,              -- last-write-wins
  summary    TEXT,              -- DO-only writes
  status     TEXT,              -- DO-only writes
  num_turns  INTEGER,            -- DO-only writes
  error      TEXT,                -- DO-only writes
  archived   INTEGER DEFAULT 0,  -- server-only writes
  updated_at INTEGER NOT NULL    -- ms epoch
);
CREATE INDEX session_meta_updated_at ON session_meta(updated_at);
```

`SessionMeta` TS type mirrors columns with `project?: string` (optional). The write gate is enforced in `patchSessionMeta(id, patch, source)` before the SQL upsert — rejected fields are silently dropped, logged at debug level. No in-memory `source` field is stored; last-write-wins for `title` is a plain column write with newer `updated_at`. Renderer treatment: `project === undefined || project === ''` both render as the "Session <first 8>" skeleton — never as an empty badge.

---

### B4: URL as init-hint, store-owned thereafter

**Core:**
- **ID:** `url-hint-only`
- **Trigger:** Page load / hard reload / push-notification tap with `?session=X` in URL.
- **Expected:** At module init (before React renders, client-side only), the URL is read **once**; if `?session=X` is present, `activateSession(X)` is called synchronously on the store (creating or activating the tab). The URL is **never** read again; instead, a store subscription (`activeSessionId`) pushes URL updates via `history.replaceState` (not TanStack Router `navigate`). No `useEffect` reconciles URL ↔ state. SSR-safe via `typeof window !== 'undefined'` guard; HMR-safe via a `globalThis.__duraclaw_url_consumed` sentinel that survives Vite hot-module re-evaluation so the URL is never re-activated on a save.
- **Verify:** (a) Grep — zero `useEffect` calls referencing `searchSessionId` remain in `AgentOrchPage.tsx`; (b) vitest — re-importing the store module in the same test does not re-run `activateSession`; (c) dev-mode smoke — edit the store file with Vite running; verify tab list is not duplicated on HMR.
- **Source:** replaces `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:42-147`.

#### UI Layer
`AgentOrchPage` reads `const selectedSessionId = useWorkspace(s => s.activeSessionId)`. No URL reading inside the component.

#### API Layer
N/A.

#### Data Layer
N/A. URL is not persistent state.

---

### B5: Optimistic write-through to UserSettingsDO

**Core:**
- **ID:** `optimistic-do-write`
- **Trigger:** Any store action that mutates `tabs`, `activeTabId`, `tabOrder`, `drafts`, or `sessions`.
- **Expected:** Store mutates local state immediately; a single fire-and-forget HTTP call (existing endpoints for tabs/drafts, new `/api/user-settings/sessions` for meta) propagates to UserSettingsDO. DO state broadcasts return via `useAgent` WS and are merged by `mergeServerState`:
  - **tabs / tabOrder / drafts** — plain last-write-wins by server snapshot (the DO is authoritative for these; the client's optimistic write is the one that triggered the broadcast, so identity is preserved).
  - **sessions** — each incoming session meta is passed through the same `mergeMeta(existing, patch, source='server')` gate from B3. Source gating supersedes recency: if the incoming broadcast carries a DO_ONLY field value that differs from local, it is **rejected** even if newer, because only a DO-source write may set that field. This prevents a server-side stale read from clobbering a fresh DO broadcast the store already received directly.
  - **activeTabId** — **not** touched by `mergeServerState` (per-browser, per resolved Open Questions); the server broadcast's `activeTabId` field is ignored.
- **Verify:** Integration test — (a) spawn tab optimistically, simulate DO broadcast 100ms later with same tab → no duplicate, no flicker; (b) set `sessions[id].status = 'running'` via DO-source patch, then deliver a server broadcast with `status = 'idle'` → status remains `'running'` (gate rejects).
- **Source:** new `mergeServerState` in `stores/session-workspace.ts`; existing WS wiring at `apps/orchestrator/src/hooks/use-user-settings.tsx:200-206` is repointed to call `store.mergeServerState`.

#### UI Layer
N/A — invisible.

#### API Layer
Existing: `POST /api/user-settings/tabs`, `PATCH /api/user-settings/tabs/:id`, `DELETE /api/user-settings/tabs/:id`, WS at `api/user-settings/ws`.
New: `POST /api/user-settings/sessions` (batch patches).

#### Data Layer
No schema change for tabs (B2 handles that). `session_meta` table from B3.

---

### B6: Feature preservation

**Core:**
- **ID:** `feature-parity`
- **Trigger:** All existing user-facing workflows.
- **Expected:** Every feature below keeps working unchanged. Full list (self-contained, matches research doc §3 F1–F16):

  | # | Feature | Post-refactor mechanism |
  |---|---|---|
  | F1 | Pinned tabs persist cross-device | UserSettingsDO `tabs` table + WS broadcast |
  | F2 | Active tab restored on cold launch | zustand `persist` hydrates `activeTabId` |
  | F3 | Push-notification deep-link first frame | module-init URL read → `activateSession` |
  | F4 | Archived-session deep-link | `sessions[id]` lookup ignores the sidebar's archived filter |
  | F5 | Quick-prompt hints `?newSessionProject=X`, `?newTab=true` | read at init, stored in transient slice, URL stripped via `replaceState` |
  | F6 | Keyboard shortcuts Cmd+T / Cmd+W / Cmd+1–9 | `useWorkspace.getState()` (sync, same as today's `getUserSettings()`) |
  | F7 | Drag-reorder tabs | `tabOrder` slice + write-through to DO |
  | F8 | Per-tab draft (debounced) | store `saveDraft` action with 500ms debounce |
  | F9 | Switch-session-in-tab (dropdown) | `switchTabSession(tabId, newSessionId)` action |
  | F10 | Sidebar click opens/activates tab | `activateSession(id)` + `patchSessionMeta` from sidebar fetch |
  | F11 | Tab StatusDot reflects session.status | `useSessionMeta(id).status`, updated by DO WS |
  | F12 | Tab title updates from DO summary | `patchSessionMeta(id, {summary}, 'do')` via `useCodingAgent` |
  | F13 | Tab project backfills from DO | rendered from `sessions[id].project` (no tab mutation required) |
  | F14 | Close-last-tab → composer | `removeTab` sets `activeTabId=null`; subscription clears URL |
  | F15 | Swipe-between-tabs (mobile) | `use-swipe-tabs` calls `activateSession` |
  | F16 | Multi-browser-tab coordination | existing `useAgent` WS fans out DO broadcasts to all tabs |

- **Verify:** Chrome-devtools-axi smoke script covers F1–F16 end-to-end; vitest covers the 6 race scenarios from research §10.
- **Source:** see Verification Plan.

#### UI Layer
All existing components (`TabBar`, `NavSessions`, `QuickPromptInput`, `AgentDetailView`) continue to work. Changes are limited to the imports they use (`useWorkspace` / `useSessionMeta` instead of `useUserSettings` / `useSessionsCollection`) but props and rendering stay identical.

#### API Layer
No breaking changes. New `/api/user-settings/sessions` endpoint is additive.

#### Data Layer
No data migration at rest that loses information. localStorage migration is read-once-delete as approved.

---

## Non-Goals

Explicitly out of scope:
- **`messagesCollection` refactor** — stays as TanStack DB; message hydration has its own caching story and is not touched here.
- **BroadcastChannel for cross-browser-tab sync** — the existing `useAgent` WS already fans out DO state broadcasts to all connected tabs; we rely on that instead of adding a second channel.
- **CRDT-based tab sync (Yjs)** — separate initiative tracked in issue #3; composes on top of this store later.
- **Sidebar session search / virtualization** — unchanged; sidebar still iterates the sessions list.
- **Session list pagination** — out of scope; `/api/sessions` stays full-list.

## Open Questions

- [x] Where does session meta live? — **UserSettingsDO** (answered, planning interview P1).
- [x] Tab shape `{id, sessionId}` or embed project/title? — **`{id, sessionId}`** (answered).
- [x] Vitest + chrome-devtools smoke? — **yes to both** (answered).
- [x] `messagesCollection` in scope? — **no** (answered).
- [x] DO pruning retention for `session_meta`? — **yes, prune on DO startup**: drop rows where `updated_at` is older than 30 days AND `id` is not referenced by any row in the `tabs` table. This is a hard decision, not a recommendation, and is implemented in P1.
- [x] `activeTabId` per-browser or server-synced? — **per-browser** (status quo). `activeTabId` stays in the store's `persist` blob per device; not written to UserSettingsDO. Each device tracks its own active tab.

## Implementation Phases

See YAML frontmatter `phases:` above. P1 → P2 → P3 → P4 → P5 strictly sequential; phases are 2–4 hours each.

## Verification Strategy

### Test Infrastructure
- **Vitest** — already configured at `apps/orchestrator/vitest.config.ts` with jsdom. New test file `apps/orchestrator/src/stores/session-workspace.test.ts`.
- **chrome-devtools-axi** — already installed (per session-start hook). New script `scripts/smoke-issue-5.sh` drives the login + scenarios.
- **DO unit tests** — add `apps/orchestrator/src/agents/user-settings-do.test.ts` covering the new `session_meta` precedence rules. Existing `apps/orchestrator/src/agents/user-settings-do-migrations.test.ts` pattern is followed.

### Build Verification
Use `pnpm typecheck && pnpm test && pnpm build` (NOT bare `tsc`) — TanStack Start generates route types at build time and `tsup` builds workspace libs first. Run at repo root so turbo picks up the dependency graph.

## Verification Plan

Concrete, executable steps to verify the refactor works end-to-end against the real app.

### VP1: Push-notification deep link, metadata cached
Steps:
1. Pre-seed: `chrome-devtools-axi open http://localhost:43173/login` and log in as `agent.verify+duraclaw@example.com`.
2. Spawn a session in project `demo`; note its `sessionId`.
3. `chrome-devtools-axi open "http://localhost:43173/?session=<sessionId>"` (fresh-load simulates push tap).
4. `chrome-devtools-axi snapshot` within 200ms of load.
   Expected: `demo` project badge visible on the tab; no text containing `"unknown"` anywhere in the accessibility tree.

### VP2: Push-notification deep link, cache cleared

**SLA:** badge must resolve within 500ms of load (asserted by vitest); smoke script waits up to 1500ms as tolerance for network jitter but still fails if unresolved by then.

Steps:
1. `chrome-devtools-axi eval "localStorage.clear(); location.reload()"` then reopen `/?session=<sessionId>`.
2. `chrome-devtools-axi snapshot` immediately.
   Expected: tab shows `"Session <first 8 chars>"` skeleton, never `"unknown"`.
3. Poll-snapshot every 100ms until the `demo` badge appears or 1500ms elapses.
   Expected: real `demo` badge resolved by 500ms (target); MUST resolve by 1500ms (hard fail).

### VP3: Archived session deep link
Steps:
1. Archive `<sessionId>` via the session menu.
2. `chrome-devtools-axi open "http://localhost:43173/?session=<sessionId>"`.
   Expected: tab opens with correct project badge and archived indicator; session is accessible even though it's filtered from the sidebar.

### VP4: Keyboard shortcuts synchronous
Steps:
1. Open a tab, then press `Cmd+T` → new tab; `Cmd+W` → closes; `Cmd+1` → activates first tab.
2. `chrome-devtools-axi snapshot` after each.
   Expected: every keypress takes effect on the **first** press (no "first keystroke ignored" edge).

### VP5: Drag-reorder survives reload
Steps:
1. Drag tab B before tab A; reload.
2. `chrome-devtools-axi snapshot`.
   Expected: order preserved (B before A).

### VP6: Band-aid grep check
```bash
git grep -nE 'lookupSessionInCache|seedFromCache|updateTabProject|didRestoreRef' apps/orchestrator/src
```
Expected: no matches.

### VP7: Effect-count check
```bash
git grep -c useEffect apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx
```
Expected: 2 or fewer (projects fetch + keyboard listener — all URL/tab/session sync effects deleted).

## Implementation Hints

### Dependencies

Already present: `zustand` (via `stores/tabs.ts`), `agents/react`, `@tanstack/react-router`. No new npm dependencies needed.

### Key Imports

| Module | Import | Used For |
|---|---|---|
| `zustand` | `{ create }` | store factory |
| `zustand/middleware` | `{ persist, subscribeWithSelector, createJSONStorage }` | localStorage hydration + selector subscriptions |
| `agents/react` | `{ useAgent }` | existing WS to UserSettingsDO |
| `~/agents/user-settings-do` | `{ UserSettingsState, SessionMeta }` | shared type |

### Code Patterns

**Store skeleton:**
```ts
// stores/session-workspace.ts
// NOTE: activeSessionId is a DERIVED selector, not stored state.
//   const activeSessionId = (s) => s.tabs.find(t => t.id === s.activeTabId)?.sessionId ?? null
// Consumers read it via `useWorkspace(selectActiveSessionId)` or the module-level export below.
// This guarantees activeTabId and activeSessionId can never disagree — switching sessionId in a tab
// immediately and atomically updates both URL and render.
export const selectActiveSessionId = (s: WorkspaceState) =>
  s.tabs.find(t => t.id === s.activeTabId)?.sessionId ?? null

export const useWorkspace = create<WorkspaceState & Actions>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        tabs: [], activeTabId: null, tabOrder: [], drafts: {}, sessions: {},
        // (no `activeSessionId` field — it is derived via selectActiveSessionId)
        activateSession: (sessionId) => { /* find-or-create + setActive */ },
        addTab: (sessionId) => { /* + POST to DO */ },
        removeTab: (id) => {
          // cancel pending debounce timer, drop draft from localStorage, DELETE DO
        },
        patchSessionMeta: (id, patch, source) => { /* gate + POST */ },
        mergeServerState: (serverState) => { /* per-field gate for sessions, LWW for rest */ },
      }),
      { name: 'duraclaw-workspace', version: 1, migrate: migrateLegacy, storage: createJSONStorage(() => localStorage), partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId, tabOrder: s.tabOrder, drafts: s.drafts, sessions: s.sessions }) },
    ),
  ),
)

// URL init — client-only, one-shot across HMR reloads
declare global { var __duraclaw_url_consumed: boolean | undefined }
if (typeof window !== 'undefined' && !globalThis.__duraclaw_url_consumed) {
  globalThis.__duraclaw_url_consumed = true
  const initial = new URL(window.location.href).searchParams.get('session')
  if (initial) useWorkspace.getState().activateSession(initial)
}

// URL subscription (one-way, store → URL), client-only, driven by derived activeSessionId
if (typeof window !== 'undefined') {
  useWorkspace.subscribe(
    selectActiveSessionId,
    (sid) => {
      const u = new URL(window.location.href)
      if (sid) u.searchParams.set('session', sid); else u.searchParams.delete('session')
      history.replaceState(history.state, '', u.toString())
    },
    { equalityFn: Object.is },
  )
}
```

**Per-field source-gated merge** (stateless — no per-record `source` to track):
```ts
const DO_ONLY = new Set(['status', 'summary', 'num_turns', 'error'])
const SERVER_ONLY = new Set(['project', 'archived'])
// 'title' and 'id' and 'updated_at' are LWW (no gate).

function mergeMeta(
  existing: SessionMeta | undefined,
  patch: Partial<SessionMeta>,
  source: 'do' | 'server',
): SessionMeta {
  const base: SessionMeta = existing ?? {
    id: patch.id!, project: patch.project ?? '', updated_at: 0,
  }
  const out = { ...base }
  for (const key of Object.keys(patch) as (keyof SessionMeta)[]) {
    if (DO_ONLY.has(key as string) && source !== 'do') continue          // reject server→do-field
    if (SERVER_ONLY.has(key as string) && source !== 'server') continue  // reject do→server-field
    out[key] = patch[key] as never
  }
  out.updated_at = Date.now()
  return out
}
```
The gate is pure — no prior-source lookup required, so the contradiction surfaced in review (interleaved writes clobbering a gated field) cannot occur.

**Thin useUserSettings wrapper (drop-in for existing call sites):**
```ts
export function useUserSettings() {
  useAgent<UserSettingsState>({
    agent: 'user-settings-do',
    basePath: 'api/user-settings/ws',
    onStateUpdate: (s) => useWorkspace.getState().mergeServerState(s),
  })
  return useWorkspace()  // or a selector returning the old shape
}

export const getUserSettings = () => useWorkspace.getState()
```

### Gotchas

- `history.replaceState` can surprise TanStack Router if it re-reads `window.location` on navigation; if that happens, fall back to `router.navigate({ search: { session: sid }, replace: true })` — still far cheaper than an effect.
- Zustand `persist` with React 19 strict mode: use `skipHydration` + explicit `rehydrate()` if double-invocation of the factory becomes an issue (rare on the client).
- Existing `use-user-settings.tsx` registers keyboard-shortcut paths via `getUserSettings()`; the new wrapper must preserve that named export.
- DO SQL migrations are forward-only — the `ALTER TABLE tabs DROP COLUMN` in B2 must wait until at least one release ships where nothing reads those columns.
- Draft sync debounce (500ms) must be preserved to avoid DO write amplification — move the timer into the store, not the hook. `removeTab` must `clearTimeout` the pending timer before the DELETE is sent.
- `mergeServerState` for the sessions slice MUST delegate to `mergeMeta(…, 'server')` — applying a plain LWW would defeat the source gate and reintroduce the class of bug this refactor eliminates.
- `activeSessionId` is **derived** (selector), not stored. Never set it directly. Setting `activeTabId` and `switchTabSession` are the only mutators that affect it.
- `session_meta.project` is nullable; the UI treats `''` and `undefined` identically as "skeleton pending" to avoid an empty-badge flash during DO-then-server write races.

### Reference Docs
- [Zustand — persist middleware](https://github.com/pmndrs/zustand/blob/main/docs/integrations/persisting-store-data.md) — hydration, migrate function, storage adapters.
- [Zustand — subscribeWithSelector](https://github.com/pmndrs/zustand/blob/main/docs/guides/auto-generating-selectors.md) — selector-based subscribe used for URL sync.
- Research doc `planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md` — §§1–10 cover problem, root cause, rejected alternatives, verification plan.
- Related audit `planning/research/2026-04-16-state-management-audit.md` — covers prior state-management pain points.

---

<!-- Approved implementations should update status: approved in frontmatter. -->
