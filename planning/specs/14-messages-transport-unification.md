---
initiative: messages-transport-unification
type: project
issue_type: feature
status: approved
priority: high
github_issue: 14
created: 2026-04-19
updated: 2026-04-19
phases:
  - id: p1
    name: "DO delta protocol — seq + unified {type:'messages'} channel"
    tasks:
      - "Add a `MessagesFrame` discriminated union to `packages/shared-types/src/index.ts`: `{type:'messages', sessionId, seq, payload: {kind:'delta', upsert?: SessionMessage[], remove?: string[]} | {kind:'snapshot', version, messages: SessionMessage[], reason: 'reconnect'|'rewind'|'resubmit'|'branch-navigate'}}`. Monotonic `seq` is per-session, assigned by SessionDO at broadcast time."
      - "Add `messageSeq: number` to SessionDO instance state (not persisted — resets to 0 on cold start). In `apps/orchestrator/src/agents/session-do.ts`, add a private `broadcastMessages(payload: MessagesPayload, reason?: string)` helper that increments `messageSeq`, stamps it onto the frame, and calls `broadcastToClients({type:'messages', sessionId, seq, payload})`."
      - "Replace every `broadcastToClients({type:'message', message})` call site in session-do.ts with `broadcastMessages({kind:'delta', upsert:[message]})`. Call sites: partial_assistant streaming (~line 1692), tool result (~line 1822), assistant finalised (~1830), user-echo, gate promotion (ask_user/permission_request), resubmit new user row (line 1642)."
      - "On browser WS connect (`session-do.ts:202-208`), replace the current `{type:'messages', messages}` send with `broadcastMessages({kind:'snapshot', version: messageSeq, messages: this.session.getHistory(), reason:'reconnect'})`. `version` equals the current `messageSeq` (not a separate counter) — this gives clients a single monotonic watermark."
      - "Make rewind DO-authored: in `session-do.ts` rewind handler (~line 1533-1540), after the gateway command is sent, compute the trimmed history via `this.session.getHistory().slice(0, turnIndex + 1)` and broadcast a snapshot with `reason:'rewind'`. RPC return value stays `{ok:true}` for wire compat."
      - "Make resubmit DO-authored: after `session.appendMessage(newMsg, parentId)` and `persistTurnState()` (session-do.ts:1640-1641), call `broadcastMessages({kind:'snapshot', version:messageSeq, messages: session.getHistory(newMsgId), reason:'resubmit'})`. Drop the existing single `broadcastMessage(newUserMsg)` call immediately before it — the snapshot supersedes."
      - "Add a new DO RPC method `getBranchHistory(leafId: string) → {ok:true} | {ok:false, error:'unknown_leaf'|'not_on_branch'}`. Validates `leafId` exists in `session.getHistory()` and is a user-turn; on success, calls `broadcastMessages({kind:'snapshot', version:messageSeq, messages:session.getHistory(leafId), reason:'branch-navigate'}, {targetClientId})` where `targetClientId` is the RPC caller's WS socket id. Scope: this snapshot is delivered to the requesting client only (view-state change; see B2 API Layer)."
      - "Add a new DO RPC method `requestSnapshot() → {ok:true} | {ok:false, error:'session_empty'}` in `session-do.ts`. Returns `session_empty` if `session.getHistory()` length is 0. Otherwise, calls `broadcastMessages({kind:'snapshot', version:messageSeq, messages:session.getHistory(), reason:'reconnect'}, {targetClientId})` scoped to the requesting client. Used by client-side gap detection (prior task)."
      - "Extend `broadcastMessages` helper with optional `{targetClientId?: string}` arg: when set, sends the frame only to that WS connection via the Agents SDK's per-connection send API instead of `broadcastToClients`. Used by the two new RPCs above."
      - "Client-side dispatch: in `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` onMessage handler (line 269-283), replace the `type:'message'` vs `type:'messages'` branches with a single `type:'messages'` handler that inspects `frame.payload.kind`. Delta → `messagesCollection.upsert(payload.upsert)` + `messagesCollection.delete(payload.remove)` (both per-row). Snapshot → `replaceAllMessages(payload.messages)` (helper stays until P5). Track `lastSeq` in a `useRef<Map<sessionId, number>>`."
      - "Client-side gap detection with three branches: (a) `frame.seq === lastSeq + 1` → normal path, apply payload, set `lastSeq = frame.seq`. (b) `frame.seq > lastSeq + 1` AND `frame.payload.kind === 'delta'` → true gap, call `requestSnapshot()`, do NOT apply the delta (the snapshot will contain it), do NOT update `lastSeq` until the snapshot arrives. (c) `frame.seq <= lastSeq` → stale/duplicate frame (e.g., in-flight delta arriving after a targeted snapshot bumped lastSeq via max). Drop silently. (d) Snapshots always apply regardless of seq; after applying, set `lastSeq = max(lastSeq, payload.version)` (see Gotchas for targeted-snapshot rationale)."
      - "Keep `replaceAllMessages()`, `insertOptimistic`, `deleteOptimistic`, `clearOldestOptimisticRow`, `turnHint`, `branchInfo`, `hydratedRef`, `agentSessionsCollection` shadow-write, and `events` useState exactly as they are today. Phase 1 is wire-compat: the DO protocol changes, the client dispatch shape changes, but all reconciliation behavior is preserved. No user-visible change."
    test_cases:
      - id: "delta-seq-monotonic"
        description: "Send 5 messages in a session. Capture all WS frames via browser devtools. Verify every frame is `{type:'messages'}`, every frame has seq=N+1 of prior frame, every streaming frame has kind='delta'."
        type: "integration"
      - id: "snapshot-on-reconnect"
        description: "Open session, send message, close WS, reopen. First frame after reopen has kind='snapshot', reason='reconnect', version equal to last delta's seq. Second frame (if any new activity) has seq=version+1."
        type: "integration"
      - id: "rewind-broadcasts-snapshot"
        description: "Send 3 messages, rewind to turn 1. DO emits a snapshot with reason='rewind' containing exactly the kept messages. Client's messagesCollection has the trimmed set with no further RPC."
        type: "integration"
      - id: "resubmit-broadcasts-snapshot"
        description: "Resubmit a message. DO emits a snapshot with reason='resubmit' containing the new branch path. No separate `broadcastMessage(newUserMsg)` call."
        type: "integration"
      - id: "gap-triggers-snapshot-request"
        description: "Simulate a dropped delta frame (client skips seq=N+1, observes seq=N+2). Client calls requestSnapshot RPC; DO responds with a snapshot frame. messagesCollection converges to server truth."
        type: "integration"
      - id: "broadcast-messages-helper-unit"
        description: "Direct unit test of the `broadcastMessages` helper in isolation (mocking `broadcastToClients` and `sendToClient`). Cases: (a) default call increments `messageSeq` and calls `broadcastToClients` with the stamped frame; (b) `{targetClientId:'x'}` does NOT increment `messageSeq` and calls `sendToClient('x', frame)` with the current seq; (c) `{targetClientId}` when the map has no matching connection drops silently (no throw); (d) frame shape is `{type:'messages', sessionId, seq, payload}` on all paths."
        type: "unit"
      - id: "no-user-visible-change"
        description: "Smoke-test the entire hydrate → send → rewind → resubmit → branch-navigate → reconnect loop. Behavior and UI identical to pre-P1 baseline."
        type: "smoke"

  - id: p2
    name: "Hydration migration — queryCollectionOptions, retire hydratedRef"
    tasks:
      - "Add a new DO RPC `getMessages() → {messages: SessionMessage[]}` in `apps/orchestrator/src/agents/session-do.ts` that returns the current-branch linear history (`this.session.getHistory()`). This is the pull-side counterpart to the WS-pushed snapshots — used by the queryCollection's `queryFn` for cold-start and reconnect-with-stale-cache scenarios. Note: `agentName` identifies the DO instance (routing happens at the Agents SDK layer), so the RPC itself takes no arguments; the call site just scopes the `rpcCall` to the right DO."
      - "In `apps/orchestrator/src/db/messages-collection.ts`: change from `localOnlyCollectionOptions` to `queryCollectionOptions` wrapped in `persistedCollectionOptions`. Schema bumps to v3 (v2→v3 is additive; old rows re-hydrate via queryFn on first read). `queryFn` calls `rpcCall('getMessages', {}, {signal, agent: agentName})` and maps the result via `toCachedMessage`. Config: `syncMode: 'on-demand'`, `refetchInterval: undefined` (WS is the push channel; refetch is reconnect-only), `staleTime: Infinity`, `retry: 1`, `retryDelay: 500`."
      - "Retire the hydration ladder in `use-coding-agent.ts`: delete `hydratedRef` useRef, delete the lines 239-261 hydrate-gate with setTimeout(500) retry, delete the running→idle re-hydrate effect at lines 259-260, delete `hydrateMessages()` function (lines 337-348). The query collection owns hydration."
      - "Expose `isFetching` from the messagesCollection via the factory. Update `isConnecting` derivation in use-coding-agent.ts: `isConnecting = messages.isFetching || wsReadyState !== 1`. Pass through to `useCodingAgent` consumers."
      - "Keep the `{type:'messages'}` on-connect snapshot as a latency optimisation — it writes directly to the collection, so the query's `queryFn` is only used for cold-start (no cached row) and reconnects with stale cache. Document this dual-path in a code comment."
      - "Update `useMessagesCollection` hook: remove the `usr-optimistic-*` special-case from sortKey ONLY IF it's no longer referenced (it still is, until P3). Leave intact for P2; sort logic does not change in this phase."
      - "Add an exponential-backoff test: simulate a cold DO (queryFn returns empty first call, populated second call). Verify the collection retries once with 500ms delay, then settles. Replaces the setTimeout(500) ladder."
    test_cases:
      - id: "hydratedref-deleted"
        description: "`rg 'hydratedRef' apps/orchestrator/src/` returns 0 matches. `rg 'hydrateMessages' apps/orchestrator/src/` returns 0 matches."
        type: "audit"
      - id: "coldstart-retry"
        description: "Open session URL directly. DO cold-starts, gateway-hydrate races with client. Messages appear in UI within 1s without manual retry. Network tab shows one `getMessages` call; if it returns empty with sdk_session_id present, a second call fires ~500ms later."
        type: "integration"
      - id: "resume-rehydrate"
        description: "Let session go idle >30min. Send new message (runner cold-spawns, resumes). Messages collection refetches via onConnect snapshot; no manual running→idle re-hydrate effect exists in code."
        type: "integration"
      - id: "isconnecting-derivation"
        description: "isConnecting is true while messagesCollection.isFetching is true OR wsReadyState !== 1. Becomes false once first non-empty response arrives AND ws is open."
        type: "unit"

  - id: p3
    name: "Optimistic migration — createTransaction + server-accepts-client-ID"
    tasks:
      - "Extend `stream-input` GatewayCommand in `packages/shared-types/src/index.ts` with optional `client_message_id?: string`. Runner (`packages/session-runner/src/`): when `stream-input` carries `client_message_id`, pass it through to the SDK's user-turn append and include it in the echoed user message as `id` (or surface it via a new event field — choose one; see Implementation Hints). SessionDO (`session-do.ts`): when accepting the user-turn echo with a `client_message_id`, use that as the primary `SessionMessage.id` and store the canonical turn index in a new `canonical_turn_id: 'usr-N'` field on the message."
      - "Initialize `this.turnCounter` on SessionDO cold start by scanning `this.session.getHistory()` for user-turn messages and taking `max(parseTurnOrdinal(msg.canonical_turn_id ?? msg.id))` (defaulting to 0 if history is empty). This prevents canonical-ID collisions on DO eviction + resume, when the SQLite history survives but the in-memory counter would otherwise reset. Add a unit test `turn-counter-initialization` that persists 3 turns, evicts the DO, reopens, sends a 4th turn, and asserts `canonical_turn_id === 'usr-4'` (not `'usr-1'`)."
      - "Update `SessionMessage` type in shared-types: add `canonical_turn_id?: string` as an optional secondary field for history/rewind/branch-id purposes. Existing server-assigned `usr-N` messages get `canonical_turn_id = id` on persistence (backward-compat; if id starts with `usr-client-`, canonical is set from turn counter)."
      - "Client-side: rewrite user-message send in `use-coding-agent.ts` to use `createTransaction`. Pattern: generate `client_message_id = \\`usr-client-\\${crypto.randomUUID()}\\``; wrap the RPC in `createTransaction({ mutationFn: async () => rpc.sendMessage(content, client_message_id) })`; inside `tx.mutate(() => messagesCollection.insert({id: client_message_id, sessionId, role:'user', parts, createdAt}))`. The library auto-rolls back on mutationFn failure."
      - "Retire `insertOptimistic`, `deleteOptimistic`, `clearOldestOptimisticRow`, `maxServerTurn`, `turnHint` computation — all from use-coding-agent.ts. Delete the `usr-optimistic-*` special case from `hooks/use-messages-collection.ts:41-59`. Delete the `turnHint` field from `CachedMessage` in `db/messages-collection.ts` — schema bump v3→v4; old rows load without turnHint (optional field)."
      - "Simplify sort key in `hooks/use-messages-collection.ts`. Every message row has one of three positions on the timeline: (a) user turns carry `canonical_turn_id = 'usr-N'` once the server echo arrives (and `undefined` briefly while optimistic — they sort by `createdAt` in that window); (b) assistant rows and tool-result rows have NO `canonical_turn_id` and are anchored to the user turn that preceded them via their `createdAt` timestamp; (c) streaming partial-assistant rows likewise sort by `createdAt`. The composite sort key is `[parseTurnOrdinal(canonical_turn_id) ?? Number.POSITIVE_INFINITY, createdAt]`: rows with a turn ordinal sort first by that ordinal, everything else interleaves by creation time after its anchor user turn. Helper: `parseTurnOrdinal(id?: string): number | undefined` — returns `N` if `id` matches `/^usr-(\\d+)$/`, else `undefined` (so `usr-client-<uuid>` optimistic rows and non-user rows both fall through to the `createdAt` branch). This gives a total order even during rapid bursts because `createdAt` is assigned server-side with ms resolution and user-turn ordinals monotonically increase."
      - "Update `resubmitMessage` and `forkWithHistory` call sites to follow the same createTransaction pattern. `forkWithHistory` (the orphan-runner recovery path — see CLAUDE.md 'Session lifecycle & resume') creates a new branch by spawning a fresh execute with a transcript-prefixed prompt; it resolves on the server side via a normal user-turn append inside the DO. Branch-info emission follows the same path as resubmit: the first DO user-echo after the fork triggers `broadcastMessages({kind:'snapshot', reason:'resubmit', branchInfo:[...]})` (B2/B7). No separate branch-info code path is needed for `forkWithHistory`."
      - "Remove `active_callback_token` safeguards (none should be needed) and confirm that the `deep-equality reconciliation` of TanStack DB retires the optimistic row when the server echo arrives with the same id. Test: insert optimistic → echo arrives with matching id + new canonical_turn_id → collection update fires once, no flicker."
    test_cases:
      - id: "optimistic-retire-by-deep-equality"
        description: "Send a message. The row appears instantly with id=usr-client-<uuid>. When the DO echo arrives with the same id + canonical_turn_id='usr-3', the row is updated in place (no delete+insert). Observe zero React-render-counter increment on that list item during echo."
        type: "integration"
      - id: "rollback-on-rpc-failure"
        description: "Mock rpc.sendMessage to reject. After the call, messagesCollection has no row for the client_message_id. createTransaction auto-rolled back."
        type: "unit"
      - id: "turnhint-deleted"
        description: "`rg 'turnHint|insertOptimistic|deleteOptimistic|clearOldestOptimisticRow|maxServerTurn' apps/orchestrator/src/` returns 0 matches."
        type: "audit"
      - id: "sort-stable"
        description: "Message list order is correct during a burst of 3 rapid sends: user rows appear in send-order; assistant rows appear between them; no reordering flicker when echoes arrive."
        type: "integration"
      - id: "turn-counter-initialization"
        description: "Persist 3 user turns in a session, force DO eviction (via `/admin/evict-do` or 30min idle), reopen. Send a 4th turn. Assert the new message's `canonical_turn_id === 'usr-4'` (not `'usr-1'`). Verifies that turnCounter is derived from `session.getHistory()` on cold start."
        type: "integration"
      - id: "fallback-if-gatewaycommand-locked"
        description: "Contingency path — only exercised if pre-P3 compatibility spike (see Implementation Phases → Pre-P3 Gate) shows VPS-detached runners reject the `client_message_id` field. Swap implementation to client-side ID promotion: optimistic id is usr-optimistic-<ms>; on echo arrival with usr-N, call messagesCollection.update(optimisticId, row => ({...row, id: serverId})). All other P3 code (createTransaction, sort simplification) stays."
        type: "integration"

  - id: p4
    name: "Branches — branchInfoCollection + DO push"
    tasks:
      - "Create `apps/orchestrator/src/db/branch-info-collection.ts`: per-session factory returning a `localOnlyCollectionOptions` collection, OPFS-persisted (schemaVersion 1), keyed on `parentMsgId`. Shape: `{parentMsgId: string, sessionId: string, siblings: string[] /* user-message ids */, activeId: string, updatedAt: string}`. Factory matches the `messagesCollection` per-agentName pattern."
      - "Add DO → client branch-info push. In `session-do.ts`: on the on-connect snapshot (B1), compute branch-info for every user turn in `getHistory()` and include it in the MessagesFrame as an optional `branchInfo?: BranchInfoRow[]` field on the snapshot payload. On resubmit, after the snapshot broadcast, compute the affected parent's new sibling list and include it in the snapshot's branchInfo field."
      - "Client-side: in use-coding-agent.ts onMessage handler, after applying snapshot messages, upsert each `branchInfo` row into branchInfoCollection (`agentName`-scoped factory)."
      - "Retire the client's `branchInfo: useState<Map>`, `refreshBranchInfo()`, and N per-turn `getBranches()` RPCs. Delete lines 120-122 (useState), 398-434 (refreshBranchInfo), all call sites invoking it."
      - "Expose `useBranchInfo(sessionId, parentMsgId): {current, total, siblings}` hook at `apps/orchestrator/src/hooks/use-branch-info.ts`. Wraps `useLiveQuery` on branchInfoCollection + derives current/total from siblings array + active message leaf."
      - "Update `ChatThread.tsx` branch-navigation UI (~line 668) to consume `useBranchInfo` instead of the map from use-coding-agent."
      - "Rewrite `navigateBranch(targetSiblingId)` in use-coding-agent.ts: call new DO RPC `getBranchHistory(targetSiblingId)` (from P1); on response, the DO also broadcasts a snapshot with reason='branch-navigate' containing the new history AND updated branchInfo. Client reacts via collection subscription — no `replaceAllMessages()` call in the RPC handler."
      - "Delete the `getBranches` RPC from SessionDO. Grep to confirm no callers."
    test_cases:
      - id: "branch-collection-persists"
        description: "Open session with branches, tab away, return. Branch info UI renders instantly from OPFS. No `getBranches` RPC call fires on tab-switch (verified via Network tab filter)."
        type: "integration"
      - id: "resubmit-updates-branches"
        description: "Resubmit a message to create a new branch. Branch UI immediately shows 'current: 2, total: 2' under the parent — no RPC call, no manual refresh."
        type: "e2e"
      - id: "branchinfo-usestate-deleted"
        description: "`rg 'branchInfo|refreshBranchInfo|getBranches' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` returns 0 matches. useState<Map> for branchInfo is gone."
        type: "audit"
      - id: "branch-navigate-no-manual-replace"
        description: "Click next-branch arrow. Chat view swaps to sibling branch. Implementation: no `replaceAllMessages()` call is reached in the click handler; the collection update comes from the DO-pushed snapshot."
        type: "integration"
      - id: "docoldstart-hydrates-branches"
        description: "Cold-start DO, open session URL directly. On-connect snapshot includes branchInfo for every user turn with siblings. UI shows branch arrows on the correct messages."
        type: "integration"

  - id: p5
    name: "Cleanup — agentSessionsCollection, events array, replaceAllMessages helper"
    tasks:
      - "Bump `sessionLiveStateCollection` schema v1→v2 in `apps/orchestrator/src/db/session-live-state-collection.ts`. Add fields: `project?: string`, `model?: string`, `prompt?: string`, `archived?: boolean`, `createdAt?: string`. Migration: v1 rows load with these fields undefined; populated on first onStateUpdate after upgrade (DO sends these in SessionState.project etc.)."
      - "Migrate `tab-bar.tsx`, `quick-prompt-input.tsx`, `SessionListItem.tsx` readers: replace `useLiveQuery(agentSessionsCollection)` with `useLiveQuery(sessionLiveStateCollection)`. Fields they read (status, model, project) come from the expanded schema or from the nested `state` field (status comes from `state.status`)."
      - "Delete the dual-write in `use-coding-agent.ts:226-236` (the `sessionsCollection.utils.writeUpdate(...)` call). The expanded sessionLiveStateCollection upsert already carries project/model; schema v2 makes them readable."
      - "For the archived-session list in `SessionListItem.tsx` fallback path (when no live-state row exists because the session was never opened this browser session): add a one-shot REST fetch to `/api/sessions/{id}` and hydrate a read-only row into sessionLiveStateCollection with `wsReadyState: 3` (closed). Document: the collection is now the single source of truth; offline sessions live there too."
      - "Delete `apps/orchestrator/src/db/agent-sessions-collection.ts`. Update `use-sessions-collection.ts` to wrap sessionLiveStateCollection instead. For CRUD (create/update/archive), keep the `/api/sessions` POST/PATCH + createTransaction pattern but target sessionLiveStateCollection."
      - "Delete `apps/orchestrator/src/debug/session-collection.tsx`. Dev-only observer — the existing TanStack DB devtools surface covers the same observation needs. Remove its route registration if any (`rg 'debug/session-collection' apps/orchestrator/src/` → 0 matches after deletion)."
      - "Delete `events: useState<Array<{ts, type, data}>>([])` from use-coding-agent.ts line 119. Delete the append at lines 288-291. Remove `events` from the hook's public `UseCodingAgentResult` interface (no consumers confirmed via `rg` during research)."
      - "Delete `replaceAllMessages()` helper from use-coding-agent.ts (lines 165-187). Rewind, resubmit, branch-navigate now rely on DO-authored snapshots from P1 — no client-side replace logic remains."
      - "Audit sweep: `rg 'agentSessionsCollection' apps/orchestrator/src/` → 0 matches. `rg 'events: ' apps/orchestrator/src/features/agent-orch/` → check for stale types. `rg 'replaceAllMessages' apps/orchestrator/src/` → 0 matches. `rg 'turnHint|maxServerTurn|insertOptimistic|deleteOptimistic|clearOldestOptimisticRow|hydratedRef' apps/orchestrator/src/` → 0 matches."
      - "Update `CLAUDE.md` 'Client data flow' section to name messagesCollection + branchInfoCollection as the render sources (alongside sessionLiveStateCollection from #12). Document the seq'd {type:'messages'} protocol."
    test_cases:
      - id: "agentsessions-deleted"
        description: "File `apps/orchestrator/src/db/agent-sessions-collection.ts` does not exist. No imports of `agentSessionsCollection` anywhere."
        type: "audit"
      - id: "livestate-schema-v2"
        description: "sessionLiveStateCollection row for an open session has `project`, `model`, `prompt`, `archived`, `createdAt` populated. Tab bar shows project name live-reactively."
        type: "integration"
      - id: "events-retired"
        description: "`grep -c 'events' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` does not include the useState declaration or append calls. Hook return type does not include `events`."
        type: "audit"
      - id: "replaceall-deleted"
        description: "`rg 'replaceAllMessages' apps/orchestrator/src/` returns 0 matches. Rewind, resubmit, branch-navigate rely entirely on DO snapshots."
        type: "audit"
      - id: "no-manual-reconciliation"
        description: "`rg 'turnHint|maxServerTurn|insertOptimistic|deleteOptimistic|clearOldestOptimisticRow|hydratedRef|refreshBranchInfo|getBranches' apps/orchestrator/src/` returns 0 matches."
        type: "audit"
      - id: "smoketest-full-loop"
        description: "End-to-end smoke test via scripts/verify/: hydrate cold DO → send 3 messages → rewind to turn 1 → send → resubmit the new message → navigate to sibling branch → tab away → tab back. UI correct at every step."
        type: "smoke"
