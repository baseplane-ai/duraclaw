---
date: 2026-04-17
topic: Issue #7 — Is the "loading gate" fix viable? Proper TanStack DB usage for our case.
type: library evaluation + feasibility
status: complete
github_issue: 7
related: planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md, planning/research/2026-04-16-state-management-audit.md
---

# Research: Loading Gate Fix for Tab/Session Race — and Proper TanStack DB Use

## 0. TL;DR

The loading-gate fix proposed in issue #7 — "render a skeleton until `useLiveQuery(sessionsCollection).isLoading === false`, then everything is magically synchronous" — **does not work as intended under TanStack DB 0.6.4's actual semantics**. Two specific findings make it worse than the current band-aid approach, not better:

1. **`isLoading` only goes `false` when the collection's sync (the `queryFn`) calls `markReady()`** — *not* when `writeBatch`-seeded data lands, and *not* when OPFS persistence hydrates. Source: `@tanstack/db` `lifecycle.ts:134-151`, `useLiveQuery.ts:540`. So the gate will wait for `GET /api/sessions` (typical 100–500 ms, longer on first cold load) before paint — a **visible skeleton regression** vs. today's instant paint from `lookupSessionInCache()`.
2. **OPFS persistence is not actually active on any of our collections**. The `persistence` export from `db-instance.ts` is assigned asynchronously (`initPersistence()` is an `async` function, awaited by `dbReady`), but `sessions-collection.ts`, `tabs-collection.ts`, and `messages-collection.ts` all run `createCollection()` synchronously at module load — when `persistence === null`. Every collection in the app falls back to memory + localStorage-only. The OPFS-SQLite dependency is pure weight today.

The practical implication for issue #7: **the cheap one-frame gate doesn't exist as long as sync completion is the gate criterion.** The only TanStack-DB-native way to get the "instant paint" we already have is to keep `seedFromCache()` and either (a) accept that `data` arrives before `isLoading: false` and render on `data.length > 0`, or (b) gate on `collection.status === 'ready'` while also pre-populating `syncedData` so the skeleton phase has stale-but-correct data behind it.

Neither option gives issue #7 what it promised ("everything is available — no band-aids needed"). The real fix — the one that *does* close every race structurally — is the refactor outlined in issue #5's root-cause doc: put tab/session metadata in a zustand `persist` store that hydrates synchronously at module load and treat TanStack DB's `sessions` collection as a *catalog* reader, not a first-render dependency.

**Recommendation:** Do not implement the gate-based fix. Proceed with issue #5's refactor. Fix the OPFS bug as an independent cleanup (out of scope for #7 itself). Keep the localStorage cache (renamed/tidied) as the first-render source — whether it lives in zustand (#5's design) or behind `seedFromCache`.

---

## 1. Issue #7's stated premise, verified against library semantics

Issue #7 proposes:

```tsx
function AgentOrchPage() {
  const { data: sessions, isLoading } = useLiveQuery(sessionsCollection)
  const { data: tabs, isLoading: tabsLoading } = useLiveQuery(tabsCollection)

  if (isLoading || tabsLoading) return <AppShell />  // "skeleton, ~1ms"

  // Everything is available — no band-aids needed
  return <AgentOrchContent sessions={sessions} tabs={tabs} />
}
```

The claim: "The gap between module load and OPFS cache resolution is ~1ms — one imperceptible frame."

### 1.1 What `isLoading` actually tracks

From `@tanstack/react-db/src/useLiveQuery.ts:540`:

```ts
isLoading: snapshot.collection.status === 'loading'
```

From `@tanstack/db/src/collection/lifecycle.ts:134-151`, status transitions:

```
idle  →  loading  →  ready
```

`ready` is set only by an explicit `markReady()` call from the sync implementation. For a `queryCollectionOptions`-backed collection (our `sessionsCollection` and `tabsCollection`), that call happens **after `queryFn` resolves** — i.e. after the HTTP round-trip to `GET /api/sessions` or `GET /api/user-settings/tabs`. Neither OPFS hydration, nor `writeBatch` writes, nor `writeInsert` writes move the status.

From `@tanstack/db/src/sync/manual-sync.ts:154`:

- `writeBatch`/`writeInsert` apply with `immediate: true` → data becomes visible to queries synchronously.
- But they do not emit the `markReady` signal.

**So:**

| Action | `data` populated? | `isLoading → false`? |
|---|---|---|
| Module-load `seedFromCache` → `writeBatch(writeInsert(...))` | Yes (synchronously) | **No** — sync not marked ready |
| OPFS persistence rehydrate | Yes (async, once pump completes) | **No** — persistence does not call `markReady` |
| `queryFn` returns (network round-trip) | Yes | **Yes** (at that moment) |

The "~1ms" figure in the issue confuses "data ready for render" with "isLoading flag flipped." These are different in TanStack DB 0.6.4. The flag is gated on sync, not on data presence.

### 1.2 Direct consequence for the gate

`if (isLoading) return <AppShell />` waits on the `GET /api/sessions` fetch, not on OPFS/localStorage. On a warm page reload with valid auth cookies that's roughly 50–200 ms best-case; on cold PWA wake or slow mobile, hundreds of ms to seconds; on first-ever load with no cached user, indefinite.

Today's behaviour: `AgentOrchPage` reads `lookupSessionInCache()` inside `useState` init — **no hook subscription, no `isLoading` check** — and paints the tab bar in the same synchronous tick as `createRoot().render()`. The gate version would be strictly worse on every path except "first-ever load with no cache" (where both are identical).

### 1.3 `writeBatch` doesn't fix this

We already call `seedFromCache()` at module load in `sessions-collection.ts:81`. After that module finishes loading, the collection's `syncedData` contains the cached sessions. But:

- `useLiveQuery` sees `data` arriving in the first render.
- It *also* sees `isLoading: true` because `queryFn` hasn't resolved.
- Gating on `isLoading` would hide the already-available data.

This is the specific behaviour issue #7's author worried about ("TanStack DB's `useLiveQuery` does not treat `writeBatch` data as 'resolved query results'"). The library source confirms it — it's by design. `writeBatch` is a data-plane operation; `markReady` is a control-plane signal.

### 1.4 Upstream exit for #7's investigation question 2

> *"Has TanStack DB fixed the issue where `writeBatch` data isn't treated as resolved query results?"*

**No, and it is not a bug.** Separating data-visibility from sync-ready is deliberate in 0.6.x. The project's position (visible in `manual-sync.ts` + `lifecycle.ts`) is that readiness is the sync's responsibility; the collection has no way to know whether `writeBatch` data is "complete" or "partial stale." A future release might add an `acknowledge`/`markReady` utility on `queryCollectionOptions` so a cache-seed can end the loading state, but nothing in 0.6.4 exposes one.

## 2. The OPFS bug we uncovered while investigating

Unrelated to #7's stated scope, but dispositive for the "is OPFS cache resolution ~1ms?" question: **OPFS is not the cache we're measuring, because OPFS persistence never wires up.**

### 2.1 Evidence

`apps/orchestrator/src/db/db-instance.ts:14-45`:

```ts
let persistence: Persistence | null = null          // line 18
export const queryClient = new QueryClient()

async function initPersistence(): Promise<Persistence | null> {
  // ... awaits navigator.storage.getDirectory() + openBrowserWASQLiteOPFSDatabase
}

export const dbReady = initPersistence().then((p) => {
  persistence = p                                    // resolves later
  return p
})

export { persistence }                               // still `null` at import time
```

ES module top-level code runs synchronously. By the time any collection module imports `{ persistence }`, it sees `null` — the `dbReady` promise has not resolved.

All three collection files check `if (persistence)` synchronously at module body level:

- `sessions-collection.ts:38` — inside `createSessionsCollection()`, called at line 53
- `tabs-collection.ts:71` — inside `createTabsCollection()`, called at line 84
- `messages-collection.ts:31` — inside `createMessagesCollection()`, called at line 46

So every collection instantiates on the non-persisted code path. The OPFS SQLite WASM and worker never service any of them.

### 2.2 What the code actually persists today

| Surface | Claimed | Actual |
|---|---|---|
| `sessionsCollection` | "Persisted to OPFS SQLite (schema version 1)" (header comment) | Memory + `localStorage['duraclaw-sessions']` via `persistSessionsToCache` |
| `tabsCollection` | "Persisted to OPFS SQLite (schema version 1)" (header comment) | Memory only. Authoritative copy on UserSettingsDO, manually mirrored via `useUserSettings`. |
| `messagesCollection` | "Persisted to OPFS SQLite (schema version 1)" + "30-day age-based eviction" (header comment) | Memory only. Per-session rehydrate from DO on every WS connect. |

The `evictOldMessages()` function in `messages-collection.ts:49-72` is cosmetic — nothing survives the page reload to be evicted.

### 2.3 Fix shapes (for a separate cleanup PR)

Three options, in order of invasiveness:

**A — await dbReady in the entry point.** One-line change in `entry-client.tsx`: `await dbReady` before `createRoot().render()`. Delays first paint by however long OPFS open takes (typically <50 ms when available). Collections then instantiate on the first dynamic import after hydration. Requires moving all collection imports to lazy/dynamic imports, which ripples through every `use-*-collection.ts` consumer.

**B — factory pattern.** Replace `export const sessionsCollection = createSessionsCollection()` with `export const getSessionsCollection = async () => ...`. Breaks every synchronous reader (e.g. the `lookupSessionInCache` flow) and every `useLiveQuery(sessionsCollection)` call site. High cost.

**C — late rewrap (requires upstream support).** TanStack DB would need to support re-wrapping an already-created collection with `persistedCollectionOptions` after creation. Not in 0.6.4.

The right order of operations is: decide whether OPFS earns its weight at all (we can answer that independently — see §4 below), and if yes, land option A. Fixing the bug does *not* retroactively make issue #7's gate idea viable.

## 3. What "proper TanStack DB use" looks like for our shape

Our data surfaces, and how they fit (or don't) TanStack DB's grain:

| Surface | Shape | Write pattern | Good fit? |
|---|---|---|---|
| `sessions` (list for sidebar, metadata lookup) | List, ~dozens to thousands, read-mostly | HTTP pull every 30s; optimistic CRUD; DO WS patches per session | **Yes for catalog reads.** Query-collection + optional OPFS persistence is the shape TanStack DB is built for. |
| `tabs` (per-user ordered list) | Tiny list (<20), read-write, cross-device sync | CRUD via HTTP; WS broadcast from UserSettingsDO | **Mismatch.** No queries, no joins, two-writer problem (queryFn vs. WS broadcast is already observed in the state-management audit). A plain zustand store with write-through to the DO is strictly simpler. |
| `messages` (per-session chat log) | Linear append-only stream, per session, grows unbounded | WS push (`partial_assistant`, `assistant`, `tool_result`, …); no user writes | **Wrong abstraction.** TanStack DB wants optimistic mutations + sync; we want an append-only log with seq-numbered deltas. The audit's Phase 2 target (DO SQLite + cursor-based one-way sync → collection) is the correct shape; the current `localOnlyCollection` is a placeholder. |

### 3.1 Keeping TanStack DB where it actually wins

The places TanStack DB's design genuinely pays off here:

1. **`sessions` collection** — list queries, archive filter, sort-by-activity, optimistic rename/archive. All good. Keep as-is; fix OPFS; trust the `data` array on first render (not `isLoading`); retire `lookupSessionInCache` once the zustand store from #5 owns tab creation.
2. *(none of the other two collections today)*

### 3.2 Where it loses

- **Tabs:** TanStack DB adds a `useLiveQuery` hop and a second writer (queryFn reconciliation vs. WS broadcast) to data that is cross-device-synced via a specific DO and rendered synchronously by callers (`getUserSettings()`, keyboard shortcuts). The store owns the race; TanStack DB just forwards it.
- **Messages:** WS-only with no offline write path, hydrated on every reconnect from the DO — the collection is a cache-with-eviction, not a synced store. Appending via `messagesCollection.insert(...)` after the DO broadcasts is doubled work; reading via `useLiveQuery` is a live view over the same data. The Phase 2 target in the state-management audit (seq-numbered append log, cursor-based delta sync) lets `messagesCollection` become a true replica — the design it wants — but that's a deeper refactor than #7.

### 3.3 How #5's refactor "uses TanStack DB properly"

Under #5's design the answer is: *don't use TanStack DB for tab state at all* (it has no query-shaped benefit), and use it only for the sessions catalog and (post-Phase-2) the message replica. Issue #7's framing — "fix it inside TanStack DB" — is an over-reach in scope: the problem isn't a timing bug in the library, it's that the library is the wrong tool for two of our three surfaces.

## 4. Answering issue #7's explicit questions

From the issue body:

**1. Verify the timing: Is OPFS cache resolution actually ~1ms?**
N/A. OPFS is not resolving our collections at all (§2). The actual "instant data" path today is `localStorage.getItem('duraclaw-sessions')` → `JSON.parse` → `writeBatch`, executed synchronously at module load. That is fast (sub-ms), but it sets `data`, not `isLoading: false`.

**2. Test writeBatch behavior: Has TanStack DB fixed the issue where writeBatch data isn't treated as resolved query results?**
No. The separation is deliberate in 0.6.x (`manual-sync.ts:152-154`, `lifecycle.ts:134-151`). `writeBatch` is data-plane; `markReady` is control-plane. Library semantics won't change to paper over the gate idea.

**3. Deep-link UX: Is a single-frame skeleton acceptable on push notification taps?**
Not single-frame — full network round-trip. 100 ms–seconds, not 1 ms. For push notifications on mobile especially, this is a visible regression over today's instant paint.

**4. Effect chain simplification: With the loading gate, can the entire URL→tab→session effect chain be replaced with a single useEffect at mount?**
The effect chain *can* be flattened, but not because of the gate. Flattening falls out of #5's design — one module-load `activateSession(sessionId)` call plus a store→URL subscription. The gate by itself doesn't simplify the effects; it just hides them behind a skeleton.

**5. Edge case: empty OPFS on first-ever load. Is the skeleton acceptable for that case?**
First-ever load has no cache and no useful data regardless of approach. A skeleton is acceptable. But this is the *only* case where the gate idea doesn't make things worse — the other 99% of loads are today's instant paint, which the gate would convert into network-bounded skeletons.

## 5. Decision

- **Loading gate fix: reject.** Would cause a UX regression on the common case to eliminate band-aids that #5's refactor eliminates cleanly anyway.
- **Issue #5's refactor (zustand synchronous store + TanStack DB as catalog reader): proceed.** Its root-cause analysis remains correct after this deeper library check. TanStack DB is not the problem for the one collection that actually benefits from it (sessions); it *is* the wrong tool for tabs.
- **OPFS persistence bug: file a separate cleanup.** Either wire it up correctly (option A, await `dbReady` in entry) or delete the OPFS dependencies entirely. Today they cost bundle size for zero runtime value. Do not conflate with #7.
- **Comment audit:** the collection files claim OPFS behaviour they don't exhibit. Fix the comments in the same cleanup PR that addresses the OPFS wiring (or removes it).

## 6. Open questions

- If we fix OPFS wiring (option A above), does `queryCollectionOptions` treat a successful persistence hydrate as ready before `queryFn` resolves? Reading the 0.6.4 source, it does not — `markReady` is still gated on `queryFn`. Would need to confirm on a newer/experimental release before betting on it.
- Does TanStack DB expose an `acknowledgeInitial()` / `markReadyFromSeed()` primitive on `queryCollectionOptions` in later versions? Worth checking before retrying any `isLoading`-based approach in future. As of 0.6.4 the answer is no.
- Is there appetite to upstream a "cache-first ready" option? Out of scope for this research, but the pattern (seed from cache → report ready → reconcile with server in background) is general and would benefit more than Duraclaw.

## 7. Sources

- `apps/orchestrator/src/db/sessions-collection.ts` (full)
- `apps/orchestrator/src/db/tabs-collection.ts` (full)
- `apps/orchestrator/src/db/messages-collection.ts` (full)
- `apps/orchestrator/src/db/db-instance.ts` (full)
- `apps/orchestrator/src/hooks/use-sessions-collection.ts` (full)
- `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx` (lines 1-147, 270-311)
- `node_modules/@tanstack/db/src/collection/lifecycle.ts:73-151`
- `node_modules/@tanstack/db/src/sync/manual-sync.ts:138-227`
- `node_modules/@tanstack/db/src/collection/persisted.ts:889-908, 1098-1248`
- `node_modules/@tanstack/react-db/src/useLiveQuery.ts:275-540`
- `node_modules/@tanstack/browser-db-sqlite-persistence/README.md`
- `planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md`
- `planning/research/2026-04-16-state-management-audit.md`
