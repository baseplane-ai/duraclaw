# StreamDB Pattern Adoption — collection-level sync primitives

**Date:** 2026-04-20
**Status:** Implemented — see `planning/specs/28-synced-collections-pattern.md` (GH#32). The forward-looking "collection-level sync primitives" recommendation landed as `createSyncedCollection` in `apps/orchestrator/src/db/synced-collection.ts`, driving `user_tabs`, `user_preferences`, `projects`, and `chains`. Y.Doc retired from `UserSettingsDO`; delta frames replace polling + invalidation-refetch.
**Owner:** dev3

## Context

Three commits tried to fix the streaming regression. The first two mis-diagnosed:

- `d250345` ("replace useLiveQuery IVM with direct subscribeChanges for messages") worked around the symptom with `useSyncExternalStore` + `collection.subscribeChanges`. Bypass, not a fix.
- `97ddcdb` ("switch messagesCollection to syncMode eager for IVM reactivity") flipped `syncMode: 'on-demand' → 'eager'` and claimed this made IVM reactive to bare mutations. User-reported: still broken. The claim doesn't match the source — `syncMode` controls *when queryFn fires*, not IVM propagation.

### Actual root cause (verified against `@tanstack/db@0.6.4` source)

TanStack DB's `queryCollection` has two data layers:

- **Synced state** (`_state.syncedData: SortedMap`) — the server-authoritative projection that IVM / `useLiveQuery` subscribes to. Populated by `queryFn` and by `utils.writeInsert / writeUpdate / writeDelete / writeUpsert / writeBatch`.
- **Optimistic state** (`_state.optimisticUpserts` / `optimisticDeletes`) — where `collection.insert / update / delete` write. These are user-initiated mutations that round-trip through `onInsert / onUpdate / onDelete` handlers registered in the collection config.

Our WS handler called `messagesCollection.insert/update/delete` from the delta/snapshot path. Those writes landed in the optimistic layer. IVM projects off the synced layer, so `useLiveQuery` never saw them. `subscribeChanges` fires across both layers, which is why the `d250345` bypass worked.

### The right API

`@tanstack/query-db-collection` exposes sync-write utilities on `collection.utils` (type doc at `node_modules/@tanstack/query-db-collection/dist/esm/query.d.ts` lines 62–81):

```
writeInsert(data)              // direct insert into syncedData
writeUpdate(data)              // direct update
writeDelete(keys)              // direct delete
writeUpsert(data)              // insert-or-update
writeBatch(() => { ... })      // atomic batch, calls collect via begin/write/commit
```

Implementation (`manual-sync.js`) does `ctx.begin({immediate:true}) / ctx.write(...) / ctx.commit()` on the sync layer, then `queryClient.setQueryData(queryKey, updatedData)` to keep the TanStack Query cache coherent. This is exactly what StreamDB uses internally — the "every write is a server-authoritative sync" pattern.

### Fix

`apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` — WS delta/snapshot handler for messages now calls `messagesCollection.utils.writeUpsert / writeDelete` inside `utils.writeBatch(...)`. User-initiated `sendMessage` still uses `createTransaction` + `tx.mutate(() => coll.insert(...))` (correct: that IS an optimistic round-trip).

The action-wrapping idea originally proposed as "Step 1" was wrong — actions are for optimistic round-trip, not for server-originated writes. The correct primitive for server-origin writes is the sync-write API.

The rest of the proposal below (uniform offset/catch-up, multiplexing, txid round-trip, derived collections) stands on its own as a forward-looking architectural direction.

## Our architecture today vs StreamDB primitives

| | **StreamDB** | **Us (duraclaw, 2026-04-20)** |
|---|---|---|
| Schema | One `createStateSchema({ entity: { schema, type, primaryKey } })` call | One file per collection (`messages-collection.ts`, `branch-info-collection.ts`, `session-live-state-collection.ts`, `user-tabs-collection.ts`, `user-preferences-collection.ts`, `projects-collection.ts`, `chains-collection.ts`) with ad-hoc options |
| Source of truth | Durable Stream (append log at URL) | SessionDO SQLite (per session); D1 for user-level data |
| Offset | Single monotonic offset per stream | Per-session `messageSeq` on DO + `lastSeq` Map on client. Nothing equivalent for user-level collections. |
| Catch-up | Client resumes from last offset | `snapshot` frame on reconnect / gap; `delta` otherwise |
| Multiplexing | One stream, `type` field routes to N collections | One WS per SessionDO; `branchInfo` piggybacks on messages snapshot payload. User-level collections have separate REST + invalidation stories. |
| Writes | Actions only: `onMutate` + `mutationFn` + `awaitTxId(txid)` | Mixed: user turns go through `createTransaction`; WS delta handler writes are bare `coll.insert()` / `coll.update()` — this is the bug. |
| Local echo | TanStack DB deep-equality reconciles echo with optimistic row | Same, but overloaded onto primary key (`usr-client-<uuid>`) because we have no txid channel |
| Reactivity | `useLiveQuery` (IVM) — works because every write is an action | Had to switch messages to `useSyncExternalStore` + `subscribeChanges` because bare WS writes bypass IVM. Other collections still on `useLiveQuery`, still at risk. |

## Four primitives worth stealing

### 1. Uniform offset/catch-up across ALL entity types

Today only the per-session messages stream has seq/snapshot/delta. `user-tabs`, `user-preferences`, `projects`, `chains` each invent their own sync. Extend the seq+snapshot+delta pattern to a generic `SyncedCollection` primitive and migrate every collection onto it.

### 2. Declarative multiplexing

Today `branchInfo` piggybacks on the messages snapshot payload because we didn't want a second frame type. With typed routing, every entity is first-class: `{type, seq, payload}` on the wire; client has a `type → collection` dispatch table.

### 3. `awaitTxId` as an explicit primitive

We rely on id-echo + deep-equality (`usr-client-<uuid>` becomes the server-assigned primary key). A txid handshake gives us "this write is confirmed" as a Promise return value. Kills the primary-key overload hack and lets updates/deletes round-trip cleanly, not just inserts.

### 4. Derived collections with IVM

`createLiveQueryCollection` already exists in `@tanstack/db@0.6.4`. We just haven't used it. Candidates:

- `messagesByParent` — `messages` grouped by `parentMsgId`, drives branch-arrow UI without `branchInfo` being a separate collection at all
- `sessionsByProject` — `sessionLiveStateCollection` filtered by project, drives project sidebar
- `visibleSessionsForUser` — tabs ⋈ session-summaries, expresses the "deep-link not-yet-synced" fallback declaratively

## Proposed target architecture

```
createSyncedCollection({
  id: 'messages',
  getKey: (m) => m.id,
  schema: messageSchema,
  stream: sessionStream,       // Primitive 2
  type: 'message',             // routing key on the stream
  queryFn?: restFallback,      // cold-start REST; absent for DO-push-only entities
  persistence?: opfsPersistence,
})
```

Internally:
- Owns `lastSeq`, gap-detect, snapshot-on-gap
- Handles txid reconcile (Primitive 3)
- Every inbound frame is applied through a **sync action** so IVM tracks the write
- `upsert` / `applySnapshot` / `handleMessagesFrame` ad-hoc helpers disappear

Streams:

```
SessionStream (SessionDO)         UserStream (UserSettingsDO)
  type: 'message'                   type: 'tab'
  type: 'branchInfo'                type: 'preference'
  type: 'state'                     type: 'project'
  type: 'chain'                     type: 'session-summary'
```

Server-side: SessionDO already stamps `seq` for messages — extend to every type it emits. Promote `UserSettingsDO` into a streaming DO that emits seq'd frames for everything user-scoped. Each of those entities today has its own ad-hoc REST + invalidation story; they all collapse into one WS.

## What this doesn't do

- **We are not adopting `@durable-streams/state` as a dependency.** We are stealing the patterns and keeping our DO-per-session durability model. StreamDB's value is the architecture, not the library — and the library would still inherit our IVM bug without action-wrapping.
- **Auth and dial-back stay** — runner → DO bearer-token handshake, `active_callback_token` rotation, DialBackClient backoff. None of that changes.

## Rollout order

1. **Action-wrap the messages WS handler.** Smallest diff, proves the IVM theory, lets us revert `useSyncExternalStore`. If this doesn't restore `useLiveQuery`, everything below is premature.
2. **Extract `createSyncedCollection`** by generalising `messagesCollection`. Migrate `branchInfo` + `sessionLiveState` onto it. `branchInfo` becomes its own frame type (stops piggybacking on the messages snapshot payload).
3. **Introduce UserStream** by extending `UserSettingsDO`. Move `user-tabs` + `user-preferences` + `projects` + session-summaries list onto it.
4. **Add txid round-trip** to `SyncedCollection`. Retire the `usr-client-<uuid>` id overload.
5. **Refactor branch-info UI onto a derived collection** — proves Primitive 4 and deletes a collection.

Step 1 is a one-afternoon change and de-risks the whole direction.

## Files touched at each step

- **Step 1:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (`upsert` / `applySnapshot` / `handleMessagesFrame` wrap in `createTransaction`), revert `apps/orchestrator/src/hooks/use-messages-collection.ts` back to `useLiveQuery`.
- **Step 2:** new `apps/orchestrator/src/db/synced-collection.ts`; rewrite `messages-collection.ts`, `branch-info-collection.ts`, `session-live-state-collection.ts` as thin wrappers; new `type: 'branchInfo'` frame on SessionDO.
- **Step 3:** new `apps/orchestrator/src/agents/user-stream-do.ts` (or extend `user-settings-do.ts`); migrate REST endpoints that today serve tabs/preferences/projects into stream emitters.
- **Step 4:** `SessionMessage` drops `usr-client-<uuid>` id scheme; `{type: 'txack', txid}` frame on every stream; client exposes `{ txid, settled: Promise<void> }` from action dispatches.
- **Step 5:** new derived collection in `db/`; delete `branch-info-collection.ts` and `use-branch-info.ts`.

## Open questions

- Does `@tanstack/db@0.6.4`'s IVM actually track action writes that happen outside a React render? We're assuming yes from the StreamDB post's implementation. Step 1 tests this empirically — if it fails, we either upgrade tanstack/db or keep the `useSyncExternalStore` pattern and still pursue the stream/multiplex/txid/derived-collection work separately.
- User-level streams need per-user auth. `UserSettingsDO` already has it. Scoping per-user WS frames to the correct user is straightforward; scoping per-session filtering on a shared user stream (e.g., "which projects is this user allowed to see") is the one place that might push back on the design.
- Persistence story for derived collections: do we persist the derived view or recompute on hydrate? StreamDB recomputes. We've been persisting everything to OPFS SQLite. Likely recompute for derived collections, persist only base collections.