---

# GH#14: Unify Message Transport on TanStack DB — Retire Manual Hydrate/Optimistic/Replace Reconciliation

> GitHub Issue: [#14](https://github.com/baseplane-ai/duraclaw/issues/14)

## Overview

Follow-up to GH#12 (PR #13). #12 unified session live state on TanStack DB's
`sessionLiveStateCollection` but explicitly left the messages path out of
scope. The messages path still has the same class of hand-rolled reconciliation
#12 aimed to retire: an imperative hydrate/retry/re-hydrate ladder, a
custom optimistic-row protocol with fabricated `turnHint` sort keys, a dual
`type:'message'` / `type:'messages'` DO→client wire fork, a non-reactive
`branchInfo` useState<Map> rebuilt via N per-turn RPCs, a shadow-write dual-
maintained against `agentSessionsCollection`, and an unbounded debug `events`
array. This spec extends the patterns #12 established into the messages
transport: one DO→client channel carrying seq'd deltas or snapshots, query-
collection-backed hydration, `createTransaction` optimistic inserts
auto-reconciled by deep-equality, a reactive `branchInfoCollection`, and a
phased retirement of every helper, ref, and useState the reconciliation
machinery built up.

## Feature Behaviors

### B1: Unified DO → client messages channel with monotonic seq

**Core:**
- **ID:** messages-channel-seq
- **Trigger:** Any DO-side message state change: streaming `partial_assistant`,
  tool result, finalised assistant, user echo, gate promotion, resubmit,
  rewind, on-connect hydrate.
- **Expected:** DO emits exactly one frame shape: `{type:'messages',
  sessionId, seq, payload: {kind:'delta', upsert?, remove?} |
  {kind:'snapshot', version, messages, reason}}`. `seq` is monotonic per
  session, assigned by the DO at broadcast time (not persisted; resets to 0
  on DO cold start). Streaming paths emit deltas. Reconnect, rewind,
  resubmit, and branch-navigate emit snapshots.
- **Verify:** See test `delta-seq-monotonic`. Send 5 messages; capture WS
  frames; every frame is `{type:'messages'}`; every `seq` is prior+1;
  streaming frames have `kind:'delta'`.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` (replace
  `broadcastToClients({type:'message', message})` call sites + the
  `{type:'messages', messages}` on-connect send at `:202-208`).

#### API Layer
New wire protocol (DO → browser client, over the TanStack DB WS connection —
unchanged at the socket level):

```ts
interface MessagesFrame {
  type: 'messages'
  sessionId: string
  seq: number  // per-session monotonic
  payload: DeltaPayload | SnapshotPayload
}
interface DeltaPayload {
  kind: 'delta'
  upsert?: SessionMessage[]
  // Reserved for future use. No current DO call site populates `remove` —
  // message deletion is not a supported operation in this spec. The field
  // exists so the client-side handler can be correct-by-construction when a
  // future feature (e.g., "delete attachment") adds a producer. Until then,
  // P1 never emits it and `messagesCollection.delete(payload.remove)`
  // short-circuits on empty/undefined arrays.
  remove?: string[]  // message ids
}
interface SnapshotPayload {
  kind: 'snapshot'
  version: number  // equals current messageSeq
  messages: SessionMessage[]  // linear history on current branch
  reason: 'reconnect' | 'rewind' | 'resubmit' | 'branch-navigate'
  branchInfo?: BranchInfoRow[]  // optional, per B7
}
```

The GatewayEvent wire (runner ↔ DO) is unchanged.

#### Data Layer
No SessionDO SQLite schema changes. `messageSeq: number` lives on the DO
instance as non-persisted state. `SessionMessage` gains optional
`canonical_turn_id?: string` (see B6) but existing rows load without it.

---

### B2: DO-authored snapshots for rewind, resubmit, branch-navigate

**Core:**
- **ID:** do-authored-snapshots
- **Trigger:** Client invokes `rewind(turnIndex)`, `resubmitMessage(id, content)`,
  or `navigateBranch(targetSiblingId)` RPC on the SessionDO.
- **Expected:** DO computes the new linear history (via
  `session.getHistory(leafId)`) and broadcasts a snapshot with
  `reason: 'rewind' | 'resubmit' | 'branch-navigate'`. Client receives
  the snapshot via the standard `{type:'messages'}` handler and converges
  its collection — no client-side `replaceAllMessages()`, no
  `getMessages({leafId})` round-trip.
- **Verify:** Tests `rewind-broadcasts-snapshot`, `resubmit-broadcasts-snapshot`,
  and `branch-navigate-no-manual-replace`. After each of the three operations,
  the DO emits exactly one snapshot frame; the client's RPC handlers do not
  call `replaceAllMessages()`.
- **Source:** `session-do.ts` rewind (~line 1533), resubmit (~1602-1658),
  plus a new `getBranchHistory(leafId)` → snapshot-broadcast path for
  navigate.

#### API Layer
Broadcast scope (decided):

- **`reason:'rewind'`** — broadcasts to **all connected clients** of the
  session. Rewind mutates persistent session state; every viewer must
  converge. Pre-empts any in-flight deltas — the DO increments `seq`, emits
  the snapshot, and any still-queued delta frames are flushed before it (DO
  is single-threaded, so WS writes are serialized).
- **`reason:'resubmit'`** — broadcasts to **all connected clients**. Same
  rationale as rewind.
- **`reason:'branch-navigate'`** — sends to **only the requesting client**.
  Branch navigation is view-state, not persistent-state; User B's active
  branch should not shift because User A clicked a sibling arrow.
  Implementation: `broadcastMessages` helper gains an optional
  `{ targetClientId?: string }` arg; when set, the DO sends to that one
  socket via `this.sendToClient(...)` instead of calling `broadcastToClients`,
  **and does NOT increment `messageSeq`** — targeted sends echo the current
  seq without perturbing it, so non-recipients' `lastSeq` stream stays
  aligned and no spurious gap is observed. The recipient client updates
  `lastSeq = max(lastSeq, payload.version)` (see Gotchas → "Targeted
  snapshots MUST NOT advance the shared `seq` counter" for the full rule).
- **`reason:'reconnect'`** — single-client (the one that just connected or
  called `requestSnapshot()`).

New DO RPCs and their error behaviors:

- **`getBranchHistory(leafId: string) → {ok: true} | {ok: false, error:
  'unknown_leaf' | 'not_on_branch'}`**. Return value is acknowledgement
  only; data arrives via the broadcast. Errors:
  - `unknown_leaf` — `leafId` does not exist in the session's history.
    Client shows a toast and leaves the current view intact (no collection
    mutation).
  - `not_on_branch` — leaf exists but isn't a user-turn message (can't
    navigate to it). Same client behavior.
  - No retry; errors are deterministic given the caller's `leafId`.
- **`requestSnapshot() → {ok: true} | {ok: false, error: 'session_empty'}`**.
  `session_empty` is returned if the DO has no history yet (cold start + no
  messages sent). Client treats this as a no-op (collection is already
  empty). On network error, the WS layer's existing reconnect protocol
  takes over — no client-side retry inside the RPC wrapper.

---

### B3: Seq gap detection and snapshot fallback

**Core:**
- **ID:** seq-gap-fallback
- **Trigger:** Client receives a delta frame whose `seq` is not
  `lastSeq + 1` (e.g., dropped frame mid-buffer, unknown-order delivery).
- **Expected:** Client calls new DO RPC `requestSnapshot()`; DO responds by
  broadcasting a snapshot with `reason:'reconnect'`. Client's collection
  converges. `lastSeq` updates to snapshot's `version`.
- **Verify:** Test `gap-triggers-snapshot-request`. Simulate a dropped delta
  (force client to skip seq N+1, receive seq N+2). Client emits
  `requestSnapshot`; DO responds; collection contains the server's current
  truth.
- **Source:** New — `use-coding-agent.ts` onMessage handler, replacing the
  `type:'message' | 'messages'` branch.

#### API Layer
New DO RPC: `requestSnapshot() → {ok:true} | {ok:false, error:'session_empty'}`.
Side effect on success: sends `{kind:'snapshot', reason:'reconnect'}` to the
requesting client only (targeted; no `seq` increment — see B2). On
`session_empty`, the client treats it as a no-op since the collection is
already empty. Full error-shape rationale lives in B2 API Layer.

---

### B4: Query-collection-backed message hydration (retires hydratedRef + setTimeout retry)

**Core:**
- **ID:** query-collection-hydrate
- **Trigger:** Component mounts with a `sessionId`; `messagesCollection` has
  no cached row for that session.
- **Expected:** `queryCollectionOptions({ queryFn: getMessages, syncMode:
  'on-demand', retry: 1, retryDelay: 500 })` fetches via RPC. `isFetching`
  is true during the fetch, transitions to false when data arrives (or
  retry exhausted). `isConnecting` in the hook derives from
  `messages.isFetching || wsReadyState !== 1`. No `hydratedRef`, no
  `setTimeout(500)`, no running→idle re-hydrate useEffect.
- **Verify:** Tests `hydratedref-deleted`, `coldstart-retry`,
  `resume-rehydrate`, `isconnecting-derivation`. Grep confirms deletion;
  cold-DO scenario shows one-retry behavior; idle → running → idle does
  not trigger a manual re-hydrate call.
- **Source:** Replace `use-coding-agent.ts:239-261, 337-348`. Modify
  `db/messages-collection.ts` to use `queryCollectionOptions`.

#### Data Layer
`messages-collection.ts` schema bump v2→v3. v2 rows (with `turnHint`) load
compatibly; turnHint is still present at this phase. Removed in P3.

---

### B5: createTransaction-based optimistic user message insert

**Core:**
- **ID:** optimistic-create-transaction
- **Trigger:** User submits a message via `sendMessage`, `submitDraft`, or
  `forkWithHistory`.
- **Expected:** Client generates `client_message_id =
  \`usr-client-${crypto.randomUUID()}\``. Wraps the RPC call in
  `createTransaction({ mutationFn })`. `tx.mutate()` inserts the user row
  with `id = client_message_id`. On RPC failure, TanStack DB auto-rolls
  back. On success, the row persists; the DO echo arrives and reconciles
  via B6.
- **Verify:** Test `rollback-on-rpc-failure`. Mock `sendMessage` rejection;
  row is absent after the call resolves. Test `optimistic-retire-by-deep-
  equality` verifies the happy-path reconciliation.
- **Source:** Replace `insertOptimistic`, `deleteOptimistic`,
  `clearOldestOptimisticRow`, `maxServerTurn`, `turnHint` in
  `use-coding-agent.ts:79-214, 488-515` and `db/messages-collection.ts`
  (CachedMessage type + schema v3→v4).

#### Data Layer
`CachedMessage.turnHint` field removed. Schema bump v3→v4 (turnHint becomes
ignored on load; dropped on next write).

---

### B6: Server-accepts-client-ID echo reconciliation

**Core:**
- **ID:** server-accepts-client-id
- **Trigger:** User-turn RPC `sendMessage(content, client_message_id)` flows
  DO → runner → SDK append → SDK echoes user turn.
- **Expected:** DO accepts the user-turn echo with `SessionMessage.id =
  client_message_id` (the client-proposed id) and stores the turn's
  canonical ordinal as `canonical_turn_id: 'usr-N'` (secondary field; used
  for history ordering, rewind, branch identity). The DO broadcasts the
  message via B1. Client's `messagesCollection` receives the echo — id
  matches existing row; TanStack DB deep-equality retires the optimistic
  transaction silently (no delete+insert churn).
- **Verify:** Test `optimistic-retire-by-deep-equality`. React-render counter
  on the list item for the echoed user row increments at most once between
  optimistic-insert and echo-arrival.
- **Source:** Modify `packages/shared-types/src/index.ts` (add
  `client_message_id` to `stream-input` GatewayCommand; add
  `canonical_turn_id?: string` to `SessionMessage`). Modify
  `packages/session-runner/src/` (propagate client_message_id to SDK user
  append, surface on echo). Modify `apps/orchestrator/src/agents/session-do.ts`
  (accept and store both ids).

#### API Layer
`GatewayCommand` `stream-input` gains optional `client_message_id?: string`.
Runner/DO honor it when present; legacy callers that omit it continue to
get server-assigned `usr-N` ids (backward-compat path, also used for
DO-originated user messages like resubmit).

#### Fallback
If runtime testing reveals the GatewayCommand extension breaks detached
runners on the VPS, P3 swaps to **client-side ID promotion** (see P3 task
`fallback-if-gatewaycommand-locked`): optimistic id stays `usr-optimistic-<ms>`,
echo arrives with server `usr-N`, client calls `messagesCollection.update(
optimisticId, r => ({...r, id: serverId}))` inside the same transaction.
All other P3 code unchanged.

---

### B7: branchInfoCollection — reactive per-session branch state

**Core:**
- **ID:** branch-info-collection
- **Trigger:** Any DO-authored snapshot with a populated `branchInfo` field.
  Specifically: (a) on-connect snapshot (populated for every user turn
  that has siblings); (b) resubmit snapshot (populated for the affected
  parent — new sibling list); (c) branch-navigate snapshot (populated with
  the target branch's sibling map so the recipient's UI updates in lockstep
  with the history swap); (d) rewind snapshot (populated for any parent
  whose sibling list changes if rewind removes branches — else omitted).
- **Expected:** Client reads `branchInfo` from the snapshot payload and
  upserts each row into `branchInfoCollection` (per-session factory,
  OPFS-persisted, keyed on `parentMsgId`). Components consume via
  `useBranchInfo(sessionId, parentMsgId) → {current, total, siblings}` —
  a thin wrapper over `useLiveQuery` + sibling-array index math.
- **Verify:** Tests `branch-collection-persists`, `resubmit-updates-branches`,
  `branchinfo-usestate-deleted`. Tab switch has zero `getBranches` calls;
  resubmit UI updates without refresh; `useState<Map>` deleted.
- **Source:** New file `db/branch-info-collection.ts`. New hook
  `hooks/use-branch-info.ts`. Delete `use-coding-agent.ts:120-122, 398-434`.
  Delete `getBranches` RPC from SessionDO.

#### Data Layer
New collection, per-session (factoryed by `agentName`), `schemaVersion: 1`,
OPFS-persisted. Shape:

```ts
interface BranchInfoRow {
  parentMsgId: string  // key
  sessionId: string
  siblings: string[]  // user-message ids, order = creation order
  activeId: string    // the sibling currently on the active branch
  updatedAt: string
}
```

---

### B8: sessionLiveStateCollection schema v2 — metadata expansion

**Core:**
- **ID:** session-live-state-v2
- **Trigger:** P5 migration; first `onStateUpdate` after bumping.
- **Expected:** `sessionLiveStateCollection` gains `project`, `model`,
  `prompt`, `archived`, `createdAt` fields (all optional). Writers
  (onStateUpdate in use-coding-agent.ts) populate them from
  `SessionState.project` / `.model` / ..., plus a one-shot REST hydrate
  for offline sessions. Readers (tab-bar, quick-prompt, SessionListItem)
  read these fields.
- **Verify:** Test `livestate-schema-v2`. Open session; row has all v2
  fields populated; tab bar updates reactively when `project` changes.
- **Source:** Modify `apps/orchestrator/src/db/session-live-state-collection.ts`
  (bump schema). Modify readers: `tab-bar.tsx:79`, `quick-prompt-input.tsx:99`,
  `SessionListItem.tsx`.

#### Data Layer
Schema v1→v2 migration. Old rows load with new fields `undefined`; populate
on first `onStateUpdate`.

---

### B9: agentSessionsCollection + shadow-write retirement

**Core:**
- **ID:** agent-sessions-collection-retire
- **Trigger:** P5 cleanup; all readers migrated to `sessionLiveStateCollection` (B8).
- **Expected:** `apps/orchestrator/src/db/agent-sessions-collection.ts` is
  deleted. Shadow-write at `use-coding-agent.ts:226-236` is deleted.
  `use-sessions-collection.ts` now wraps `sessionLiveStateCollection` for
  CRUD. `SessionListItem` offline fallback uses a one-shot
  `/api/sessions/{id}` REST fetch that upserts a row into
  `sessionLiveStateCollection` with `wsReadyState: 3`.
- **Verify:** Test `agentsessions-deleted`.
  `rg 'agentSessionsCollection' apps/orchestrator/src/` returns 0 matches.
- **Source:** Delete file. Modify `use-coding-agent.ts:226-236`,
  `use-sessions-collection.ts`, `SessionListItem.tsx`, `tab-bar.tsx`,
  `quick-prompt-input.tsx`, `debug/session-collection.tsx`.

---

### B10: events array + replaceAllMessages retirement

**Core:**
- **ID:** events-replaceall-retire
- **Trigger:** P5 cleanup.
- **Expected:** `events: useState<Array>([])` and its appenders at
  `use-coding-agent.ts:119, 288-291` are deleted. `events` is removed from
  the hook's public `UseCodingAgentResult` interface.
  `replaceAllMessages()` helper at `:165-187` is deleted. All three
  rewind/resubmit/branch-navigate call sites now rely on DO-authored
  snapshots (B2).
- **Verify:** Tests `events-retired`, `replaceall-deleted`,
  `no-manual-reconciliation`.
- **Source:** Delete from `use-coding-agent.ts`.

---

### B11: CLAUDE.md + docs update

**Core:**
- **ID:** docs-update
- **Trigger:** P5 close.
- **Expected:** CLAUDE.md "Client data flow (session live state)" section
  expands to name `messagesCollection` and `branchInfoCollection` as the
  other render sources. Documents the seq'd `{type:'messages'}` protocol
  and B2's DO-authored snapshots. Adds a one-paragraph note on the
  deep-equality optimistic reconciliation pattern.
- **Verify:** `rg -c 'messagesCollection|branchInfoCollection' CLAUDE.md`
  returns ≥ 2 for each term. `rg "type:'messages'" CLAUDE.md` returns ≥ 1.
  `rg '\bseq\b|monotonic' CLAUDE.md` returns ≥ 1. Manual skim confirms the
  "Client data flow" section names all three collections (messages,
  branch-info, live-state) as render sources.
- **Source:** `CLAUDE.md` section "Client data flow (session live state)".

---

## Non-Goals

Explicitly out of scope for this feature:
- **No SessionDO SQLite schema changes.** On-disk session history format
  stays the same. The Anthropic SDK `Session` class storage is opaque;
  we do not touch it.
- **No GatewayEvent (runner → DO) wire format changes.** The event shapes
  emitted by the session runner are stable. The only protocol change in
  the runner↔DO direction is the optional `client_message_id` field on the
  DO→runner `stream-input` GatewayCommand (see B6; fallback path exists
  if this proves unsafe in practice).
- **No TanStack DB migration.** Library stays at `@tanstack/db@0.6.4`.
- **No cross-session branch navigation.** `branchInfoCollection` is
  per-session; a future "recent branches across sessions" view is a
  separate feature.
- **No delta-since-seq replay on reconnect.** Reconnect always delivers a
  snapshot. Adding delta-replay requires a DO-side retention window; deferred
  until benchmarking justifies it (see Open Questions).
- **No changes to sessionLiveStateCollection's `state` field shape.** #12
  locked it in; this spec adds sibling fields (B8) but doesn't reshape the
  core SessionState.
- **No devtools events panel.** `events` array is retired outright; if a
  future devtools reader appears, it'll land as a new capped collection
  (not in this spec).

## Open Questions

- [ ] *(none currently open — all P1-blocking questions resolved below.)*
- [ ] **Snapshot granularity for very long sessions** — current branch can
  be 1000+ turns. A full snapshot may be 500KB+ over the wire. Benchmark in
  P1; if problematic, Phase 6 (out of scope here) adds delta-since-seq
  replay. Not a blocker for this spec.
- [ ] **Archived-session REST fallback shape** — B9 specifies a one-shot
  `/api/sessions/{id}` hydrate into `sessionLiveStateCollection`. If the
  `/api/sessions` list endpoint already returns enough fields per item,
  we can hydrate lazily from the list. Check during P5 implementation.

### Pre-P3 gate (blocking)

**GatewayCommand compatibility spike** — before starting P3, run a one-hour
spike that deploys a DO build carrying the optional `client_message_id`
field on `stream-input` to the live staging VPS. Verify that already-running
session-runner processes (which predate the field) continue to execute
user turns without crashes, missed echoes, or schema violations (the field
is optional; old runners must simply ignore it). Two outcomes:

- **Pass** → P3's primary path (B6 server-accepts-client-ID) proceeds as
  specified.
- **Fail** → swap P3 implementation to the client-side ID promotion path
  described in the `fallback-if-gatewaycommand-locked` test case. All other
  P3 work (`createTransaction`, sort simplification, `turnHint` retirement)
  is unaffected. Update B6 Source section to reflect the DO-only id-
  tracking scheme.

This gate was previously listed as "Interview Q1 verification" in Open
Questions; it's been promoted to a blocking decision because P3 can't
start until one path is chosen. No spec revision is needed on either
outcome — both paths are fully specified.

### Resolved during spec review

- **VP1 observability** — use the `WebSocket.prototype.addEventListener`
  monkey-patch shown in VP1 step 3. It captures every incoming frame as
  plain JS, no CDP tooling needed, and works under `chrome-devtools-axi
  eval`. The alternative (puppeteer + `Network.webSocketFrameReceived`)
  is deferred to a future tooling upgrade.
- **`debug/session-collection.tsx` fate** — delete it. It's a dev-only
  observer UI; the migration cost of rewriting it against
  `sessionLiveStateCollection` is not worth the payoff, and the existing
  TanStack DB devtools UI covers the same observation needs.
- **Snapshot broadcast scope per operation** — decided in B2 API Layer:
  rewind/resubmit broadcast to all clients; branch-navigate and reconnect
  are requester-only.
- **New RPC error shapes** — specified in B2 API Layer
  (`getBranchHistory`, `requestSnapshot`).
- **Sort key composition with assistant/tool rows** — specified in P3 task
  list (composite `[canonical_turn_id, createdAt]`).

## Implementation Phases

See YAML frontmatter `phases:` above. Each phase is independently shippable:

- **P1** is wire-compat: DO-side changes only, client still uses all legacy
  reconciliation paths. No user-visible change. **P1 has an internal
  checkpoint** — tasks 1-9 (DO-side: `MessagesFrame` type, `broadcastMessages`
  helper, call-site replacements, new RPCs for `getBranchHistory` /
  `requestSnapshot`, and the `sendToClient` map) can land and ship as a
  standalone commit even if the client-side dispatch rewrite (tasks 10-12)
  isn't ready. The DO emits both old (`{type:'message'}`) and new
  (`{type:'messages'}`) frames during this sub-phase by routing every old
  call site through `broadcastMessages` but also leaving one legacy-shape
  send path untouched initially; remove the legacy path in task 10 (the
  client-side dispatch rewrite) once the client handles the new shape. This lets a long P1 checkpoint cleanly
  mid-way without user-visible breakage.
- **P2** retires the hydrate ladder. No user-visible change.
- **P3** retires optimistic reconciliation. No user-visible change (same UX,
  different mechanism).
- **P4** retires the branch-info map. Faster tab switch on sessions with
  many branches; otherwise no user-visible change.
- **P5** retires cleanup debt. No user-visible change; codebase is clean.

If a phase has to be rolled back, the preceding phases remain functional.

## Verification Strategy

### Test Infrastructure
- **Vitest** for unit tests (existing config at
  `apps/orchestrator/vitest.config.ts`).
- **Integration tests** mock the DO connection via the existing `useAgent`
  mock pattern; pattern lives in `apps/orchestrator/src/features/agent-orch/
  __tests__/` if present, otherwise create during P1.
- **chrome-devtools-axi** for smoke tests (per `scripts/verify/`).
- **No new test infra required.**

### Build Verification
`pnpm build && pnpm typecheck && pnpm test` at the repo root. The
orchestrator builds via Vite through wrangler; workspace libs build via
tsup. Types flow through `packages/shared-types` — a breaking change to the
MessagesFrame type will surface as a typecheck error in both
`apps/orchestrator` and `apps/agent-gateway` on first build.

## Verification Plan

Concrete, executable steps. Run from repo root unless noted. Assumes local
verify stack (`scripts/verify/dev-up.sh` or `portless-up.sh`) is running.

### VP1: Delta-seq monotonicity (B1, B3)

Steps:

1. `scripts/verify/axi-dual-login.sh`
   Expected: two Chrome instances signed in as users `+a` and `+b`.

2. `scripts/verify/axi-a open $VERIFY_ORCH_URL/dashboard`
   Expected: dashboard loads.

3. `scripts/verify/axi-a eval 'window.__wsFrames = []; const orig =
   WebSocket.prototype.send; WebSocket.prototype.addEventListener = ((o) =>
   function(ev, cb) { if (ev === "message") return o.call(this, ev, (e) =>
   { window.__wsFrames.push(JSON.parse(e.data)); cb(e); }); return
   o.apply(this, arguments); })(WebSocket.prototype.addEventListener);'`
   Expected: WS frame capture hook installed.

4. Create a new session, send 3 messages via the chat input
   (`scripts/verify/axi-a fill @<input> "hello"; axi-a click @<submit>` ×3).
   Expected: 3 user turns + 3 assistant turns visible in UI.

5. `scripts/verify/axi-a eval 'JSON.stringify(window.__wsFrames.filter(f =>
   f.type === "messages").map(f => ({seq: f.seq, kind:
   f.payload.kind})))'`
   Expected: every frame has `type:"messages"`; `seq` values are strictly
   monotonic (1, 2, 3, ...); streaming frames have `kind:"delta"`; the
   initial on-connect frame has `kind:"snapshot", reason:"reconnect"`.

### VP2: Cold-DO hydrate retry (B4)

Steps:

1. Force DO idle: wait 30+ min after creating a session, OR
   `curl -X POST $VERIFY_ORCH_URL/admin/evict-do?sessionId=<id>` (if
   endpoint exists; else restart orchestrator).

2. `scripts/verify/axi-a open $VERIFY_ORCH_URL/session/<id>`
   Expected: Session page loads. Messages may be empty initially.

3. `scripts/verify/axi-a eval 'await new Promise(r => setTimeout(r, 1500));
   document.querySelectorAll("[data-test=\"message\"]").length'`
   Expected: Count > 0 within 1.5 seconds (queryCollectionOptions retry
   resolved).

4. `scripts/verify/axi-a eval 'performance.getEntriesByType("resource").
   filter(r => r.name.includes("getMessages")).length'`
   Expected: ≤ 2 `getMessages` calls (one initial, at most one retry).

### VP3: Optimistic send + echo reconciliation (B5, B6)

Steps:

1. Open a running session. Install a render-counter hook on the chat list
   by patching `React.createElement` to tally calls per message id:

   ```bash
   scripts/verify/axi-a eval '
     window.__profilerRenderCounts = {};
     const origCE = React.createElement;
     React.createElement = function(type, props, ...children) {
       if (props && typeof props["data-test-msgid"] === "string") {
         const id = props["data-test-msgid"];
         window.__profilerRenderCounts[id] = (window.__profilerRenderCounts[id] || 0) + 1;
       }
       return origCE.apply(this, arguments);
     };
   '
   ```

   Expected: the hook is installed; message list rows render with
   `data-test-msgid={msg.id}` prop (add this to the chat-row component if
   missing during P3 implementation). After installation,
   `window.__profilerRenderCounts` collects counts keyed by message id.

2. Send a message via the input.
   Expected: row appears instantly in the chat list.

3. `scripts/verify/axi-a eval 'window.__lastClientMessageId'` (hook sets
   this at send time).
   Expected: `usr-client-<uuid>` format.

4. Wait 2s for echo.
   `scripts/verify/axi-a eval 'window.__profilerRenderCounts[<msgId>]'`
   Expected: 1 (single render between insert and echo; deep-equality
   prevents a second).

5. Rollback scenario: throttle network to offline, send a message.
   Expected: row appears optimistically, then disappears when the
   `createTransaction` mutationFn rejects.

### VP4: Rewind and resubmit broadcast snapshots (B2)

Steps:

1. In a session with 5 turns, click rewind on turn 2.
2. `scripts/verify/axi-a eval 'window.__wsFrames.slice(-1)[0]'`
   Expected: `{type:"messages", seq:N, payload:{kind:"snapshot",
   reason:"rewind", messages:[<2 messages>]}}`.
3. `scripts/verify/axi-a eval 'document.querySelectorAll(
   "[data-test=\"message\"]").length'`
   Expected: 2.
4. Resubmit turn 1.
5. Expected last frame: `{payload:{kind:"snapshot", reason:"resubmit",
   messages:[...new branch path...], branchInfo:[{parentMsgId:<p>,
   siblings:[<orig>, <new>]}]}}`.

### VP5: Branch navigation without getBranches RPCs (B7)

Steps:

1. Session with a branching turn (resubmitted at least once).
2. Tab away, tab back.
3. `scripts/verify/axi-a eval 'performance.getEntriesByType("resource").
   filter(r => r.name.includes("getBranches")).length'`
   Expected: 0 (RPC retired; data comes from `branchInfoCollection`).
4. Click next-branch on a branching user turn.
   Expected: chat swaps to sibling branch; no `getBranches` or
   `getMessages` calls fire; one WS frame with
   `reason:"branch-navigate"` arrives.

### VP6: Cleanup audit (B8-B10)

Steps:

1. `rg 'agentSessionsCollection' apps/orchestrator/src/ | wc -l`
   Expected: 0.
2. `rg 'turnHint|maxServerTurn|insertOptimistic|deleteOptimistic|
   clearOldestOptimisticRow|hydratedRef|refreshBranchInfo|replaceAllMessages'
   apps/orchestrator/src/ | wc -l`
   Expected: 0.
3. `grep -c 'events:' apps/orchestrator/src/features/agent-orch/
   use-coding-agent.ts`
   Expected: no match for useState pattern.
4. `test -f apps/orchestrator/src/db/agent-sessions-collection.ts && echo
   STILL_EXISTS || echo DELETED`
   Expected: DELETED.
5. Open tab-bar; verify project name updates live when session's
   `project` state changes (tests B8's schema v2 writer).

### VP7: Full integration smoke (B1-B11)

Steps:

1. `scripts/verify/axi-dual-login.sh`.
2. User A: create session, send 3 messages.
3. User A: rewind to turn 1, send a new message (forks branch).
4. User A: resubmit turn 2 (another fork).
5. User A: navigate between siblings on turn 1 branch.
6. User A: tab away and back.
7. User A: reload page.
8. After every step, `axi-a snapshot` accessibility tree includes the
   expected message count, branch arrows on the branched turns, and the
   current branch's leaf visible at the bottom.

## Implementation Hints

### Dependencies

No new dependencies. Existing:
- `@tanstack/db@0.6.4`
- `@tanstack/react-db@0.1.82`
- `@tanstack/query-db-collection@1.0.35`
- `partysocket@1.1.4` (WS client; unchanged)

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@tanstack/db` | `createTransaction` | B5 optimistic mutations |
| `@tanstack/db` | `createCollection` | Collection factories |
| `@tanstack/query-db-collection` | `queryCollectionOptions` | B4 hydration |
| `@tanstack/react-db` | `useLiveQuery` | B7 branch-info reads (already used for messages) |
| `~/db/messages-collection` | `createMessagesCollection` | P2 factory |
| `~/db/branch-info-collection` | `createBranchInfoCollection` | P4 factory (new) |
| `~/db/session-live-state-collection` | `upsertSessionLiveState`, `SessionLiveState` | B8 schema v2 (modify type) |
| `@duraclaw/shared-types` | `MessagesFrame`, `DeltaPayload`, `SnapshotPayload`, `BranchInfoRow` | B1 wire types |

### Code Patterns

**B1 — DO broadcast helper** (`session-do.ts`):

```ts
private messageSeq = 0
private broadcastMessages(
  payload: DeltaPayload | SnapshotPayload,
  opts: { targetClientId?: string } = {},
) {
  // Only advance the shared seq when the frame reaches every client.
  // Targeted sends echo the current seq without perturbing it — non-
  // recipients stay aligned, recipient uses max(lastSeq, version).
  if (!opts.targetClientId) this.messageSeq += 1
  const frame: MessagesFrame = {
    type: 'messages',
    sessionId: this.name,
    seq: this.messageSeq,
    payload,
  }
  if (opts.targetClientId) {
    this.sendToClient(opts.targetClientId, frame)
  } else {
    this.broadcastToClients(frame)
  }
}

// Call sites:
this.broadcastMessages({ kind: 'delta', upsert: [msg] })                   // all clients, seq++
this.broadcastMessages({ kind: 'snapshot', version: this.messageSeq,
  messages: this.session.getHistory(), reason: 'reconnect' },
  { targetClientId })                                                      // one client, no seq++
this.broadcastMessages({ kind: 'snapshot', version: this.messageSeq,
  messages: this.session.getHistory(leafId), reason: 'branch-navigate' },
  { targetClientId: rpcCallerId })                                         // one client, no seq++
```

**B4 — query-backed messages collection** (`db/messages-collection.ts`):

```ts
export function createMessagesCollection(agentName: string) {
  return createCollection(
    persistedCollectionOptions({
      schemaVersion: 3,
      ...queryCollectionOptions<CachedMessage>({
        id: `messages_${agentName}`,
        queryFn: async ({ signal }) => {
          // agentName routes at the Agents SDK layer; the RPC takes no args.
          const r = await rpcCall('getMessages', {}, { signal, agent: agentName })
          return r.messages.map(toCachedMessage)
        },
        syncMode: 'on-demand',
        retry: 1,
        retryDelay: 500,
        staleTime: Infinity,
        getKey: (m) => m.id,
      }),
    })
  )
}
```

**B5 — createTransaction optimistic send** (`use-coding-agent.ts`):

```ts
const sendMessage = async (content: string) => {
  const clientId = `usr-client-${crypto.randomUUID()}`
  const tx = createTransaction({
    mutationFn: async () => {
      await connection.call('sendMessage', { content, client_message_id: clientId })
    },
  })
  tx.mutate(() => {
    messagesCollection.insert({
      id: clientId,
      sessionId: agentName,
      role: 'user',
      parts: [{ type: 'text', text: content }],
      createdAt: new Date().toISOString(),
    })
  })
  try {
    await tx.isPersisted.promise
    return { ok: true, clientId }
  } catch (err) {
    return { ok: false, error: err }
  }
}
```

**B6 — server-accepts-client-ID (SessionDO)**:

```ts
// In session-do.ts user-turn append handler. Increment turnCounter EXACTLY ONCE per turn.
const canonicalId = `usr-${++this.turnCounter}`
// If the client proposed an id, use it as the row id; otherwise fall back to the
// canonical id (legacy path — id === canonical_turn_id for backward-compat).
const rowId = userMsg.client_message_id ?? canonicalId
const msg: SessionMessage = {
  id: rowId,
  canonical_turn_id: canonicalId,
  role: 'user',
  parts: userMsg.parts,
  createdAt: new Date().toISOString(),
}
this.session.appendMessage(msg, parentId)
this.broadcastMessages({ kind: 'delta', upsert: [msg] })
```

Note: legacy callers (no `client_message_id`) land on `rowId === canonicalId`, preserving
the prior "`id` and `canonical_turn_id` match" invariant. Only callers that supply a
client id get a diverged pair, which is the whole point of this behavior.

**B7 — branchInfoCollection per-session factory** (new file):

```ts
export function createBranchInfoCollection(agentName: string) {
  return createCollection(
    persistedCollectionOptions({
      schemaVersion: 1,
      ...localOnlyCollectionOptions<BranchInfoRow>({
        id: `branch_info_${agentName}`,
        getKey: (r) => r.parentMsgId,
      }),
    })
  )
}
// In use-coding-agent.ts onMessage snapshot handler:
if (frame.payload.branchInfo) {
  for (const row of frame.payload.branchInfo) {
    branchInfoCollection.upsert({ ...row, updatedAt: new Date().toISOString() })
  }
}
```

**useBranchInfo hook** (`hooks/use-branch-info.ts`):

```ts
export function useBranchInfo(sessionId: string, parentMsgId: string) {
  const { data: row } = useLiveQuery(
    branchInfoCollection(sessionId),
    (q) => q.where('parentMsgId', '==', parentMsgId)
  )
  if (!row || row.siblings.length < 2) return null
  const current = row.siblings.indexOf(row.activeId) + 1
  return { current, total: row.siblings.length, siblings: row.siblings }
}
```

### Gotchas

- **TanStack DB deep-equality reconciliation** depends on **byte-identical**
  row shape after echo. If the server echo adds `canonical_turn_id` but the
  optimistic row doesn't have it, that's a field diff and **will** trigger
  an update event. Optimistic inserts should NOT include
  `canonical_turn_id` (it's server-authoritative). The update event is a
  single-field patch — acceptable, avoids a delete+insert.
- **Schema version migration in OPFS**: TanStack DB's persisted collection
  uses `schemaVersion` to detect migrations; on bump, it drops old rows and
  re-fetches. For P2 (v2→v3) and P3 (v3→v4), this means first load after
  deploy shows a brief loading state. Acceptable. If we want to preserve
  rows, we'd have to implement a migration function — not worth the
  complexity for the schema changes in this spec.
- **`queryCollectionOptions` + WS push**: the query collection's `queryFn`
  is pull-only. WS pushes bypass it and write directly via `collection.upsert`
  / `collection.delete`. This is the established pattern from
  `sessionLiveStateCollection` in #12 — don't fight it by trying to invalidate
  the query on every WS frame.
- **Runner/DO protocol evolution**: the `client_message_id` field is
  OPTIONAL on `stream-input`. Old runner binaries running on the VPS when
  the DO deploys first MUST keep working. DO handling: if the echo comes
  back without a `client_message_id`, fall back to server-assigned
  `usr-N`. Same on the runner side: if DO sends stream-input without
  `client_message_id`, runner behaves identically to today.
- **`Session.appendMessage` id parameter**: Anthropic SDK's `Session` class
  MAY reject or silently replace custom IDs. Verify during P3
  implementation that `appendMessage(msg, parentId)` respects
  `msg.id` when it looks like `usr-client-<uuid>`. If not, the client-side
  fallback (P3 task `fallback-if-gatewaycommand-locked`) is mandatory, and
  B6 reduces to an internal DO id-tracking scheme (DO maps clientId ↔
  canonicalId for echo reconciliation).
- **`messageSeq` per-session, not persisted**: on DO cold start, seq resets
  to 0 and the first broadcast (on-connect snapshot) carries seq=1. Client
  must treat any snapshot as "this is the new truth — accept whatever
  version is on it" and update `lastSeq` from the snapshot's
  `payload.version`.
- **Snapshot application is atomic within a single onMessage callback**:
  the client's WS `onMessage` handler runs to completion before the next
  frame can be processed — this is guaranteed by the JS event loop and
  `partysocket`'s frame-at-a-time delivery. A snapshot's
  `replaceAllMessages(payload.messages) + branchInfoCollection.upsert(...)
  + set lastSeq = max(lastSeq, payload.version)` sequence runs in one
  microtask, so no delta can interleave with the apply. Do NOT introduce
  `await` boundaries inside the snapshot-apply path; if a future
  implementer needs async work (e.g., a schema migration), do it before
  calling the apply sequence, not inside it. If the WS disconnects mid-
  apply, the next reconnect triggers a fresh snapshot — partial state is
  not a concern because the apply itself is synchronous.
- **Multi-client concurrency is implicit, not locked**: SessionDO is a single-
  threaded Durable Object — all RPC handlers and WS writes execute serially
  on one isolate. That means: (a) two clients calling `requestSnapshot()`
  at the same time get serialized; each receives its own snapshot frame,
  each at a distinct `seq`; no duplicate frames, no races. (b) If User A
  triggers rewind while User B is mid-stream receiving assistant deltas,
  the DO finishes the current broadcast, increments `seq`, then emits the
  rewind snapshot (which invalidates the in-flight assistant turn on both
  clients). No explicit locking is needed; do NOT add `waitUntil()` or mutex
  wrappers around these handlers — it would only degrade perf while adding
  nothing.
- **Per-connection send — Agents SDK v0.7 has `Connection.send()`**: the
  `targetClientId` branch of `broadcastMessages` relies on the
  `@cloudflare/agents` SDK exposing a way to send to one specific socket.
  Agents SDK v0.7 surfaces this via the `Connection` object passed to
  `onMessage`/`onConnect` — each connection has its own `.send()` method,
  and `this.getConnection(id)` retrieves a live connection by its id. P1
  implementer: maintain a `Map<string, Connection>` keyed on
  `connection.id` (populate in `onConnect`, remove in `onClose`) and
  expose a private `sendToClient(id, frame)` helper that looks up the
  connection and calls `.send(JSON.stringify(frame))`. Drop the frame
  silently if the target id isn't in the map (client already disconnected).
  If the SDK version in use doesn't expose connection IDs, fall back to
  broadcasting with a `targetClientId` field in the frame and filtering on
  the client — less efficient but functionally equivalent. Verify SDK
  surface in P1 task 0 before implementing the targeted-send path.
- **Targeted snapshots MUST NOT advance the shared `seq` counter**: the
  `broadcastMessages` helper increments `messageSeq` only when
  `targetClientId` is undefined (all-clients broadcast). When
  `targetClientId` is set (branch-navigate, requester-only reconnect), the
  frame's `seq` echoes the current `messageSeq` (no increment), and the
  snapshot's `version` field carries the same value. This keeps
  non-requesting clients' `lastSeq` stream aligned — they only advance on
  frames they actually receive. Client-side rule: on a snapshot, set
  `lastSeq = max(lastSeq, payload.version)` rather than
  `lastSeq = payload.version`, to tolerate the targeted-snapshot case where
  a later delta frame may already have updated `lastSeq` past the snapshot's
  version.
- **`sessionLiveStateCollection` schema bump impact on offline users**:
  v1→v2 bump forces re-hydration; if the schema migration in persisted
  collection options drops v1 rows, offline-only sessions lose their
  sidebar metadata until the user next connects. Given the typical use
  pattern (always-connected browser), acceptable. Alternative: write a
  forward-compat loader that reads v1 rows and upgrades in place. Defer
  decision to P5 implementation.

### Reference Docs

- [TanStack DB — Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection) — `queryCollectionOptions`, `syncMode: 'on-demand'`, retry config.
- [TanStack DB — Mutations & Optimistic Actions](https://tanstack.com/db/latest/docs/guides/mutations) — `createTransaction`, `tx.mutate()`, `isPersisted.promise`, auto-rollback semantics.
- [TanStack DB — Live Queries](https://tanstack.com/db/latest/docs/guides/live-queries) — `useLiveQuery` patterns; differs from `@tanstack/query`'s `useQuery`.
- [Anthropic Agent SDK — `Session` class](https://docs.anthropic.com/en/api/claude-agent-sdk) — `appendMessage`, `getHistory`, `getBranches` semantics; message id behavior.
- [planning/specs/12-client-data-layer-unification.md](./12-client-data-layer-unification.md) — the pattern template this spec extends.
- [planning/research/2026-04-19-messages-transport-unification.md](../research/2026-04-19-messages-transport-unification.md) — research doc with all 7 deep-dive findings, strawman decisions, and the file:line index.
