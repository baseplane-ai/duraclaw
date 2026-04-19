---
date: 2026-04-19
topic: Unify message transport on TanStack DB (retire manual hydrate/optimistic/replace reconciliation)
type: feature
status: complete
github_issue: 14
follow_up_to: 12
items_researched: 7
---

# Research: Unify message transport on TanStack DB (GH#14)

## Context

GH#14 is an explicit follow-up to GH#12 / PR #13. GH#12 unified **session live
state** on TanStack DB (`sessionLiveStateCollection` + `useSessionLiveState` +
`deriveDisplayState`) and called out the messages path as a deliberate
non-goal (spec 12 non-goals #4: *"No messages collection changes — already
collection-native. Write path stays in `use-coding-agent.ts`."*).

Re-reading `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`
after PR #13 shows the messages path still carries the same *class* of
manual reconciliation that #12 claimed to eliminate: the collection is the
render source, but the write path is hand-rolled protocol work. Issue #14
enumerates 8 distinct reconciliation sites that this research decomposes
into 3 structural gaps.

## Scope

- **Items researched (7):** hydrate ladder (R1), optimistic + turnHint (R2),
  DO dual transport + replace (R3), branchInfo RPC (R4), agentSessions
  shadow + events state (R5), TanStack DB primitives (R6, wider survey),
  prior art from #12 / PR #13 (R7).
- **Fields populated per item:** current behavior with file:line, invariants
  protected, downstream consumers, failure modes, TanStack-DB-native target.
- **Sources:** codebase full-read of `use-coding-agent.ts`, `session-do.ts`,
  `apps/orchestrator/src/db/*`, `apps/orchestrator/src/hooks/*`; WebSearch
  + WebFetch on tanstack.com/db; planning/specs/12 + spec 33; PR #13 diff.

## Structural reframing

The issue lists 8 reconciliation sites. They cluster into **3 structural
gaps in the current protocol**:

| Gap | Issue sites | Root cause |
|-----|-------------|------------|
| **A. No server-push hydration signal** | #1 hydrate ladder, #4 dual `message`/`messages` transport, #5 manual `replaceAllMessages` | DO broadcasts per-event frames but has no unified "messages changed for session X" channel. Client must decide on ingress whether to upsert-one or replace-all, and imperative hydrate + 500ms retry + state-transition re-pull fills the gap at mount. |
| **B. No server-anchored send correlation** | #2 optimistic protocol, #3 turnHint fabrication | Server echoes users as `usr-N` without telling the client *which* optimistic row this echoes. Client compensates with FIFO-by-insert-timestamp drain + client-fabricated `[turnHint, 0.5]` sort key. |
| **C. Derived state modelled as useState** | #6 branchInfo Map, #7 agentSessions shadow, #8 events list | Each is computable from (or already lives in) a canonical collection. They exist only because PR #13 deliberately stopped at session-live-state. |

## Findings

### R1 — Hydrate ladder

**Files:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:237-261, 258-261`; `apps/orchestrator/src/agents/session-do.ts:1543-1589, 718-866, 202-208`

**Current flow.** On first `onStateUpdate`:
1. If `!hydratedRef.current`, call `hydrateMessages(connection)`.
2. If msgCount > 0 → lock the ref permanently.
3. If msgCount === 0 AND `sdk_session_id` exists, schedule a `setTimeout(500)` retry.
4. On `running → idle` state transition, re-call `hydrateMessages` (no ref gate).
5. In parallel: `onConnect` on the DO already sends `type:'messages'` with full history — *this frame arrives before the first `onStateUpdate`*, so the imperative hydrate is a belt-and-braces duplicate.

**Invariants protected.**
- The 500ms retry catches a race where `SessionDO.hydrateFromGateway()` hasn't yet merged the VPS-side transcript into the DO's SQLite.
- The `running → idle` re-hydrate catches tail-of-turn messages flushed after session completion.
- `hydratedRef` prevents re-hydration loops on non-message state updates (context_usage etc.).

**Failure modes.**
- `setTimeout` has **no cleanup** on unmount or `agentName` change (no
  `clearTimeout`). Stale callbacks fire on a stale `connection` ref; safe
  today because the silent try/catch swallows the failure, but it's a
  latent bug that should die with the ladder.
- If both initial + retry return 0 and no live messages arrive, list stays
  empty until user sends a message. No explicit recovery.
- Concurrent `hydrateMessages` calls possible if `running → idle` fires
  right after first state update; TanStack DB dedupes by id so no
  corruption, just wasted RPCs.

**Downstream.** `useMessagesCollection` reads `messagesCollection`, filters
by `sessionId`, sorts by extracted turn number with `turnHint` tiebreaker
at 0.5. ChatThread, sidebar cost summaries, branch navigation all consume.

### R2 — Optimistic protocol + turnHint fabrication

**Files:** `use-coding-agent.ts:189-214, 487-515` (lifecycle); `:491` (turnHint); `apps/orchestrator/src/hooks/use-messages-collection.ts:25-59` (sort); `apps/orchestrator/src/db/messages-collection.ts:27-35` (schema)

**Lifecycle.** User send →
1. `optimisticId = 'usr-optimistic-${Date.now()}'`.
2. `turnHint = maxServerTurn(cachedMessages) + 1` — scans the collection
   for the highest `usr-N`/`msg-N`/`err-N` id to invent a sort bucket.
3. Insert row; RPC send.
4. On WS `type:'message'` with `role:'user' && !id.startsWith('usr-optimistic-')`:
   call `clearOldestOptimisticRow()` (FIFO by embedded timestamp), then upsert.
5. On RPC failure: manual `deleteOptimistic`.

**FIFO contract.** One echo → one clear. Breaks if echoes reorder or drop
(BufferedChannel does provide monotonic `seq`, but **the client doesn't use
it for matching** — it trusts FIFO by insert timestamp).

**Three-file leakage.** The issue's "reconciliation leaking into three files"
maps to:
1. `use-coding-agent.ts` — lifecycle (insertOptimistic / clearOldest / sendMessage).
2. `use-messages-collection.ts` — sort regex `/^usr-optimistic-(\d+)$/` and `[turnHint, 0.5]` key.
3. `messages-collection.ts` — `CachedMessage.turnHint?: number` schema field.

**turnHint rationale.** Without the hint, optimistic rows fall back to
`[Number.MAX_SAFE_INTEGER, createdAt]` which positions them *after* later
assistant replies — a UX inversion (user's own message appears below
its reply). The hint is a client-side guess at what turn the server will
assign, committed at insert time.

### R3 — DO message transport + emit sites (DO scan)

**Files:** `apps/orchestrator/src/agents/session-do.ts` — 16 single-broadcast sites, 2 bulk sites.

**Single `type:'message'` emits** (broadcast via `broadcastMessage` helper at `:542`):
`:488` finalize-streaming (recovery), `:585` promoteToolPartToGate, `:618`
gate fallback, `:1031` spawn initial prompt, `:1101` resumeDiscovered,
`:1245` resolveGate, `:1354` sendMessage, `:1449` forkWithHistory, `:1642`
resubmitMessage, `:1712`/`:1728` partial_assistant (first), `:1773`
partial_assistant (subsequent), `:1811` assistant (final), `:1829`
tool_result, `:1939` file_changed.

**Bulk `type:'messages'` emits:** `:204` onConnect (browser role) with
`Session.getHistory()`; `:207` onConnect error fallback with `[]`.

**Critical asymmetry.** Client-driven flows bypass broadcast entirely:
- `rewind(turnIndex)` — RPC only; client slices locally + `replaceAllMessages(kept)`.
- `resubmitMessage(id, content)` — RPC returns `leafId`; client then RPCs `getMessages({ leafId })` + `replaceAllMessages(newMsgs)`.
- `navigateBranch(id, dir)` — RPC `getMessages({ leafId: sibling })` + `replaceAllMessages(newMsgs)`.

**Client `replaceAllMessages` (`:165-187`).** Iterate collection, build
staleIds set (`sessionId === agentName && !newIds.has(id)`), `delete(staleIds)`,
bulkUpsert. **Does not preserve optimistic rows** — they're collateral damage
on every branch switch.

**Transport constraints.** Browser ↔ DO is the Agents-SDK WS; gateway
(runner) ↔ DO is a separate WS dialed by the runner. Message events only
broadcast to browser role connections (filtered at `:526-535`).

### R4 — branchInfo + getBranches RPC

**Files:** `use-coding-agent.ts:120-122, 398-434`; `session-do.ts:1592-1599`; `ChatThread.tsx:644, 665-670`

**Call pattern.** `refreshBranchInfo` runs after hydrate, after resubmit,
and after navigateBranch. Loops every user message, resolves parentId as
`msgs[idx-1].id`, fires `connection.call('getBranches', [parentId])`
**sequentially** (no `Promise.all`), filters to user-role siblings, builds
`Map<messageId, {current, total, siblings[]}>`.

**DO side.** `@callable getBranches(messageId)` delegates entirely to
`this.session.getBranches(messageId)` — the Agents SDK Session class.

**UI.** `MessageBranch` component renders prev/next chevrons + `current/total`
counter on user messages with siblings.

**Reactivity gaps.**
- Not reactive — if another tab creates a sibling, current tab won't update
  until the next `refreshBranchInfo` call.
- Full re-fetch on every message set change; no per-parent cache.
- Concurrent resubmits from the same parent can race.

**`[uncertain]` Session.getBranches storage.** The Agents SDK Session class
is external; unclear whether it stores `parentId` as a SQLite column or
reconstructs from insert order. **This is the single largest unknown in
the spec — a 30-minute pre-spec spike is warranted before committing to
the derived-collection plan.**

### R5 — agentSessionsCollection shadow + events state

**Files:** `use-coding-agent.ts:119` (events); `:226-236` (shadow); `apps/orchestrator/src/db/agent-sessions-collection.ts`; `apps/orchestrator/src/db/session-live-state-collection.ts`

**events useState.** Unbounded debug-log array. **Zero production
consumers.** Only test reads it. Safe to delete outright.

**Shadow mirror.** `onStateUpdate` calls
`sessionsCollection.utils.writeUpdate({ id, status, numTurns, totalCostUsd, durationMs, updatedAt })`
to keep sidebar status fresher than the 30s QueryCollection refetch. Spec
#12 behavior B8 already committed sidebar cards to `useSessionLiveState` —
once that migration completes (or we verify it has), these lines are
unreachable. `agentSessionsCollection` itself stays (it's the source for
history, tab-bar metadata, project→tab lookup).

### R6 — TanStack DB primitives (wider survey)

**Installed:** `@tanstack/db@0.6.4` (April 2026), `@tanstack/react-db@0.1.82`, `@tanstack/query-db-collection@1.0.35`, `@tanstack/browser-db-sqlite-persistence@0.1.8`.

**Primitives that retire GH#14 sites:**

| Primitive | Replaces |
|---|---|
| `createOptimisticAction({ onMutate, mutationFn })` | R2 insertOptimistic + manual rollback — `mutationFn` throw auto-reverts optimistic state. |
| `collection.utils.writeBatch(writeDelete(ids), writeInsert(rows))` | R3/R5 `replaceAllMessages` iterate-delete + bulkUpsert. First-class for local-only collections. |
| `createLiveQueryCollection(q => q.from({m: messagesCollection}).where(...))` | R4 `useState<Map>` + refresh loop. Reactive, derived from upstream collection. |
| `useLiveQuery` with `.where()` | R1 session-filtered reads; already idiomatic. |
| Virtual props `$synced` / `$origin` | Optional future delivery-state UI. |

**Gaps.**
- No built-in optimistic↔echo correlation. Client still needs an `echoOf`
  matching strategy (we propose server-anchored via an optional field).
- No WS-native sync adapter. Electric / PowerSync / Trailbase are all
  Postgres-bound. DO-over-WS stays hand-wired — direct collection writes
  from `onMessage`, same as today.

**Gotchas.**
- Indexes opt-in as of 0.6; messagesCollection doesn't use any, no impact.
- "Magic return" removed — mutation handlers must explicitly throw or
  return. Our code is already explicit.
- OPFS silently falls back to memory on init failure; keep existing
  warning log.
- Bumping `schemaVersion` drops stale rows — acceptable for cache, but
  `parentId` addition (for R4) needs a version bump.

### R7 — Prior art from GH#12 / PR #13

**Files:** `planning/specs/12-client-data-layer-unification.md`;
`apps/orchestrator/src/db/session-live-state-collection.ts`;
`apps/orchestrator/src/hooks/use-session-live-state.ts`;
`apps/orchestrator/src/lib/display-state.ts`.

**Pattern template.**
1. **Collection factory**: `persistedCollectionOptions(localOnlyCollectionOptions({ id, getKey, initialData }))` with `await dbReady` at module scope.
2. **Write path**: `upsertXxx(key, patch)` helper with `sanitize` + insert-vs-update branch + silent error swallow.
3. **Read path**: `useXxx(key)` thin hook wrapping `useLiveQuery` with client-side filter + `useMemo` stable return.
4. **Derivation**: pure function `deriveDisplayState(state, wsReadyState)` for status/label/color/icon, consumed by every rendering surface.
5. **Transition observation**: `useRef<Map>` seeded at hook top, compare-on-tick for genuine transitions only.

**Migration cost signal.** 11 B-IDs across 3 phases, ~4–10 hours total,
net change `use-coding-agent.ts` 798 → 626 LOC (−172). New files (~280
LOC) offset by Zustand server-data bridge + session-status-collection
deletions.

**Explicit parking statement.** Spec #12 non-goal #4: *"No messages
collection changes — already collection-native. Write path stays in
`use-coding-agent.ts`."* — this research is the cash-in.

## Comparison — per-site recommendation

| # | Current | Recommended | DO change needed |
|---|---------|-------------|-------------------|
| 1. Hydrate ladder | RPC + 500ms retry + running→idle re-pull | Retain RPC but drive from unified `messages-changed` full-replay frame on `onConnect`; client `writeBatch(writeDelete+writeInsert)`. No retry. | Rename frame |
| 2. Optimistic + echo drain | `insertOptimistic` + FIFO clear | `createOptimisticAction` for rollback + server-anchored `echoOf` correlation (client includes `echoOf: optimisticId` in `sendMessage` RPC; server echoes it back). FIFO fallback for pre-existing optimistic rows only. | `sendMessage` accepts + echoes `echoOf` |
| 3. turnHint fabrication | `maxServerTurn(cachedMessages) + 1` | **Delete.** Echo-by-id correlation replaces optimistic row with canonical atomically — no sort inversion window. | None (consequence of #2) |
| 4. Dual `message`/`messages` ingress | Two handlers in `onMessage` switch | Unified `messages-changed` event: `{ operation: 'full-replay' \| 'upsert-single' \| 'trim', messages?, message?, reason }`. Single switch. | **Yes — protocol rename + unification** |
| 5. `replaceAllMessages` | iterate-delete + bulkUpsert | `messagesCollection.utils.writeBatch(writeDelete(staleIds), writeInsert(newMsgs))`. | None |
| 6. `branchInfo` Map + N × `getBranches` | useState<Map>, N parallel RPCs | Add `parentId` to CachedMessage + DO emit → `createLiveQueryCollection` derives branches. Retires RPC. **Contingent on R4 spike.** | `parentId` in every message frame; CachedMessage schema bump |
| 7. `agentSessionsCollection` shadow | `writeUpdate` in `onStateUpdate` | Delete lines 223-236. Verify sidebar consumers migrated to `useSessionLiveState` per spec #12 B8. | None |
| 8. `events` useState | Unbounded debug log | Delete outright. Update `use-coding-agent.test.ts` to assert on `upsertSessionLiveState` calls instead. | None |

## Recommendations

**Adopt hard cutover, matching PR #13 precedent.** No feature flag. Ship
the unified `messages-changed` channel and client refactor in one spec.
This was explicitly confirmed during research.

**Run a pre-spec spike on `Session.getBranches` storage** (30 min). Read
`@anthropic-ai/claude-agent-sdk` (or Agents SDK) Session class source and
confirm whether `parentId` is persisted as a column. If yes → derived
collection is go. If no → spec needs a Phase 4b fallback that keeps RPC-
driven branchInfo with invalidation via the unified channel.

**Proposed phasing (to inform spec skeleton).**

1. **P1 — DO protocol unification.** Rename `type:'message'` / `type:'messages'`
   to `type:'messages-changed'` with `operation` discriminator. Add `parentId`
   to every message frame. Add optional `echoOf` field. Add `reason` for
   debugging.
2. **P2 — Client ingress + hydrate retirement.** Replace `onMessage`
   switch with a single `onMessagesChanged` handler. Retire
   `hydratedRef` + 500ms retry + running→idle re-hydrate. Swap
   `replaceAllMessages` → `writeBatch`.
3. **P3 — Optimistic lifecycle.** Adopt `createOptimisticAction`. Correlate
   echoes by `echoOf`. Retire `turnHint`, `clearOldestOptimisticRow`,
   `maxServerTurn` scan. Update `useMessagesCollection` sort to drop the
   `0.5` tiebreaker (or keep as degenerate safety net).
4. **P4 — Derived branchInfo.** Add `parentId` to `CachedMessage` schema
   (bump version). `createLiveQueryCollection` keyed on parentId derives
   siblings from `messagesCollection`. Retire `useState<Map>`,
   `refreshBranchInfo`, `getBranches` RPC from client. **DO-side
   `getBranches` endpoint stays as a last-resort fallback during
   transition.**
5. **P5 — Cleanup.** Delete `events` state, delete shadow mirror lines
   223-236, verify sidebar consumers, update tests.

**Rough estimate (anchored to PR #13):** ~12–16 B-IDs, 5 phases,
12–20 hours, net −200 to −300 LOC in `use-coding-agent.ts`.

## Open Questions

Carried forward to the P1 interview:

1. **`echoOf` scope.** User-echo only, or every server-echo event
   (tool_result, assistant, partial_assistant)? Broader coverage unlocks
   optimistic assistant/tool UI in future; widens DO surface now.
2. **Multi-tab consistency.** Current FIFO drain is per-tab. If Tab A
   sends optimistically and Tab B is open on the same session, does Tab B
   see the optimistic row? OPFS is same-origin but not live across tabs
   without a SharedWorker/BroadcastChannel. **In scope for GH#14 or
   defer?**
3. **Virtual props / delivery ticks.** Use `$synced` / `$origin` for a
   sent-vs-acked UI indicator now, or defer as a separate follow-up?
4. **`CachedMessage` schema migration.** Adding `parentId` bumps schema
   version — OPFS drops stale rows. Acceptable for ephemeral message
   cache? Any UX regression for existing users on first load?
5. **Rewind / resubmit / navigateBranch DO-side.** Should the DO
   broadcast `messages-changed full-replay` after these operations so the
   second tab / multi-device scenarios pick it up, or keep them
   client-RPC-driven? Favors DO-push once the unified channel exists.

## Next Steps

1. **[pre-spec spike, 30 min]** Read `Session.getBranches` + append
   storage in the Agents SDK source tree. Confirm `parentId` persistence.
2. **`kata enter planning`** has already been run — next kata phase is
   **P1: interview** (resolve the 5 open questions above).
3. **P2: spec writing** — use this research + interview answers. Target
   shape: 5 phases, 12–16 B-IDs, hard cutover.
4. **P3: spec review + P4: approve.**
5. **Implementation in a separate PR**, branch `feat/14-unify-messages-transport`.

## Uncertainties carried forward

- `Session.getBranches` storage model — resolved by spike.
- Whether `createOptimisticAction` + WS echo ordering interact cleanly
  when the WS handler writes the canonical row *before* `mutationFn`
  resolves (TanStack DB should see the real row via `writeBatch` from
  the WS handler, then `mutationFn` returns and optimistic commits; the
  canonical id wins because upsert overwrites).
- OPFS quota behavior under load — out of scope for GH#14 but flagged
  for future eviction-policy work.

## References

**Codebase (full reads during research):**
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`
- `apps/orchestrator/src/agents/session-do.ts`
- `apps/orchestrator/src/db/messages-collection.ts`
- `apps/orchestrator/src/db/session-live-state-collection.ts`
- `apps/orchestrator/src/db/agent-sessions-collection.ts`
- `apps/orchestrator/src/db/db-instance.ts`
- `apps/orchestrator/src/hooks/use-messages-collection.ts`
- `apps/orchestrator/src/hooks/use-session-live-state.ts`
- `apps/orchestrator/src/lib/display-state.ts`
- `packages/shared-transport/src/buffered-channel.ts`

**Specs:**
- `planning/specs/12-client-data-layer-unification.md`
- `planning/specs/33-tanstackdb-session-state.md`
- `planning/specs/36-session-message-format.md`

**External:**
- https://tanstack.com/db/latest/docs
- https://tanstack.com/db/latest/docs/reference/functions/createOptimisticAction
- https://tanstack.com/db/latest/docs/reference/functions/createLiveQueryCollection
- https://tanstack.com/db/latest/docs/guides/mutations
- https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes
