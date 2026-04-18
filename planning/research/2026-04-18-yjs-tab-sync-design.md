# Yjs Tab Sync — Design for Implementation

**Date:** 2026-04-18
**Type:** Feasibility + implementation design
**Context:** Tab state management has gone through three failed fix attempts (`603c866`, `538a06b`, `4df474a`) after the D1 migration (PR #9). The root cause is optimistic-insert / server-dedup races in the TanStack QueryCollection layer. The decision is to replace the entire tab sync infrastructure with Yjs, which is already in the stack for multiplayer draft collaboration (#3/#4).

**User requirements (verbatim):**
- "I just want sync"
- "Tabs are a view and shouldn't be backed by DB"
- "Sessions are source of truth and tab should equal session route"
- "Sync is absolutely needed. Real not ephemeral. Deep link needed."

---

## 1. Architecture: Tabs as a Yjs Y.Array on UserSettingsDO

### 1.1 Core thesis

A tab IS a session reference. The Y.Doc holds an ordered list of session IDs and the active selection. Display metadata (project, title, status) comes from `agentSessionsCollection` via join — never stored on the tab.

### 1.2 Y.Doc schema

```
Y.Doc "user-settings" (one per user, on UserSettingsDO)
├── Y.Array<string> "openTabs"         # ordered session IDs
└── Y.Map "workspace"
    └── activeSessionId: string | null # currently focused session
```

That's the entire state surface. No tab IDs, no positions, no metadata fields.

### 1.3 Server: upgrade UserSettingsDO from PartyServer → YServer

**Current state** (`src/agents/user-settings-do.ts`): extends `Server` from partyserver. Stateless fanout — receives `POST /notify`, broadcasts JSON to connected sockets.

**New state**: extends `YServer` from y-partyserver. Same pattern as `SessionCollabDO`:

```ts
// user-settings-do.ts (rewritten)
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'

export class UserSettingsDO extends YServer {
  static options = { hibernate: true }
  static callbackOptions = {
    debounceWait: 2000,
    debounceMaxWait: 10000,
    timeout: 5000,
  }

  private ensureTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS y_state (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  async onLoad() {
    this.ensureTable()
    const rows = this.ctx.storage.sql
      .exec("SELECT data FROM y_state WHERE id = 'snapshot' LIMIT 1")
      .toArray()
    if (rows.length > 0) {
      const data = rows[0].data as ArrayBuffer | Uint8Array
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      Y.applyUpdate(this.document, bytes)
    }
  }

  async onSave() {
    const update = Y.encodeStateAsUpdate(this.document)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO y_state (id, data, updated_at)
       VALUES ('snapshot', ?, ?)`,
      update,
      Date.now(),
    )
  }
}
```

~30 lines. Identical to `SessionCollabDO`.

### 1.4 WS routing + auth

The existing `server.ts` routes `/parties/session-collab/{sessionId}` to SessionCollabDO. The existing `/parties/user-settings/{userId}` route points to UserSettingsDO already. y-partyserver's `useYProvider` will connect to that path automatically with `party: 'user-settings'`.

Auth: y-partyserver's `onConnect` can validate the session cookie, same as the current `UserSettingsDO.onConnect`. The `YServer` base class exposes the same `onConnect(conn, ctx)` lifecycle hook.

```ts
// Add to UserSettingsDO
async onConnect(conn: Connection, ctx: ConnectionContext) {
  const session = await getRequestSession(this.env, ctx.request)
  if (!session) {
    conn.close(4401, 'unauthenticated')
    return
  }
  if (this.name && this.name !== session.userId) {
    conn.close(4403, 'forbidden')
    return
  }
}
```

### 1.5 Wrangler migration

UserSettingsDO already has SQLite from `tag = "v2"`. The `v4` migration was a no-op (class went stateless). The new YServer usage will write back into SQLite via `onSave`. No new migration tag needed — `CREATE TABLE IF NOT EXISTS y_state` in `onLoad` handles schema creation idempotently. The old orphaned SQLite data (from the v2 Agent-based implementation) is harmless — different table names.

---

## 2. Client: `useTabSync` hook

### 2.1 Shape

```ts
// hooks/use-tab-sync.ts

