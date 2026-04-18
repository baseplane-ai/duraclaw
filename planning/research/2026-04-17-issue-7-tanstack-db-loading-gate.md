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

## 7. Correction — `persistedCollectionOptions` DOES fast-track `markReady`

**The original analysis below misread the library.** After a further source trace (prompted by pushback — "if the collection has ever been loaded it will be insanely fast"), this correction changes the recommendation materially.

### What I missed

The `markReady` calls I cited earlier (`@tanstack/query-db-collection/src/query.ts:1328, 1390`) are the ones that fire when the **inner query sync** resolves — i.e. when `queryFn` returns. That path is real, but it is **not the sync that the persisted collection registers with the lifecycle.**

`@tanstack/db-sqlite-persistence-core/src/persisted.ts:2721-2725` returns a `PersistedSyncOptionsResult` whose `sync` is **not** the wrapped `queryCollectionOptions`; it is a **loopback**:

```ts
return {
  ...localOnlyOptions,
  id: collectionId,
  persistence,
  sync: createLoopbackSyncConfig(runtime),   // ← this is the collection's real sync
  // ...
}
```

And `createLoopbackSyncConfig` (`persisted.ts:2522-2563`) calls `markReady()` as soon as `runtime.ensureStarted()` resolves:

```ts
function createLoopbackSyncConfig(runtime) {
  return {
    sync: (params) => {
      runtime.setSyncControls({ begin: params.begin, write: params.write, commit: params.commit, … })
      void runtime.ensureStarted()                           // OPFS DB open + rows loaded
        .then(() => { params.markReady() })                  // ← mark ready from OPFS, NOT from queryFn
        .catch(() => { params.markReady() })
      // …
    },
    getSyncMetadata: () => ({ source: `persisted-phase-2-loopback` }),
  }
}
```

In the two-phase architecture ("phase 1" is the `queryFn`-backed source sync feeding OPFS; "phase 2" is the loopback that the collection actually registers), **readiness is gated on OPFS hydration, not on `queryFn` settling.** The query sync's own `markReady` call (at `query.ts:1328`) gets wrapped (`persisted.ts:2242-2253`) and serves a different role — signalling that the "source" has produced its first result, used internally for retention maintenance — not the collection's overall readiness.

### What this means concretely

For a `persistedCollectionOptions({ persistence, ...queryCollectionOptions(...) })` collection:

| Case | Time to `isReady: true` | `data` at that moment |
|---|---|---|
| Warm load, OPFS has cached rows | OPFS DB open + row load (typically 5–50 ms) | Populated from OPFS |
| First-ever load (empty OPFS) | OPFS DB open (typically 5–30 ms) | `[]` |
| OPFS unavailable (fallback path) | Falls back to non-persisted sync → `queryFn` round-trip | whatever `queryFn` returned |

So issue #7's core premise — *"~1ms one imperceptible frame between module load and cache resolution"* — is **approximately correct for warm loads** once OPFS is actually wired up. A sub-50 ms skeleton on warm reload is a defensible UX, and the "hundreds of ms to seconds" concern in §1.2 applies only to the broken-OPFS path that Duraclaw is currently on (per §2).

### What DOES still block issue #7 today

**The OPFS bug from §2.** As long as `persistence` is `null` at collection-creation time, `persistedCollectionOptions` is never applied, so the loopback sync never exists, so `markReady` falls through to the query-db-collection path (`query.ts:1328`) which genuinely does wait for `queryFn`. **Until that bug is fixed, the gate proposed in #7 behaves exactly as §1 describes — a network-bounded skeleton, not a one-frame gate.** The library isn't the bottleneck; our wiring is.

### Revised recommendation

Two viable shapes, different risk profiles. Both assume fixing the OPFS wiring first.

**(a) Fix OPFS wiring + implement issue #7's gate** (fastest path to closing #7)

