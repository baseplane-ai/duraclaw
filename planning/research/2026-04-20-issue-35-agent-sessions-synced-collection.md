---
date: 2026-04-20
topic: Migrate agent_sessions onto createSyncedCollection
type: feature
status: complete
github_issue: 35
items_researched: 6
---

# Research: migrate session list (`agent_sessions`) onto `createSyncedCollection`

## Context

GH#35 proposes migrating the sidebar session list (`agent_sessions` metadata)
onto the `createSyncedCollection` factory that landed in GH#32. Today the
sidebar is populated cold from `GET /api/sessions` and refreshed on window
focus / user-stream reconnect — there's no cross-browser live push for the
list itself. Per-session live state (gate, contextUsage, kataState) already
rides on the per-session gateway WS, but the issue author identified four
open questions before migration could proceed: migration scope, DO→DO
broadcast path for runner-originated mutations, cross-user visibility, and
performance under bulk transitions.

User directive for this research: **evaluate both full and static-only
scope, include cross-user visibility as in-scope**, and surface a precise
recommendation rather than just an option matrix.

## Scope

**Items researched (6 parallel deep-dives):**

1. Current session metadata model — D1 schema, write sources, sidebar read path
2. `sessionLiveStateCollection` boundary — fields, update cadence, derived hooks
3. `createSyncedCollection` factory — API, two-layer model, wire protocol, reconnect
4. `UserSettingsDO` broadcast path — `/broadcast`, secret, `user_presence`, chunkOps
5. `SessionDO` integration points — transition sites, userId chain, DO binding, batching
6. Cross-user visibility ACL — session ownership today, projects template, fanout shape alternatives

**Sources:** codebase (`apps/orchestrator/src/**`, `packages/shared-types`),
GH#32 spec (`planning/specs/28-synced-collections-pattern.md`), GH#35 issue
thread, git log, wrangler config.

## Findings

### 1. Session metadata model

**D1 table:** `agent_sessions` at `apps/orchestrator/src/db/schema.ts:128–165`.
22 columns. Relevant indices: `(user_id, last_activity)`, `(user_id, project)`,
and a unique partial index on `sdk_session_id` where not null.

**Write sources:**

| Origin | Endpoint / site | Columns | Broadcasts today? |
|--------|-----------------|---------|-------------------|
| User | `POST /api/sessions` (`api/index.ts:1479`) | all | No |
| User | `PATCH /api/sessions/:id` (`api/index.ts:1712`) | title, summary, tag, status, archived, model, project | **No** — client-side optimistic only, no WS echo |
| User | `POST /api/sessions/:id/fork` | (new row) | No |
| User | `POST /api/sessions/:id/abort` | status | No |
| Cron | `POST /api/sessions/sync` (scheduled.ts) | status, model, updatedAt, lastActivity, numTurns, totalCostUsd | No |
| SessionDO | `syncSdkSessionIdToD1` (`session-do.ts:1080`) ← `session.init` event | sdkSessionId, updatedAt | No |
| SessionDO | `syncResultToD1` (`session-do.ts:1061`) ← `result` / `stopped` events | status, summary, durationMs, totalCostUsd, numTurns, lastActivity | No |
| SessionDO | `syncStatusToD1` (`session-do.ts:1049`) ← status transitions | status, updatedAt, lastActivity | No |
| SessionDO | `syncKataToD1` (`session-do.ts:1092`) ← `kata_state` event | kataMode, kataIssue, kataPhase | No (but does broadcast `chains` delta) |

**Every D1 write site is silent today.** The sidebar only gets fresh data
by re-fetching `/api/sessions` on mount / focus / reconnect.

**Read path:** `NavSessions` component (`components/layout/nav-sessions.tsx`)
renders top-5 by `lastActivity DESC` plus a worktrees tree. Data comes from
`useSessionsCollection()` which wraps a plain TanStack DB collection
(`sessionLiveStateCollection`) and calls `backfillFromRest()` on mount,
`onUserStreamReconnect`, and `window.focus`. Individual session rows are
hydrated by `seedSessionLiveStateFromSummary`.

### 2. `sessionLiveStateCollection` field classification

**Collection definition** (`db/session-live-state-collection.ts:75`):
plain `localOnlyCollectionOptions` wrapped with OPFS `persistedCollectionOptions`
(schema v3). Single user-scoped collection keyed by `sessionId`, no query
backing, no WS sync driver.

Reframed field classification after second-pass scrutiny (the original
"live" label was inflated — update cadence is dominated by client poll
frequency, not server push):

