---
date: 2026-04-23
topic: Why messages stall mid-stream and show "idle" while SQL holds the full row
type: feature
status: complete
github_issue: null
related_issues: [69]
items_researched: 5
---

# Research: streaming "stuck incomplete message" — end-to-end audit

## Context

Symptom reported: a live assistant turn streams for a while, halts mid-text,
and the session flips to **idle**; a page refresh (or any cold-load path)
re-renders the full message. Happens on web active tabs, web background-tab
/ session-switch, and mobile Capacitor. This is a **live-stream
reconciliation failure**, not a persistence failure — SQL has the row, the
live delta path does not deliver the tail.

Recent fix churn on adjacent surfaces is heavy (`ed9c673`, `d026838`,
`54ae9db`, `aeb9209`, `590444d`, `16e7d72`) but none of them address the
client-side recovery gap this audit identifies. GH#69's research doc
(`planning/research/2026-04-22-gh69-session-state-drift.md`) identifies the
same symptom class and calls out an unshipped client recommendation —
this audit makes that specific and quantitative.

Classification: feature research, failure-mode focused. Parallel Explore
agents mapped the runner emission, DO append+broadcast, cursor+snapshot,
client delta apply, and the prior-fix timeline.

## Scope

Five deep-dive tracks, all run in parallel:

1. Runner event emission + `BufferedChannel` drop semantics
2. SessionDO append, seq assignment, broadcast channels
3. Cursor replay + snapshot RPC (DO side)
4. Client delta apply + `lastSeq` + `requestSnapshot` (client side)
5. Prior fixes, open issues, coverage gaps

## Top-line finding

**The client has no seq-gap detection path.** `messageSeq` is stamped on
every DO broadcast (`apps/orchestrator/src/agents/session-do.ts:1885-1892`),
is persisted across DO hibernation, and is clearly designed to drive
client-side gap detection → `requestSnapshot` RPC → snapshot merge. The
DO side of that protocol is implemented (`session-do.ts:4092-4112`). The
client side was never shipped.

`messagesCollection` (`apps/orchestrator/src/db/messages-collection.ts:95-127`)
applies every `synced-collection-delta` frame in arrival order with **no
seq comparison and no gap detection**. When a frame is lost in transit, the
client stays stale until something else triggers a cursor-based re-pull
(reconnect / refresh / tab-switch hydrate).

The test suite even references the unimplemented feature:
`apps/orchestrator/src/features/agent-orch/use-coding-agent.test.ts:12`
documents "Gap detection: out-of-order delta → requestSnapshot RPC, stale
deltas dropped" — no production code implements it.

Combined with three known frame-drop paths (below) and a separate race
between the status channel and the messages channel, this fully explains
the observed symptom.

## Findings

### 1. Runner event emission — correct, but overflow sentinel is volatile

**Event shapes** (`packages/session-runner/claude-runner.ts`):

| Event | Where | Carries `id` | `seq` stamp |
|-------|-------|--------------|-------------|
| `partial_assistant` | `:539-560` (text_delta / thinking_delta) | yes | `++ctx.nextSeq` at send |
| `assistant` (finalized) | `:593-603` | **same uuid as preceding partials** | `++ctx.nextSeq` |
| `tool_result` | `:604-614` | yes | `++ctx.nextSeq` |
| `result` | `:669-713` | — | `++ctx.nextSeq` (strictly after the final `assistant` in the same iterator loop) |

`partial_assistant` → `assistant` is an **in-place replace** on the
client, keyed on `uuid`. `mergeFinalAssistantParts`
(`gateway-event-mapper.ts:210-231`) merges streamed parts into the
finalized row; the streamed copy is authoritative for text, the
finalized copy is authoritative for structured content (tool blocks).

**Ordering guarantee on the runner:** none of these can reorder —
`claude-runner.ts` consumes the SDK iterator sequentially, and `seq` is
assigned at `send()` time. If an event is emitted, it is in order.

**Drop path — `BufferedChannel`** (`packages/shared-transport/src/buffered-channel.ts`):
- 10K events / 50 MB ring (`:48, 107-124`).
- On overflow, oldest entries are evicted and a single coalesced
  `{type:'gap', dropped_count, from_seq, to_seq}` sentinel is staged as
  `pendingGap` (`:163-183`).
