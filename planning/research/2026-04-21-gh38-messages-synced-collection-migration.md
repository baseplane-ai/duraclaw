---
date: 2026-04-21
topic: Migrate messagesCollection off hand-spun WS push path onto createSyncedCollection (R1.5)
type: feasibility
status: complete
github_issue: 38
workflow: GH#38
extends: 2026-04-20-session-state-surface-inventory.md
related:
  - 2026-04-19-messages-transport-unification.md  # GH#14 predecessor that built the current bespoke path
  - 2026-04-20-issue-35-agent-sessions-synced-collection.md  # agent_sessions migration (sibling R1)
items_researched: 5
---

# Research: Migrate `messagesCollection` off hand-spun WS push path onto `createSyncedCollection` (R1.5)

## Context

Issue #38 proposes a follow-up unification bet: take the bespoke `{type:'messages'}`
delta/snapshot channel that Spec #31 built (commit `40f5f62`) and collapse it onto
the `createSyncedCollection` factory that Spec #32/#33 built three hours later
(commit `0c1e011`). The two ship dates are revealing — the factory was general
enough to cover messages on paper, but per-session WS affinity and seq discipline
made messages a harder target, so Spec #31 kept its own wire protocol.

This doc is the P0 research step for Issue #38. It treats the issue body as the
problem statement and answers:

1. **Is the tangle actually as described?** Yes, and deeper — five write paths plus
   two responsibilities (`seq` discipline, structural snapshots) that
   `createSyncedCollection` doesn't currently own.
2. **Is the proposed migration path viable?** Conditionally — the issue understates
   one architectural delta: the factory is **user-scoped**, messages are
   **session-scoped**. Three routing options are viable; none is purely a frame-type
   extension.
3. **What sequencing makes sense?** Most likely after R1 (status collapse, issue
   #37) but spec review owns the final call.
4. **What open questions must the P1 interview resolve?** Eight, enumerated below.

## Scope

**In scope:**
- The hand-spun WS push path for `messagesCollection` (`use-coding-agent.ts`
  `handleMessagesFrame`, `applySnapshot`, `bulkUpsert`, `writeUpsert`, optimistic
  user-turn mutation, `lastSeq` ref lifecycle).
- The `messagesCollection` factory itself (`messages-collection.ts`), including
  REST cold-load triple-stamp (`version` / `seq` / `frame.seq`).
- The DO broadcast path (`SessionDO.broadcastMessages`, `broadcastMessage`, RPC
  handlers for rewind/resubmit/getBranchHistory/requestSnapshot).
- The wire frame shape (`MessagesFrame` in `packages/shared-types`).
- The `createSyncedCollection` factory and its extension points.
- The `branchInfoCollection` split — user confirmed this is in-scope for R1.5
  (not deferred to a follow-up).

**Out of scope:**
- Actually writing Spec R1.5 (that's P2's job).
- R1 sequencing decision (deferred to P3 spec review per user P0 instruction).
- `sessionLiveStateCollection` retirement (R2 — separate spec).
- Message D1 backup (R5 — covered by the `2026-04-16-state-management-audit.md`
  migration-to-PartyServer plan).

**Sources:** Five parallel Explore agents reading:
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`
- `apps/orchestrator/src/db/messages-collection.ts`
- `apps/orchestrator/src/db/synced-collection.ts`
- `apps/orchestrator/src/db/branch-info-collection.ts`
- `apps/orchestrator/src/agents/session-do.ts`
- `packages/shared-types/src/index.ts`
- `apps/orchestrator/src/lib/broadcast-synced-delta.ts`, `chunk-frame.ts`
- `apps/orchestrator/src/agents/user-settings-do.ts`
- `apps/orchestrator/src/hooks/use-user-stream.ts`, `use-branch-info.ts`
- `apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx`
- `apps/orchestrator/src/db/user-tabs-collection.ts`, `user-preferences-collection.ts`,
  `projects-collection.ts`, `chains-collection.ts`
- `planning/research/2026-04-19-messages-transport-unification.md` (GH#14
  predecessor — actual source of the bespoke path)
- `planning/research/2026-04-20-session-state-surface-inventory.md` (the research
  doc referenced by the issue, pulled from `origin/main` commit `a5628c3`)
- `planning/specs/28-synced-collections-pattern.md`,
  `planning/specs/31-unified-sync-channel.md`
- Commits `e9b5177`, `3a8169c`, `9b80143`, `b37cd6e`, `ad5f548`, `40f5f62`,
  `0c1e011` via `git show`

---

## Part 1 — The Tangle, Inventoried

### 1.1 Five write paths into `messagesCollection`

Enumerating what the issue calls "the write path forks by provenance, not by data":

| # | Path | Mechanism | Seq source |
|---|------|-----------|------------|
| 1 | REST cold-load | `queryFn` (`messages-collection.ts:96-111`) → `toCachedMessage(m, agentName, json.version)` | `json.version` (DO's `messageSeq` at fetch time, returned by `GET /api/sessions/:id/messages`) |
| 2 | WS delta | `handleMessagesFrame` contiguous branch (`use-coding-agent.ts:318-334`) → `writeBatch` + `writeUpsert(toRow(m, agentName, frame.seq))` | `frame.seq` |
| 3 | WS snapshot | `applySnapshot` (`use-coding-agent.ts:185-199, 246-247`) → diff-delete stale + `bulkUpsert(messages, frame.payload.version)` | `frame.payload.version` |
| 4 | Optimistic user turn | `sendMessage` (`use-coding-agent.ts:702-738`) → `writeUpsert(optimisticRow)` with `id: 'usr-client-<uuid>'`, **no seq** | none (pre-echo) |
| 5 | Server echo | Delta handler re-writes the same id with `frame.seq`; deep-equal loopback retires optimistic row silently (`use-coding-agent.ts:329`) | `frame.seq` |

**Each path enforces different invariants** — different seq-stamping rules,
different stale-row handling, different idempotency contracts. The JSDoc at
`messages-collection.ts:104-108` **is** the tangle:

> `version` is the DO's current `messageSeq` at fetch time. Stamp every
> REST-loaded row with it so query-db-collection's diff reconcile doesn't
> clobber the `seq` values that the on-connect WS snapshot has already written.

Translation: a framework contract (deep-equal diff) being bypassed by a manual
stamp because the push path lives outside the factory.

### 1.2 `handleMessagesFrame` invariants (188 lines)

Per Explore agent B, `handleMessagesFrame` (`use-coding-agent.ts:221-409`)
owns these concerns:

| Invariant | Lines | Notes |
|-----------|-------|-------|
| Seq gap detection → `requestSnapshot` RPC | 387-390 | `frame.seq > lastSeq + 1` triggers `onGap()` |
| Backwards-seq → `requestSnapshot` (not silent drop) | 403-405 | Commit `9b80143`; handles DO rehydrate resetting `messageSeq` to 0 |
| Snapshot reason handling (`reconnect`/`rewind`/`resubmit`/`branch-navigate`) | 246-314 | Reason field is passed but handler applies **identical reconciliation** regardless |
| Stale-row deletion on snapshot | 185-199, 246-247 | Diff-delete rows not in incoming messages set |
| BranchInfo splitter — snapshot path | 270-313 | Extract `branchInfo`, reconcile separately |
| BranchInfo splitter — delta path | 341-382 | Same for `deltaBranchInfo.upsert`/`remove` |
| Optimistic user turn id (`usr-client-<uuid>`) | 76-80 | Server accepts client-proposed id; echo reconciles by id match |
| `lastSeq` ref lifecycle | 122-124, 140, 244, 253, 383 | Per-agentName map; reset on snapshot, tab-switch, contiguous delta |

The fact that **snapshot reason is ignored by the handler** is notable — the
client doesn't care why the snapshot arrived, only that it's authoritative. That
means the DO-side `reason` tag is observability metadata, not a contract. R1.5
can drop it (or keep it for logs).

### 1.3 Two collections on one frame

`{type:'messages'}` carries messages **and** branchInfo. The frame shape
(`packages/shared-types/src/index.ts:634-682`):

```typescript
interface MessagesFrame {
  type: 'messages'
  sessionId: string
  seq: number
  payload: DeltaPayload | SnapshotPayload
}

type DeltaPayload = {
  kind: 'delta'
  upsert?: SessionMessage[]
  remove?: string[]
  branchInfo?: { upsert?: BranchInfoRow[]; remove?: string[] }
}

type SnapshotPayload = {
  kind: 'snapshot'
  version: number
  messages: SessionMessage[]
  reason: 'reconnect' | 'rewind' | 'resubmit' | 'branch-navigate'
  branchInfo?: BranchInfoRow[]
}
```

Commit `b37cd6e` (branchInfo snapshot reconcile + robust upsert fallback) was
needed precisely because the hand-wired splitter got out of sync with the messages
reconcile path. The fix adds diff-and-delete for branchInfo on every snapshot and
switches to update-first-insert-fallback on every upsert.

### 1.4 Triple-stamped seq

Three places independently stamp `seq` onto a row:

1. **DO broadcast** — `SessionDO.broadcastMessages` (`session-do.ts:951-960`)
   assigns `this.messageSeq += 1` per broadcast.
2. **REST queryFn** — stamps every REST-loaded row with `json.version` (the DO's
   current `messageSeq` at fetch time, returned by the REST endpoint).
3. **Client WS handler** — stamps rows with `frame.seq` (delta) or
   `frame.payload.version` (snapshot).

Why: `queryCollectionOptions` uses deep-equal to reconcile `queryFn` results
against the in-memory collection. Without the REST row carrying the same `seq`
that a prior WS snapshot wrote, diff-reconcile would treat every row as changed
and clobber the WS-written seq values. The triple-stamp is a workaround for the
push path being outside the factory.

### 1.5 Server-side `messageSeq` lifecycle

Per Explore agent D:

- `private messageSeq = 0` (in-memory, `session-do.ts:188`).
- Rehydrated from typed SQLite `session_meta.message_seq` column on `onStart`
  (`session-do.ts:212-218`, migration v6 at `session-do-migrations.ts:70-119`).
- Persisted **every 10th increment** only (`session-do.ts:957`,
  `MESSAGE_SEQ_PERSIST_EVERY = 10`). Rationale: avoid per-frame SQL writes during
  streaming `partial_assistant`; clients reconnect with a snapshot anyway when
  the DO evicts.
- **Survives DO hibernation** via SQLite; no risk of seq going backwards on
  reload.

No per-message `seq` column in SQLite — seq is frame-level only, stamped at
broadcast. This matters for R1.5: the DO can emit `synced-collection-delta`
frames with seq on the op without changing any DO SQLite schema.

### 1.6 The hidden architectural delta

**The issue's proposed migration understates one thing: routing scope.**

`createSyncedCollection` is **user-scoped** by design:

- Fanout path: `broadcastSyncedDelta(env, userId, collection, ops)` →
  `UserSettingsDO.handleBroadcast` → iterate user's socket set → `ws.send`.
- Socket tracking: `UserSettingsDO` holds one WS set per user, hibernation-
  rehydrated via `ctx.getWebSockets()`.
- Reconnect: `onUserStreamReconnect` registered per `createSyncedCollection`
  instance, per user.
- Cross-user fanout (projects only): `SELECT user_id FROM user_presence` then
  `Promise.allSettled` across the active user list.

`messagesCollection` is **session-scoped**:

- Wire: per-session WS dialed by the DO at
  `wss://.../agents/session-agent/<do-id>?role=gateway`.
- Broadcast: `SessionDO.broadcastMessages` iterates `this.getConnections()`
  (Agent SDK hibernation-aware), filters out the gateway role by connection id,
  sends to browser clients.
- Reconnect: DO pushes a snapshot at `onConnect` (`session-do.ts:393-407`).

These are two different WS topologies. You can't just swap the frame type —
you have to pick how messages get their socket.

---

## Part 2 — Routing Options (per user P0 instruction: present all three)

### Option A — Route messages through UserSettingsDO

**Shape:**

- `SessionDO.broadcastMessages` calls `broadcastSyncedDelta(env, userId, 'messages:{sessionId}', [ops])`.
- `UserSettingsDO` fans out to all user sockets. Client-side, frames with
  `collection: 'messages:{sessionId}'` route to the right per-session collection
  via the same `frameHandlers` registry that already handles `user_tabs` etc.
- Session-scoped WS (`/agents/session-agent/<do-id>`) is retained **only** for
  runner-role ingress — no browser clients on it anymore.

**Pros:**
- Messages look **identical** to the other four synced collections; one code path.
- `UserSettingsDO` already handles hibernation-aware socket rehydration, cross-
  tab broadcast, `SYNC_BROADCAST_SECRET` auth.
- Reconnect invalidation uses the existing `queryClient.invalidateQueries`
  pattern. No session-scoped reconnect handler needed.

**Cons:**
- **Largest refactor.** Every browser WS currently talks to its `SessionDO`
  directly. Moving the browser-facing channel to `UserSettingsDO` means
  re-routing every existing frame type (`gateway_event`, `session_summary`,
  `raw_event`, `mode_transition`) either through `UserSettingsDO` or keeping
  them on the per-session WS alongside a separate messages-only path through
  `UserSettingsDO`. The latter means clients would hold **two** WSs per session
  instead of one.
- Loses per-session WS affinity. `SessionDO.getConnections()` as a
  "who's watching this session" signal goes away or needs re-plumbing.
- ACL — `UserSettingsDO` would need to validate that the userId owns the session
  before fanning out. Today that check is implicit in the per-session WS upgrade.
- Performance — 50-message burst from an `assistant` streaming turn would
  round-trip through two DOs (SessionDO → UserSettingsDO → client) instead of
  one.

**Migration cost:** **High.** 10+ files; wire-contract change on every frame
type, not just messages.

### Option B — Extend `createSyncedCollection` with a session-scoped binding

**Shape:**

- New construction variant:
  ```typescript
  createSyncedCollection({
    id: 'messages',
    sessionScoped: true,   // new
    subscribeToSessionStream: (sessionId, handler) => { ... },
    // ... rest unchanged
  })
  ```
- The factory registers its `begin/write/commit` handler against a session-
  scoped stream hook instead of the module-level `use-user-stream.ts` registry.
- `SessionDO.broadcastMessages` emits `synced-collection-delta` frames on the
  existing per-session WS; no `UserSettingsDO` touched.
- The four existing user-scoped collections keep their current construction;
  messages and branchInfo use the new session-scoped variant.

**Pros:**
- **Wire-compat with existing session WS.** No DO re-plumbing.
- Factory gains a parameterized dependency (which stream to subscribe to)
  without the other collections knowing.
- Per-session WS affinity preserved.
- Clear scoping semantics — a session-scoped collection is instantiated per
  `agentName` (matching today's memoisation).

**Cons:**
- **Forks the factory.** `createSyncedCollection` now has a
  user-scoped mode and a session-scoped mode with subtly different lifecycle
  (per-agentName memoisation vs module-level singleton; per-session reconnect
  vs user-wide reconnect).
- The promised "one collection pattern across the codebase" outcome from the
  issue becomes "one factory with two modes" — a modest walk-back.

**Migration cost:** **Medium.** Factory extension + message/branchInfo adoption.
~5 files touched.

### Option C — Extend the frame shape only; keep session-scoped apply logic

**Shape:**

- Extend `SyncedCollectionFrame` and `SyncedCollectionOp`:
  ```typescript
  type SyncedCollectionOp<TRow> =
    | { type: 'insert'; value: TRow; seq?: number }
    | { type: 'update'; value: TRow; seq?: number }
    | { type: 'delete'; key: string; seq?: number }

  interface SyncedCollectionFrame<TRow> {
    type: 'synced-collection-delta' | 'synced-collection-snapshot'
    collection: string
    ops: Array<SyncedCollectionOp<TRow>>
    sessionId?: string  // when session-scoped
    seq?: number        // frame-level, for snapshot correlation
  }
  ```
- `messagesCollection` keeps its bespoke construction for now (still
  `queryCollectionOptions` + `persistedCollectionOptions`) but the **wire format**
  becomes the shared synced-collection frame shape. The client apply logic still
  lives in a custom handler.
- BranchInfo gets its own frame type `{collection: 'branch-info:{sessionId}'}`.

**Pros:**
- **Smallest delta.** Wire format unifies without touching routing topology.
- Lets downstream R1.5 work (if taken up later) swap to a shared apply path
  without another wire-format churn.
- Unblocks future Option B by making the frame shape compatible first.

**Cons:**
- **Doesn't actually retire the hand-spun apply logic.** `handleMessagesFrame`
  stays, just reads a slightly different JSON shape. The issue's "~20 lines of
  config" outcome is not achieved.
- Creates a "unified frame shape, forked apply logic" state that's arguably
  worse than today's clean "separate frame, separate apply" — the seam moves but
  doesn't disappear.
- The `seq?: number` on each op is the minimum footprint, but it's only used by
  one consumer (messages). For the four user-scoped collections it's dead weight
  on the type.

**Migration cost:** **Low.** Frame shape extension + DO broadcast rewrite.
~3 files. But **effort doesn't buy the stated goal** — the hand-spun handler
persists.

### Comparison matrix

| Criterion | Option A (UserSettingsDO) | Option B (session-scoped factory) | Option C (frame-shape only) |
|-----------|---------------------------|-----------------------------------|------------------------------|
| Retires `handleMessagesFrame` | **Yes** | **Yes** | **No** |
| Retires `applySnapshot` | **Yes** | **Yes** | **No** |
| Retires `writeUpsert` bypass | **Yes** | **Yes** | **No** |
| One factory pattern codebase-wide | **Yes** | No (two modes) | No |
| Preserves per-session WS affinity | No | **Yes** | **Yes** |
| Preserves DO `getConnections()` signal | No | **Yes** | **Yes** |
| Wire-contract change beyond messages | **Yes** (all frames) | No | No |
| New ACL surface | **Yes** (UserSettingsDO validates session ownership) | No | No |
| File touch count | ~10+ | ~5 | ~3 |
| Delivers issue's stated outcome | **Yes** | **Yes** | **No** |
| Parallelizable with R1 | Yes | Yes | Yes |

### Strawman recommendation

**Option B** — extend `createSyncedCollection` with a session-scoped
construction mode.

- Only option that delivers the issue's stated outcome (retire the hand-spun
  handler) without upending the WS topology.
- Preserves all the SessionDO invariants (hibernation, `getConnections()`,
  token auth, dial-back).
- The "one factory with two modes" walk-back is small — the user-scoped
  construction stays the idiomatic path; session-scoped is the narrow exception
  for per-session live state.
- BranchInfo naturally rides the same session-scoped variant with its own
  collection name.

Option C is a reasonable staging step if the team wants to decouple wire-format
unification from apply-logic unification, but on its own it doesn't meet the
issue's goal.

Option A is correct in spirit (total unification) but the cost is disproportionate
— it entangles messages routing with a WS topology migration that should be its
own spec.

**P1 interview must confirm.** This is the highest-stakes open question.

---

## Part 3 — Seq Discipline Under Each Option

### Today

Frame-level `seq` + per-client `lastSeq` ref + `requestSnapshot` RPC on gap or
backwards-seq. Stamped at three points (DO broadcast, REST queryFn, client
handler) to keep deep-equal reconcile from clobbering the value.

### Under Option A / B (full migration)

Two sub-choices:

1. **Keep seq discipline — extend the factory to honor it.**
   - `SyncedCollectionOp` gains optional `seq?: number`.
   - `SyncedCollectionFrame` gains a snapshot variant (`type:
     'synced-collection-snapshot'` or `kind` discriminator).
   - Factory's `sync` callback rejects backwards seq, detects gaps, and invokes
     a `requestSnapshot` callback (supplied by the collection config) to pull a
     fresh snapshot.
   - REST `queryFn` still returns `{rows, version}`; rows stamped at fetch time;
     factory's deep-equal reconcile needs teaching to treat `seq` as opaque
     metadata (not compared) — or the stamp is dropped entirely if we switch to
     option (2) below.
   - Pros: matches the issue's proposed extension exactly. Protects against
     missed deltas during streaming.
   - Cons: adds seq semantics to a factory that other collections don't need.
     Every future consumer of `createSyncedCollection` has to know whether their
     frames should carry seq or not.

2. **Drop seq discipline; lean on `queryFn` re-fetch on reconnect.**
   - On reconnect, `queryClient.invalidateQueries` → `queryFn` re-hits
     `GET /api/sessions/:id/messages` → D1 (or DO SQLite via REST) state
     reconciled via `applySuccessfulResult` deep-equal.
   - **But:** messages are the hot path. A 1000-turn session on cold reconnect
     would re-fetch 1000 messages. The DO SQLite supports it (that's what REST
     already does) but the wire cost is real.
   - Gap detection during a live stream (e.g., one frame dropped mid-turn) would
     only recover on next reconnect, not immediately.
   - Pros: radical simplification. Factory stays uniform. No seq concept.
   - Cons: bandwidth on reconnect; live gap-tolerance regression.

**Strawman:** **Keep seq discipline.** Messages are uniquely hot (streaming
deltas many per second during an assistant turn). The factory extension is
small. The alternative — full re-fetch on every gap — is operationally
expensive.

P1 interview should confirm. An intermediate option is "seq on session-scoped
collections only" — i.e., the factory's new session-scoped mode (Option B)
honors seq; the user-scoped mode ignores it.

### Under Option C (frame-shape only)

Seq stays exactly where it is today (client's `lastSeq` ref, `requestSnapshot`
RPC). Frame shape just wraps the same fields in the new envelope.

---

## Part 4 — BranchInfo Split (user-confirmed in-scope)

Per Explore agent E, the branchInfo migration is straightforward:

### New frame shape (Options A/B)

```typescript
// synced-collection-delta frame with:
{
  type: 'synced-collection-delta',
  collection: 'branch-info:<sessionId>',
  ops: [
    { type: 'insert'|'update', value: BranchInfoRow },
    { type: 'delete', key: parentMsgId },
  ],
}
```

### Seq discipline: **NOT needed**

BranchInfo is **idempotent per `parentMsgId`** and **always follows a message
mutation**. The DO emits branchInfo ops in the same broadcast batch as the
message ops that caused them. As long as both rides the same WS, they arrive
together; no seq correlation needed. This is Explore agent E's recommendation
and it holds under Option B.

Under Option A (through UserSettingsDO) this is still safe because both frames
fan out sequentially from the same origin.

### Emission frequency unchanged

- On user-turn mutations that add a sibling (`sendMessage`, `forkWithHistory`):
  single-row upsert for the affected parent.
- On structural changes (`rewind`, `resubmit`, `branch-navigate`, `onConnect`,
  `requestSnapshot`): full reconciliation — emit a snapshot of all rows + diff-
  delete stale.

No change in how often branchInfo moves; just which wire channel it rides.

### Client-side

- New `branchInfoCollection` as a session-scoped `createSyncedCollection` under
  Option B (keyed by `parentMsgId`, memoised per agentName).
- `useBranchInfo` hook unchanged in signature; internally subscribes to the new
  collection.
- Delete the branchInfo splitter code from `handleMessagesFrame`
  (`use-coding-agent.ts:270-313, 341-382, 254` — the diff-delete-stale logic).

### Consistency with messages

Under Options A/B, messages and branchInfo are separate frames. There's a
narrow window where messages apply before branchInfo (or vice versa), during
which the UI could render a user turn whose parent's sibling count is stale.
Today this is atomic because both ride one frame. Mitigations:

1. **Batch at the DO** — emit both frames in the same `broadcastToClients`
   iteration; browser event-loop sees them back-to-back. Probably sufficient.
2. **TanStack DB batch commit** — wrap the two `begin/write/commit` into one
   outer transaction so `useLiveQuery` sees a single atomic update. Requires a
   factory extension or a local batch wrapper.

Option 1 is cheapest; Option 2 is more correct. Defer to P1 interview.

---

## Part 5 — Sequencing vs R1, R2, R3

Per Issue #37's research doc (`2026-04-20-session-state-surface-inventory.md`):

- **R1** = collapse session status onto `agent_sessions` column (Path A in that
  doc). Depends on nothing.
- **R2** = retire `sessionLiveStateCollection`. Depends on R1.
- **R3** = D1-mirror result/error/gate. Depends on nothing (cleanest after R1).
- **R4** = seq-stamped gateway events. Deferred.
- **R5** = message D1 backup. Out of scope.

**R1.5 (this issue) is not in the research doc's ranked list.** The issue
author correctly notes it as implicit under Gaps #1/#2 and proposes it as its
own unification bet.

### What R1 buys R1.5

Post-R1:
- `useDerivedStatus` is deleted. Status comes from `agent_sessions.status`.
- `messagesCollection` no longer powers status derivation — it's purely a
  render source for the chat thread.
- **Seq correctness becomes a render-ordering concern, not a correctness
  concern.** A dropped or out-of-order message delta manifests as a visible
  glitch in the conversation thread, not as a frozen status indicator.

This narrows R1.5's verification surface substantially. Pre-R1, R1.5 must prove
seq discipline preserves every `useDerivedStatus` edge case (15+ regression
fixes from the research doc's commit table). Post-R1, R1.5 only needs to prove
render ordering is stable.

### What R1.5 buys R2

R2 retires `sessionLiveStateCollection`. That collection's writes happen in
`handleMessagesFrame`'s sibling, `use-coding-agent.ts:485-521` (gateway_event
handlers for `context_usage`, `kata_state`). Those aren't on the messages
channel, so R1.5 doesn't touch them directly. But if R1.5 establishes the
session-scoped `createSyncedCollection` variant (Option B), R2 can reuse it
for context_usage / kata_state migration.

### Strawman sequencing (for P3 spec review to confirm)

```
R1 (status collapse) → R1.5 (messagesCollection migration) → R2 (sessionLiveStateCollection retirement) → R3 (result/error D1 mirror)
```

R1 and R3 could parallel if the team wants. R1.5 → R2 is strict because R2
leans on the session-scoped factory mode R1.5 builds.

An alternative sequencing: **R1.5 before R1.** Buys faster factory unification
but means R1.5 must carry the full status-correctness regression burden. Not
recommended on effort grounds but not wrong.

Spec review decides.

---

## Part 6 — Key Findings

1. **Tangle is real and slightly deeper than the issue describes.** Seven
   responsibilities (five write paths plus seq discipline plus structural
   snapshots), not five.

2. **Routing scope is the hidden architectural delta.** The issue's proposed
   migration reads as a frame-shape extension, but messages live on a per-
   session WS while `createSyncedCollection` is user-scoped. Three routing
   options (A/B/C) with meaningfully different cost/benefit.

3. **Option B (session-scoped factory variant) is the strawman.** Retires the
   hand-spun handler, preserves per-session WS affinity, smallest cost that
   meets the issue's goal. Option A is disproportionately expensive; Option C
   doesn't retire the handler.

4. **Seq discipline should probably stay** (messages are the hottest write
   path; `queryFn` re-fetch on every gap is operationally expensive) but this
   is explicitly an interview question.

5. **BranchInfo split is straightforward.** Own `createSyncedCollection`, no
   seq needed (idempotent per `parentMsgId`), emission frequency unchanged,
   narrow consistency window with messages (mitigable by DO batch-emit).

6. **R1.5 sequences cleanly after R1 but not strictly.** Post-R1 the verification
   burden shrinks dramatically; pre-R1 is feasible but more expensive to test.

7. **The "triple-stamp" comment at `messages-collection.ts:104-108` is the
   tangle.** A framework contract (deep-equal diff) being manually bypassed
   because the push path lives outside the factory. The migration retires the
   stamp at its root.

8. **Snapshot `reason` tag is observability, not a contract.** Client ignores
   it. Safe to drop or log-only.

---

## Part 7 — Open Questions (for P1 interview)

1. **Routing option — A, B, or C?** (Part 2 above.) Strawman B. Highest-stakes
   decision in the spec. Determines scope, file count, WS topology.

2. **Seq discipline — keep or drop?** (Part 3 above.) Strawman keep. If drop,
   confirm we accept full-fetch reconnect cost for 1000-turn sessions.

3. **Client-proposed optimistic ID (`usr-client-<uuid>`).** Does the DO's
   current "accept client id" contract transfer cleanly to `onInsert`
   mutationFn semantics? Or does the optimistic user turn need special
   handling in the factory?

4. **Snapshot variant wire shape.** `type: 'synced-collection-snapshot'` as a
   separate discriminator, or `ops: [{type: 'snapshot-begin'}, ...ops,
   {type: 'snapshot-end'}]` bracket, or carry `kind: 'snapshot'` inside the
   existing delta frame? Affects every consumer of the frame type, not just
   messages.

5. **Per-agentName memoisation.** `messagesCollection` and `branchInfoCollection`
   are per-agentName (one instance per session). Existing synced collections
   are module-level singletons. Where does memoisation live — in
   `createSyncedCollection` itself (new `scopeKey` param), in a wrapper hook
   (`useMessagesCollection(agentName)` owns the cache), or just inline in the
   hook?

6. **REST cold-load `version` stamp.** If the factory honors seq on ops, does
   the REST `queryFn` also stamp `version` on every returned row? Or does the
   client trust the WS to settle ordering and REST just seeds the collection?
   (Simpler: latter. But behaviorally regresses the fix `e9b5177` addressed —
   initial-load ordering flash — unless seq-aware apply handles it.)

7. **R1 sequencing — R1.5 before, after, or in parallel?** Strawman after.
   Spec review owns the call.

8. **Phasing within R1.5.** Single migration (one spec, one impl), or stage it
   (P1 = frame shape; P2 = factory extension; P3 = branchInfo split; P4 =
   handler deletion)? Messages is hot-path — staging reduces revert surface.

9. **Snapshot `reason` — drop, keep for logs, or keep in client for analytics?**
   Client ignores today; DO emits four values. Cheapest: keep in wire shape for
   observability, drop from client handler.

10. **DO batch-emit for messages+branchInfo atomicity.** When both frames are
    emitted for the same mutation, do we gate their application on a single
    TanStack DB transaction, or trust event-loop ordering?

---

## Part 8 — Next Steps

1. **P1 interview** (`/kata-interview`) — walk through the 10 open questions
   above. Priority order: Q1 (routing), Q2 (seq), Q8 (phasing), Q7 (R1
   sequencing).

2. **P2 spec writing** (`/kata-spec-writing`) — draft with B-IDs organized by
   layer (DO broadcast / wire frame / factory extension / client apply /
   branchInfo) and phases matching the interview decision on Q8.

3. **P3 spec review** (`/kata-spec-review`).

4. **P4 close** — commit research doc + link to #38.

5. **Consider filing a companion issue for Option B factory extension** if P1
   picks it — the factory change is reusable by R2's live-state migration and
   arguably deserves its own behavior-level tracking.

---

## Appendix A — File:line index (quick reference)

| Concern | Location |
|---------|----------|
| `messagesCollection` factory | `apps/orchestrator/src/db/messages-collection.ts:65-141` |
| Triple-stamp comment | `apps/orchestrator/src/db/messages-collection.ts:104-108` |
| `handleMessagesFrame` | `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:221-409` |
| `applySnapshot` | `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:185-199` |
| Optimistic user turn (`usr-client-<uuid>`) | `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:76-80, 702-738` |
| `lastSeq` ref lifecycle | `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:122-124, 140, 244, 253, 383` |
| `MessagesFrame` wire type | `packages/shared-types/src/index.ts:634-682` |
| `BranchInfoRow` wire type | `packages/shared-types/src/index.ts:659-665` |
| `SyncedCollectionFrame` wire type | `packages/shared-types/src/index.ts:731-740` |
| `createSyncedCollection` factory | `apps/orchestrator/src/db/synced-collection.ts:33-100` |
| `broadcastSyncedDelta` helper | `apps/orchestrator/src/lib/broadcast-synced-delta.ts:13-44` |
| `chunkOps` 256 KiB cap | `apps/orchestrator/src/lib/chunk-frame.ts:1-34` |
| `UserSettingsDO.handleBroadcast` | `apps/orchestrator/src/agents/user-settings-do.ts:99-133` |
| WS receive + `frameHandlers` registry | `apps/orchestrator/src/hooks/use-user-stream.ts:111-187` |
| `SessionDO.broadcastMessages` | `apps/orchestrator/src/agents/session-do.ts:921-989` |
| `SessionDO.broadcastMessage` | `apps/orchestrator/src/agents/session-do.ts:837-871` |
| `onConnect` snapshot emit | `apps/orchestrator/src/agents/session-do.ts:362-407` |
| `requestSnapshot` RPC | `apps/orchestrator/src/agents/session-do.ts:2675-2691` |
| `rewind` RPC | `apps/orchestrator/src/agents/session-do.ts:2496-2523` |
| `resubmitMessage` RPC | `apps/orchestrator/src/agents/session-do.ts:2575-2645` |
| `getBranchHistory` RPC | `apps/orchestrator/src/agents/session-do.ts:2648-2672` |
| `computeBranchInfo` | `apps/orchestrator/src/agents/session-do.ts:889-913` |
| `computeBranchInfoForUserTurn` | `apps/orchestrator/src/agents/session-do.ts:922-948` |
| `messageSeq` in-memory counter | `apps/orchestrator/src/agents/session-do.ts:188` |
| `messageSeq` rehydrate on `onStart` | `apps/orchestrator/src/agents/session-do.ts:212-218` |
| `session_meta` SQLite migration v6+v7 | `apps/orchestrator/src/agents/session-do-migrations.ts:70-144` |
| REST `GET /messages` DO handler | `apps/orchestrator/src/agents/session-do.ts:299-323` |
| REST `/api/sessions/:id/messages` route | `apps/orchestrator/src/api/index.ts:1675-1709` |
| `branchInfoCollection` factory | `apps/orchestrator/src/db/branch-info-collection.ts:42-69` |
| `useBranchInfo` hook | `apps/orchestrator/src/hooks/use-branch-info.ts:24-46` |

## Appendix B — Commit references

| SHA | Summary | Relevance |
|-----|---------|-----------|
| `40f5f62` | Spec #31 landing — unified sync channel | **Origin** of bespoke `{type:'messages'}` path |
| `0c1e011` | Spec #32/#33 landing — `createSyncedCollection` factory | **Target** factory pattern |
| `e9b5177` | Kill initial-load + send-time ordering flashes | Seq seam between REST and WS sort order (motivation for triple-stamp) |
| `3a8169c` | Stamp optimistic user row with seq | Seam between optimistic and echo |
| `9b80143` | Backwards seq → `requestSnapshot` | Gap-detection edge case (handleMessagesFrame concern) |
| `b37cd6e` | BranchInfo snapshot reconcile + robust upsert fallback | Splitter drift (motivation for branchInfo split) |
| `ad5f548` | `useDerivedStatus` missed tool input-available | Downstream derivation (eliminated by R1, informs R1/R1.5 ordering) |
| `a5628c3` | Research #37 docs landing | Reference research doc (pulled post-research-start) |

## Appendix C — Discrepancies noted

1. Issue #38 cites `planning/research/2026-04-20-session-state-surface-inventory.md`
   as the source research doc. At the time research started, that file was on
   another worktree's unpushed branch. After `git pull origin main` (commit
   `a5628c3`) the file is present. Noted for auditability.

2. Issue #38 uses labels R1 / R1.5 / R2 that aren't literally in the research
   doc's Part 4 recommended specs (doc uses R1 / R2 / R3 / R4 / R5). The
   issue's R1 = doc's R1 (status collapse); issue's R1.5 = this issue (not in
   doc); issue's R2 = doc's R2 (retire `sessionLiveStateCollection`). Labels
   are aligned in spirit; spec-review should normalize before publishing.