interface UseTabSyncResult {
  /** Ordered list of open session IDs (reactive). */
  openTabs: string[]
  /** Currently focused session ID (reactive). */
  activeSessionId: string | null
  /** Add a session to open tabs (idempotent) and optionally activate it. */
  openTab: (sessionId: string, activate?: boolean) => void
  /** Remove a session from open tabs. Returns the next active session ID. */
  closeTab: (sessionId: string) => string | null
  /** Set the active session. */
  setActive: (sessionId: string | null) => void
  /** Reorder tabs (from drag-and-drop). */
  reorder: (fromIndex: number, toIndex: number) => void
  /** Yjs provider status. */
  status: 'connecting' | 'connected' | 'disconnected'
}
```

### 2.2 Implementation sketch

```ts
export function useTabSync(): UseTabSyncResult {
  const { data: session } = useSession()
  const userId = session?.user?.id

  // One Y.Doc per user, stable across renders.
  const doc = useMemo(() => {
    const d = new Y.Doc()
    d.guid = `user-settings:${userId}`
    return d
  }, [userId])

  const openTabsY = useMemo(() => doc.getArray<string>('openTabs'), [doc])
  const workspaceY = useMemo(() => doc.getMap('workspace'), [doc])

  // y-partyserver provider — auto-reconnect, hibernation-safe.
  const provider = useYProvider({
    host: typeof window !== 'undefined' ? window.location.host : '',
    room: userId ?? '',
    party: 'user-settings',
    doc,
    options: { connect: Boolean(userId) },
  })

  // IndexedDB persistence for offline cold-start.
  useEffect(() => {
    if (!userId) return
    const idb = new IndexeddbPersistence(`user-settings:${userId}`, doc)
    return () => { idb.destroy() }
  }, [userId, doc])

  // Reactive state from Y.Doc observers.
  const [openTabs, setOpenTabs] = useState<string[]>(() => openTabsY.toArray())
  const [activeSessionId, setActiveState] = useState<string | null>(
    () => (workspaceY.get('activeSessionId') as string) ?? null
  )

  useEffect(() => {
    const handler = () => setOpenTabs(openTabsY.toArray())
    openTabsY.observe(handler)
    // Sync initial state (IndexedDB may have hydrated by now).
    setOpenTabs(openTabsY.toArray())
    return () => openTabsY.unobserve(handler)
  }, [openTabsY])

  useEffect(() => {
    const handler = () => {
      setActiveState((workspaceY.get('activeSessionId') as string) ?? null)
    }
    workspaceY.observe(handler)
    handler()
    return () => workspaceY.unobserve(handler)
  }, [workspaceY])

  // Actions — all write to Y.Doc, which syncs to server + peers.
  const openTab = useCallback((sessionId: string, activate = true) => {
    doc.transact(() => {
      const arr = openTabsY.toArray()
      if (!arr.includes(sessionId)) {
        openTabsY.push([sessionId])
      }
      if (activate) {
        workspaceY.set('activeSessionId', sessionId)
      }
    })
  }, [doc, openTabsY, workspaceY])

  const closeTab = useCallback((sessionId: string): string | null => {
    let nextActive: string | null = null
    doc.transact(() => {
      const arr = openTabsY.toArray()
      const idx = arr.indexOf(sessionId)
      if (idx === -1) return
      openTabsY.delete(idx, 1)
      // If closing the active tab, pick adjacent.
      const current = workspaceY.get('activeSessionId')
      if (current === sessionId) {
        const remaining = openTabsY.toArray()
        nextActive = remaining[Math.min(idx, remaining.length - 1)] ?? null
        workspaceY.set('activeSessionId', nextActive)
      }
    })
    return nextActive
  }, [doc, openTabsY, workspaceY])

  const setActive = useCallback((sessionId: string | null) => {
    workspaceY.set('activeSessionId', sessionId)
  }, [workspaceY])

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    doc.transact(() => {
      const item = openTabsY.get(fromIndex)
      openTabsY.delete(fromIndex, 1)
      openTabsY.insert(toIndex, [item])
    })
  }, [doc, openTabsY])

  return { openTabs, activeSessionId, openTab, closeTab, setActive, reorder, status }
}
```

~100 lines total. All races are structurally impossible — Y.Array/Y.Map operations are immediate-local, sync-eventual.

### 2.3 Client-side offline persistence

**Package:** `y-indexeddb` (~3 KB gzipped). Standard Yjs persistence provider. Auto-syncs Y.Doc state to/from IndexedDB.

**Cold-start flow:**
1. `IndexeddbPersistence` hydrates Y.Doc from IndexedDB (synchronous-ish — fires `synced` event when done, but initial state is available immediately on next microtick).
2. `openTabsY.toArray()` returns the last-known tabs.
3. Tab bar renders immediately.
4. WS connects to UserSettingsDO → CRDT merge reconciles any changes that happened on other devices.

No OPFS, no TanStack QueryCollection, no `queryFn` race.

---

## 3. Deep link flow

```
User taps push notification → browser opens /?session=abc123
  1. React mounts AgentOrchContent
  2. useTabSync() hydrates Y.Doc from IndexedDB (sync)
  3. Read URL: searchSessionId = 'abc123'
  4. openTab('abc123', true)  // idempotent add + activate
     └── Y.Array.push(['abc123']) if missing
     └── Y.Map.set('activeSessionId', 'abc123')
  5. Tab bar renders: finds 'abc123' in openTabs
     └── Joins with agentSessionsCollection['abc123']
     └── If session not hydrated: skeleton
     └── On queryFn resolve: project/title/status fill in
  6. WS connects → Y.Doc syncs → other devices see the new tab
```

One tick (IndexedDB) + one WS connect (~50ms). No race between 5+ async sources.

---

## 4. Tab bar rendering

Tab bar remains a join, but simpler — no `userTabsCollection`, just a plain array:

```tsx
function TabBar({ onSelectSession, ... }) {
  const { openTabs, activeSessionId, closeTab, setActive, reorder } = useTabSync()

  // Join against sessions for display metadata.
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ session: agentSessionsCollection })
  )
  const sessionsMap = useMemo(() => {
    const m = new Map<string, SessionRecord>()
    for (const s of sessions ?? []) m.set(s.id, s)
    return m
  }, [sessions])

  const rows = openTabs.map(sessionId => ({
    sessionId,
    session: sessionsMap.get(sessionId),
  }))

  // Render rows with skeleton fallback for unhydrated sessions...
}
```

No LEFT JOIN via `useLiveQuery` across two TanStack collections. Just a `map` + `Map.get`. The `useLiveQuery` reads sessions only — tabs are from Yjs.

---

## 5. What gets deleted

| File / concern | Lines | Status |
|---|---|---|
| `src/db/user-tabs-collection.ts` | 86 | **Delete entirely** |
| `src/lib/tab-utils.ts` | 51 | **Delete entirely** |
| `src/hooks/use-active-tab.ts` | 61 | **Delete entirely** |
| `src/hooks/use-invalidation-channel.ts` `user_tabs` branch | ~5 | Remove from collections map |
| `src/api/index.ts` tab CRUD endpoints (lines 305-458) | ~153 | **Delete entirely** |
| `src/api/notify.ts` `user_tabs` collection type | ~2 | Remove from type union |
| `src/components/tab-bar.tsx` LEFT JOIN + `userTabsCollection` refs | ~30 | Rewrite to use `useTabSync` |
| `src/features/agent-orch/AgentOrchPage.tsx` init tangle | ~50 | Simplify dramatically |
| `src/components/layout/nav-sessions.tsx` `ensureTabForSession` | ~5 | Replace with `openTab` |
| `src/components/notification-drawer.tsx` `ensureTabForSession` | ~5 | Replace with `openTab` |

**Total deleted:** ~450 lines
**Total added:** ~130 lines (UserSettingsDO rewrite + `useTabSync` hook)
**Net:** −320 LOC

### D1 table

The `user_tabs` table in D1 becomes dead. Two options:
- **A (clean):** Drop it in a migration. Any rollback needs a re-seed from Y.Doc snapshots.
- **B (cautious):** Leave it, stop writing to it, garbage-collect later.

Recommend B — leave the table, add a `-- deprecated` comment in the schema, delete in a follow-up after one week of stable Yjs tabs.

---

## 6. One-time migration: D1 tabs → Y.Doc

On first connect to the upgraded UserSettingsDO, the Y.Doc is empty (no prior `y_state` snapshot). We need to seed the `openTabs` array from the user's existing D1 tabs.

**Server-side seed** (in `onLoad`, after snapshot restore):

```ts
async onLoad() {
  this.ensureTable()
  // ... restore from y_state snapshot as before ...

  // One-time migration: if openTabs is empty, seed from D1.
  const openTabs = this.document.getArray<string>('openTabs')
  if (openTabs.length === 0) {
    const db = getDb(this.env)
    const userId = this.name  // room = userId
    const tabs = await db
      .select()
      .from(userTabs)
      .where(eq(userTabs.userId, userId))
      .orderBy(asc(userTabs.position))
    if (tabs.length > 0) {
      this.document.transact(() => {
        for (const tab of tabs) {
          if (tab.sessionId) openTabs.push([tab.sessionId])
        }
        // Preserve active tab from localStorage via client hint,
        // or default to first tab.
        const workspace = this.document.getMap('workspace')
        workspace.set('activeSessionId', tabs[0].sessionId ?? null)
      })
    }
  }
}
```

This runs once — after the first `onSave`, the `y_state` snapshot has data, and subsequent `onLoad` calls restore from that.

**Client-side active-tab migration:** The first time `useTabSync` connects and the Y.Doc's `workspace.activeSessionId` is null, read `localStorage['duraclaw-active-tab']` and set it. Then delete the localStorage key.

---

## 7. How the seven failure modes resolve

| # | Failure mode | Resolution |
|---|---|---|
| **F1** | "New tab for project" broken | **Product decision baked in:** `openTab(sessionId)` is idempotent. A tab IS a session. Menu becomes "New session for project" → spawn → `openTab(newSessionId)`. No ambiguity. |
| **F2** | Phantom optimistic rows on dedup | **Structurally impossible.** Y.Array insert is local-first, no server re-keying. CRDT merge handles concurrent inserts from multiple devices. |
| **F3** | `useState` init side effects | **Gone.** Y.Doc hydrates from IndexedDB. URL `?session=X` handled by a single `openTab(X)` call outside render, or in a one-shot `useEffect`. |
| **F4** | `selectedSessionId` drifts | **Gone.** `activeSessionId` is reactive (Y.Map observer). No React-state mirror. Component re-renders on Y.Doc change. |
| **F5** | `activeTabId` stale pointer | **Gone.** Active lives in Y.Doc. `closeTab` advances the pointer atomically in a `doc.transact()`. Cross-device delete fires observer → UI updates. |
| **F6** | Orphan skeleton tabs | **Trivial reaper.** On `agentSessionsCollection` refetch, sweep `openTabs` Y.Array: remove IDs not in sessions map. 3 lines in a `useEffect`. |
| **F7** | OPFS cold-load divergence | **Gone.** IndexedDB Y.Doc + server Y.Doc merge via CRDT. No two-collection reconciliation. |

All seven resolved. F1 by product clarity, F2/F3/F4/F5/F7 by structural impossibility, F6 by a trivial reaper.

---

## 8. What stays unchanged

- `agentSessionsCollection` (D1-backed, 30s refetch) — still the source of session metadata
- `SessionDO` — still owns session state, messages, agent lifecycle
- `SessionCollabDO` — still owns multiplayer draft collaboration
- `notifyInvalidation` for `agent_sessions` and `user_preferences` — still works
- All agent gateway / session-runner code — untouched
- Keyboard shortcuts — same logic, call `openTab`/`closeTab`/`setActive` instead of collection operations
- Drag-reorder — call `reorder(from, to)` instead of POST `/reorder`
- Push notifications — same deep-link flow, `openTab(sessionId)` instead of `ensureTabForSession`

---

## 9. New dependency

**`y-indexeddb`** — ~3 KB gzipped. Standard Yjs persistence provider for client-side offline state.

```bash
pnpm --filter @duraclaw/orchestrator add y-indexeddb
```

Already in the stack: `yjs@^13.6.30`, `y-partyserver@^2.1.4`, `y-protocols@^1.0.7`.

---

## 10. Implementation phases

### Phase 1: UserSettingsDO → YServer (~2 hours)

- Rewrite `user-settings-do.ts` to extend `YServer`
- Add `y_state` table + `onLoad`/`onSave` (clone SessionCollabDO)
- Add `onConnect` auth (port existing auth logic)
- Add D1 migration seed in `onLoad`
- Wrangler: no migration tag needed (existing SQLite from v2)
- Verify: WS connects, Y.Doc syncs between two browser tabs

### Phase 2: `useTabSync` hook (~2 hours)

- New `hooks/use-tab-sync.ts`
- Add `y-indexeddb` dependency
- Wire up Y.Doc observers → React state
- Expose `openTab`, `closeTab`, `setActive`, `reorder`
- Port localStorage migration for `activeTabId`

### Phase 3: Wire consumers (~3 hours)

- `AgentOrchPage.tsx`: replace `useState` init + `ensureTabForSession` with `useTabSync().openTab`
- `tab-bar.tsx`: replace `useLiveQuery` join with `useTabSync().openTabs` + sessions map lookup
- `nav-sessions.tsx`: `ensureTabForSession` → `openTab`
- `notification-drawer.tsx`: `ensureTabForSession` → `openTab`
- Keyboard shortcuts: `getActiveTabId` / `userTabsCollection` → `useTabSync` actions
- `use-swipe-tabs.ts`: use `openTabs` array for prev/next

### Phase 4: Delete dead code (~1 hour)

- Delete `user-tabs-collection.ts`
- Delete `tab-utils.ts`
- Delete `use-active-tab.ts`
- Delete tab CRUD API endpoints from `api/index.ts`
- Remove `user_tabs` from `notifyInvalidation` + `use-invalidation-channel.ts`
- Leave `user_tabs` D1 table for rollback (comment as deprecated)

### Phase 5: Verify (~1 hour)

- Cold-start deep link `?session=X`
- Cross-device tab sync (open tab on device A, appears on device B)
- Drag-reorder persists + syncs
- `Cmd+T` / `Cmd+W` / `Cmd+1-9`
- Close-last-tab → composer
- Swipe-between-tabs
- Push notification tap
- Offline: tabs persist in IndexedDB, render on cold start before WS connects

**Total: ~9 hours (1-2 sessions)**

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| UserSettingsDO class change breaks existing WS connections | PartyKit reconnect is automatic; y-partyserver speaks its own framing. Existing clients (pre-deploy) will get a WS error and reload. One-time blip on deploy. |
| D1 migration seed races with client first-connect | Seed runs in `onLoad` (before connections are accepted). By the time the client's `useYProvider` handshakes, the Y.Doc is populated. |
| Y.Array allows duplicate sessionIds (concurrent `openTab` on two devices) | `openTab` checks `arr.includes(sessionId)` before push. Two devices racing will both check empty, both push → duplicates. Fix: add a `dedup` sweep in the observer (remove all but first occurrence). Cheap, rare, self-healing. |
| `y-indexeddb` first-time hydration is async (not truly sync) | Y.Doc is usable immediately (empty arrays). IndexedDB populates on next microtick. First render may show empty tab bar for one frame, then fill in. Acceptable — faster than current OPFS + queryFn race. |
| Orphan `user_tabs` D1 table grows forever | Stop writing (Phase 4). Garbage-collect in a follow-up migration after 1 week of stability. |

---

## 12. Cross-device sync flow

```
Device A                      UserSettingsDO            Device B
   │                              (YServer)                 │
   │ openTab('session-X')            │                      │
   │──Y.Array.push────────────────►  │                      │
   │                                 │ ◄──Y-sync-protocol──►│
   │                                 │   openTabs observer   │
   │                                 │   fires on Device B   │
   │                                 │──────────────────────►│
   │                                 │   Tab bar re-renders  │
   │                                 │   with session-X      │
```

y-partyserver handles the binary sync-protocol framing. No JSON broadcasts, no REST endpoints, no refetch cycles. Pure CRDT.

---

## 13. NotifyInvalidation: what stays, what goes

Current `notifyInvalidation` usage:

| Collection | Trigger | After Yjs tabs |
|---|---|---|
| `agent_sessions` | Session create/update/archive | **Stays** — sessions still D1-backed |
| `user_tabs` | Tab insert/update/delete/reorder | **Deleted** — no more D1 tabs |
| `user_preferences` | Preference change | **Stays** — prefs still D1-backed (for now; could move to Y.Doc `workspace` later) |

`useInvalidationChannel` drops the `user_tabs` case from `COLLECTIONS_BY_NAME`.

---

## 14. Future: preferences in Y.Doc

The `workspace` Y.Map can hold more than `activeSessionId`. Future work (not in this scope):

```
Y.Map "workspace"
├── activeSessionId: string
├── theme: 'light' | 'dark' | 'system'
├── permissionMode: 'default' | 'auto' | 'manual'
├── model: string
└── maxBudget: number | null
```

This would retire `user_preferences` D1 table + its collection + its CRUD endpoints. Same pattern, same win. Out of scope for this task — stick to tabs.

---

## 15. Bottom line

The existing Yjs infra (`SessionCollabDO`, y-partyserver, `y-protocols`) gives us everything we need. A new `UserSettingsDO` extending `YServer` is ~30 lines of server code. `useTabSync` is ~100 lines of client code. We delete ~450 lines of QueryCollection + CRUD + dedup + invalidation. Net −320 LOC.

All seven tab-state failure modes become structurally impossible.

Cross-device sync, deep links, offline cold-start, drag-reorder — all work from day one via CRDT merge semantics.

Ready for `kata enter planning --issue=5` or direct `kata enter task`.