1. Land the OPFS fix (`await dbReady` in entry-client — §2.3 option A). This is the precondition for anything.
2. Verify empirically (DevTools performance profile) that `isReady: true` fires within ≤50 ms on warm reload after a prior session.
3. Replace the `useState` init + `lookupSessionInCache` + URL-sync effect chain with the gate from the issue: `if (!isReady) return <AppShell />`. Sessions + tabs then arrive together with valid data.
4. Keep the first-ever-load skeleton. No cache means `isReady` fires early with empty `data`; render accordingly.
5. First-ever load: `data` is still `[]` when `isReady` fires. Component must handle "ready but empty" as a distinct state from "loading" (show empty tab bar, spawn form, etc.). This is the same state the app already reaches after the queryFn returns an empty array, so it's not new UX territory.

**(b) Ship issue #5's zustand refactor** (deeper, structural, closes more failure modes)

Everything §2–§6 of the sibling root-cause doc argues for still applies. The refactor removes a whole class of races structurally, not just "makes them fast enough to not fire." It also doesn't depend on OPFS working. Considerations beyond pure timing — the two-writer races between queryFn and WS broadcast for tabs, the archived-session deep-link, cross-device tab sync — are not solved by the gate alone.

**My now-corrected take.** The gate really is the cheaper fix if the only goal is closing #7 in the common warm-reload case. But it still leaves the underlying architecture (tabs in TanStack DB, placeholder-tab logic, URL↔state effect chain) intact, and those remain the root cause of the non-timing failure modes. If we believe the issue #5 refactor is landing on its merits anyway, the gate is make-work; if we want the fastest possible patch to stabilize the current UX before #5 is ready, the gate is reasonable — but it requires the OPFS fix first.

Either way, **the OPFS wiring bug is the highest-leverage fix** — it's currently eating its bundle cost for zero runtime value, and it unblocks this whole conversation.

### Corrections to earlier sections

- §0 TL;DR line "the cheap one-frame gate doesn't exist" — **corrected: the one-frame gate exists in the library, but only when `persistedCollectionOptions` actually wraps the collection, which today it does not.**
- §1.1 table "writeBatch/OPFS rehydrate: isLoading → false? No" — **corrected for the persisted code path:** OPFS rehydrate (via `createLoopbackSyncConfig.ensureStarted().then(markReady)`) DOES flip `isLoading` to `false`. `writeBatch` still does not.
- §1.2 "full network round-trip, 50–200 ms best-case" — **applies only to the currently-broken OPFS path.** With OPFS wired up, warm-load gate is 5–50 ms.
- §4 Q1 "N/A. OPFS is not resolving our collections at all" — still accurate today, but the library-semantics answer would change once OPFS is wired: warm-load hydration is indeed ≈1 frame on modern browsers.
- §5 Decision "Loading gate fix: reject" — **revised: reject as currently architected (OPFS broken); would be viable after OPFS fix.** #5's refactor still preferred on architectural grounds beyond timing.

## 8. Addendum — confirmed against the public `useLiveQuery` docs

Verified at https://tanstack.com/db/latest/docs/framework/react/reference/functions/useLiveQuery (2026-04-17):

The hook returns a superset of flags beyond `isLoading`: `{ data, collection, state, status, isIdle, isLoading, isReady, isError, isCleanedUp, isEnabled }`. The existence of a distinct `isReady` flag raised a reasonable question — maybe `isReady` is the "data visible, still fetching" signal, separate from `isLoading`. It is not.

`useLiveQuery.ts:541`:

```ts
isReady: snapshot.collection.status === 'ready'
```

`useLiveQuery.ts:540`:

```ts
isLoading: snapshot.collection.status === 'loading'
```

Both flags reduce to `collection.status`. With the three-state machine `idle → loading → ready`, `isReady` is simply the inverse of `isLoading` (with `isIdle` capturing the pre-start state). There is no separate "data hydrated but sync not complete" signal exposed by the hook.

Where `markReady()` is actually called for `queryCollectionOptions`:

`query-db-collection/src/query.ts:1328`:

```ts
// Mark collection as ready after first successful query result
markReady()
```

`query-db-collection/src/query.ts:1390`:

```ts
// Mark collection as ready even on error to avoid blocking apps
markReady()
```

