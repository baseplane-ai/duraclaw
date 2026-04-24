# Awaiting-response + async-wait state for SessionDO

**Date:** 2026-04-23
**Mode:** research (hybrid — feature research + design brainstorming)
**Trigger:** UX bug — after `sendMessage`, the first assistant token can land
10–20 s later; if the user tabs away and back during that window, the UI
reports **idle**. Fixes forward to the Agent SDK Monitor / Task async-wake
tools, which legitimately wait minutes-to-hours.
**Related:** GH #76 (subtract status complexity) / PR #79,
GH #14 (seq'd wire protocol), GH #42 (connection manager).

## TL;DR

1. **The 45 s TTL that flipped `running → idle` is already gone in PR #79.**
   My first read of this bug blamed the TTL; that's half-right but half-stale
   — the diff has been in flight for days and deletes both `TTL_MS` and
   `lastEventTs`. Status is now a pure fold over `messagesCollection` tail.
2. **Post-#79 the bug shrinks but doesn't disappear.** During the 10–20 s
   first-token wait, `useDerivedStatus` returns `undefined` (no text /
   result / gate part in tail) and render falls back to
   `session?.status` from D1. If the D1 mirror is stale at the instant
   the user's tab refocuses (e.g. DO eviction dropped the in-flight
   `syncStatusToD1` debounce), the UI still flickers "idle" for the wait.
3. **The deeper problem is that `messagesCollection` has no marker for
   "user turn committed, awaiting first runner event"** — and separately
   no marker for "runner is legitimately blocked on a sub-agent / Monitor
   tool / async-wake." Both states are currently inferred from absence,
   which is fragile on reconnect.