- On WS reattach the sentinel is sent first (`:136-140`). **But**
  `pendingGap` is in-memory only. If the WS drops or the runner process
  crashes between overflow and reattach, the sentinel is lost. No disk
  persistence.

**Tests:** `buffered-channel.test.ts:78-105` cover the happy reattach
path. No test exercises "overflow → disconnect → new WS never sees the
gap."

### 2. DO append + broadcast — two separate channels, no ordering guarantee

**Seq mechanics** (`session-do.ts`):
- In-memory `private messageSeq = 0` (`:212`), persisted to
  `session_meta.message_seq` (migration v6, `session-do-migrations.ts:75`).
- Incremented in `broadcastMessages` **only** when the broadcast is not
  targeted (`:1885`). Targeted replays do not advance seq (design
  correct — a targeted reconnect-replay must not desync peer clients).
- Rehydrated on `onStart` (`:271-274`). Survives DO eviction.
- `persistMessageSeq` is fire-and-forget (`:1947-1954`).

**`partial_assistant` handling** (`:4158-4252`) — upserts the same row
as each delta arrives; `broadcastMessage()` at `:4245` emits a
`synced-collection-delta` insert op (TanStack DB auto-converts to
update on key collision).

**`assistant` handling** (`:4255-4292`) — `mergeFinalAssistantParts`
(`:4267`) dedupes the finalized content against the streamed parts,
then `safeUpdateMessage` (`:4276-4282`) and `broadcastMessage` (`:4286`).
Same wire channel.

**`result` handling** (`:4426-4546`) — **two broadcasts on two
channels**:

1. Messages channel (`:4433, 4450, 4470, 4481`): finalizes orphaned
   parts, broadcasts error or result text deltas.
2. Status channel (`:4493-4510`): `updateState({status:'idle', ...})`
   which triggers `broadcastSessionStatus()` (`:1464, 1473-1489`) and
   D1 mirror sync via `broadcastSessionRow` (`broadcast-session.ts:24-62`).

Both fire synchronously on the DO inside the same `result` handler,
but they ride **separate logical frames** on the WS. The client
applies them through different reactors (messagesCollection vs
sessionLiveState / D1 agent_sessions). **No atomicity, no ordering
contract.** A client can observe status=idle while its
messagesCollection is still at the pre-final-assistant partial.

**Silent-drop hazard** (`session-do.ts:1237-1242`): if a client
socket is mid-close when the DO calls `broadcastToClients`, the
frame is dropped with no log, no retry, no queue-for-reconnect.
No mechanism guarantees the client catches up — only the
client-initiated cursor subscribe on reconnect recovers, and only
if the cursor has been advanced correctly.

### 3. Cursor + snapshot — the SQL fallback paths are sound

Why refresh works:

**REST cold-load** (`session-do.ts:421-495`) — keyset paginated on
`(created_at, id)`. Enriches wire payload with `modifiedAt` from SQL
so the client's tail cursor is accurate.

**Cursor-aware subscribe replay** (`session-do.ts:1778-1841`,
`:1799-1807`):
```sql
SELECT id, created_at, modified_at, content FROM assistant_messages
WHERE session_id = ''
  AND modified_at IS NOT NULL
  AND ((modified_at > ${cursor.modifiedAt})
       OR (modified_at = ${cursor.modifiedAt} AND id > ${cursor.id}))
ORDER BY modified_at ASC, id ASC LIMIT 500
```

- Unified on `modified_at` (commit `d026838`, migration v13).
- Legacy `{createdAt, id}` cursor accepted transparently (`:1014-1022`)
  for warm-cache clients.
- Post-append seed (`:618-629`) and post-update seed (`:312-319`)
  ensure every row has a non-NULL `modified_at`.
- Composite index `idx_assistant_messages_session_modified_id` (migration
  v13, `session-do-migrations.ts:223`) makes the keyset scan cheap.