Confirmed: `ready` is gated on `queryFn` settling (success or error). Not on `writeBatch`, not on persistence hydrate. `@tanstack/browser-db-sqlite-persistence` does not call `markReady` at all — it is a pure persistence adapter; readiness remains the sync's job.

The `db-core/custom-adapter/SKILL.md` bundled with `@tanstack/db` reinforces this:

> `markReady()` transitions the collection to "ready" status. Without it, live queries never resolve and `useLiveSuspenseQuery` hangs forever in Suspense.

Reaffirms the decision in §5: issue #7's "skeleton, ~1ms" gate doesn't exist in the library as shipped. Reject the gate; proceed with #5.

## 9. Second correction — TanStack DB's joins make zustand redundant

Further pushback, steelmanned: **"TanStack DB can do joins client-side when everything is in collections. There's no reason to use zustand. Move all metadata out of the Durable Objects into SQL (D1), then use TanStack DB's sync path. That's the beauty of it."**

This is a better architecture than §7(a) or §7(b). The "gate vs zustand" framing was a false dichotomy created by the original placeholder-tab-metadata problem. Once joins are in the picture, the problem dissolves without either workaround.

### 9.1 The join API, verified

`@tanstack/db/src/query/builder/index.ts:188-344` exposes `join`, `leftJoin`, `rightJoin`, `innerJoin`, `fullJoin` on the query builder. Both operands are collections; the join is evaluated client-side over their `syncedData`. Example from the library JSDoc (`index.ts:174`):

```ts
query
  .from({ users: usersCollection })
  .join({ posts: postsCollection }, ({users, posts}) => eq(users.id, posts.userId))
```

Types propagate — `MergeContextWithJoinType` at `index.ts:198` gives full inference for inner/left/right/full semantics. Subquery joins are supported (`index.ts:182-186`).

For our case, the tab-bar query becomes a one-liner:

```ts
const { data: rows, isReady } = useLiveQuery(q =>
  q.from({ tab: tabsCollection })
   .leftJoin({ session: sessionsCollection }, ({tab, session}) =>
     eq(tab.sessionId, session.id))
   .orderBy(({tab}) => tab.order)
)
// rows: Array<{ tab: TabRef, session: SessionRecord | undefined }>
```

Every tab renders from its joined session. No embedded `project`, no embedded `title`, no placeholder `"unknown"`, no backfill effect. The join output reactively updates when either side changes — a WS push to `sessionsCollection` propagates to tab labels with no explicit plumbing.

### 9.2 The full architecture this unlocks

| Layer | As-built | Preferred |
|---|---|---|
| Session index | `ProjectRegistry` DO SQLite (singleton) | **D1 table** (`chat_sessions`) |
| User settings (tabs, drafts, prefs, tab order) | `UserSettingsDO` (per-user) | **D1 tables** (`user_tabs`, `user_drafts`, `user_preferences`) |
| Client-side replica | Mixed: TanStack DB (sessions), manual zustand (UserSettingsDO mirror), localStorage band-aids | **TanStack DB collections for all of the above, via `queryCollectionOptions` + OPFS persistence** |
| Client render path | `useState` init + `lookupSessionInCache` + effect chain + WS broadcast patches | `useLiveQuery(q => q.from(tabs).leftJoin(sessions))` — one query, reactively joined, OPFS-hydrated |
| Cross-device sync | Custom UserSettingsDO HTTP + WS protocol | Normal HTTP CRUD against D1-backed endpoints + standard `queryCollectionOptions` refetch / optional WS push |
| Loading state | Ad-hoc (null checks, "unknown" sentinels) | `isReady` from the loopback (OPFS open, 5–50 ms warm) |

This is strictly the architecture the state-management audit (`2026-04-16-state-management-audit.md` §Target architecture) already pointed at, minus the zustand detour that §5's root-cause doc proposed. The zustand proposal was a defensible response to *"TanStack DB isn't actually giving us a synchronous store"*, which was true only because (a) joins were unused and (b) OPFS persistence was unwired. Fix both and the zustand layer has no job left to do.