| Field | D1? | Effective update freq | Bucket |
|-------|-----|----------------------|--------|
| id, userId, project, model, prompt, createdAt, origin, agent, sdkSessionId | ✓ | once | static |
| title, tag, archived | ✓ | user-edit (~0–5×/session) | static |
| status | ✓ | gateway events (~5–20×/session) | slow |
| numTurns | ✓ | 1×/turn | slow |
| totalCostUsd, durationMs, summary | ✓ | 1×/result event | slow |
| lastActivity, updatedAt | ✓ | 1×/turn + edits | slow |
| kataMode, kataIssue, kataPhase | ✓ | 1–5× (mode) / 5–50× (phase) | slow |
| **contextUsage** | — | **~1×/turn** (value only meaningful post-turn; "frequent" client observation is just polling a cached value) | **slow** (reframed) |
| **kataState (full blob)** | DO-`kv` only | ~1–50×/session | slow but **large** |
| worktreeInfo | — | once (not yet implemented) | static |
| **wsReadyState** | — | WS flap | **client-local only** |

**Derived hooks:** `useDerivedStatus(sessionId)` folds over
`messagesCollection` (last 10 msgs); `useDerivedGate(sessionId)` folds over
last 20 msgs. Fallback pattern: `useDerivedStatus(sessionId) ?? live.status`
— active sessions prefer message-derived, inactive sidebar entries fall back
to the D1-mirrored `status`.

### 3. `createSyncedCollection` factory reference

**File:** `apps/orchestrator/src/db/synced-collection.ts`.

**Signature:**

```typescript
createSyncedCollection<TRow, TKey>({
  id: string
  getKey: (row: TRow) => TKey
  queryKey: readonly unknown[]
  queryFn: () => Promise<TRow[]>
  syncFrameType: string
  onInsert?, onUpdate?, onDelete?
  persistence?, schemaVersion?
})
```

**Two-layer model:**

- **Optimistic** — user writes fire `onInsert/Update/Delete`; the row sits in
  `optimisticUpserts` map until the REST mutation settles. Throw → rollback.
- **Synced** — `SyncConfig.sync` custom driver subscribes to
  `subscribeUserStream(syncFrameType, handler)`. WS frames arrive and apply
  via `params.begin() / params.write({type, value|key}) / params.commit()`.
  Reconciliation with outstanding optimistic rows uses TanStack DB's built-in
  `deepEquals` — no explicit loopback guard in this repo.

**Frame routing:** module-level `frameHandlers: Map<string, Set<FrameHandler>>`
at `hooks/use-user-stream.ts:43`. Each collection's `subscribeUserStream` call
registers into its own bucket. Multiple handlers per frame type are supported.

**Reconnect:** `onUserStreamReconnect` registers per-collection callbacks that
fire on every WS `open` event after the first. Each callback calls
`queryClient.invalidateQueries({queryKey})` → `queryFn` re-fires.

**Wire protocol** (`packages/shared-types/src/index.ts:731`):

```typescript
type SyncedCollectionOp<T> =
  | {type: 'insert', value: T}
  | {type: 'update', value: T}
  | {type: 'delete', key: string}

interface SyncedCollectionFrame<T> {
  type: 'synced-collection-delta'
  collection: string
  ops: Array<SyncedCollectionOp<T>>
}
```

**Cap:** 256 KiB hard limit enforced on `UserSettingsDO.POST /broadcast`
(pre- and post-parse). Safety margin 200 KiB via `chunkOps()`.

**Current consumers:** `user_tabs`, `user_preferences` (user-writable);
`projects`, `chains` (server-written, read-only).

### 4. UserSettingsDO broadcast path

**DO class** at `apps/orchestrator/src/agents/user-settings-do.ts:28–174`.
Owns `sockets: Set<WebSocket>` (hibernation-rehydrated via
`this.ctx.getWebSockets()`), maintains `user_presence` D1 row on 0↔1
transitions, accepts browser WS at `/parties/user-settings/{userId}` with
cookie auth.

**`broadcastSyncedDelta(env, userId, collection, ops)`** at
`apps/orchestrator/src/lib/broadcast-synced-delta.ts`:

```typescript
const stub = env.USER_SETTINGS.get(env.USER_SETTINGS.idFromName(userId))
await stub.fetch('https://user-settings/broadcast', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.SYNC_BROADCAST_SECRET}` },
  body: JSON.stringify({ type: 'synced-collection-delta', collection, ops }),
})
```

**Secret:** `SYNC_BROADCAST_SECRET` wrangler secret (`wrangler.toml:118–121`).
Currently compared via direct `!==` (not constant-time) — low-impact
pre-existing nit, noted for future fix.

**Cross-user fanout template** (`api/index.ts:741–763`, projects sync):

```typescript
const userIds = (await db.select({userId: userPresence.userId}).from(userPresence))
  .map(r => r.userId)
const chunks = chunkOps(ops, 200 * 1024)
c.executionCtx.waitUntil((async () => {
  for (const chunk of chunks) {
    await Promise.allSettled(userIds.map(uid =>
      broadcastSyncedDelta(c.env, uid, 'projects', chunk)))
  }
})())
```

`user_presence` is a D1 table (`schema.ts:223`) with one row per active user
(cascaded delete from `users`), maintained by `UserSettingsDO` on socket
count 0→1 / N→0 transitions.

### 5. SessionDO integration points

**Binding:** `env.USER_SETTINGS` is already wired — `wrangler.toml:29–31`
exposes it on the shared `Env`, and `SessionDO extends Agent<Env, …>` has
access via `this.env.USER_SETTINGS`.

**userId chain:** `SessionDO` stores `userId` in its `SessionMeta` state.
Populated from `getRequestSession(env, request)` in `onRequest`
(`session-do.ts:265–273`) on every authenticated WS connection. Also mirrored
to D1 `agent_sessions.user_id` at session create. Guaranteed non-null before
any gateway event handler runs.

**Missing broadcast call sites** (each already has a `syncXToD1` sibling —
broadcast can piggyback right after the D1 write):

| Site | Trigger | Row shape to broadcast |
|------|---------|------------------------|
| `syncStatusToD1` | resolveGate → running, ask_user / permission → waiting_gate, result / stopped / error → idle | `{id, status, updatedAt, lastActivity}` |
| `syncResultToD1` | result event | `{id, status, summary, durationMs, totalCostUsd, numTurns, lastActivity}` |
| `syncSdkSessionIdToD1` | session.init event | `{id, sdkSessionId}` |
| `syncKataToD1` | kata_state event | `{id, kataMode, kataIssue, kataPhase}` |
| assistant event numTurns++ (inline at `session-do.ts:2743`) | every assistant turn | `{id, numTurns}` |
| error event | gateway error | `{id, status, error}` |
| REST `PATCH /api/sessions/:id` (`api/index.ts:1712`) | rename / archive / model change | updated row |
| REST `POST /api/sessions` | create | new row |
| REST `POST /api/sessions/:id/fork` | fork | new row |

**No batching needed.** SessionDO does not batch any outbound broadcast today.
Under gateway-restart storm (N sessions transitioning simultaneously), each
SessionDO instance fires its own `broadcastSyncedDelta` call into the one
target `UserSettingsDO`. UserSettingsDO naturally serializes via its socket
set. Worst-case tail latency is bounded by `ctx.waitUntil`'s budget
(~30s); reconnect re-fetch is the backstop for any drops.

### 6. Cross-user visibility today (and what's needed)

**Current ACL: strictly single-user.**
- Every session list endpoint filters `WHERE eq(agentSessions.userId, userId)`.
- `getOwnedSession()` (`api/index.ts:195–214`) returns **404 (not 403) for
  ownership mismatch** to hide existence — this is an intentional
  anti-enumeration design.
- No org / team / workspace / membership table exists. Better Auth's
  `organization()` plugin is available but not enabled.
- `projects` is global (no user_id) and fans out to all active users, but
  that's not a useful template for sessions — projects are low-sensitivity
  metadata, sessions are not.

**Fanout-shape comparison** (given N active team members, M sessions
transitioning simultaneously):

| Strategy | Frame layout | Server cost | Leaks? |
|----------|--------------|-------------|--------|
| (a) Global broadcast, client filters | one frame, all users | O(users) broadcasts | **Yes** — session IDs visible to non-members |
| (b) Per-user ACL query per broadcast | per-user filtered frame | O(users × ACL) queries | No |
| (c) Hybrid — frame carries `visibleToUserIds`, DO filters at fanout | one frame per chunk, DO-side filter | O(users) broadcasts + 1 ACL query | No |

**(c) is the recommended shape.** Projects fanout is the network template;
the DO-side filter is the new piece (bolt into `UserSettingsDO.POST /broadcast`).

## Comparison

### Migration scope

| Scope | What moves to synced collection | Risk | Effort |
|-------|--------------------------------|------|--------|
| **Static only** | create/rename/archive columns | Low — sidebar title/archived sync; status/metrics stay stale for inactive sessions | ~3 new broadcast calls |
| **Static + slow (reframed)** ⭐ | Everything D1-mirrored + contextUsage + kata trio + worktreeInfo | Medium — ~13 call sites in SessionDO, all already have `syncXToD1` siblings | **Recommended** |
| **Full incl. kataState blob via WS** | Above + serialized kataState blob on row | High — blob bloat risks 256 KiB cap; defeats factory pattern | Not recommended |

### Live-field disposition (after user re-scrutiny)

| Field | Destination |
|-------|-------------|
| `contextUsage` | **Synced collection** — reframed as slow-changing (1×/turn) |
| `kataMode` / `kataIssue` / `kataPhase` | **Synced collection** — D1-backed already |
| `kataState` full blob | **REST endpoint** (`GET /api/sessions/:id/kata-state`) — per user decision; matches spec #31 P3 intent. Dropped from per-session WS push. |
| `worktreeInfo` | **Synced collection** — static (resolved once) |
| `wsReadyState` | **Client-local collection** — browser concern, never crossed the wire anyway |

## Recommendations

1. **Scope: "Static + slow" middle option**, with `contextUsage` reframed
   into the slow bucket and full `kataState` blob extracted to REST.
   Create `sessionsCollection` via `createSyncedCollection({ syncFrameType:
   'agent_sessions' })`. Narrow `sessionLiveStateCollection` into a
   client-local `sessionLocalCollection` holding `wsReadyState` only.

2. **Cross-user fanout: strategy (c) — hybrid with DO-side filter.** Add a
   minimal `project_members` table (`userId`, `projectName`, `role`). Every
   session broadcast carries a computed `visibleToUserIds` array
   (= project members ∪ `{session.userId}`). `UserSettingsDO.POST /broadcast`
   filters ops by membership before dispatching. Falls back to single-user
   (owner only) when project has no members.

3. **No SessionDO-side batching.** Fire `broadcastSyncedDelta` inline
   after each `syncXToD1` call, wrapped in `ctx.waitUntil`. Reconnect
   re-fetch covers any drops.

4. **Broadcast from REST PATCH too** (`api/index.ts:1712`). The PATCH handler
   already has the updated row from Drizzle's `.returning()`; just needs the
   `broadcastSyncedDelta` call.

5. **Delete the backfill scaffolding** in `use-sessions-collection.ts`
   (mount, focus, reconnect handlers). Factory replaces all three.

6. **Extract kata-state REST endpoint.** `GET /api/sessions/:id/kata-state`
   returns the full blob from DO `kv`. Kata HUD pulls on mount + on
   `kata_state_changed` event notification. Removes blob from per-session WS
   push.

7. **Document the client-local `sessionLocalCollection` as the last
   resort for any browser-only session concerns.** Sets the precedent for
   future fields (connection health, UI mode, etc.).

## Open Questions

1. **Live-field push post-migration.** Once `contextUsage` and kata trio
   move to the synced collection, does the per-session WS still need to
   emit `context_usage` / `kata_state` events? Proposal: yes, but only as
   triggers for the client to invalidate the synced-collection row (or the
   REST `kata-state` endpoint). Spec P1 interview should confirm.

2. **`project_members` population.** How do members get added? Self-serve
   via invitation, owner-assigns via UI, auto-derive from project presence?
   Likely deferred to a follow-up spec; for GH#35 a stub API + manual D1
   inserts suffice to exercise the fanout plumbing.

3. **Migration ordering vs. in-flight active sessions.** During rollout,
   can we keep the old `sessionLiveStateCollection` and new
   `sessionsCollection` both live until all consumers migrate? Pattern
   matches spec #31 P5's narrowing phase.

4. **Constant-time compare for `SYNC_BROADCAST_SECRET`.** Pre-existing nit
   worth fixing opportunistically during this work (2-line change to
   `user-settings-do.ts:102–104`).

## Next Steps

- **P1 (interview):** confirm open questions 1–3 with user; in particular
  confirm the `project_members` shape (columns, role enum, invitation flow
  or not).
- **P2 (spec writing):** behaviors around sessionsCollection shape, every
  broadcast site in SessionDO / REST, DO-side ACL filter, `project_members`
  table + minimal API, REST `GET /api/sessions/:id/kata-state`, migration /
  rollout phases, test matrix (optimistic reconcile, reconnect resync,
  cross-user fanout, chunk boundary).
- **P3 (review), P4 (close).**