4. **Recommendation (minimal, ships after #79):** add a synthetic
   `awaiting_response` message part stamped by the DO at `sendMessage`
   time and cleared by the first `partial_assistant` / `assistant` /
   `tool_result` / `permission_request` from the runner. One extra case
   in `useDerivedStatus` makes this TTL-free, eviction-safe, and it
   composes naturally with the sub-agent case (same shape).
5. **Recommendation (taxonomy, follow-up):** promote the implicit states
   into a `waiting_reason` on `SessionMeta` — `subagent | monitor |
   permission | user_input | first_token` — and expose
   `gateway_attached: boolean` as the authoritative "runner is alive"
   signal separate from status. This is the shape the Agent SDK is
   pushing us toward with Monitor and Task\* tools.

Do not fold this into #79 — it's merged or about to merge. Ship as a
follow-up PR on top.

## Current state (pre-#79 baseline)

`apps/orchestrator/src/lib/derive-status.ts` exposed:

```ts
const TTL_MS = 45_000
if (row.status === 'running' && nowTs - row.lastEventTs > TTL_MS) return 'idle'
```

`lastEventTs` was bumped by `bumpLastEventTs()` on every inbound runner
event with a 10 s debounced flush to D1
(`LAST_EVENT_FLUSH_DEBOUNCE_MS = 10_000`). `sendMessage` bypassed the
debounce and flushed immediately so a just-sent turn wasn't instantly
stale. The debounce timer lived in DO memory — hibernation / eviction
drops it and the next bump is what re-arms.

The failure trace I mapped for the reported bug:

1. User sends turn N at `t₀`. DO writes `status=running`, flushes
   `lastEventTs=t₀` immediately.
2. Runner's first event lands at `t₀ + 10–20 s`; the 10 s debounce
   means the D1 `lastEventTs` mirror may be anywhere up to 10 s behind
   live.
3. User switches tabs. DO hibernates within seconds; debounce timer is
   lost.
4. Previous turn N-1 had finished streaming at, say, `t₀ - 60 s`. In
   the D1 row, `lastEventTs` is still the last flushed value from that
   prior turn (or the immediate flush from step 1, minus 10 s of
   coalesced bumps). Depending on timing it can look >45 s old.
5. User refocuses at `t₀ + 20 s`. Sidebar card reads D1, runs the TTL
   predicate, decides `running → idle`. UI shows "idle" for the last
   few seconds of the wait, flipping back to "running" the moment the
   first delta arrives.

The TTL is **scoped to `'running'`** — `waiting_gate` / `waiting_input`
never flip via this path. So user-side latency during a tool-permission
modal was immune, but first-token latency was not.

## Post-#79 state (as merged / landing)

PR #79 (issue #76, "Collapse 4 session-status signals → 1 derivation
hook") does three things relevant here:

1. **Deletes `derive-status.ts` and the TTL outright.** `lastEventTs`
   is removed from `SessionRecord`, `SessionSummary`, and the DO's
   `SessionMeta`. Migration `0021_drop_last_event_ts.sql` drops the
   column. `bumpLastEventTs()` and the immediate-flush in `sendMessage`
   are gone.
2. **Adds `useDerivedStatus(sessionId)`** at
   `apps/orchestrator/src/hooks/use-derived-status.ts`. Scans the tail
   of `messagesCollection` and returns:
   - `'idle'` — last part is `type: 'result'`.
   - `'running'` — last part is `type: 'text'` with
     `state: 'streaming'`.
   - `'waiting_gate'` — last part is a `tool-permission` or
     `tool-ask_user` with `state: 'approval-requested'`.
   - `undefined` — none of the above; caller falls back to
     `session?.status` from D1.
3. **Moves `messageSeq` onto `SessionSummary`** (migration
   `0016_add_message_seq.sql`) so the hook has a reactive dep that
   fires on every DO broadcast.

The bug shrinks because:

- There is no TTL to mis-fire. A stale mirror no longer causes a false
  flip.
- `useDerivedStatus` subscribes to `messagesCollection`, which is
  OPFS-persisted + reactive, so a foreground-reconnect repopulates tail
  from the cache first, then reconciles via snapshot.

But a gap remains:

- Between `sendMessage` commit and the first runner event, the tail's
  last part is the user turn (`role: 'user'`, no streaming text, no
  result). `useDerivedStatus` returns `undefined`. The caller falls
  back to `session?.status`.
- `sendMessage` still sets `status: 'running'` on the DO and calls
  `syncStatusToD1()` — so the D1 mirror should read `running`. But:
  - `syncStatusToD1` is debounced / batched (verify — see Open
    Questions). If the DO evicts before the flush, the mirror can be
    behind.
  - `useSession(sessionId)` reads `sessionLiveStateCollection` which is
    D1-mirrored via `useSessionsCollection`. This refreshes on the
    user-stream WS's synced-delta frames. If the user-stream WS is
    mid-reconnect when the tab refocuses, the cached D1 row is
    whatever was last written.
- Foreground-reconnect flow: ConnectionManager schedules
  `conn.reconnect()` with a 0–500 ms jitter for stale conns. The agent
  adapter's post-reconnect `open` triggers `hydrate()` which RPCs a
  snapshot — but that only rebuilds `messagesCollection`, not the
  sidebar-consumed `sessionLiveStateCollection` D1 mirror. So the
  sidebar card keeps rendering `session?.status` from the possibly
  stale D1 row until the user-stream WS catches up with a
  synced-delta.

Net: severity drops from "regular / reproducible" to "narrow race
around DO eviction + tab switch + first-token wait." But the
render-source fragmentation is now more exposed — active-tab
consumers get the correct `undefined → running` path via message
deltas, sidebar / idle-tab consumers go through the D1 mirror which
has its own cadence.

## Sub-agents, Monitor, async-wake — the legitimate-wait case

The user flagged a second dimension: "when the runner is waiting on
agents we really do need this waiting state." The Agent SDK surface
visible in this session's deferred tool list and recent docs confirms
this isn't hypothetical.

**Task\* tools** (`TaskCreate`, `TaskGet`, `TaskOutput`, `TaskStop`,
`TaskList`, `TaskUpdate`) emit
`SDKTaskNotificationMessage { subtype: 'task_notification' }` frames.
A Task can run arbitrarily long; the parent SDK query is awake but
blocked in the sense that there is no main-thread assistant token
production until the Task resolves or notifies.

**Monitor tool** runs background scripts and streams stdout as
notifications, batched within 200 ms windows, with
`persistent: true | false` and `timeout_ms`. A persistent monitor
(PR watcher, log tailer) can run for hours with no assistant tokens.

**Async-wake** — the SDK now supports query suspension that resumes
on external events (`Monitor` notifications being the canonical
trigger). During the suspended window no `partial_assistant` /
`assistant` events are produced at all.

Under the post-#79 hook, all three look identical to "first-token
wait": tail doesn't match any of the three explicit cases, hook
returns `undefined`, sidebar shows D1 `status` (`running` if set —
but what resets it? today nothing, because the DO only moves to
`idle` on a `type=result` event).

So there's no wrong flip in steady state — but there's also no
expressive UI state. The user has no way to see "runner is on the
monitor tool, this could take a while" vs "runner just got the turn
and is about to stream." They both look like "running" with no
visible progress.

## Options evaluated

### Option A — `pendingTurnSince: number | null` on SessionMeta

Smallest possible delta. DO sets the field in `sendMessage`, clears
it on first runner event. `useDerivedStatus` checks it before
falling back to `session?.status`. No TTL — cleared on event, not on
time.

- Pro: 1 field, 1 hook case, no wire-protocol change.
- Pro: Eviction-safe if persisted in `session_meta` SQLite (migration
  v8).
- Con: Doesn't help the sub-agent / Monitor case at all — that's a
  separate concern with a separate signal.
- Con: Still two sources of truth (`messagesCollection` vs
  `SessionMeta.pendingTurnSince`) — a small step away from the #79
  "one derivation" design.

### Option B — Synthetic `awaiting_response` message part

Stamp a part in `messagesCollection` at `sendMessage` time with
`{ type: 'awaiting_response', turnId, startedTs }`. Delete the part
on first `partial_assistant` / `assistant` / `tool_result` /
`permission_request` event from the runner. `useDerivedStatus` adds
one case: tail is `awaiting_response` → return `'running'` (or
`'pending'` if we want a distinct color).

- Pro: Stays inside the #79 "one derivation over messagesCollection"
  design. No extra state source.
- Pro: Composes naturally with sub-agent / Monitor — same shape,
  different `reason` field.
- Pro: Delta-driven — the insert is a seq'd message frame, so
  foreground-reconnect's snapshot path handles it for free.
- Con: Synthetic parts in `messagesCollection` are a new concept
  (today all parts trace back to an SDK event). Need a convention /
  type discriminator so snapshot replay doesn't confuse them with
  runner-authored parts.
- Con: Deletes cost a seq'd delete frame; minor wire-protocol cost.

### Option C — `waiting_reason` taxonomy on SessionMeta + `gateway_attached` signal

Full redesign. `SessionMeta.status` becomes
`'running' | 'waiting' | 'idle' | 'terminated'` with
`waiting_reason?: 'subagent' | 'monitor' | 'permission' |
'user_input' | 'first_token'`. Separate boolean
`gateway_attached: boolean` is the authoritative "runner process is
alive and the DO has its WS attached" signal, independent of status.

Render surfaces that care about "is the runner alive?" read
`gateway_attached`. Render surfaces that care about "why is it
quiet?" read `waiting_reason`. `status` is just the top-level bucket.

- Pro: Expressive — UI can show "waiting on subagent for 2m" or
  "monitoring PR #123." No guessing.
- Pro: Separates "alive" from "producing tokens" — which is the
  thing #76 was trying to collapse but may have over-collapsed.
- Con: Real schema change; ripples through `SessionSummary`, D1
  mirror, wire protocol (new events for `waiting_reason` transitions),
  and every render surface. Bigger than #79.
- Con: Requires runner-side hooks for each reason. `permission` and
  `first_token` are easy (DO-authored). `subagent` / `monitor` need
  the runner to stamp explicit enter / exit events — the SDK surface
  for that is evolving.

### Option D — Do nothing (ship #79 as-is, reassess)

- Pro: #79 is the biggest structural win. Let it bake, measure
  whether the first-token bug actually recurs in the field.
- Con: The sub-agent / Monitor case is coming whether we ship
  anything or not — as we adopt Task\* and Monitor in the agent loop,
  "why is it quiet" becomes a more common question.

## Recommendation

**Ship Option B as a small follow-up PR after #79 merges.** Rationale:

- It stays inside #79's "one derivation over messagesCollection"
  design instead of reintroducing a side-channel state field.
- It fixes the residual first-token fallback-path race without any
  TTL, debounce, or mirror-freshness dependency.
- It sets up the shape for sub-agent / Monitor. The same part type
  with a `reason` discriminator handles `subagent_running`,
  `monitor_active`, `awaiting_async_wake` when the SDK starts
  emitting those boundary events. The render side ends up as a
  single `waiting_reason` switch.

**Plan Option C as a spec but don't implement yet.** File as a
follow-up issue tagged with "design" and gate on: (a) #79 having
been in prod long enough to measure, and (b) first real use of
Monitor / Task\* / async-wake in the agent loop so we know what the
runner-side events actually look like. Until then, Option B's
message-part approach gives us the expressive room without
committing to a schema.

## Proposed Option B shape

Wire (add to `GatewayEvent` union in
`packages/shared-types/src/index.ts`):

```ts
// DO-authored, not runner-authored — stamped at sendMessage time
interface AwaitingResponseEvent {
  type: 'awaiting_response'
  seq: number
  turn_id: string
  started_ts: number
  reason: 'first_token' | 'subagent' | 'monitor' | 'async_wake'
}

// Cleared by DO on first runner event that ends the wait
interface AwaitingResponseClearedEvent {
  type: 'awaiting_response_cleared'
  seq: number
  turn_id: string
}
```

`messagesCollection` part:

```ts
type AwaitingResponsePart = {
  id: string            // `awaiting-${turn_id}`
  type: 'awaiting_response'
  state: 'pending'
  reason: 'first_token' | 'subagent' | 'monitor' | 'async_wake'
  startedTs: number
}
```

Hook case (added to `useDerivedStatus`):

```ts
if (last.type === 'awaiting_response') return 'running'
// Or 'pending' / 'waiting' if we want a distinct UI state
```

Clear path:

- DO's runner-WS handler deletes the `awaiting-${turn_id}` part in
  response to the first `partial_assistant` | `assistant` |
  `tool_result` | `permission_request` event for that turn.
- On DO eviction + rehydrate, the part is still in `session_meta`
  SQLite (the #79 migration already gives us a typed meta table) —
  rehydrate replays it into `messagesCollection`.

## Open questions / follow-ups

1. **Does `syncStatusToD1` still fire on `sendMessage` post-#79, and
   is it still debounced?** The #79 diff removes
   `flushLastEventTsToD1` but I didn't confirm the `status` flush
   path. If it's also debounced, the sidebar / idle-tab consumers
   can still see a stale `running` mirror on fast DO eviction.
   Worth verifying before Option B lands — if `status` is
   immediate-flushed on `sendMessage`, Option B mostly plugs the
   active-tab ambiguity; if it's debounced, Option B is also
   plugging a sidebar-staleness race.

2. **`useSession` reactivity on foreground-reconnect.** The
   ConnectionManager reconnects stale WSs; the user-stream WS
   handles `synced-collection-delta` frames for the sessions
   collection. Is there a round-trip on reconnect that resyncs the
   session row from D1, or do we rely on the next write to push a
   delta? If it's the latter, a re-focused sidebar can render a
   stale row for arbitrarily long.

3. **Delete-vs-update for the `awaiting_response` part.** Upside of
   delete: tail becomes whatever runner-authored part arrives next;
   hook's existing cases kick in naturally. Upside of update-in-
   place (`state: 'pending' → 'cleared'`): no delete frame, and we
   retain a timestamp for telemetry. Leaning delete for simplicity;
   telemetry can go elsewhere.

4. **Sub-agent boundary events from the runner.** For Option C
   eventually, the runner needs to emit `subagent_started` /
   `subagent_completed`. The Agent SDK exposes these via
   `SDKTaskNotificationMessage` but we'd need to decide which
   `subtype` transitions map to waiting. Open question for whoever
   adopts Task\* first.

5. **Should the `awaiting_response` part render?** There's a UX
   choice: invisible (only affects status derivation) vs visible
   ("Claude is thinking…" bubble). Invisible is safer for a minimal
   fix; visible is nicer once we have `reason` values to show
   ("thinking", "running subagent", "watching monitor"). Starting
   invisible, upgrading to visible when reasons diversify, is the
   lowest-regret path.

## References

- PR #79 — `feat(#76): collapse 4 session-status signals → 1
  derivation hook`
- GH #76 — Epic: subtract complexity in session state tracking
- GH #14 — seq'd `{type:'messages'}` wire protocol
- GH #42 — Client connection manager
- `apps/orchestrator/src/hooks/use-derived-status.ts` (new, PR #79)
- `apps/orchestrator/src/lib/display-state.ts` —
  `deriveDisplayStateFromStatus(status, wsReadyState)`
- `apps/orchestrator/src/agents/session-do.ts` — `sendMessage`,
  `syncStatusToD1`, `hydrateMetaFromSql`
- `packages/shared-types/src/index.ts` — `GatewayEvent` union,
  `SessionSummary`
- `planning/research/2026-04-23-session-state-subtraction-gh76.md` —
  companion research behind #79
- `planning/research/2026-04-23-streaming-reconnect-burst-smoothing.md`
  — adjacent streaming UX work
- Agent SDK: `SDKTaskNotificationMessage`, Monitor tool
  (`persistent` / `timeout_ms` / 200 ms batching), async-wake
