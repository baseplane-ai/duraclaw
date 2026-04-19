---
date: 2026-04-19
topic: Messages transport unification on TanStack DB (GH#14)
type: feature
status: complete
github_issue: 14
related: [12 (spec 12-client-data-layer-unification), PR#13]
items_researched: 7
---

# Research: Unify Message Transport on TanStack DB — Retire Manual Hydrate/Optimistic/Replace Reconciliation

## Context

Follow-up to GH#12 (PR #13). GH#12 unified *session live state* on TanStack DB
(`sessionLiveStateCollection`) but explicitly left the messages path out of
scope. Re-reading `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`
shows the messages path still has the same class of manual reconciliation that
#12 aimed to retire — the collection is the render source, but the write path
is hand-rolled protocol work:

1. Imperative hydrate + retry + re-hydrate ladder (`use-coding-agent.ts:239-261, 337-348`)
2. Hand-rolled optimistic-row protocol (`:189-214, 487-515`) with `usr-optimistic-*` IDs
3. Client-fabricated `turnHint` for sort ordering (`:491`)
4. Dual `type:'message'` vs `type:'messages'` DO→client fork (`:269-283`)
5. Manual `replaceAllMessages` for rewind/resubmit/navigateBranch (`:165-187`)
6. Non-reactive `branchInfo` useState<Map> + N `getBranches()` RPCs per hydrate (`:120-122, 398-434`)
7. Shadow-mirror write to `agentSessionsCollection` (`:226-236`)
8. Unbounded `events` useState log (`:119`)

Classification: **feature research** — identify what exists, what invariants
must survive, what the library already provides, and what's idiomatic.

## Scope

**Confirmed non-goals (interview-locked):**
- No SessionDO SQLite schema changes.
- No GatewayEvent (runner↔DO) wire format changes.
- TanStack DB stays — no migration.

**In scope:**
- DO ↔ browser WS protocol (this is the DO-side change that complements #12).
- Client reconciliation machinery (hydrate/optimistic/replace/branch).
- Collection layout: extending `sessionLiveStateCollection` patterns to messages,
  retiring `agentSessionsCollection` shadow, retiring `events` array.

**Items researched (R1–R7):**
- R1: Hydration ladder
- R2: Optimistic row protocol
- R3: DO → client message transport
- R4: Branch navigation model
- R5: `agentSessionsCollection` shadow mirror
- R6: `events` log + GH#12 prior-art constraints
- R7: TanStack DB 0.6.4 native patterns

Sources: codebase (Glob/Grep/Read), `planning/specs/12-client-data-layer-unification.md`,
`planning/research/2026-04-19-issue-12-client-data-layer-delta.md`, TanStack DB
docs at `tanstack.com/db/latest`, package.json for pinned versions, git history
on `use-coding-agent.ts` and `session-do.ts`.

## Findings

### R1 — Hydration ladder

**Current behavior.** The WS connect path sends `{type:'messages', messages}`
unconditionally (even empty), which the client maps to `replaceAllMessages()` +
`hydratedRef.current = true` (line 281). A parallel RPC path (`onStateUpdate` →
`hydrateMessages()` → `getMessages()` → `bulkUpsert()`) only commits
`hydratedRef = true` if the response is non-empty (line 242). When it returns
empty and `sdk_session_id` is set, a 500ms `setTimeout` retries once (lines
243–251). `running → idle` transition triggers a re-hydrate (lines 259–260).

**Invariants preserved.**
- Empty-first-response doesn't permanently gate subsequent hydrations (cold DO
  race).
- Fresh sessions (no `sdk_session_id`) skip the retry to avoid 500ms delay on
  new conversations.
- On-connect frame and RPC both succeed safely (idempotent writes via
  `messagesCollection.has`/`insert`/`update`).

**Touch points.** `hydratedRef` (4 sites), `messagesCollection` writers
enumerated in 12 distinct call sites (see R1 raw findings).

**Target shape.** `queryCollectionOptions<CachedMessage>({ queryFn: (ctx) =>
rpc.getMessages(ctx.meta?.loadSubsetOptions), syncMode: 'on-demand', retry: 1,
retryDelay: 500 })`. `isFetching` replaces `hydratedRef`. Resume re-hydrate
becomes a `useEffect` that calls `refetch()` when `state.status` transitions to
`idle`. The `{type:'messages'}` on-connect frame can either (a) stay as a
latency optimisation feeding the query cache via `queryClient.setQueryData`, or
(b) be dropped (recommend (b) — simpler, acceptable latency with `syncMode:
'on-demand'` preloading).

### R2 — Optimistic row protocol

**Current behavior.** `insertOptimistic(content)` creates a
`usr-optimistic-<ms>` row with a frozen `turnHint = maxServerTurn + 1`
(`use-coding-agent.ts:488-507`). Echo handler at `:269-276` checks the incoming
message's role + ID shape and calls `clearOldestOptimisticRow()`
(`:189-214`) to FIFO-drain one optimistic row per canonical user-turn echo.
`deleteOptimistic(id)` is the rollback-on-RPC-error path.

**Sort-key encoding** (`use-messages-collection.ts:41-59`): turn-ID match →
`[N, 0]`; `usr-optimistic-<ms>` with `turnHint` → `[turnHint, 0.5]`; without
→ `[MAX, ms]`; unknown → `[MAX, createdAt]`. The `0.5` secondary places
optimistic rows deterministically between adjacent server turns.

**Invariants.** Chronological order, one-echo-one-drain, FIFO cleanup, rollback
idempotency, session isolation (all iterations filter by `sessionId`).

**Touch points (three files).**
- `use-coding-agent.ts` — `insertOptimistic`, `deleteOptimistic`, `maxServerTurn`,
  `clearOldestOptimisticRow`, echo handler.
- `hooks/use-messages-collection.ts` — `sortKey`, `TURN_ID_RE`, `OPTIMISTIC_ID_RE`.
- `db/messages-collection.ts` — `CachedMessage.turnHint?: number`, persisted
  at schema v2.

**Target shape.** `createTransaction({ mutationFn: async () =>
rpc.sendMessage(content) })` + `tx.mutate(() =>
messagesCollection.insert(optimistic))`. Library auto-rollbacks on
`mutationFn` failure. Deep-equality reconciliation retires the optimistic row
silently **when the server echo matches** — but note **the optimistic ID
(`usr-optimistic-*`) does not match the server echo ID (`usr-N`), so naive
deep-equality won't reconcile**. This is a key open question; see synthesis
below.

### R3 — DO → client transport

**Two wire formats, different triggers.**

| Frame | Trigger | Semantics |
|---|---|---|
| `{type:'message', message}` | Streaming `partial_assistant`, tool result, finalised assistant, user-echo, gate promotion, resubmit new user row | Incremental upsert; order-preserving; idempotent by ID |
| `{type:'messages', messages[]}` | Browser reconnect only (`session-do.ts:202-208`) | Full-truth replacement |

**`replaceAllMessages` consumers — all client-side.** Rewind, resubmit, and
`navigateBranch` each call `getMessages()` RPC then `replaceAllMessages()`
locally. The DO does **not** broadcast trimmed history after rewind. Two-tab
coherence is broken today.

**No sequence numbers.** Neither frame carries `seq`. On network reorder or
reconnect, the client can't distinguish new-vs-retransmission. Echo matching
relies on FIFO + ID uniqueness.

**Target shape (recommended).** Hybrid delta+snapshot under a single
`{type:'messages'}` channel:
```ts
// Streaming path (normal case):
{ type: 'messages', sessionId, seq: 42, delta: { upsert: [msg], remove: [] } }

// Reconnect / rewind / resubmit / branch-navigate:
{ type: 'messages', sessionId, seq: 42, snapshot: { version: 42, messages: [...] } }
```
Client tracks `lastSeq` per session; non-contiguous seq → request snapshot.
Matches `BufferedChannel` gap-sentinel pattern already in `shared-transport`.
This moves ownership of rewind/resubmit/navigateBranch history trimming to
the **DO**, which kills all three `replaceAllMessages` client call sites.

### R4 — Branch model

**Server storage.** Anthropic SDK's `Session` class holds a tree with
parent-child links; SQLite-persisted (schema opaque to us). `getBranches(msgId)`
returns siblings; `getHistory(leafId?)` returns linear path root→leaf.

**Client hydration.** `branchInfo: useState<Map<msgId, {current, total,
siblings[]}>>` rebuilt on tab switch + every hydrate + every resubmit/navigate,
via N `getBranches()` RPCs (one per user turn). Cost O(U) RPCs per rebuild.
Discarded on tab switch. Non-reactive, non-persisted.

**Flows.**
- **Rewind** (RPC) → DO sends command to gateway → client trims its local
  collection; DO does not broadcast trimmed state.
- **Resubmit** (RPC) → DO appends new user sibling, broadcasts `{type:'message'}`;
  client calls `getMessages({leafId: newId})` + `refreshBranchInfo`.
- **Navigate** → client `getMessages({leafId: target})` + `refreshBranchInfo`.

**Invariants.** Branch identity = parent + sibling set; "current" = leaf of
`getHistory(leafId)`; message IDs are stable across rewinds (siblings stay in
the tree).

**Target shape.** DO pushes `branch-info` on hydrate + on resubmit. Client
holds it in a new `branchInfoCollection` (TanStack DB, keyed on parent-message
ID). `useLiveQuery` reads reactively. Retires `useState<Map>`,
`refreshBranchInfo`, and N per-turn `getBranches` RPCs.

```ts
// branchInfoCollection row:
{ parentMsgId: 'msg-2', siblings: ['usr-3', 'usr-4'], activeId: 'usr-4', sessionId }
```

Open: global collection vs per-session (like `sessionLiveStateCollection`);
behaviour across DO cold-start.

### R5 — `agentSessionsCollection` shadow mirror

**Current dual-write.** `use-coding-agent.ts:226-236` patches
`agentSessionsCollection` via `sessionsCollection.utils.writeUpdate()` on
every `onStateUpdate` — purely local, no server round-trip — while
`sessionLiveStateCollection` gets the full `SessionState` via
`upsertSessionLiveState`.

**Why both exist.** The #12 spec (approved 2026-04-19) staged the
consolidation: Phase 1 migrates StatusBar + live-state side effects;
Phases 2/3 migrate sidebar + tab-bar + delete the shadow. The dual-write is
an intentional transitional bridge.

**Readers of `agentSessionsCollection`.** `tab-bar.tsx:79`,
`quick-prompt-input.tsx:99`, `debug.session-collection.tsx:83`,
`SessionHistory.tsx:30`, `use-sessions-collection.ts:36`, `SessionListItem.tsx`
(fallback when live state row missing).

**Schema overlap.** `status`, `model`, `project`, `totalCostUsd`, `durationMs`,
`numTurns` duplicated; denormalised shape on `agentSessionsCollection`,
nested-under-`state` on `sessionLiveStateCollection`.

**Target shape.** Migrate tab-bar + quick-prompt + debug readers to
`sessionLiveStateCollection`; delete the dual-write. `SessionListItem` fallback
needs either a synthesis stub or a read-only `/api/sessions/{id}` single-fetch
for sessions never opened in this browser.

### R6 — `events` log + GH#12 prior-art constraints

**(A) `events` array.** `useState<Array<{ts, type, data}>>([])` at line 119.
Appended on every `gateway_event` WS frame (lines 288–291). Unbounded. Reset
on tab switch (line 136). **No reader uses it.** It leaks from the hook's
return type but no panel consumes it in production.

**Recommendation.** Retire in production. Optional capped dev-time collection
(500-row, memory-only) if a future devtools panel wants it. Keep the hook
return-type stable by returning `[]` until a reader appears.

**(B) Prior-art constraints from #12 / PR#13.** The spec established five
invariants this issue must not re-litigate:

1. **One collection per domain is the render source** — readers go through
   `useLiveQuery` or a thin hook wrapper (`useSessionLiveState`,
   `useMessagesCollection`). No Zustand middleware, no prop drilling, no
   context bridges.
2. **WS handlers write via upsert** — `onStateUpdate` / `onMessage` call
   collection-write functions directly. No middleware; no store-then-sync.
3. **OPFS persistence is the cache** — `persistedCollectionOptions` +
   `schemaVersion` is the only cache layer. The collection **is** the cache.
4. **Display-state derivation via pure function** — `deriveDisplayState(state,
   wsReadyState)` in `lib/display-state.ts` centralises multi-surface
   rendering.
5. **Patch-style upsert merging** — omitted fields preserve prior values.

**Non-goals quoted from #12 spec.** "No DO protocol changes — `onStateUpdate`
still delivers full `SessionState`, `onMessage` still delivers `gateway_event`.
The change is purely where the client writes that data." Messages were
"deliberately excluded [from #12] as a non-goal" because they already use
collection-native storage. **#14's job is to take the same patterns that #12
locked in for live state and extend them into the messages transport.**

### R7 — TanStack DB 0.6.4 native patterns

**Pinned version.** `@tanstack/db@0.6.4`, `@tanstack/react-db@0.1.82`,
`@tanstack/query-db-collection@1.0.35`. Docs match.

**Pull-hydrate.** `queryCollectionOptions({ queryFn, syncMode: 'on-demand',
refetchInterval, staleTime })` wrapped in `persistedCollectionOptions`.
Codebase already uses it for `agentSessionsCollection`
(`db/agent-sessions-collection.ts:25-39`). Not yet used for messages.

**WebSocket sync adapter.** **Not shipped by TanStack DB.** The idiomatic pattern
is: external adapter (PartySocket — already in deps at `partysocket@1.1.4`) calls
`createTransaction({ mutationFn: async () => {} }) + tx.mutate(() =>
collection.upsert(rows))` on each delta. The empty `mutationFn` keeps the delta
write inside transaction semantics (reconciliation, rollback) without round-tripping
to a server.

**Optimistic transactions.** `createTransaction({ mutationFn })` + `tx.mutate(() =>
insert())` + `await tx.isPersisted.promise`. Auto-rollback on `mutationFn`
rejection. Echo reconciliation via **deep-equality**: when server data arrives
matching optimistic state, the collection emits no change event, preventing
re-render flicker. **But** ID mismatch (`usr-optimistic-*` vs `usr-N`) defeats
deep-equality — see synthesis.

**Derived collections.** Two options: `createLiveQueryCollection()` with
hierarchical `includes` (new in 0.6; requires Electric-compatible backend), or
plain `useLiveQuery()` with client-side grouping. Codebase uses the latter
(`hooks/use-messages-collection.ts:21`).

**Adoption snapshot.** Persisted collections ✓, query collections ✓ (sessions
only), optimistic transactions ✓ (sessions only), live queries ✓, WS sync ✗
(messages path bypasses TanStack DB today).

**Gaps.**
1. No official WS adapter → custom wrapper.
2. `syncMode: 'on-demand'` not yet enabled anywhere.
3. No hierarchical `includes` adoption (branches use client-side grouping).
4. No turn-ID-based echo matching; deep-equality only.

## Comparison — current vs target

| Concern | Current (GH#14 problem) | Target (TanStack DB 0.6.4 native) |
|---|---|---|
| Hydrate | `hydratedRef` + `setTimeout(500)` + running→idle re-hydrate | `queryCollectionOptions({ syncMode: 'on-demand', retry: 1, retryDelay: 500 })`; `isFetching` replaces `hydratedRef` |
| Optimistic | `insertOptimistic` + `deleteOptimistic` + `clearOldestOptimisticRow` + `turnHint` | `createTransaction` + `tx.mutate` + auto-rollback; ID reconciliation strategy TBD |
| DO → client wire | `{type:'message'}` vs `{type:'messages'}` fork | Single `{type:'messages'}` channel with `seq` + `delta` or `snapshot` |
| `replaceAllMessages` | Client helper called by 3 flows | Retired — DO-authored snapshot deltas |
| Branches | `useState<Map>` + N `getBranches` RPCs per hydrate | `branchInfoCollection` populated by DO pushes |
| Sessions shadow | Dual-write `agentSessionsCollection` + `sessionLiveStateCollection` | Single `sessionLiveStateCollection`; readers migrated; shadow + collection deleted |
| Events log | Unbounded `useState` array, no reader | Retired (or capped dev-only) |

## Recommendations

### Transport shape — **hybrid delta+snapshot under one channel**

Replace the `message` vs `messages` fork with a single `{type:'messages', ...}`
channel carrying either a `delta` (streaming path, normal case) or a `snapshot`
(reconnect / rewind / resubmit / branch-navigate). Every payload carries a
monotonic `seq`. Client tracks `lastSeq` per session; gap → request snapshot.
This is symmetric with how `shared-transport`'s `BufferedChannel` already
handles gaps on the runner↔DO side.

Rationale: deltas are cheap during streaming; snapshots are robust for rare
bulk ops; single channel simplifies the client dispatch.

### Echo ID reconciliation — **explicit ID-promotion in transaction**

The TanStack DB deep-equality reconciliation only retires optimistic rows when
they are **equal** to the server-echoed row. Because
`usr-optimistic-<ms>` ≠ `usr-N`, this will not auto-work. Three viable
strategies (interview must pick):

1. **Server accepts client-proposed ID.** Runner/SessionDO accepts a
   `client_message_id: 'usr-optimistic-<ms>'` on `sendMessage` and broadcasts
   back using that ID (plus a separate `canonical_id: 'usr-N'` field for
   history). Eliminates rename entirely.
2. **Transaction promotes ID.** Optimistic insert with temporary ID; when echo
   arrives, run `collection.update(optimisticId, row => ({ ...row, id: serverId
   }))` + re-index. TanStack DB supports this; essentially keeps the explicit
   matching step but moves it inside transaction semantics.
3. **Accept double-render.** Insert optimistic row, never reconcile IDs; echo
   arrives as a new row, optimistic row gets removed by a minimal replacement
   for `clearOldestOptimisticRow`. Functionally current behaviour, less code,
   but the manual piece is still there.

Strawman: **option 1 (server-accepts-ID)** if the gateway protocol allows. Needs
confirmation during interview because it grazes the `no GatewayEvent wire
format changes` non-goal — the gateway→DO command `stream-input` would need a
`client_message_id` field. **Fallback: option 2** (all client-side) if the
non-goal holds strictly.

### Branch collection — **per-session like `sessionLiveStateCollection`**

Not derived from `messagesCollection` (branch edges aren't in messages; they
live on the Session tree). Keyed on `{sessionId, parentMsgId}`. Populated by
DO on hydrate + on resubmit. OPFS-persisted so tab switch doesn't rebuild.

### `agentSessionsCollection` phase-out — **complete in GH#14**

Since the spec-phase strawman below naturally lands the readers' migration
last, fold it into #14's cleanup phase rather than defer. If tab-bar / quick-
prompt can't migrate cleanly (missing metadata fields), extend
`sessionLiveStateCollection` schema or read from a new read-only server fetch
for metadata-only surfaces.

### `events` array — **retire outright**

No reader. Hook return type keeps `events: []` as a deprecated empty array
for one migration beat; next pass removes from the interface.

### Partial update semantics for tool results — **ship full parts[]**

Simpler and matches deep-equality reconciliation. Per-part patches have no
benefit since parts[] is small.

### Phasing — **5 phases, each independently shippable**

| Phase | Deliverable | Visible change |
|---|---|---|
| P1 | DO delta-protocol with `seq`; single `{type:'messages'}` channel; DO owns rewind/resubmit/navigateBranch snapshots | None (wire-compat; client still works with legacy reconciliation) |
| P2 | Migrate hydration to `queryCollectionOptions({ syncMode: 'on-demand' })`; retire `hydratedRef`, `setTimeout(500)` retry, running→idle re-hydrate | None user-facing; cold-start retry behaviour equivalent |
| P3 | Migrate optimistic via `createTransaction`; retire `insertOptimistic`/`deleteOptimistic`/`clearOldestOptimisticRow`/`turnHint`/`maxServerTurn` and related sort-key code | None user-facing; same optimistic-insert UX |
| P4 | Add `branchInfoCollection`; DO pushes on hydrate + resubmit; retire `useState<Map>`, `refreshBranchInfo`, per-turn `getBranches` RPCs | Faster tab switch (no rebuild); no flicker on branch-info arrival |
| P5 | Retire `agentSessionsCollection` shadow write + collection + readers; retire `events` array; delete `replaceAllMessages` helper | None user-facing; sidebar/tab-bar/quick-prompt read from `sessionLiveStateCollection` |

Each phase is independently revertible and testable; Phase 1 unblocks the rest.

## Open Questions (for interview)

1. **Transport `seq` scope** — per session (restarts with a new DO) vs
   monotonic-forever. Per session matches `BufferedChannel`; forever helps
   cross-session debugging.
2. **Echo ID reconciliation** — which of the three strategies above. Hinges on
   whether we can touch the `stream-input` GatewayCommand to accept
   `client_message_id`.
3. **Reconnect catch-up** — should the DO support "send everything since
   `seq=X`" (requires DO-side retention window), or only push current snapshot?
4. **Branch collection scoping** — per-session (OPFS-persisted per
   `agentName`) vs global (one collection holding all sessions' branches).
   `sessionLiveStateCollection` pattern suggests per-session.
5. **`agentSessionsCollection` metadata for tab-bar/quick-prompt** — can
   `sessionLiveStateCollection` schema absorb `project`, `model`, `prompt`
   fields, or do those stay read-only server-fetched?
6. **`events` array migration path** — empty stub for one release then delete,
   or delete now from public hook API?
7. **Snapshot granularity** — does a snapshot deliver the full session
   history, or can it be scoped to "the current branch"? Relevant for long
   sessions (1000+ turns) where full history is large.
8. **Phase boundaries** — 5 phases as proposed, or coalesce P2+P3 (both client
   rewrites with no user-visible change) into one bigger diff?
9. **`tool_use_summary` / gate-promotion events** — currently flow through
   `broadcastMessage`. Do they fit the `{upsert}` delta shape cleanly, or need
   a distinct event type in the new channel?
10. **Testability** — what's the minimum test-infra lift (unit tests on the
    delta dispatch, integration tests against a mock DO, chrome-devtools-axi
    for round-trip) before Phase 1 ships?

## Next Steps

1. **Write this doc** → `planning/research/2026-04-19-messages-transport-unification.md`.
2. **P1 interview** (`kata-interview`) — walk through the 10 open questions
   above to produce spec-ready decisions. Priority order: Q2 (echo ID
   reconciliation), Q3 (reconnect catch-up), Q5 (agentSessionsCollection
   migration feasibility), Q8 (phase boundaries).
3. **P2 spec writing** (`kata-spec-writing`) — draft with B-IDs organised by
   layer (DO protocol / client transport / client collections / readers) and
   P1–P5 implementation phases.
4. **P3 spec review** (`kata-spec-review`).
5. **P4 close** — commit, push, link PR to #14.

## Appendix — file:line index (quick reference)

| Concern | Location |
|---|---|
| Hydration ladder | `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:239-261, 337-348` |
| Re-hydrate on running→idle | `use-coding-agent.ts:259-260` |
| On-connect `{type:'messages'}` frame dispatch | `use-coding-agent.ts:279-282` |
| DO on-connect frame emitter | `apps/orchestrator/src/agents/session-do.ts:202-208` |
| `insertOptimistic` / `deleteOptimistic` | `use-coding-agent.ts:488-515` |
| `clearOldestOptimisticRow` | `use-coding-agent.ts:189-214` |
| `maxServerTurn` + `turnHint` | `use-coding-agent.ts:79-90, 491` |
| Echo drain trigger | `use-coding-agent.ts:269-276` |
| `replaceAllMessages` | `use-coding-agent.ts:165-187` |
| Rewind / resubmit / navigateBranch call sites | `use-coding-agent.ts:382-485` |
| Sort-key + ID regex | `apps/orchestrator/src/hooks/use-messages-collection.ts:41-59` |
| Messages collection definition | `apps/orchestrator/src/db/messages-collection.ts` |
| `branchInfo` useState + refresh | `use-coding-agent.ts:120-122, 398-434` |
| `agentSessionsCollection` shadow write | `use-coding-agent.ts:226-236` |
| `agentSessionsCollection` def | `apps/orchestrator/src/db/agent-sessions-collection.ts:25-45` |
| `sessionLiveStateCollection` def + helpers | (see `lib/display-state.ts` + collection dir per #12 spec) |
| `events` useState | `use-coding-agent.ts:119, 288-291, 136` |
| #12 spec | `planning/specs/12-client-data-layer-unification.md` |
| #12 delta research | `planning/research/2026-04-19-issue-12-client-data-layer-delta.md` |
| SessionDO `getBranches` / `resubmitMessage` / `rewind` | `apps/orchestrator/src/agents/session-do.ts:1534-1658` |
