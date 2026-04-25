---
paths:
  - "apps/orchestrator/src/**"
---

# Client data flow (session live state)

**DO-authoritative status** — the SessionDO stamps `sessionStatus` on
every `messages:*` / `branchInfo:*` WS frame and pushes a status-only
frame on every `updateState({status})` transition. The client extracts
`sessionStatus` from frames and writes it to the transient
`sessionLocalCollection` (memory-only). `useSessionStatus(sessionId)`
reads it; consumers fall back to `session?.status` (D1 row) only before
the first WS frame (cold-start). No message-fold, no tiebreaker, no
derivation. `useDerivedGate(sessionId)` still folds over
`messagesCollection` for the gate payload. The DO persists its own typed
`SessionMeta` in a `session_meta` SQLite table (migration v6+v7) and
restores it on rehydrate via `hydrateMetaFromSql()`.

The browser has three render sources for per-session state, all TanStack DB
collections (OPFS-persisted, reactive via `useLiveQuery`):

1. `sessionsCollection` — per-session summary (`project`, `model`,
   `numTurns`, `totalCostUsd`, `durationMs`, `contextUsage`, `kataState`,
   `worktreeInfo`, `messageSeq`, and `status`). D1-mirrored via
   `broadcastSessionRow`. The D1 `status` column is the cold-start
   fallback only; live status comes from `useSessionStatus` (WS frame).
   The transient `sessionLocalCollection` carries
   `{id, wsReadyState, wsCloseTs, status}` (memory-only, no persistence).
2. `messagesCollection` — per-session message history, one collection per
   agentName (memoised by `createMessagesCollection`). Query-backed with a
   REST fallback (`GET /api/sessions/:id/messages`) for cold-start and
   reconnect-with-stale-cache; WS is the live push channel.
3. `branchInfoCollection` — per-session branch siblings for rewind /
   resubmit / navigate. Populated by DO-pushed snapshots alongside
   messages; the `useBranchInfo` hook drives the branch arrows in the UI.

## Seq'd wire protocol (GH#14 B1-B3)

The SessionDO stamps every broadcast with a per-session monotonic `seq`.
The client tracks `lastSeq` per agentName in a ref. `kind:'delta'` frames
whose `seq === lastSeq + 1` apply directly (upsert / delete on
`messagesCollection` plus any `branchInfo` upserts piggybacked on the
frame). Out-of-order or gap-detected frames trigger a
`requestSnapshot()` RPC to the DO. The server replies with
`kind:'snapshot'` (reason: `reconnect` / `rewind` / `resubmit` /
`branch-navigate`) carrying the full linear history plus refreshed
branchInfo rows; the snapshot handler replaces the collection contents
for that session and resets `lastSeq`.

**DO-authored snapshots** — rewind / resubmit / branch-navigate are
computed server-side via `session.getHistory(leafId)` and pushed to every
connected client as a `kind:'snapshot'` frame. The client RPCs
(`rewind`, `resubmitMessage`, `getBranchHistory`) fire-and-await; no
client-side history mutation, no per-tab divergence.

**Optimistic user turns** (GH#14 B5-B6) use
`createTransaction({mutationFn})` with client-generated
`usr-client-<uuid>` ids. The DO accepts the client id as the primary
`SessionMessage.id`, so the server echo reconciles via TanStack DB
deep-equality — a single row that updates in place, no delete+insert
churn and no client-side sort hints.

Display derivation goes through
`deriveDisplayStateFromStatus(status, wsReadyState)` in
`apps/orchestrator/src/lib/display-state.ts` so StatusBar, sidebar cards,
and the tab bar all agree on label / color / icon.

## Connection manager (GH#42)

`apps/orchestrator/src/lib/connection-manager/` holds a cross-cutting
coordinator for every client-owned WS (`agent:<agentName>` PartySocket,
`user-stream` PartySocket, `collab:<sessionId>` y-partyserver provider).
Substrate-agnostic `ManagedConnection` adapters
(`adapters/partysocket-adapter.ts` + `adapters/yprovider-adapter.ts`)
plug into a module-level `connectionRegistry`. A singleton
`connectionManager` (started once from `routes/__root.tsx`) subscribes to
`lifecycleEventSource` — Capacitor `App.appStateChange` +
`Network.networkStatusChange` behind `isNative()`, plus browser
`visibilitychange` / `online` / `offline` — and on every `foreground` or
`online` event iterates the registry and schedules a `conn.reconnect()`
with a per-conn random stagger in [0, 500) ms for any conn whose
`lastSeenTs` is >5 s stale. `useConnectionStatus()` folds `readyState`
across every registered conn into a unified `isOnline` signal that drives
the `OfflineBanner` (with a 1 s show-debounce).

## Synced collections (user-scoped reactive data)

`createSyncedCollection` at `apps/orchestrator/src/db/synced-collection.ts`
is the canonical factory for user-scoped TanStack DB collections. It wraps
`queryCollectionOptions` and installs a custom `SyncConfig.sync` so the
synced layer is driven by WS delta frames from `UserSettingsDO` instead of
polling. Four collections ride on it today: `user_tabs`,
`user_preferences`, `projects`, `chains`.

**Two-layer model — don't conflate them:**

- **Optimistic layer** — user-initiated writes via `onInsert / onUpdate /
  onDelete` handlers (`mutationFn` POSTs the REST endpoint, rolls back on
  throw). Lives in TanStack DB's `optimisticUpserts` / `optimisticDeletes`
  maps and disappears when the write settles.
- **Synced layer** — authoritative state from D1. Populated cold by
  `queryFn` (initial load + reconnect resync) and kept hot by WS delta
  frames dispatched through `begin / write / commit` on
  `SyncConfig.sync`'s params. The server echo of the user's own write
  reconciles via TanStack DB's `deepEquals` loopback guard — no
  watermark, no tombstone, no client-side dedup.

**Wire protocol** — `SyncedCollectionFrame` in
`packages/shared-types/src/index.ts`:

```typescript
type SyncedCollectionOp<TRow> =
  | { type: 'insert'; value: TRow }
  | { type: 'update'; value: TRow }
  | { type: 'delete'; key: string }

interface SyncedCollectionFrame<TRow> {
  type: 'synced-collection-delta'
  collection: string
  ops: Array<SyncedCollectionOp<TRow>>
}
```

**Fanout path** — API writes call `broadcastSyncedDelta(env, userId,
collection, ops)` wrapped in `ctx.waitUntil`. The helper POSTs
`/broadcast` on the user's `UserSettingsDO` with
`Authorization: Bearer ${SYNC_BROADCAST_SECRET}`. 256 KiB cap enforced;
use `chunkOps()` in `apps/orchestrator/src/lib/chunk-frame.ts` for bulk
syncs.

**Cross-user fanout** (projects) — `/api/gateway/projects/sync`
reconciles D1 then queries `SELECT user_id FROM user_presence` and fans
out via `Promise.allSettled`.

**Reconnect semantics** (B7) — the hook's `onUserStreamReconnect`
handler calls `queryClient.invalidateQueries({queryKey})` on every
registered collection. The "optimistic delete reappears because
mutationFn threw offline" path is explicitly accepted behavior, not a bug.

**Secrets** — `SYNC_BROADCAST_SECRET` (worker -> DO) and
`CC_GATEWAY_SECRET` (gateway -> worker) rotate independently.
