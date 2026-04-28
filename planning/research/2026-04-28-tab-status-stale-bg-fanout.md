# Tab Status Sync Goes Stale in Background — Why, and What "Event-by-Event Fan-Out" Should Mean

**Workflow**: RE-b2ea-0428
**Date**: 2026-04-28
**Type**: Feature research / debugging context
**Author**: Ben (with Claude)

## Problem statement

> "Tab status sync still not working and going stale in bg. We should look into an event by event fan out to usersettingdo for freshness."

This research nails down (a) which "tab status" is stale (it's the per-tab status **indicator**, not the tab list), (b) the four concrete gaps in the current architecture that produce stale-in-bg behavior, and (c) what an "event-by-event fan-out to UserSettingsDO" could realistically mean — comparing four design options. A recommendation is at the end.

## Disambiguation: which "status" is stale?

Two things in this codebase are colloquially "tab status":

| What | Where it lives | Goes stale in bg? |
|---|---|---|
| **A. The tab list** (which sessions a user has open as tabs across devices) | D1 `user_tabs` + `userTabsCollection` synced via UserSettingsDO snapshots | **No** — it only mutates on user action; snapshot + REST refetch on reconnect closes any window |
| **B. The per-tab status indicator** (the colored ring/spinner on each tab — running, idle, waiting_gate, error, completed_unseen) | `sessionLocalCollection` (memory-only) fed by `session_status` fanout + per-session WS frames | **Yes — this is the bug** |

So the user's complaint is **B**: the colored ring on each tab in the tab strip showing what each session is doing.

Renderer: `apps/orchestrator/src/components/tab-bar.tsx:517-536` calls `useSessionStatus(sessionId)` for **every** tab, then `deriveTabDisplayState({status, wsReadyState, isActive, sessionMessageSeq, lastSeenSeq})` to pick the ring color. That hook reads from `sessionLocalCollection`.

## Current architecture — how status reaches a backgrounded tab

```
SessionDO.updateState({status})        (status.ts:28-49)
    │
    ├── broadcastStatusFrame(ctx)      → per-session WS (active tab only)
    │       (broadcast.ts:227-236)
    │
    └── broadcastStatusToOwner(ctx)    → user-stream (ALL tabs incl. bg)
            (broadcast.ts:244-252)
              │
              └── broadcastSyncedDelta(env, userId, 'session_status', ops)
                      (lib/broadcast-synced-delta.ts)
                      │
                      └── stub.fetch('https://user-settings/broadcast', POST)
                              fire-and-forget under ctx.waitUntil
                              │
                              ▼
                      UserSettingsDO.handleBroadcast    (user-settings-do.ts:178-212)
                              for ws of this.sockets:  ws.send(payload)
                              │
                              ▼
                      Browser PartySocket (user-stream)
                              │
                              ▼
                      subscribeUserStream('session_status', …)
                              (db/session-local-collection.ts:84-104)
                              │
                              ▼
                      sessionLocalCollection.update(id, draft => draft.status = …)
                              │
                              ▼
                      useSessionStatus(sessionId) → tab-bar.tsx ring color
```

Cold-start / reconnect path:
1. **Prime on WS upgrade** (`f467dbc`, `user-settings-do.ts:119-176`): when a socket connects, UserSettingsDO selects all D1 sessions where `agent_sessions.status = 'running'`, RPC-fetches `state.status` from each SessionDO, and sends a one-shot `session_status` delta to **just that socket**.
2. **Clear-on-reconnect** (`7d3d6d5`, `db/session-local-collection.ts:63-82`): when the user-stream WS reconnects, the client clears every cached `status` field, so the UI falls back to `session?.status` (the cold D1 mirror) until the prime arrives.

## Four prior fixes — and why we're back here

| Commit | Intent | Residual gap |
|---|---|---|
| `024a987` refactor(status): kill D1 from live status path, push via UserSettingsDO | Status becomes pure runtime fanout, no D1 read on hot path | D1 mirror is now stale by design — only updated to `idle` at result time |
| `ea01ca5` (companion to above) | Single hop DO → UserSettingsDO → browser | If user-stream WS is closed during a transition, fanout is sent to nobody and there is **no buffer/replay** |
| `7d3d6d5` fix(status): clear stale status on reconnect | Don't show pre-disconnect cached state after reconnect | Pushes the burden onto the prime, which is incomplete (see below) |
| `f467dbc` fix(tabs): prime live session_status on user-stream connect | Cover the cold-load → DO state mismatch (substates D1 doesn't carry) | Prime is gated on `WHERE status='running'` in D1, but D1 status is no longer authoritative; missed sessions stay stale |

The reason it's "still not working" is that each fix closed one window but the **broadcast pipe itself is lossy and the prime is incomplete**.

## The four gaps that produce stale-in-bg

### Gap A — UserSettingsDO has zero buffering

`broadcastSyncedDelta` POSTs to UserSettingsDO; UserSettingsDO iterates `this.sockets` and `ws.send(payload)`. If the browser's user-stream WS is closed at that instant (background-tab teardown, network blip, CF Worker rolling restart), the frame is dropped. No queue, no replay, no in-memory cache of "last status per session for this user".

`apps/orchestrator/src/agents/user-settings-do.ts:202-209`:
```ts
for (const ws of [...this.sockets]) {
  try { ws.send(payload) }
  catch (err) { this.sockets.delete(ws) }
}
```

This is the central failure. Every other gap is either a consequence of it or a different version of the same "no replay" problem.

### Gap B — Prime queries D1, which is no longer authoritative

`primeSessionStatusForSocket` (`user-settings-do.ts:119-176`):
```ts
where(and(
  eq(schema.agentSessions.userId, userId),
  eq(schema.agentSessions.status, 'running'),
))
```

But after `ea01ca5`, D1 `agent_sessions.status` is **only written at result time** (set to `'idle'`). So:

- Sessions that were `running` last result, never re-spawned → D1 says `idle` → not primed (correct, harmless).
- Sessions actively running → D1 might still say `running` from the previous run, or `idle` if the prior run completed cleanly → **maybe not primed**.
- Sessions in `waiting_gate`, `waiting_input`, `pending` → D1 only carries the coarse `running` axis, so substate is correctly fetched IFF the row says `running`.
- A session that opened a runner just now (D1 row inserted with `status:'idle'` per the new defer-spawn flow in `c89cb45`) → not primed at all. The very situation the prime exists to cover.

The prime universe is the wrong set.

### Gap C — Clear-then-stale window on reconnect

`db/session-local-collection.ts:63-82` clears every cached status on `onUserStreamReconnect`. The UI then renders `session?.status` from `sessionsCollection` (D1 mirror). If D1 was last set to `idle` two hours ago and the session is currently `waiting_gate`, the tab ring is wrong from reconnect until the prime lands (and only if Gap B doesn't drop it first).

### Gap D — Status field alone underspecifies the tab indicator

`deriveTabDisplayState` reads:

- `status` ← session_status fanout (covered, modulo gaps A/B/C)
- `wsReadyState` ← local-only (per-session PartySocket state)
- `isActive` ← local
- `sessionMessageSeq` ← `sessionsCollection.messageSeq` from D1 mirror via `broadcastSessionRow`
- `lastSeenSeq` ← local

The `completed_unseen` ("blue dot — there's a new message you haven't seen") indicator depends on `sessionMessageSeq`. That bumps via `broadcastSessionRow` → `sessions` collection delta → same UserSettingsDO pipe, with the **same Gap A**. So even a perfect status fanout fix wouldn't address `completed_unseen` going stale.

## What "event-by-event fan-out to UserSettingsDO" could mean

The phrase in the user's report is ambiguous in the right way — the literal mechanism (push events through UserSettingsDO) already exists for status transitions and D1-mirrored fields. So "event by event fan out for freshness" is best read as **make the UserSettingsDO conduit reliable enough that bg tabs converge to truth without per-session WS or D1 fallback**. Four flavors of that, ordered by scope:

### Option 1 — UserSettingsDO becomes a per-user status cache (my recommendation)

Give UserSettingsDO an in-memory `Map<sessionId, SessionStatus>` (optionally backed by `ctx.storage` for hibernation survival). Mutate it on every `/broadcast` of `session_status`, `messageSeq`, etc. On socket connect, replay the cache to the new socket — **no D1 round-trip, no SessionDO RPC fan-out**.

```ts
// inside UserSettingsDO
private statusCache = new Map<string, { status: SessionStatus; messageSeq?: number; ts: number }>()

handleBroadcast() {
  // …existing code…
  if (frame.collection === 'session_status') {
    for (const op of frame.ops) {
      if (op.type === 'update' || op.type === 'insert') {
        const v = op.value as { id: string; status: SessionStatus }
        this.statusCache.set(v.id, { status: v.status, ts: Date.now() })
      } else if (op.type === 'delete') {
        this.statusCache.delete(op.key)
      }
    }
  }
  // …fan to sockets…
}

handleWebSocketUpgrade() {
  // …existing code…
  // Replace primeSessionStatusForSocket with:
  this.replayCacheToSocket(server)
}
```

**Closes**: A (cache survives socket-down windows because next socket connect replays it), B (no D1 query — cache is the authoritative live mirror), C (replay arrives instantly on reconnect, no clear-then-empty gap).
**Doesn't close**: D — but extending the cache to `messageSeq` (and any other per-tab-display field) is straightforward in the same DO.

**Pros**: Smallest change. Single DO, no new transport. Eliminates the D1 prime and all its bugs. Native to where the data is fanned today.
**Cons**: Memory grows with sessions per user. Cap + LRU needed (200 is the existing prime cap; same bound suffices). Cache survives WebSocket Hibernation only if persisted; needs `ctx.storage.put`/`get` on init or the cache resets on DO eviction (acceptable — first reconnect after eviction does a one-time D1+SessionDO prime, then steady-state from cache).

### Option 2 — Fan out richer per-event payloads (literal reading of "event by event")

Today the user-stream gets `session_status` (id+status), `messages:*` (per-session, only via per-session WS), `chains`, `projects`, `sessions` (D1 mirror), `user_tabs`, `user_preferences`. Add fan-outs for every event class that affects tab UI:

- `gate_open` / `gate_close` — tab needs amber ring without waiting on a status transition
- `error_set` / `error_clear` — distinct from idle
- `progress` heartbeat (debounced) — keepalive freshness signal
- `messageSeq` standalone delta (already piggybacked on `sessionsCollection`, but only when D1 row mutates)

**Pros**: Matches the literal ask. Decouples tab indicator from D1 mirror entirely — UI can drive purely off user-stream.
**Cons**: Significant API surface growth. More fan-out call sites in SessionDO. Still doesn't fix the buffering problem (Gap A) — if the user-stream WS is down when the gate event fires, the bg tab still misses it.

### Option 3 — Periodic freshness tick

UserSettingsDO runs an alarm (e.g. every 30s) that queries every running SessionDO for the user and pushes a snapshot frame.

**Pros**: Bounded staleness window (≤ tick interval). Zero per-event call-site change.
**Cons**: Wasteful when nothing's happening. 30s is too long for a UI indicator. <5s ticks pressure DO budgets. Doesn't address transient transitions that flip and flip back within a tick.

### Option 4 — Direct DO ↔ DO RPC instead of HTTP fetch

Replace `stub.fetch('https://user-settings/broadcast', ...)` with a typed RPC method. Still fire-and-forget but eliminates JSON serialization overhead and maybe the auth header.

**Pros**: Faster, slightly cleaner.
**Cons**: Doesn't address any of the actual gaps. Performance optimization, not a correctness fix.

## Recommendation

Implement **Option 1 (per-user status cache in UserSettingsDO)**, with a follow-on for Option 2's `gate_open`/`error_set` fan-outs once the cache exists.

Concrete next steps for whoever picks this up:

1. **Replace `primeSessionStatusForSocket` with `replayCacheToSocket`**. The new method just iterates `this.statusCache` and sends a single delta frame.
2. **Mutate the cache inside `handleBroadcast`** for `session_status` (and later `messageSeq` if Option 2's expansion is taken). Cache is purely a write-through observer — fan-out to live sockets stays unchanged.
3. **Persist the cache via `ctx.storage` in chunks** so DO eviction doesn't lose it. Restore on init alongside the existing `getWebSockets()` rehydrate. Acceptable to skip persistence in a v0 — first reconnect after eviction primes from D1+SessionDO once.
4. **Drop the `WHERE status='running'` D1 filter from any remaining cold-prime path**. After the cache is the source of truth, cold prime should fall back to "scan SessionDO list for the user" (via `agent_sessions` regardless of D1 status) or skip entirely and let the per-session WS first-frame correct.
5. **Keep `7d3d6d5`'s clear-on-reconnect** but the replay arrives in the same tick, so the "blank then stale-D1" window collapses to nothing.
6. **Bound the cache** to ~200 entries per user (same as today's prime cap) with LRU eviction — well above any realistic concurrent-session count.
7. **Test plan**: extend `apps/orchestrator/src/agents/user-settings-do.fanout.test.ts` with: (a) status broadcast → cache mutation → replay-on-reconnect, (b) eviction simulation (new DO instance, cache empty, fall back gracefully), (c) bounded cache LRU.

Estimated scope: ~150 LOC in `user-settings-do.ts` + tests, no API changes, no client changes (`session-local-collection.ts` consumes the same `session_status` frames whether they come from cache replay or live fanout).

## Files to touch

| File | Change |
|---|---|
| `apps/orchestrator/src/agents/user-settings-do.ts` | Add `statusCache` + `replayCacheToSocket`; mutate cache in `handleBroadcast`; replace `primeSessionStatusForSocket` call with replay |
| `apps/orchestrator/src/agents/user-settings-do.fanout.test.ts` | New tests for cache mutation + replay on reconnect + LRU bound |
| (optional Option 2 follow-up) `apps/orchestrator/src/agents/session-do/broadcast.ts` | New `broadcastGateToOwner`, `broadcastErrorToOwner` helpers |
| (optional Option 2 follow-up) `apps/orchestrator/src/db/session-local-collection.ts` | Subscribe to new collections, write to local store |

## Open questions for the implementer

1. **Cache vs D1 mirror coexistence**: should `sessionsCollection` (D1 mirror) keep updating `status` at result time, or is the cache so authoritative we can drop the D1 column entirely? (My read: keep D1 for cold-paint fallback before WS connects at all.)
2. **Hibernation persistence — eager or lazy?** `ctx.storage.put` per mutation is one extra write per status transition. Lazy (debounced 5s flush) is fine because eviction during a transition is rare.
3. **Prime universe after this change**: do we still need any D1 read on socket upgrade, or does the cache plus per-session WS first-frame fully cover cold-load?
4. **Other collections** (`messageSeq` via `sessions`, gate state if Option 2 happens) — same cache, separate cache, or eagerly fold into `session_status` frames? (My read: extend `session_status` payload to `{id, status, messageSeq?}` and keep one cache.)

## References

- `apps/orchestrator/src/components/tab-bar.tsx:487-650` — tab strip rendering, `deriveTabDisplayState`
- `apps/orchestrator/src/agents/user-settings-do.ts:1-282` — current DO
- `apps/orchestrator/src/agents/session-do/broadcast.ts:227-252` — `broadcastStatusFrame`, `broadcastStatusToOwner`
- `apps/orchestrator/src/agents/session-do/status.ts:28-49` — `updateState` transition trigger
- `apps/orchestrator/src/db/session-local-collection.ts:1-110` — client consumer
- `apps/orchestrator/src/lib/broadcast-synced-delta.ts:1-44` — fire-and-forget transport
- `.claude/rules/client-data-flow.md` — DO-authoritative status conventions
- Prior fixes: `024a987`, `ea01ca5`, `7d3d6d5`, `f467dbc`
