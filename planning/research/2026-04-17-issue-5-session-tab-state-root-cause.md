# Issue #5 — Session/Tab State Refactor: Root-Cause Solution

**Type:** Feasibility + architectural design (narrow, focused on one refactor)
**Issue:** [GH#5](https://github.com/baseplane-ai/duraclaw/issues/5) — "Refactor session/tab state management to zustand-style sync store"
**Author of this doc:** research-mode session, 2026-04-17
**Related prior research:** `2026-04-16-state-management-audit.md`, `2026-04-17-yjs-tab-and-draft-sync-feasibility.md`

---

## 1. Problem, restated precisely

The state path that drives the main page today is:

```
URL search params  →  TanStack DB collections (useLiveQuery)  →  effect chain  →  tab/active/selected state  →  React render
                                                              ↑                          ↓
                                                              └───── backfill from DO state ──────┘
```

Five independent asynchronous sources converge on the first render:

| # | Source | Ready when |
|---|---|---|
| 1 | `URL ?session=X` (TanStack Router `useSearch`) | Sync on mount |
| 2 | `localStorage['duraclaw-sessions']` (sessions cache) | Sync at module load (`seedFromCache`) |
| 3 | `sessionsCollection` via `useLiveQuery` | After queryFn resolves (first render usually empty) |
| 4 | `tabsCollection` via `useLiveQuery` | After queryFn resolves |
| 5 | `SessionDO` state via `useCodingAgent` WS | After WS handshake + first broadcast |

Because `useLiveQuery` does **not** resolve synchronously from the `writeBatch` seed, the first render of `AgentOrchPage` must decide tab/project/title before #3–#5 arrive. Today that is papered over with:

- `sessions-collection.ts:62-81` — `seedFromCache()` at module load
- `sessions-collection.ts:98-112` — `lookupSessionInCache()` reads `localStorage` directly
- `AgentOrchPage.tsx:42-71` — synchronous `useState` init reading the sync lookup
- `AgentOrchPage.tsx:105-147` — URL↔state sync effect with `project='unknown'` fallback
- `AgentOrchPage.tsx:388-413` — `updateTabProject` + `updateTabTitle` backfill from `agent.state`
- `AgentOrchPage.tsx:97-102` — `didRestoreRef` guard to push localStorage-restored session into URL
- Extra guard for `quickPromptHint` to stop `navigate({ to: '/' })` racing with stale URL

Each band-aid solves one timing edge, but the set is not closed: adding a new consumer (archived-session deep link, mobile PWA wake, push-notification tap) reliably breaks one of them.

---

## 2. Root cause (one sentence)

**Tabs embed cached session metadata (`project`, `title`) but the system has no synchronous, authoritative source for that metadata at first render — so tab creation has to guess, then backfill, and the guess/backfill pair races with every other async loader.**

Every observed failure mode is a consequence of this:

| Failure mode | Mechanism |
|---|---|
| Push-notification tap shows "unknown" badge | Tab created in `useState` init from `lookupSessionInCache`; cache miss → `'unknown'`; backfill runs only after WS state arrives (tens of ms to seconds later). |
| Placeholder tab persists after sessions load | `findTabBySession` short-circuits the URL-sync effect's create branch, so the `project='unknown'` tab written in init is never re-evaluated from the now-present `sessions` array. |
| Archived sessions deep-link to placeholder | `sessionsCollection` filters `.archived`, so even after queryFn resolves `sessions.find(id)` returns `undefined`; backfill path via `agent.state` only runs if the DO WS actually connects (archived sessions may not auto-spawn). |
| `?newSessionProject=…` races with `?session=…` | Two effects mutate URL in the same tick; guard was bolted on (`quickPromptHint` check at `AgentOrchPage.tsx:136`). |
| Cold-launch with stale `activeTabId` | Added fallback `AgentOrchPage.tsx:65-69` — pick first tab — because the effect chain couldn't decide. |

The fix is not "add a sixth band-aid." The fix is **remove the reason tabs need cached metadata**.

---

## 3. Design goal

A single synchronous store that is the authoritative source for:

- **Tab list** (ordered refs)
- **Active selection**
- **Session metadata lookup** (project, title, status, summary, archived)
- **Drafts**

…hydrated synchronously on module load, written through optimistically to the UserSettings DO for cross-device sync, and updated by the existing real-time sources (sessions fetch, DO WS state, UserSettingsDO WS sync) as they arrive.

All of the following existing features must continue to work:

| # | Feature | Citation |
|---|---|---|
| F1 | Pinned tabs persist across reload & across devices | `user-settings-do.ts`, `tabs-collection.ts` |
| F2 | Active tab restored on cold launch | `AgentOrchPage.tsx:57-69` |
| F3 | Deep-link `/?session=X` (push notifications) lights up correct tab on first frame | `AgentOrchPage.tsx:42-54` |
| F4 | Deep-link to an archived session opens it | implicit |
| F5 | Quick-prompt hints `?newSessionProject=X`, `?newTab=true` | `AgentOrchPage.tsx:76-92` |
| F6 | `Cmd+T / Cmd+W / Cmd+1–9` keyboard shortcuts (synchronous, no-hook callers) | `AgentOrchPage.tsx:270-311` |
| F7 | Drag-reorder tabs, persisted | `tab-bar.tsx`, `localStorage['duraclaw-tab-order']` |
| F8 | Per-tab draft, debounced to server | `use-user-settings.tsx` |
| F9 | Tab-level "switch session in this tab" (dropdown) | `switchTabSession` |
| F10 | Sidebar session click opens/activates tab | `nav-sessions.tsx:280-287` |
| F11 | Tab `StatusDot` reflects session status | `tab-bar.tsx` |
| F12 | Tab title updates from DO `summary` | `AgentOrchPage.tsx:401-407` |
| F13 | Tab project backfills from DO `project` | `AgentOrchPage.tsx:408-410` |
| F14 | Close-last-tab returns to empty-state composer | `handleLastTabClosed` |
| F15 | Swipe-between-tabs (mobile) | `use-swipe-tabs` |
| F16 | Touch/pull-to-refresh does not clobber state | implicit |

And all problems P1–P6 (see §1) must be eliminated.

---

## 4. Solution: a three-slice synchronous store

### 4.1 Slice shape

```ts
// apps/orchestrator/src/stores/session-workspace.ts  (new)

interface TabRef { id: string; sessionId: string }           // ← no project/title/status
interface SessionMeta {
  id: string
  project: string
  title?: string
  summary?: string
  status?: string
  archived?: boolean
  updatedAt: number   // used for last-write-wins between sources
}

interface Drafts   { [tabId: string]: string }
interface TabOrder { [tabId: string]: number }

interface WorkspaceState {
  tabs: TabRef[]
  activeTabId: string | null
  tabOrder: TabOrder
  drafts: Drafts
  sessions: Record<string, SessionMeta>   // keyed by sessionId, covers tabs + sidebar
  activeSessionId: string | null          // derived: tabs[activeTabId]?.sessionId
}
```

Three conceptual slices; one zustand store for the synchronous API.

### 4.2 Synchronous hydration (no async at first render)

```ts
const persisted = zustand.persist(
  storeFactory,
  {
    name: 'duraclaw-workspace',
    storage: createJSONStorage(() => localStorage),
    partialize: (s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      tabOrder: s.tabOrder,
      drafts: s.drafts,
      sessions: s.sessions,     // crucial: metadata cache lives in the same store
    }),
    version: 1,
    migrate: migrateLegacy,     // translate existing `duraclaw-sessions`, `duraclaw-active-tab`, `duraclaw-tab-order`, `agent-tabs` on first load
  },
)
```

- Zustand `persist` runs *during* `create(...)`, so the store is populated before React renders.
- The `sessions` slice subsumes `localStorage['duraclaw-sessions']` — same data, same owner, one less moving part.
- Migration reads all four legacy keys, merges, writes unified blob, deletes the old keys. Keeps existing users continuous.

### 4.3 URL is a hint, consumed once

```ts
// At module init, after store is hydrated:
const url = new URL(window.location.href)
const s = url.searchParams.get('session')
if (s) useWorkspace.getState().activateSession(s)   // creates/activates tab synchronously
```

- `activateSession(sessionId)` is the existing `addTab` logic minus the `project`/`title` requirement: if a tab exists for this session, set it active; otherwise push `{ id, sessionId }` and set active.
- No project/title needed at this point — the renderer pulls from `sessions[sessionId]` with a graceful "Session <8-char>" fallback while metadata fills in.

### 4.4 Store → URL subscription (one-way)

```ts
useWorkspace.subscribe(
  (s) => s.activeSessionId,
  (sessionId) => {
    const u = new URL(window.location.href)
    if (sessionId) u.searchParams.set('session', sessionId)
    else u.searchParams.delete('session')
    history.replaceState(history.state, '', u.toString())   // NOT navigate()
  },
  { equalityFn: Object.is },
)
```

- Uses `history.replaceState` so we don't trigger TanStack Router re-resolution. No effect chain, no race with `quickPromptHint`.
- The reverse direction — URL → store — happens **only** on module init (push tap, bookmark, copy-paste). After that, the store drives URL.

### 4.5 Feeding `sessions` metadata from the three real sources

The store exposes a single `patchSessionMeta(sessionId, patch, source)` writer with per-source precedence + `updatedAt` for last-write-wins within a source:

| Source | Writer | Trigger |
|---|---|---|
| `/api/sessions` fetch | `hydrateSessionsFromServer(list)` | `useSessionsCollection` initial fetch + refetch interval |
| `SessionDO` WS state | `patchSessionMeta(id, {status, summary, project, …}, 'do')` | `useCodingAgent` onStateUpdate (replaces `AgentOrchPage.tsx:388-413`) |
| UserSettings DO WS | applied at slice granularity | existing `onStateUpdate` in `useUserSettings` |

Precedence rules (resolve conflicts deterministically):
1. `'do'` source always wins for `status`, `summary`, `num_turns`, `error` (real-time truth).
2. `'server'` source wins for `project`, `archived` (catalogue truth).
3. Within a source, newer `updatedAt` wins.
4. Writes from any source also mirror to localStorage via zustand persist.

No effect needs to reconcile these — each source writes independently, and the derived selector `getSessionMeta(id)` is a pure lookup.

### 4.6 Server sync for tabs, active, drafts, tab-order

UserSettingsDO stays the authoritative cross-device store. Write-through is already optimistic today; move those writes into zustand actions:

```ts
addTab: (sessionId) => {
  set(s => ({ tabs: [...s.tabs, { id: nanoid(), sessionId }], activeTabId: newId }))
  api.postTab({ id: newId, sessionId })         // fire-and-forget optimistic
}
```

On DO state broadcast (already hooked in `useUserSettings`), merge authoritative server state for the tab-shaped slices only (`tabs`, `activeTabId`, `drafts`, `tabOrder`). The `sessions` slice is **not** sent to UserSettingsDO — it's per-device cache.

This removes the `tabsCollection` TanStack DB layer entirely. That layer currently offers nothing (no queries, no joins, no useful caching beyond localStorage) and costs complexity (queryFn race with WS broadcast, see `2026-04-16-state-management-audit.md`). The HTTP handlers on the DO stay — the store calls them directly.

---

## 5. How each band-aid disappears

| Band-aid | Today | After refactor |
|---|---|---|
| `seedFromCache()` in sessions-collection | Module-level `writeBatch` into TanStack DB | Gone — zustand persist hydrates `sessions` slice natively. |
| `lookupSessionInCache()` sync lookup | Direct localStorage read inside `useState` init | Gone — `useWorkspace.getState().sessions[id]` is just a read. |
| `useState` init with `settings.addTab(...)` | Imperative tab create during render | Replaced by one-shot `activateSession(id)` called outside React at init. |
| `project='unknown'` fallback | Written into tab, has to be backfilled later | Never written — tab has no `project`. Renderer shows "…" until `sessions[id]` arrives. |
| `updateTabProject()` in state-sync effect | Patches the tab | Replaced by `patchSessionMeta(id, {project})` — tab is unchanged. |
| `didRestoreRef` for cold-launch URL push | Effect to push restored session into URL once | Replaced by store→URL subscription (fires exactly once on state change). |
| `quickPromptHint` guard against URL race | Conditional inside URL-sync effect | Gone — no URL-sync effect exists. `navigate({ to: '/' })` clears `?session` which fires the subscription which does nothing if activeSessionId was already null. |
| Placeholder tab-creation (`041511a`, `15f3409`) | Unconditional-then-deferred tab create | Gone — stub `activateSession` creates the tab immediately with zero metadata dependencies. |
| Carry-project-in-push URL (`87ee061`, reverted) | N/A | Obsolete — no need to transport project, receiver reads cache. |

Net effect: ~150 lines of effects → ~40 lines of store + two selectors + one subscription.

---

## 6. How each feature survives

| # | Feature | Mechanism under new design |
|---|---|---|
| F1 | Pinned tabs persist cross-device | Zustand action writes through to UserSettingsDO; WS broadcast merges back. Same as today. |
| F2 | Active tab restored on cold launch | `persist` hydrates `activeTabId`; selector `activeSessionId = tabs[activeTabId]?.sessionId`. |
| F3 | Push-notification deep-link first frame | Init script reads URL, calls `activateSession(id)` *before* React renders; `sessions[id]` either has cached meta (localStorage) or renders graceful fallback ("Session abc123…"). |
| F4 | Archived-session deep-link | Same as F3. The `archived` filter only affects the **sidebar list**, not the `sessions` slice lookup. Tab shows archived session meta correctly. |
| F5 | Quick-prompt hints | URL params read at init → stored in transient non-persisted slice → URL cleaned via `replaceState`. No effect chain. |
| F6 | Keyboard shortcuts | `useWorkspace.getState()` is synchronous — same ergonomics as today's `getUserSettings()`. |
| F7 | Drag-reorder | `tabOrder` lives in the store; reorder action updates + persists + write-through to DO. |
| F8 | Per-tab draft | `drafts[tabId]` in store; debounced write-through (existing debounce logic moves over as-is). |
| F9 | Switch session in tab (dropdown) | `switchTabSession(tabId, newSessionId)` mutates `tabs[i].sessionId`; if that tab is active, store→URL subscription pushes the new session into URL. |
| F10 | Sidebar click | `nav-sessions.tsx` calls `useWorkspace.getState().activateSession(id)`; metadata already in `sessions[id]` from the sidebar's own fetch, so first-frame is perfect. |
| F11 | StatusDot | Reads `sessions[tab.sessionId].status`. Updates live as DO broadcasts patch the slice. |
| F12 | Title from summary | DO broadcast → `patchSessionMeta(id, {summary})` → selector used by TabBar returns `sessions[id].summary ?? sessions[id].title ?? fallback`. |
| F13 | Project backfill | DO broadcast → `patchSessionMeta(id, {project})`. No tab mutation. |
| F14 | Close-last-tab → composer | `removeTab` sets `activeTabId = null`; subscription clears URL; `selectedSessionId` selector becomes `null`; composer renders. Same rule as today, just expressed as pure state. |
| F15 | Swipe-between-tabs | `use-swipe-tabs` calls `activateSession(prev/next tab's sessionId)`. Unchanged. |
| F16 | PWA wake / pull-to-refresh | Hydration is sync; no queryFn race window. |

---

## 7. Why not alternative designs

**A. "Just fix the sessionsCollection timing."** Tried (the `seedFromCache` + `lookupSessionInCache` chain is exactly this). TanStack DB's `useLiveQuery` does not treat `writeBatch` data as "resolved query results," so first-render remains empty. Root cause is the extra layer, not any single timing bug.

**B. "Store tab metadata (project/title) on the tab, but hydrate from localStorage."** This is essentially today's `use-user-settings.tsx` + `seedFromCache`. It still requires: (a) writing metadata at tab-create time (so `activateSession` needs meta → needs sync lookup → race), and (b) backfill when metadata changes (→ `updateTabProject`). Two writers for the same fact.

**C. "Subscribe to a Y.js CRDT for tabs + metadata."** Covered in `2026-04-17-yjs-tab-and-draft-sync-feasibility.md`. Solves cross-device merge but is a separate axis — CRDT-persisted tabs still need a synchronous store at the React boundary, because Y.Doc hydration is async from IndexedDB and yjs-collab is slower than `JSON.parse(localStorage)`. The zustand slice can sit *in front of* a Yjs transport if that's adopted later; the two designs compose.

**D. "Move tabs into a TanStack Router search-param array."** Makes every tab change a navigation; breaks back/forward button semantics; doesn't solve metadata, just moves tab-ref storage.

**E. "Open a `useCodingAgent` connection per tab."** Would give authoritative metadata for every tab but costs N DO WS connections per user, reaping pressure on idle tabs, and still doesn't cover cold-start render.

---

## 8. Implementation order (for a follow-on planning-mode session)

Target file list (five files, ordered by dependency):

1. **New** `apps/orchestrator/src/stores/session-workspace.ts` — the store + selectors + migration from legacy keys. (~180 lines)
2. **Rewrite** `apps/orchestrator/src/hooks/use-user-settings.tsx` — thin wrapper selecting slices + write-through to UserSettingsDO API. (`getUserSettings()` becomes `useWorkspace.getState()`; same call sites.)
3. **Rewrite** `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx` — delete Effects 2, 3, 4 (lines 83-147, 388-413 moved to selectors + state-broadcast writer); replace `useState` init with `activateSession` call at module init; keep handlers.
4. **Delete** `apps/orchestrator/src/db/sessions-collection.ts`'s `seedFromCache` + `lookupSessionInCache`; `sessionsCollection` remains only as the server-list fetcher for sidebar (or also retired if `useSessionsCollection` moves to plain fetch + `sessions` slice).
5. **Delete / retire** `apps/orchestrator/src/db/tabs-collection.ts` + its hooks. UserSettingsDO HTTP endpoints stay; store calls them directly.
6. **Delete** `apps/orchestrator/src/stores/tabs.ts` — the legacy unused zustand store (`stores/tabs.ts:1-181`). It shares DNA with the new design and might seed the implementation, but the new store supersedes it.
7. **Update consumers** `tab-bar.tsx`, `nav-sessions.tsx` — swap hook imports; no structural change.
8. **Verification**: one vitest covering the six race scenarios in `2026-04-16-state-management-audit.md` §10 (push tap cold-load, archived deep-link, rapid tab switch, close-last, quick-prompt hint race, PWA wake).

Total expected diff: **+~220 / −~400 LOC**.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Migrating existing users' localStorage silently drops state | Migration reads all four legacy keys, unions them, writes once; keep legacy keys for two releases behind a flag. |
| UserSettingsDO WS broadcast clobbers optimistic tab write | Existing behaviour — preserved. WS merge uses `updatedAt` precedence; client-echo of its own write is idempotent. |
| Multiple open browser tabs (real browser tabs, not app tabs) mutate the store | Zustand `persist` with `storage: localStorage` + `BroadcastChannel` is a one-line add; existing design doesn't solve this either (localStorage writes are last-write-wins). |
| Someone still imports `tabsCollection` / `lookupSessionInCache` | Grep-audit + delete; TS will catch uses at compile time. |
| `history.replaceState` desyncs TanStack Router internal state | Use TanStack Router's `router.navigate({ replace: true })` if the raw `replaceState` trips it; the important property is "no route resolution," which both provide. |

---

## 10. Verification plan (for the eventual implementation)

1. **Cold push-notification tap** — open app via `https://.../?session=existing-id`; first paint shows correct project badge & title from localStorage cache.
2. **Cold push-notification tap, cache miss** — clear localStorage; same URL; first paint shows "Session abcd…" skeleton; within 500 ms both sidebar fetch and DO WS arrive and update the badge. No `"unknown"` ever visible.
3. **Archived session deep-link** — `/?session=<archived-id>`; tab opens, badge correct.
4. **Cold launch with no URL** — last active tab restored; URL becomes `?session=<restored>` via subscription.
5. **New-session quick prompt** — spawn → tab appears with pre-set project → URL becomes `?session=<new>`. No intermediate `?newSessionProject=` visible after navigate.
6. **Cmd+T / Cmd+W / Cmd+1-9** — all synchronous, no "first keystroke ignored."
7. **Drag-reorder** — order persists across reload and across devices.
8. **Draft** — debounce behaviour unchanged, survives reload.
9. **WS drop + reconnect** — tab bar doesn't flicker; `sessions` slice gets refreshed on reconnect.
10. **Second browser tab** — tab changes propagate via BroadcastChannel (or, at minimum, don't corrupt on reload).

---

## 11. Open questions (for the planning session)

- Should the `sessions` slice be capped (LRU) to avoid unbounded localStorage growth for users with thousands of sessions? Current design has no cap; TanStack DB's OPFS backing was implicitly the cap.
- Should `sessions` sync across devices via UserSettingsDO too, or stay per-device? Recommendation: stay per-device — it's cache, not user setting.
- Keep `messagesCollection` as-is (separate concern, not part of this refactor) or co-locate? Recommendation: out of scope for #5.
- BroadcastChannel for cross-browser-tab coordination: in or out of this refactor? Recommendation: in — trivial to add and closes the last "state drift across tabs" gap.

---

## 12. Bottom line

The tab/session fragility is **one root cause, fixable with one store**:

> Decouple tab identity (`{id, sessionId}`) from session metadata (`sessions[id]`), make both synchronous via zustand `persist`, and let real-time sources write into the metadata slice independently.

This preserves every listed feature, eliminates every listed band-aid, makes all race conditions structurally impossible (not just guarded), and reduces LOC. Recommended as the next implementation-mode task under GH#5.
