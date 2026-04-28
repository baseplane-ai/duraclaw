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

### Option 1 — UserSettingsDO becomes a per-user status cache ❌ rejected (hibernation)

The original idea was to give UserSettingsDO an in-memory `Map<sessionId, SessionStatus>` mutated on every `/broadcast` and replayed on socket connect.

**Why this fails**: UserSettingsDO uses the WebSocket Hibernation API. The DO can be evicted from memory at any point — including while sockets are connected — and only `ctx.storage` survives. In-memory `statusCache` resets to empty on every wake. The wake itself is usually triggered by an *incoming* frame (which then populates the cache with one entry), so live fan-out works fine. But the **replay-on-reconnect** path — the whole point of the cache — is broken: any transition that occurred before the eviction is gone forever, replay sends a partial map, the tab indicator is still stale.

`ctx.storage.put` per transition would close the gap, but: (a) it's a real write per status flip, (b) it inverts the "UserSettingsDO holds NO persistent state" invariant the file's docstring opens with, (c) it duplicates state that SessionDO already owns durably. The cache is the wrong place for this storage.

### Option 1' — Stateless UserSettingsDO, fix the prime instead (recommended)

UserSettingsDO stays stateless. The fix is in `primeSessionStatusForSocket`:

1. **Drop the `WHERE status='running'` filter.** D1 status is no longer authoritative (post-`ea01ca5`), so filtering on it is the source of Gap B. Replace with a recency bound (`WHERE updated_at > now() - 7 days ORDER BY updated_at DESC LIMIT 200`) — gets the user's recently-touched sessions regardless of D1's stale `status` column.
2. **Keep the per-session SessionDO RPC.** This is already there and already correct: `stub.fetch('GET /status')` returns the DO-authoritative `state.status`, and SessionDO's state is hibernation-safe via the `session_meta` SQLite table (migration v6+v7). No new state, no new transport.
3. **Extend the prime payload to include `messageSeq`** (closes Gap D for the `completed_unseen` indicator). SessionDO already exposes `do.messageSeq` on the same `/status` endpoint, so no new DO surface.

```ts
// user-settings-do.ts — primeSessionStatusForSocket
const rows = await db
  .select({ id: schema.agentSessions.id })
  .from(schema.agentSessions)
  .where(
    and(
      eq(schema.agentSessions.userId, userId),
      gt(schema.agentSessions.updatedAt, sevenDaysAgo),  // ← was: eq(status, 'running')
    ),
  )
  .orderBy(desc(schema.agentSessions.updatedAt))
  .limit(200)
// …rest unchanged: parallel RPC each SessionDO for authoritative status+messageSeq
```

**Closes**:
- **B** — prime universe is now "every recently-active session" not "D1 says running"
- **C** — replay-after-clear arrives in the same tick as the upgrade response, so the blank-then-stale-D1 window collapses
- **D (partial)** — extending the `session_status` payload to `{id, status, messageSeq}` makes the bg tab's `completed_unseen` ring correct on cold load and on reconnect

**Doesn't close**:
- **A** — broadcasts during socket-down windows are still lost. **But**: every reconnect re-primes from authoritative SessionDO state, so the staleness window is bounded by reconnect cadence, not by transition rate. The connection-manager already triggers reconnects on `foreground`/`online`, so a backgrounded tab returning to foreground gets a fresh prime within ~stale-threshold (5s).

**Pros**: Survives hibernation by construction (zero UserSettingsDO state to lose). Smallest delta to the existing code. Doesn't violate the "stateless fanout pipe" invariant. Reuses authoritative SessionDO state instead of duplicating it.
**Cons**: 200 parallel sub-ms RPCs per socket upgrade — same as today, just dropping a WHERE clause changes the universe size, not the cost. Some sessions in the 200 will be `idle` (cheap RPC, no work). Worst case for a heavy user: 200 RPCs × ~5ms = 1s under `waitUntil`, not blocking the 101 Upgrade.

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

Implement **Option 1' — fix the prime, keep UserSettingsDO stateless**. A possible Option 2 follow-on (`gate_open`/`error_set` fan-outs) is independent and can land later.

Concrete next steps for whoever picks this up:

1. **Drop the D1 status filter in `primeSessionStatusForSocket`**. Replace `WHERE status='running'` with a recency window (`updated_at > now() - 7 days`) ordered by `updated_at DESC`, capped at 200. The cap stays the same as today — only the universe changes.
2. **Extend the prime payload to include `messageSeq`**. SessionDO's `GET /status` already has it. Update `session_status` collection type to `{id, status, messageSeq?}` and update the client subscriber in `session-local-collection.ts` to thread it into `sessionLocalCollection`. (Or fold into a new `session_live` collection name if mixing the schema feels wrong.)
3. **Keep the live fanout untouched.** `broadcastStatusToOwner` and `broadcastSyncedDelta` stay as-is. We're not changing the hot path — only making the cold prime correct.
4. **Keep `7d3d6d5`'s clear-on-reconnect.** The new prime arrives in the same tick as the upgrade response, so the "blank then stale-D1" window collapses to nothing in practice — the prime IS the freshness contract.
5. **Drop the docstring claim** that UserSettingsDO holds NO persistent state — still true after this change. Worth re-asserting because option 1 was tempting and we should remember why we passed.
6. **Test plan**: extend `apps/orchestrator/src/agents/user-settings-do.fanout.test.ts` with: (a) prime queries every recently-updated session regardless of D1 status, (b) prime payload includes messageSeq, (c) prime sends nothing for users with zero recent sessions, (d) per-session SessionDO RPC failure is swallowed and prime continues for the rest.

Estimated scope: ~30 LOC in `user-settings-do.ts` (changing one WHERE clause and adding messageSeq to the payload) + ~10 LOC in `session-do/http-routes.ts` (adding messageSeq to `/status` if not already there) + ~10 LOC in `session-local-collection.ts` to consume the new field + tests. Smaller than the rejected Option 1 by an order of magnitude because we're not adding state.

## Files to touch

| File | Change |
|---|---|
| `apps/orchestrator/src/agents/user-settings-do.ts` | Replace D1 status filter with recency filter; thread `messageSeq` into prime payload |
| `apps/orchestrator/src/agents/session-do/http-routes.ts` | Ensure `GET /status` returns `{status, messageSeq}` (verify current shape; extend if needed) |
| `apps/orchestrator/src/db/session-local-collection.ts` | Read `messageSeq` from `session_status` frames into `sessionLocalCollection` |
| `apps/orchestrator/src/agents/user-settings-do.fanout.test.ts` | Test the broader prime universe + messageSeq inclusion |
| (optional Option 2 follow-up) `apps/orchestrator/src/agents/session-do/broadcast.ts` | New `broadcastGateToOwner`, `broadcastErrorToOwner` helpers |

## Open questions for the implementer

1. **What's the right recency window for the prime?** 7 days is a guess. Too short and a returning user's 8-day-old `waiting_gate` session shows stale; too long and prime over-fans. The right answer might key off `agent_sessions.deletedAt IS NULL` plus a generous window like 30d.
2. **Cap at 200 enough?** Today's cap, never hit in practice. A heavy user with many parallel sessions could in theory exceed it; consider chunking the prime into multiple frames if we ever see this.
3. **Should `sessionsCollection` (D1 mirror) keep its `status` column?** Currently used as cold-paint fallback before any WS frame arrives. Probably yes — it's the only thing that paints before the user-stream connects at all.
4. **messageSeq via prime or via sessions D1 mirror?** Both right now. Folding into the prime payload is cleaner because the user doesn't have to wait for both `sessions` and `session_status` deltas to arrive in the right order. Pick one source of truth for the indicator's input, prefer the prime.

## References

- `apps/orchestrator/src/components/tab-bar.tsx:487-650` — tab strip rendering, `deriveTabDisplayState`
- `apps/orchestrator/src/agents/user-settings-do.ts:1-282` — current DO
- `apps/orchestrator/src/agents/session-do/broadcast.ts:227-252` — `broadcastStatusFrame`, `broadcastStatusToOwner`
- `apps/orchestrator/src/agents/session-do/status.ts:28-49` — `updateState` transition trigger
- `apps/orchestrator/src/db/session-local-collection.ts:1-110` — client consumer
- `apps/orchestrator/src/lib/broadcast-synced-delta.ts:1-44` — fire-and-forget transport
- `.claude/rules/client-data-flow.md` — DO-authoritative status conventions
- Prior fixes: `024a987`, `ea01ca5`, `7d3d6d5`, `f467dbc`