### 9.3 Why zustand falls out of the picture

Issue #5's design put zustand in front as the synchronous store, with TanStack DB reduced to a catalog reader. The reasons zustand was winning that comparison were:

1. Synchronous hydration (`persist` runs during `create`).
2. Holds derived/joined data (tab → session metadata lookup).
3. Keyboard shortcuts / non-hook callers read state synchronously via `getState()`.

Under the join architecture, each reason dissolves:

1. **Synchronous hydration:** `persistedCollectionOptions` + the fixed OPFS wiring hydrates collections from SQLite before `markReady` fires (§7 correction). Sub-50 ms warm, sub-30 ms first-open — the same order of magnitude as zustand's `localStorage.getItem` + `JSON.parse`. The timing gap that made zustand look decisive is ~20 ms at most, and it's on the skeleton path — no visible flash.
2. **Derived data:** that's what the join query is for. Joins are reactive and type-safe; manual store-projections are neither.
3. **Synchronous non-hook access:** `collection.get(key)` / `collection.values()` / `collection.toArray()` are synchronous reads from `syncedData`. Keyboard shortcuts at `AgentOrchPage.tsx:270-311` that currently call `getUserSettings()` can equally well call `tabsCollection.get(activeId)` or run an in-memory query. No hook required.

And there's a downside to keeping zustand: you now have two stores of truth for tab state. Either (a) zustand is authoritative and TanStack DB becomes a catalog-only dependency that's worse than a direct fetch, or (b) TanStack DB is authoritative and zustand is a mirror that must stay in sync — precisely the band-aid problem in different clothing.

### 9.4 What this does and doesn't solve, compared to §7(a)/(b)

| Failure mode | §7(a) gate-only | §7(b) zustand | §9 joins + D1 |
|---|---|---|---|
| Push-notification tap shows "unknown" badge | Hidden behind skeleton | Eliminated (synchronous cache) | **Eliminated by construction** (no per-tab metadata to be stale) |
| Placeholder tab persists after sessions load | Hidden behind skeleton | Eliminated (no placeholder written) | **Eliminated** (tab has no `project`/`title` field) |
| Archived-session deep link | Hidden behind skeleton | Eliminated (sessions slice covers archived) | **Eliminated** (join reads from sessions regardless of archived filter on the sidebar view) |
| Two-writer race: queryFn vs WS broadcast for tabs | Not addressed | Eliminated (zustand is sole writer) | **Eliminated** (D1 is sole source; WS patches `sessionsCollection`, not `tabsCollection`) |
| Cross-device tab sync | Not addressed | Write-through to UserSettingsDO | **Trivial** — D1 tables, optionally with a WS invalidation channel for live propagation |
| Offline tab mutation durability | Not addressed | Manual queue work | **Free** — `queryCollectionOptions` optimistic mutation pattern already provides it |
| Cold-load first-ever skeleton | ~5–30 ms (OPFS open) then empty `[]` | Sub-ms localStorage parse then empty `[]` | ~5–30 ms OPFS open then empty `[]` (network populates) |

The join architecture wins or ties on every row and introduces no new failure class.

### 9.5 Revised recommendation (final)

Land three changes in order, each shippable independently:

1. **Fix OPFS wiring** (`await dbReady` in entry — §2.3 option A). Precondition for everything. Also delete the false "Persisted to OPFS SQLite" comments from collection files or update them to reflect the fixed behaviour.
2. **Migrate session index + user settings (tabs, drafts, prefs, tab order) to D1.** This is state-management-audit Phase 1, expanded to cover UserSettingsDO as well. Endpoints become Drizzle queries against D1; `queryCollectionOptions` points at them. Delete `ProjectRegistry` DO and `UserSettingsDO` HTTP/WS plumbing.
3. **Rewrite `AgentOrchPage` and tab-bar components around join queries.** Drop `seedFromCache`, `lookupSessionInCache`, the entire URL-sync effect chain (`AgentOrchPage.tsx:83-147, 388-413`), and the placeholder tab-creation logic. Replace with: one `useLiveQuery` join for the tab bar, one `useLiveQuery` for the sidebar session list, one `history.replaceState` subscription for URL sync.