**Snapshot RPC** (`session-do.ts:4092-4112`): full-history snapshot
from `getHistory()`. Wired on the DO; **never called from the client.**

**Divergence between live and refresh paths:**
- Live: frame is ephemeral — if dropped, nothing re-creates it.
- Refresh: pulls from SQL, which is the source of truth.
- The cursor always slides forward on `modified_at`, so refresh
  deterministically paints whatever the runner actually persisted.

### 4. Client delta apply — happy path only, no gap or snapshot logic

`messagesCollection` factory (`apps/orchestrator/src/db/messages-collection.ts:95-127`):

- Dispatches on `collection: 'messages:<sessionId>'`.
- Calls `begin()`, loops ops, `write()` each, `commit()`.
- `insert` auto-converts to `update` on key collision (`:119-124`) —
  this is how growing `partial_assistant` rows upsert in place.
- **No seq comparison.** Frames are applied in arrival order.
- Per-op silent-fail on `delete` of a missing key (a symptom, not a
  cause).

Reconnect path (`hooks/use-coding-agent.ts`):
- `:147-149` buffers pre-subscribe frames (5 s TTL; commit `fdb7b90`).
- `:522` computes `sinceCursor` as the tail of the collection.
- `:608-624` on WS.open: targeted `subscribe:messages` with tail cursor
  triggers DO replay.
- `:393-416` applies `{type:'session_status'}` frames directly.

`ConnectionManager` (`lib/connection-manager/manager.ts:64-87`) only
reconnects CLOSED/CLOSING sockets (commit `82842d2`); OPEN sockets are
skipped. Reconnect fires a `subscribe:messages` on next open, relying
entirely on cursor replay. **No client-initiated `requestSnapshot`.
No `lastSeq`. No gap detection.**

Derived status (`lib/display-state.ts:106-144`): reads `status`
directly from the D1-mirrored `agent_sessions` row + `wsReadyState`,
**not** folded over `messagesCollection`. So "UI shows idle mid-stream"
means the D1/live-status channel said idle — it's not a message-fold
artifact.

### 5. Prior fixes and coverage gaps

See `planning/research/2026-04-22-gh69-session-state-drift.md` for full
prior-art catalogue. Timeline relevant here:

| Commit | Date | What it fixed | What it did not fix |
|--------|------|---------------|---------------------|
| `fa2845c` | Apr 6 | Introduced status-TTL-derived liveness | **Regression: removed app-level WS ping**, letting CF ~70 s idle-close fire during quiet phases |
| `16e7d72` | Apr 9 | Cursor-aware subscribe replay restores cold-load | — |
| `590444d` | Apr 15 | Replay in-place updates via `modified_at` | — |
| `34a2d29` | Apr 22 | Instrumentation for 1006 WS flap | Diagnostic only |
| `aeb9209` | Apr 22 | Persist `lastEventTs` through hibernation | Patches TTL staleness, not message loss |
| `ed9c673` | Apr 22 | Push live status over agent WS bypassing D1 debounce | Introduces the status-races-messages race this doc describes |
| `54ae9db` | Apr 22 | Co-flush `lastEventTs` on every running promotion | Same class as `aeb9209` |
| `d026838` | Apr 23 | Unify cursor on `modified_at` | — |

**Coverage gaps:**
- No test that exercises out-of-order frame arrival → gap detection →
  snapshot merge (the docstring at
  `use-coding-agent.test.ts:12` claims this but no implementation
  exists).
- No test for closed-socket-during-broadcast silent drop.
- No test for `BufferedChannel` overflow → runner crash → gap loss.
- No test for status-vs-messages frame ordering on `result`.

## The failure model, end to end

1. Runner sends a delta. `seq = N+1`.
2. Frame is lost. Three known paths:
   - **BufferedChannel overflow + WS drop** before reattach — `pendingGap`
     was in-memory only, lost with the process or WS.
   - **DO `broadcastToClients` silent drop** (`session-do.ts:1237-1242`)
     on a half-closed socket. No log, no retry.
   - **CF ~70 s idle-close** during a quiet phase (spec #50 removed the
     app-level keepalive that used to prevent this). Triggers recovery
     paths that can emit status transitions before message tails catch up.
3. Client has no seq check. UI holds the stale partial.
4. Runner emits `result`. DO writes the final `assistant` row to SQL,
   broadcasts the (possibly lost) final message delta, then flips
   status via a separate channel (`broadcastSessionStatus` +
   `syncStatusToD1` + `broadcastSessionRow`).
5. Client's derived status reads idle (from live `session_status` frame or
   D1). UI renders the session as idle with the stale partial text.
6. **Refresh** — REST cold-load + cursor-aware subscribe both hit SQL.
   SQL has the final row. UI renders correctly.

## Recommendations

Ranked by expected impact on the reported symptom. Fixes 1 and 2
together should eliminate it; 3-5 are defense-in-depth.

### 1. Ship the missing client-side seq-gap + `requestSnapshot` path (P1)

The DO half already exists. Add on the client:

- Per-session `lastSeq` ref, keyed on agentName, held in the hook that
  owns the agent WS.
- On each `{type:'messages'}` delta frame: if `seq > lastSeq + 1`, call
  `requestSnapshot` RPC (exists at `session-do.ts:4092`), apply the
  snapshot, reset `lastSeq` to the snapshot's top `seq`. If `seq ==
  lastSeq + 1`, apply and advance. If `seq <= lastSeq`, drop.
- Reset `lastSeq` only via snapshot or successful cursor-replay.

**Why it works:** the symptom is "frame dropped, client stayed stale."
This makes the client self-healing against ANY drop source — overflow,
closed-socket, CF idle-close, or a future unknown.

**Effort:** ~1 day. DO side is untouched. Client-side is ~1 hook + ~1
collection-options-creator change. Unit test coverage already has
scaffolding (`use-coding-agent.test.ts` docstring).

### 2. Restore a WS keepalive (P1)

Send an app-level ping frame (`{type:'ping'}` or re-use an existing
no-op event) from the client every ~30 s while the WS is OPEN. Undoes
the spec-#50 regression. Keeps CF from idle-closing quiet streams.

**Effort:** ~2 hours. Purely additive.

### 3. Make the closed-socket broadcast silent-drop loud (P2)

`session-do.ts:1237-1242`: log the drop with seq + clientId. Do not
queue — rely on (1) to recover. Just an observability fix so we can see
this happening in production.

### 4. Serialize status flip after message broadcasts on `result` (P2)

In the `result` handler (`session-do.ts:4426-4546`), `await` all
message-broadcast promises before calling `updateState({status:'idle'})`.
Eliminates the status-races-messages class without changing wire
shape.

### 5. Persist `BufferedChannel` gap sentinel (P3)

On overflow, write the coalesced sentinel to a small sidecar file next
to the runner's `.meta.json` so a runner restart can read it and
re-emit on reconnect. Only matters if (1) is shipped; otherwise the
client can't use the sentinel anyway.

## Open questions

- Is the mobile Capacitor case covered by (1) + (2) alone, or does
  `android.loggingBehavior: 'production'` + the Tailscale logcat
  instrumentation surface additional drop paths the web doesn't hit?
  (Hypothesis: no — mobile just makes visibility swaps more frequent,
  amplifying the same drop paths.)
- Does the `session_status` frame arrive before or after the final
  message delta on the wire when the runner is local (no CF TCP hop)?
  If the answer is "reliably after on single-region," (4) may not be
  necessary for the observed symptom — but still cheap defense.
- `assistant_messages` table session_id column is literal `''` in the
  cursor queries (`session-do.ts:1799`) — the SDK uses empty-string as
  a sentinel for "this DO's session." Worth confirming no edge case
  where this doesn't hold (e.g. forkWithHistory writes).

## Next steps

- If user confirms the recommendation set, open an issue to track (1)
  as the headline fix (spec-#14 follow-through). Reference this doc
  and GH#69 Cluster 2.
- Add a failing test before fix: an integration test that drops a
  single delta mid-stream and asserts the client recovers via
  requestSnapshot (or fails, under current code).
- Keep (2) as a separate small PR — it's unrelated to the gap
  protocol but regresses the same symptom from a different angle.