Step 1 alone closes issue #7's immediate symptom (gates collapse to ≤50 ms warm). Steps 2+3 close the architectural root cause. Skip the zustand refactor proposed in #5 — the join architecture supersedes it.

### 9.6 Corrections propagated

- §5 "Loading gate fix: reject" → **further revised: gate is moot under the join architecture**; `isReady` arrives fast enough on warm load that no explicit gate is needed — just render the joined rows directly and let the skeleton be the 1-frame natural loading state.
- §5 "#5's refactor: proceed" → **superseded**: the join architecture delivers the same guarantees without the zustand layer. Recommend redirecting #5 to "migrate metadata to D1, rewrite tab-bar around a join query."
- §3.1 "Mismatch — tabs have no queries/joins, plain zustand is simpler" → **wrong call in hindsight**: the tab collection *does* have a query (the join against sessions), once you allow yourself to use joins. I missed that in the first pass because the current code embeds metadata on the tab, avoiding the join.

### 9.7 Residual open questions

- **OPFS availability on the mobile PWA path**: iOS Safari's OPFS support is spotty in older WebKit builds. If we ship joins + OPFS-required synchrony, confirm the fallback (in-memory + server fetch) degrades gracefully. Today the app already falls back (memory-only), so baseline survives; only the "instant warm reload" property is browser-dependent.
- **WS push into D1-backed collections**: D1 has no native push. Two options — (a) polling at 15–30 s (current `refetchInterval`) is fine for session-status freshness since the hot path is the DO WS anyway; (b) add a thin WS invalidation channel (per-user) that triggers `collection.utils.refetch()` when another device writes. Option (a) is the cheaper default.
- **Drafts with per-keystroke writes**: drafts live in `user_drafts` in D1. The existing debounce pattern applies. No functional change from today.
- **Archive filter for sidebar vs tab bar**: sidebar filters `!archived`; tab bar does not (an archived session in an active tab stays usable). The filter is a `.where` clause on the sidebar's `useLiveQuery`, applied after the same join. Same data, different view.

## 10. Third refinement — UserSettingsDO becomes an invalidation event bus

Further pushback, steelmanned: **"UserSettingsDO just becomes an event bus for cache invalidation."**

This closes §9.7 open question (b) and is the right shape. The DO keeps its seat at the table but stops pretending to be a store. It becomes a per-user authenticated WebSocket fanout — Cloudflare's natural strength — and nothing more.

### 10.1 The separation of concerns

| Concern | Owner | Why |
|---|---|---|
| Source of truth for tabs/drafts/prefs/sessions | **D1** | Relational, queryable, cheap reads, joinable, indexed |
| Client replica + reactive render | **TanStack DB collections** (OPFS-persisted) | Optimistic mutations, joins, live queries |
| Cross-device/-tab propagation | **UserSettingsDO** | Per-user auth envelope + stateful WebSocket fanout |
| Mutation path | Client → HTTP POST/PATCH → Worker → D1 → notify DO | Single-writer path, RESTful, cacheable, auditable |

The DO's `storage` API stays empty (or used only for presence/heartbeats). Its code surface shrinks to: accept WebSocket upgrades, authenticate, maintain a `Set<WebSocket>` of the user's connected clients, broadcast invalidation messages posted to it by the Worker after a D1 commit.

### 10.2 Wire protocol

DO → client, over the per-user WebSocket:

```ts
type InvalidationEvent =
  | { type: 'invalidate', collection: 'tabs' | 'drafts' | 'preferences' | 'sessions' }
  | { type: 'invalidate', collection: string, keys: string[] }  // fine-grained
  | { type: 'hello', connectedCount: number }                     // presence
```

Worker → DO (internal, via DO stub), on every mutation:

```ts
await env.UserSettings.idFromName(userId).fetch('https://do/notify', {
  method: 'POST',
  body: JSON.stringify({ collection: 'tabs', keys: [tabId] }),
})
```

Client handler:

```ts
socket.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type === 'invalidate') {
    const c = collectionsByName[msg.collection]
    if (msg.keys) c.utils.refetchKeys?.(msg.keys) ?? c.utils.refetch()
    else c.utils.refetch()
  }
}
```

No payload replication in the broadcast — just "something changed, go refetch." That keeps the DO's message size bounded and avoids the DO ever becoming a cache that must stay consistent with D1.

### 10.3 Why this is strictly better than the alternatives

- **vs. polling (§9.7 option a):** sub-100 ms cross-device propagation instead of 15–30 s. Fewer redundant D1 reads (polls only fire when something actually changed). No change to the "happy path" bundle size — we already have a WS to the SessionDO for hot chat traffic; this is a second, long-lived per-user connection with trivial CPU cost.
- **vs. today's UserSettingsDO-holds-state:** eliminates the DO's biggest liability — it's a single-writer store for list-shaped data that D1 models natively. Migrations, indexing, full-text search, admin queries all become normal SQL. The DO stops being a data-gravity trap.
- **vs. TinyBase-style CRDT sync (issue #6):** no CRDT merge logic, no schema duplication on the DO side, no third sync system. D1 is authoritative; last-writer-wins on conflicting writes is fine for tab order and draft snapshots (and drafts already have the Yjs path for sub-keystroke granularity via #4).
- **vs. broadcasting full deltas:** no risk of DO and D1 drifting. The DO literally cannot know stale data because it never holds any.

### 10.4 DO footprint after the refactor

```ts
export class UserSettingsDO {
  sockets = new Set<WebSocket>()

  async fetch(req: Request) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') return this.handleUpgrade(req)
    if (url.pathname === '/notify') {
      const msg = await req.text()
      for (const ws of this.sockets) try { ws.send(msg) } catch {}
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  handleUpgrade(req: Request) { /* standard WS upgrade + auth */ }
}
```

Everything else — `getUserSettings`, `patchUserTabs`, `saveDraft`, all the current persisted state — is deleted. Those paths become D1 queries in normal TanStack Start API routes. The DO goes from a few hundred lines of storage logic + schema migrations to ~40 lines of WebSocket fanout.

### 10.5 Migration ordering

1. **OPFS wiring fix** (unchanged, still step 1 — precondition for everything).
2. **Add D1 tables** `user_tabs`, `user_drafts`, `user_preferences`. Create Drizzle schemas + endpoints.
3. **Add the notify channel on UserSettingsDO**, no-op on clients yet. Worker mutation endpoints start firing `/notify` after D1 commits.
4. **Client adds the WS subscription** and refetch handler. At this point invalidations flow but clients still read from the old UserSettingsDO storage.
5. **Dual-write window**: mutations go to both D1 and UserSettingsDO storage. Reads still come from DO.
6. **Flip reads to D1-backed collections.** Remove dual-write. Delete the DO storage code and schema migrations. DO is now just the fanout.
7. **Rewrite tab bar around the join query** (§9 step 3).

Steps 3-6 are the classic expand/migrate/contract pattern and can ship incrementally without a feature flag if we accept a short dual-write period.

### 10.6 Corrections propagated

- §9.7 open question (b) "add a thin WS invalidation channel" → **that's exactly what UserSettingsDO becomes**; not a new piece of infra, a repurposing of existing infra.
- §9.2 architecture table, "User settings" row → revised: D1 is the store, **UserSettingsDO is the invalidation event bus**, not "deleted."
- Issue #6 "Unify storage to D1 + TinyBase real-time sync via UserSettingsDO" → **reframed**: the title is right, but TinyBase isn't needed. D1 + per-user WS invalidation channel through the same DO is a smaller, simpler shape that achieves the same goal.

## 11. Sources

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
- `node_modules/.pnpm/@tanstack+db-sqlite-persistence-core@0.1.8_typescript@5.8.3/.../persisted.ts:2210-2563, 2721-2733` (the correction in §7)
