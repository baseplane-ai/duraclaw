---
initiative: unify-messages-transport
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 14
created: 2026-04-19
updated: 2026-04-19
phases:
  - id: p1
    name: "DO protocol: unified messages-changed channel"
    tasks:
      - "In apps/orchestrator/src/agents/session-do.ts: introduce a private helper `emitMessagesChanged(op: MessagesChangedEvent)` that wraps `broadcastToClients(JSON.stringify(...))` and logs `console.log('[sessionDO] messages-changed', {operation, reason, count, sessionId})` at the call boundary. All new emits go through this helper."
      - "Define MessagesChangedEvent type in apps/orchestrator/src/agents/messages-channel.ts (new file): `{ type: 'messages-changed'; sessionId: string; operation: 'full-replay' | 'upsert-single' | 'trim'; messages?: SessionMessage[]; message?: SessionMessage; reason: 'initial-connect' | 'gateway-event' | 'recovery' | 'rewind' | 'resubmit' | 'navigate-branch' | 'spawn' | 'resume-discovered' | 'resolve-gate' | 'send-message' | 'fork-with-history' | 'partial-assistant' | 'assistant' | 'tool-result' | 'file-changed' | 'gate' | 'finalize-streaming' }`. Export from the DO folder's barrel if any."
      - "Hydrate-at-read for parentId: in the DO's message-serialisation path (where `this.session.getHistory()` and `this.session.getBranches()` results are converted to SessionMessage before emit/return), enrich each row by joining on the persisted `parent_id` column. Implementation: read the Agents SDK Session's raw row via `this.session.getRaw?.(id)` if available, else query via `this.ctx.storage.sql` directly against `assistant_messages.parent_id` using the existing Session table. Populate `message.parentId = parent_id ?? null` on the outgoing SessionMessage. Ship in every emit."
      - "Extend SessionMessage type in packages/shared-types/src/index.ts: add `parentId?: string | null`. Update any runner event types that carry SessionMessage to match."
      - "Replace the bulk emit at session-do.ts:~204 (onConnect): call `emitMessagesChanged({type:'messages-changed', sessionId, operation:'full-replay', messages: hydratedHistory, reason:'initial-connect'})` instead of sending `{type:'messages', messages: ...}`. Replace the empty-history fallback at :207 with `operation:'full-replay', messages:[]`."
      - "Migrate all 16 single-emit sites enumerated in the research (session-do.ts emit catalogue) from `broadcastMessage(msg)` to `emitMessagesChanged({type:'messages-changed', sessionId, operation:'upsert-single', message: msg, reason: <site-specific>})`. Delete `broadcastMessage` helper at :542 once all call sites migrate."
      - "echoOf acceptance on sendMessage RPC: in session-do.ts handler for sendMessage (~:1354), read `echoOf` from the RPC args object (typed on the client side). **Do NOT persist `echoOf` into the Agents SDK Session row** (no schema change on `assistant_messages`). Keep it in a local `const echoOf = args.echoOf ?? null` and attach it only to the outgoing WS frame: `emitMessagesChanged({operation:'upsert-single', reason:'send-message', message: {...msg, echoOf}})`. Extend SessionMessage type with `echoOf?: string | null` (wire-only, user-role only). Missing `echoOf` (old client) → treat as null, emit without it."
      - "Delete all emissions of `type:'message'` and `type:'messages'` from session-do.ts. Hard cutover. Grep after: `rg \"type: ?'messages?'\" apps/orchestrator/src/agents/` must return zero matches."
    test_cases:
      - id: "unified-event-emits"
        description: "Every broadcast from session-do.ts uses emitMessagesChanged. Audit: rg 'type: ?.messages-changed.' apps/orchestrator/src/agents/session-do.ts returns >= 16 matches; rg 'broadcastMessage\\(' returns zero matches; rg \"type: ?'message'\" returns zero matches."
        type: "audit"
      - id: "parentId-on-every-frame"
        description: "Start a fresh session and send 3 turns. Capture WS frames (chrome-devtools-axi eval: monkey-patch WebSocket to log). Every `message` or `messages[]` entry in every `messages-changed` frame includes a `parentId` field (string or null)."
        type: "integration"
      - id: "echoOf-round-trip"
        description: "Client sends {type:'sendMessage', args:[{content:'hi', echoOf:'usr-optimistic-12345'}]}. Capture the resulting `upsert-single` frame — `message.echoOf === 'usr-optimistic-12345'`."
        type: "integration"

  - id: p2
    name: "Client ingress reducer + DO branch-op full-replay emits (P1+P2 ship together)"
    tasks:
      - "In apps/orchestrator/src/features/agent-orch/use-coding-agent.ts: replace the dual `onMessage` branches at :269-283 (handling `type:'message'` and `type:'messages'`) with a single branch on `type:'messages-changed'` that dispatches to a new local function `onMessagesChanged(event: MessagesChangedEvent)`. Delete the old two branches."
      - "Implement onMessagesChanged as a switch on `event.operation`: 'full-replay' → `messagesCollection.utils.writeBatch(...writeDeletes-for-stale, ...writeInserts-for-new)` using the existing stale-detection pattern from replaceAllMessages; 'upsert-single' → existing `upsert(event.message)` (but also handle `clearOldestOptimisticRow` being retired — see B10); 'trim' → reserved for future, treat as full-replay for now."
      - "Add structured log at reducer entry: `console.log('[messages] in', {operation: event.operation, reason: event.reason, count: event.messages?.length ?? (event.message ? 1 : 0)})`."
      - "Delete `hydratedRef` (line 125), the imperative initial hydrate block (:239-257), the 500ms setTimeout retry (inside that block), and the running→idle re-hydrate block (:258-261). onConnect full-replay now covers all of this."
      - "Delete client-side `hydrateMessages` helper (:337-348) — no longer called. Callers (the two hydrate blocks) are themselves deleted."
      - "Replace the client `replaceAllMessages` helper (:165-187) with a single call site inline inside `onMessagesChanged` full-replay. Delete the helper. Use `messagesCollection.utils.writeBatch(writeDelete(staleIds), writeInsert(rows))` — import from `@tanstack/db`."
      - "Gap recovery: add a new `onMessage` branch for `type:'gap'` (BufferedChannel sentinel shape: `{type:'gap', dropped_count, from_seq, to_seq}`). Handler: call `connection.call('getMessages', [{session_hint: agentName}])` (the surviving RPC), convert result to `{type:'messages-changed', sessionId: agentName, operation:'full-replay', messages, reason:'recovery'}`, and feed it back through `onMessagesChanged`. Log `console.warn('[messages] gap recovery', {from_seq, to_seq})`."
      - "DO side: rewind/resubmit/navigateBranch — after mutating the session tree, emit `operation:'full-replay'` with `reason` = the op name and `messages = this.session.getHistory(leafId)` hydrated with parentId. Client-side `resubmitMessage` (~:455) and `navigateBranch` (~:480) stop calling `replaceAllMessages` themselves — they await the DO's full-replay frame. Client-side `rewind` (~:391) same."
    test_cases:
      - id: "single-reducer"
        description: "use-coding-agent.ts has exactly one switch on event.operation inside onMessage (no branches on 'message' or 'messages'). Audit: grep for `case 'full-replay'`, `case 'upsert-single'`, `case 'trim'`."
        type: "audit"
      - id: "no-hydrate-ladder"
        description: "hydratedRef, setTimeout(…, 500), and 'running→idle' hydrate block are all deleted. Audit: rg 'hydratedRef' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts returns zero; rg 'setTimeout.*hydrate' returns zero; rg '500' inside the hook returns zero."
        type: "audit"
      - id: "hydrateMessages-helper-deleted"
        description: "No function named `hydrateMessages` exists in use-coding-agent.ts. The RPC `getMessages` is only called from the gap-recovery path."
        type: "audit"
      - id: "writeBatch-replaces-replaceAll"
        description: "No function named `replaceAllMessages` exists in use-coding-agent.ts. writeBatch is used inline for full-replay."
        type: "audit"
      - id: "gap-recovery-roundtrip"
        description: "Inject a `{type:'gap', dropped_count: 2, from_seq: 5, to_seq: 7}` WS frame via chrome-devtools-axi eval. Assert: a getMessages RPC call fires within 100ms; the collection is fully replaced by its result; console.warn logs the gap."
        type: "integration"
      - id: "gap-recovery-rpc-failure"
        description: "Mock connection.call('getMessages', ...) to reject once. Inject a gap frame. Assert: console.error('[messages] gap recovery failed', ...) fires; exactly one retry attempt is made after ~1s; no user-visible error surfaces; collection is unchanged (stale rows remain, reconciled on next real full-replay)."
        type: "integration"
      - id: "gap-recovery-dedupe"
        description: "Inject two `gap` frames 50ms apart while the first RPC is still pending. Assert: only one getMessages RPC fires; console.warn('[messages] gap recovery already in flight, skipping') logs for the second frame; after the first RPC resolves the collection reflects its result exactly once."
        type: "integration"
      - id: "reducer-error-containment"
        description: "Mock messagesCollection.utils.writeBatch to throw once. Deliver a full-replay frame. Assert: console.error('[messages] reducer failed', ...) fires; the WS onMessage handler does not throw; the next well-formed full-replay reconciles the collection successfully."
        type: "unit"

  - id: p3
    name: "Optimistic lifecycle via createOptimisticAction + schema bump"
    tasks:
      - "In use-coding-agent.ts sendMessage (~:517-528): replace the manual `insertOptimistic` + `await connection.call` + `deleteOptimistic` dance with `createOptimisticAction({onMutate, mutationFn})`. onMutate: insert `{id: optimisticId, sessionId, role:'user', parts, createdAt, echoOf: optimisticId}` into messagesCollection; return the optimisticId. mutationFn: await `connection.call('sendMessage', [{content, echoOf: optimisticId, submitId}])`; on {ok:false} throw (triggers automatic rollback of the optimistic insert)."
      - "Delete `insertOptimistic` (:487-507), `deleteOptimistic`, and the `maxServerTurn` scan. Delete `clearOldestOptimisticRow` helper (:189-214) and its call site in onMessagesChanged 'upsert-single' — with echoOf correlation, the canonical row lands via writeBatch and the optimistic row is removed by createOptimisticAction's rollback/commit lifecycle OR by an explicit delete inside the upsert-single reducer: `if (message.role === 'user' && message.echoOf) messagesCollection.delete(message.echoOf)` before upserting."
      - "CachedMessage schema bump: in apps/orchestrator/src/db/messages-collection.ts drop `turnHint` from the schema. Bump schemaVersion from current to +1. Add `parentId?: string | null` and `echoOf?: string | null` fields."
      - "Sort key change: in apps/orchestrator/src/hooks/use-messages-collection.ts (:25-59), delete the optimistic ID regex + turnHint tiebreaker logic. Replace with `sortKey = [extractTurn(row.id), row.createdAt.getTime()]` where extractTurn pulls the integer from `usr-N` / `msg-N` / `err-N`. Optimistic rows (usr-optimistic-${ms}) still exist for the short window between onMutate and upsert-single; extractTurn returns `Number.MAX_SAFE_INTEGER` for them so they sort at the tail briefly before echoOf replacement kicks in. With echoOf landing in <100ms typical, no user-visible inversion."
      - "Document the late-echo case: add a comment block in use-coding-agent.ts (above onMessagesChanged) explaining that if the WS `upsert-single` frame arrives before mutationFn resolves, the canonical row lands first; when mutationFn later resolves, createOptimisticAction commits/reverts its optimistic insert based on RPC outcome. TanStack DB's id-keyed upsert dedupes — no race, no duplicate."
    test_cases:
      - id: "createOptimisticAction-adopted"
        description: "sendMessage uses createOptimisticAction from @tanstack/db. Audit: rg 'createOptimisticAction' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts returns >= 1 match."
        type: "audit"
      - id: "no-turnHint"
        description: "turnHint field removed from CachedMessage schema. No references in the hook or the collection. Audit: rg 'turnHint' apps/orchestrator/src/ returns zero."
        type: "audit"
      - id: "no-maxServerTurn"
        description: "maxServerTurn helper deleted. Audit: rg 'maxServerTurn' apps/orchestrator/src/ returns zero."
        type: "audit"
      - id: "no-clearOldest"
        description: "clearOldestOptimisticRow deleted. Audit: rg 'clearOldestOptimisticRow' returns zero."
        type: "audit"
      - id: "echoOf-correlation-e2e"
        description: "Send a message; observe optimistic row with id starting 'usr-optimistic-'; observe WS echo arrives with echoOf set to that id; observe collection now contains the canonical 'usr-N' row and the optimistic row is gone. No ghost rows visible in the thread."
        type: "e2e"
      - id: "optimistic-rollback-on-rpc-failure"
        description: "Mock connection.call('sendMessage', ...) to reject. Send a message. Assert: optimistic row appears momentarily then disappears. No row remains in the collection for the rejected send."
        type: "integration"
      - id: "optimistic-ws-race-late-mutation-resolve"
        description: "WS-arrives-first race regression. Setup: delay the connection.call('sendMessage', ...) resolution by 200ms so the WS upsert-single frame (with echoOf) is delivered first. Call sendMessage('hi'). Assert in order: (1) optimistic row usr-optimistic-X appears; (2) WS upsert-single frame delivered — canonical usr-N row inserted AND usr-optimistic-X deleted via echoOf path; (3) mutationFn resolves with {ok:true} — createOptimisticAction commit is a no-op because the optimistic id is already absent; (4) final messagesCollection state contains exactly one row for the send (the canonical usr-N), zero rows starting with usr-optimistic-, and no exceptions thrown during the sequence."
        type: "integration"

  - id: p4
    name: "Derived branchInfo via createLiveQueryCollection"
    tasks:
      - "Create apps/orchestrator/src/db/branch-info-collection.ts: `export const branchInfoCollection = createLiveQueryCollection({id: 'branch_info', query: (q) => q.from({m: messagesCollection}).groupBy(({m}) => m.parentId).select(...), getKey: (row) => row.parentId})`. The derived shape is `{parentId: string, siblings: Array<{id: string, role: string, createdAt: Date}>}` sorted by createdAt. Filter to parentId !== null."
      - "Create apps/orchestrator/src/hooks/use-branch-info.ts exporting `useBranchInfo(sessionId: string, leafMessageId: string | null)`. Shape returned: `Map<messageId, {current: number, total: number, siblings: string[]}>` — the same shape as today's useState<Map>. Implementation: useLiveQuery on branchInfoCollection, filter by session (cross-reference messagesCollection rows where sessionId === sessionId), build the Map from user-role siblings only."
      - "In use-coding-agent.ts: delete `branchInfo` useState (:120-122), delete `refreshBranchInfo` (:398-434), delete all call sites of `refreshBranchInfo` (after hydrate, after resubmit, after navigateBranch). Replace with `const branchInfo = useBranchInfo(agentName, currentLeafId)` at the top of the hook."
      - "In use-coding-agent.ts: delete the `getBranches` RPC helper (if any) and its call sites. The DO-side RPC endpoint at session-do.ts :1592-1599 also deleted — client no longer calls it."
      - "Update ChatThread.tsx / AgentDetailView.tsx / MessageBranch: no changes needed. The branchInfo Map shape is preserved via the hook; these components already consume the Map."
      - "Currently-visible leaf tracking: the `currentLeafId` passed to useBranchInfo is derived from the last message in the current linear path. Compute it locally in use-coding-agent.ts via `const currentLeafId = useMemo(() => cachedMessages[cachedMessages.length - 1]?.id ?? null, [cachedMessages])`. No server round-trip."
    test_cases:
      - id: "branchInfo-derived"
        description: "branchInfo useState is deleted. useBranchInfo hook exports from the new file. Audit: rg 'useState.*branchInfo' apps/orchestrator/src/ returns zero; rg 'useBranchInfo' returns >= 1 hook def + 1 call site."
        type: "audit"
      - id: "getBranches-deleted-client"
        description: "No client call to connection.call('getBranches', ...). Audit: rg \"'getBranches'\" apps/orchestrator/src/features/ returns zero."
        type: "audit"
      - id: "getBranches-deleted-server"
        description: "The @callable getBranches method is removed from session-do.ts. Audit: rg '@callable\\(\\)\\s*async getBranches' returns zero."
        type: "audit"
      - id: "branch-nav-still-works"
        description: "Create a branch via resubmit. Navigate via prev/next arrows. Counter displays correctly (e.g., 1/2 → 2/2). Messages update on navigate."
        type: "e2e"
      - id: "refresh-no-rpc"
        description: "Network panel on a session with 3 branches: no outgoing getBranches RPCs fired during hydrate or after branch navigation. All branch data derived from messagesCollection."
        type: "integration"

  - id: p5
    name: "Cleanup: events + shadow mirror + tests"
    tasks:
      - "Delete `events` useState (:119 area), its reset block on agentName change, and all setEvents calls (line ~136, :288-291 area). Remove `events` from the hook return object (line ~605)."
      - "Delete the agentSessionsCollection shadow-mirror writes at :223-236 of use-coding-agent.ts. Audit-verify that all sidebar / tab-bar / session-card consumers of agentSessionsCollection status fields now use `useSessionLiveState(sessionId)` per spec #12 B8. If any consumer still reads `status` from agentSessionsCollection for live updates (not for history sort), migrate it."
      - "Update apps/orchestrator/src/features/agent-orch/use-coding-agent.test.ts: remove assertions on `result.current.events[0]`. Replace with assertions that `upsertSessionLiveState` was called with the matching payload (mirrors spec #12 P2 test-migration pattern)."
      - "Audit: run the grep suite from the Verification Plan's VP6 — every pattern should return zero matches."
      - "CLAUDE.md update: expand the 'Client data flow' section to describe the messages path: 'messagesCollection is the render source; the DO publishes a unified messages-changed channel; onConnect sends operation:full-replay, runtime events send operation:upsert-single with echoOf on user echoes; rewind/resubmit/navigateBranch trigger server-side full-replay; branchInfo is a createLiveQueryCollection derived from parentId.'"
    test_cases:
      - id: "events-deleted"
        description: "No `events` state in use-coding-agent.ts. rg 'events.*useState' inside the file returns zero."
        type: "audit"
      - id: "shadow-mirror-deleted"
        description: "No writeUpdate calls on agentSessionsCollection from onStateUpdate. rg 'sessionsCollection.utils.writeUpdate' apps/orchestrator/src/features/agent-orch/ returns zero."
        type: "audit"
      - id: "hook-loc-reduction"
        description: "use-coding-agent.ts is <= 450 LOC (down from ~626 post-#12). Verified by wc -l."
        type: "audit"
      - id: "tests-pass"
        description: "pnpm --filter @duraclaw/orchestrator test passes with zero failures. No skipped tests related to optimistic/branchInfo/events."
        type: "unit"
---

## Overview

Follow-up to #12 (PR #13). Spec #12 unified session live state on TanStack DB but deliberately excluded the messages path. This spec retires the eight manual-reconciliation sites that remain in `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` — hydrate ladder, optimistic protocol, `turnHint` fabrication, dual `message`/`messages` transport, client `replaceAllMessages`, `branchInfo` `useState<Map>`, `agentSessionsCollection` shadow mirror, and the `events` debug log — by introducing a unified `messages-changed` DO channel, adopting TanStack DB's native `createOptimisticAction` + `writeBatch` + `createLiveQueryCollection` primitives, and making the server the echo-correlation authority via a new `echoOf` field on user sends.

## Feature Behaviors

### B1: Unified `messages-changed` DO channel

**Core:**
- **ID:** unified-messages-changed-channel
- **Trigger:** Every DO code path that previously called `broadcastMessage(msg)` or emitted `{type:'messages', messages}`; also every rewind / resubmit / navigateBranch mutation.
- **Expected:** A single event shape — `{type:'messages-changed', sessionId, operation, messages? | message?, reason}` — flows to all browser clients. Old `type:'message'` and `type:'messages'` frames are gone.
- **Verify:** `rg "type: ?'messages?'" apps/orchestrator/src/` returns 0 matches and `rg "'messages-changed'" apps/orchestrator/src/agents/` returns ≥16 matches.

**Source:** `apps/orchestrator/src/agents/session-do.ts` (16 single + 2 bulk emit sites catalogued in research R3).

#### API Layer
- New type `MessagesChangedEvent` in `apps/orchestrator/src/agents/messages-channel.ts`.
- Discriminant `operation`: `'full-replay' | 'upsert-single' | 'trim'`.
- `reason` is a closed string union for debuggability — see P1 task list for full enum.
- Emitted over the browser ↔ DO WS only (gateway WS filtered out, same as today via `broadcastToClients`).

### B2: `parentId` on every message payload (hydrate-at-read)

**Core:**
- **ID:** parent-id-hydrate-at-read
- **Trigger:** Any DO code path that reads `SessionMessage` for broadcast or RPC return (`this.session.getHistory()`, `this.session.getBranches()`, `broadcastMessage` callers).
- **Expected:** Every outgoing `SessionMessage` has `parentId: string | null` populated. Source: the Agents SDK SQLite `assistant_messages.parent_id` column (persisted, indexed).
- **Verify:** WS frame inspection in VP1 — every message row has a `parentId` key.

**Source:** Agents SDK persists `parent_id` as a TEXT column with index `idx_assistant_msg_parent` (confirmed by P1-phase spike, `node_modules/agents/dist/experimental/memory/session/index.js`). The DO's JSON serialiser currently drops it — this behavior reinstates it.

**Error handling:**
- Use `.first()` / `.toArray()` (NOT `.one()` which throws on zero rows) when reading `parent_id`. Missing row → `parentId = null`. Do not throw — a missing row on the read path should never block emission.
- Wrap the bulk hydrate in a try/catch at the emit boundary; on SQL failure (e.g., schema mismatch during a rolling deploy), log `console.error('[sessionDO] parentId hydrate failed', err)` and emit the SessionMessage WITHOUT `parentId` populated. Client reducer tolerates a missing `parentId` key (treats as null).

#### Data Layer
- No new storage. Existing column read at message-serialisation time.
- `SessionMessage` type in `packages/shared-types/src/index.ts` gains `parentId?: string | null`.
- `CachedMessage` in `apps/orchestrator/src/db/messages-collection.ts` gains `parentId?: string | null` (schema bump — see B11).

### B3: Server-anchored `echoOf` correlation for user echoes

**Core:**
- **ID:** echoOf-user-correlation
- **Trigger:** Client calls `connection.call('sendMessage', [{content, echoOf: optimisticId, submitId?}])`.
- **Expected:** DO attaches `echoOf` to the `operation:'upsert-single', reason:'send-message'` WS frame so `message.echoOf === optimisticId`. Client uses this id to delete the optimistic row atomically in the `upsert-single` reducer. **Persistence model — transient on the wire, not on disk:** `echoOf` is added to the outgoing SessionMessage ONLY on the live send-message emit path. It is NOT persisted into the Agents SDK Session rows (no schema change on `assistant_messages`). A subsequent gap-recovery `getMessages` response will NOT carry `echoOf` on historical rows — this is intentional, because the optimistic row has already been reconciled (or replaced by a prior `upsert-single`) by the time recovery runs. The client reducer's `if (msg.echoOf) delete(msg.echoOf)` is a no-op on recovery frames.
- **Verify:** Integration test VP3 — client sends with known optimisticId; WS frame arrives with matching `echoOf`.

**Source:** `apps/orchestrator/src/agents/session-do.ts:~1354` (sendMessage handler).

#### API Layer
- `sendMessage` RPC arg shape gains `echoOf: string` (required for user sends from the new client code; absent tolerated for back-compat during in-flight deploys — DO treats as null).
- Only user-role emits carry `echoOf`. Assistant / tool / partial events don't — extending later is additive.

### B4: DO emits `full-replay` on rewind / resubmit / navigateBranch

**Core:**
- **ID:** branch-ops-emit-full-replay
- **Trigger:** Client calls `rewind(turnIndex)`, `resubmitMessage(messageId, newContent)`, or `navigateBranch(messageId, direction)` RPC.
- **Expected:** After the DO mutates the session tree (or selects a new leaf), it emits `{operation:'full-replay', messages: this.session.getHistory(leafId) (hydrated with parentId), reason: <op-name>}`. Client does NOT call `getMessages(leafId)` + `replaceAllMessages` anymore — it awaits the broadcast.
- **Verify:** VP6 — invoke each op via the UI; assert exactly one `full-replay` frame per op arrives on the WS; assert `getMessages` is not called in response.

**Source:** `session-do.ts` — rewind, resubmitMessage, navigateBranch RPC handlers.

### B5: Structured logs at emit and receive boundaries

**Core:**
- **ID:** messages-channel-logs
- **Trigger:** Every DO emit + every client receive on the unified channel.
- **Expected:** DO logs `console.log('[sessionDO] messages-changed', {operation, reason, count, sessionId})`. Client logs `console.log('[messages] in', {operation, reason, count})`. Gap recovery logs `console.warn('[messages] gap recovery', {from_seq, to_seq})`.
- **Verify:** Capture console output during the VP6 master E2E flow; assert log lines with expected shape appear for each emit / receive / gap-recovery boundary traversed.

### B6: Client `onMessagesChanged` reducer (single switch)

**Core:**
- **ID:** messages-changed-reducer
- **Trigger:** WS frame with `type:'messages-changed'` received by the `useAgent` `onMessage` handler.
- **Expected:** A single `switch (event.operation)` block dispatches: `full-replay` → `writeBatch(writeDelete(stale), writeInsert(new))`; `upsert-single` → delete-by-echoOf (if present) then upsert; `trim` → **reserved for future use; until a DO code path emits it, the reducer must no-op and log `console.warn('[messages] trim not implemented, ignoring', event)`**. (An earlier draft said "treat as full-replay" — that guidance is superseded: `trim` without a `messages` payload has nothing to replay, so no-op-with-warn is the correct interim behavior. A future spec that introduces a `trim` emitter will also update the reducer and the log.)
- **Verify:** VP2 — unit test on the reducer with 3 synthetic events.

**Source:** `use-coding-agent.ts:269-283` (replace the dual `message`/`messages` branches).

**Error handling:**
- Wrap the entire `onMessagesChanged` body in a try/catch. On any failure (writeBatch throw, OPFS write error, malformed frame), log `console.error('[messages] reducer failed', {operation, reason, err})` and continue — do NOT throw out of `onMessage` (uncaught there will tear down the WS subscription). The next `onConnect` / gap-recovery full-replay will re-establish consistency.
- `writeBatch` failures on OPFS error: collection falls back to in-memory state for the session; a subsequent page reload will re-hydrate from the DO. Acceptable degraded mode.
- Unknown `operation` (forward-compat) → log `console.warn('[messages] unknown operation', event.operation)` and no-op. Do not throw.

### B7: Retire hydrate ladder + setTimeout retry + running→idle re-hydrate

**Core:**
- **ID:** retire-hydrate-ladder
- **Trigger:** First `onStateUpdate` in the hook / session status transition.
- **Expected:** `hydratedRef`, the imperative `hydrateMessages(connection)` call, the `setTimeout(..., 500)` retry, and the `running → idle` re-hydrate block are all deleted. Hydration comes from the DO's onConnect `operation:'full-replay'` frame and gap recovery.
- **Verify:** Grep-audit: `rg 'hydratedRef|setTimeout.*500|running.*idle.*hydrate' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` returns 0 matches.

**Source:** `use-coding-agent.ts:239-261` + `:258-261`.

### B8: `writeBatch` replaces `replaceAllMessages`; client `hydrateMessages` helper deleted

**Core:**
- **ID:** writeBatch-replace-helpers
- **Trigger:** `onMessagesChanged` receives `operation:'full-replay'`.
- **Expected:** Use `messagesCollection.utils.writeBatch(writeDelete(staleIds), writeInsert(newRows))` inline. The `replaceAllMessages` helper (:165-187) is deleted. The client-side `hydrateMessages` helper (:337-348) is deleted — its only callers were the retired hydrate ladder.
- **Verify:** `rg 'replaceAllMessages|function hydrateMessages' apps/orchestrator/src/features/agent-orch/` returns 0 matches.

### B9: Gap recovery via `getMessages` RPC

**Core:**
- **ID:** gap-recovery-via-rpc
- **Trigger:** WS delivers a `{type:'gap', dropped_count, from_seq, to_seq}` sentinel from the BufferedChannel.
- **Expected:** Client calls `connection.call('getMessages', [{session_hint: agentName}])`, wraps the result as `{type:'messages-changed', operation:'full-replay', messages, reason:'recovery'}`, and routes through `onMessagesChanged`. Emits a `console.warn` with the gap range.
- **Verify:** VP4 — inject a synthetic `gap` frame via `chrome-devtools-axi eval`; assert RPC fires and collection refreshes.

**Source:** `packages/shared-transport/src/buffered-channel.ts` (gap shape — already emitted today per CLAUDE.md "emits a single `{type:'gap',dropped_count,from_seq,to_seq}` sentinel on next replay"; NO changes needed to `BufferedChannel` or `DialBackClient`, this spec only adds the client-side handler) + new branch in `use-coding-agent.ts` `onMessage`.

**Error handling and guard lifecycle:**
- **Guard:** maintain a `gapRecoveryInFlight` ref in the hook (`useRef<boolean>(false)`). Set `true` at the start of recovery (before the initial RPC call), set `false` only in `finally` after the final attempt resolves or rejects. The guard remains `true` across the 1s retry backoff — a new gap frame arriving mid-recovery is dropped (see dedupe test VP4c).
- **Retry:** on initial `connection.call('getMessages', ...)` rejection, log `console.error('[messages] gap recovery failed', {from_seq, to_seq, attempt: 1, err})`, `await` a 1s delay (`new Promise(r => setTimeout(r, 1000))`), and retry once. On second rejection log `console.error(..., {attempt: 2, err})` and give up — the next real WS frame or reconnect onConnect will drive a fresh `full-replay`.
- **Dropped-gap recovery after give-up:** because the guard is in the same `finally`, it releases whether the retry succeeded or failed. A subsequent gap frame after give-up is a fresh cycle, not a duplicate — it will attempt its own RPC+retry.
- **No user-visible error surface.** Gap recovery is a best-effort resilience mechanism; failed recovery degrades silently (stale rows persist until the next full-replay reconciles).
- **Unrelated `full-replay` during recovery:** the reducer's synchronous `writeBatch` completes before the gap handler's async `connection.call` resolves — no interleaving hazard. The gap's subsequent `full-replay` naturally wins as the latest state.

### B10: `createOptimisticAction` replaces manual optimistic lifecycle

**Core:**
- **ID:** create-optimistic-action
- **Trigger:** User calls `sendMessage(content)`.
- **Expected:** `createOptimisticAction({onMutate, mutationFn})` is the new send primitive. `onMutate` inserts `{id: optimisticId, sessionId, role:'user', parts, createdAt, echoOf: optimisticId}` into `messagesCollection`. `mutationFn` awaits `connection.call('sendMessage', [{content, echoOf: optimisticId}])` and throws on `{ok:false}` — automatic rollback. `insertOptimistic`, `deleteOptimistic`, `clearOldestOptimisticRow` all deleted.
- **Verify:** VP3 (happy path) + unit test VP7 (RPC rejection → row gone).

**Source:** `use-coding-agent.ts:189-214, 487-528`.

#### Data Layer
- `echoOf?: string | null` added to `CachedMessage` schema (B11 bump).
- No server-side state change beyond B3.

### B11: Retire `turnHint` / `maxServerTurn`; CachedMessage schema bump; sort becomes `[turn, createdAt]`

**Core:**
- **ID:** retire-turnHint-schema-bump
- **Trigger:** N/A (structural change).
- **Expected:** `turnHint` column dropped from `CachedMessage`. `maxServerTurn` helper and the optimistic sort-key tiebreaker deleted. Sort key in `useMessagesCollection` becomes `[extractTurn(row.id), row.createdAt.getTime()]`. Schema version bumped; OPFS drops stale rows on first load post-deploy.
- **Verify:** `rg 'turnHint|maxServerTurn' apps/orchestrator/src/` returns 0 matches. Unit tests on `extractTurn` covering every known prefix (see table below).

**`extractTurn` full contract:**

| Input id pattern                  | Return value                   | Rationale                                                     |
|-----------------------------------|--------------------------------|---------------------------------------------------------------|
| `usr-N` (N integer ≥ 0)           | `N`                            | Canonical user message; turn index comes from the DO.         |
| `msg-N`                           | `N`                            | Canonical assistant message; same namespace as `usr-N`.       |
| `err-N`                           | `N`                            | Error rows are turn-pinned; sort alongside their peers.       |
| `tool-N` (if it appears)          | `N`                            | Tool-result rows emitted alongside assistant turns.           |
| `usr-optimistic-<ms>` (timestamp) | `Number.MAX_SAFE_INTEGER`      | Optimistic rows sort at the tail until echoOf replacement.    |
| Any other / malformed id          | `Number.MAX_SAFE_INTEGER`      | Safe fallback — unknown rows land at the bottom, never NaN.   |

Implementation pattern (no regex backtracking, tolerant of extra dashes):
```ts
export function extractTurn(id: string): number {
  if (id.startsWith('usr-optimistic-')) return Number.MAX_SAFE_INTEGER
  const m = /^(?:usr|msg|err|tool)-(\d+)$/.exec(id)
  if (!m) return Number.MAX_SAFE_INTEGER
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}
```

Required unit tests:
- `extractTurn('usr-5') === 5`
- `extractTurn('msg-5') === 5`
- `extractTurn('err-3') === 3`
- `extractTurn('tool-7') === 7`
- `extractTurn('usr-optimistic-1700000000000') === Number.MAX_SAFE_INTEGER`
- `extractTurn('unknown-id') === Number.MAX_SAFE_INTEGER`
- `extractTurn('') === Number.MAX_SAFE_INTEGER`

**Source:** `apps/orchestrator/src/db/messages-collection.ts`, `apps/orchestrator/src/hooks/use-messages-collection.ts:25-59`.

#### Data Layer
- `CachedMessage` schema v(N+1): adds `parentId?: string | null`, `echoOf?: string | null`; removes `turnHint`.
- First load post-deploy shows brief empty state while DO's onConnect `full-replay` repopulates.

### B12: Derived `branchInfo` via `createLiveQueryCollection`

**Core:**
- **ID:** derived-branch-info
- **Trigger:** Any change in `messagesCollection` that affects `parentId` groupings.
- **Expected:** New hook `useBranchInfo(sessionId, leafMessageId)` returns the existing `Map<messageId, {current, total, siblings[]}>` shape. Preferred implementation: new file `apps/orchestrator/src/db/branch-info-collection.ts` exposes a `createLiveQueryCollection` keyed on `parentId`, grouping user-role siblings, and `useBranchInfo` pulls from it via `useLiveQuery`. Fallback implementation (if `createLiveQueryCollection` `groupBy` shape doesn't match the hint — verified by spike in P4): a single `useLiveQuery` over `messagesCollection` with client-side grouping inside the hook's `useMemo`. Either way, `useState<Map>` + `refreshBranchInfo` (:120-122, :398-434) + client-side `getBranches` call sites + DO-side `getBranches` `@callable` all deleted.
- **Verify:** VP5 — start a session, resubmit once, observe counter updates from 1/1 → 1/2 → 2/2 as the user navigates, with zero outgoing `getBranches` RPCs in the network panel.

**Source:** `use-coding-agent.ts:120-122, 398-434`; `session-do.ts:1592-1599`.

### B13: Delete `events` state + `agentSessionsCollection` shadow mirror

**Core:**
- **ID:** delete-events-and-shadow-mirror
- **Trigger:** N/A (cleanup).
- **Expected:** `events` `useState` and its setters + reset + return-object entry are all gone. `agentSessionsCollection.utils.writeUpdate({status, numTurns, ...})` calls inside `onStateUpdate` (lines 226-236) are gone. `use-coding-agent.test.ts` updated to assert on `upsertSessionLiveState` instead of `events`.
- **Verify:** `rg 'events.*useState|events:\\s*\\[|setEvents' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` returns 0; `rg 'sessionsCollection\\.utils\\.writeUpdate' apps/orchestrator/src/features/agent-orch/` returns 0.

**Source:** `use-coding-agent.ts:119, 136, 226-236, 288-291, 605`.

## Non-Goals

- **No multi-tab optimistic-row cross-fan.** If Tab A sends and Tab B is open on the same session, Tab B still sees only the canonical row after the server echo (same as today). Cross-tab coordination via BroadcastChannel / SharedWorker is a separate future issue.
- **No delivery-tick UI.** Virtual props (`$synced` / `$origin`) are not surfaced in the message renderer. "Sending → sent" visual indicator deferred to a dedicated UX pass.
- **No metrics infrastructure.** Structured `console.log` only. Counter / histogram / alert plumbing is out of scope; Duraclaw has no metrics pipeline yet.
- **No feature flag / gradual rollout.** Hard cutover — matches PR #13 precedent. Old `type:'message'` / `type:'messages'` frames deleted in the same PR as the new reducer lands. **P1 and P2 MUST ship in a single deploy** (single PR, single merge to `main`) — shipping P1 alone makes the DO emit frames the old client can't parse; shipping P2 alone makes the new client ignore the only frames the old DO emits. An intermediate deploy is a broken state. P3/P4/P5 can ship independently after the P1+P2 cutover.
- **No deletion of the `getMessages` RPC.** Despite the broader RPC-deletion posture (B12 retires `getBranches`), `getMessages` is the surviving gap-recovery mechanism (B9) and MUST be preserved on both client and DO. Any future cleanup pass should explicitly exclude it.
- **No OPFS schema migration tooling.** Schema version bump drops stale rows automatically. Brief empty-state flicker on first load post-deploy is acceptable for an ephemeral cache.
- **No `echoOf` on assistant / tool / partial events.** User echoes only. Extending later is additive and does not require a protocol migration.
- **No Electric / PowerSync / Trailbase sync adapter.** DO-over-WS stays hand-wired; direct collection writes from `onMessage` remain idiomatic.
- **No changes to `agentSessionsCollection` itself** — just the shadow-mirror write path. The QueryCollection fetching `GET /api/sessions` stays for sidebar history, tab-bar metadata, project→tab lookup.

## Implementation Phases

See frontmatter for the full 5-phase breakdown. Summary:

1. **P1 — DO protocol unification.** Emit helper + event type + parentId hydrate-at-read + echoOf acceptance + deletion of old frame types. **NOTE:** The DO-side emit changes for rewind / resubmit / navigateBranch (B4) are deferred to P2 because they are tightly coupled to client-side replacement of `replaceAllMessages` — shipping them in P1 without the P2 client reducer would break branch-nav UX. All other DO-side emit changes land in P1.
2. **P2 — Client ingress reducer + DO branch-op emits.** Single `onMessagesChanged` switch + retire hydrate ladder + `writeBatch` replaces `replaceAllMessages` + gap recovery + **DO-side `full-replay` emit for rewind / resubmit / navigateBranch (B4)**. Note: this phase touches both `session-do.ts` (B4 handlers) and `use-coding-agent.ts` (reducer, hydrate-ladder deletion, gap recovery) — see the P1 phase note for the coupling rationale.
3. **P3 — Optimistic lifecycle.** `createOptimisticAction` + `echoOf` correlation + retire `turnHint` / `maxServerTurn` / `clearOldestOptimisticRow` + schema bump.
4. **P4 — Derived branchInfo.** `createLiveQueryCollection` + `useBranchInfo` hook + delete `useState<Map>` + delete `getBranches` RPC both sides.
5. **P5 — Cleanup.** Delete `events` state + delete shadow mirror + update tests + CLAUDE.md update.

**Atomicity constraint:** P1 and P2 ship together in a single PR / single deploy (see Non-Goals). P3, P4, P5 may ship as separate PRs after the cutover.

Estimated total: ~13 B-IDs, 5 phases, 12–20 hours, net −200 to −300 LOC in `use-coding-agent.ts` (target <450 LOC).

## Verification Plan

Run literal commands / UI actions in order. Evidence required for each step.

### VP1 — DO emit-shape audit

1. Check unified event shape is the only one in the DO:
   ```
   rg "type: ?'messages-changed'" apps/orchestrator/src/agents/session-do.ts | wc -l
   ```
   **Expected:** ≥ 16.
2. Check old frames are gone:
   ```
   rg "type: ?'message'" apps/orchestrator/src/agents/session-do.ts
   rg "type: ?'messages'" apps/orchestrator/src/agents/session-do.ts
   ```
   **Expected:** both return 0 matches.
3. Check parentId shipping: start local stack (`scripts/verify/portless-up.sh`), open a session, send "hi", then:
   ```
   chrome-devtools-axi eval 'performance.getEntriesByType("resource").filter(e => e.name.includes("/agents/")).length'
   ```
   Inject a WS snoop:
   ```
   chrome-devtools-axi eval 'window.__wsFrames = []; const orig = WebSocket.prototype.send; WebSocket.prototype.send = function(d){ window.__wsFrames.push(d); return orig.call(this, d); }; const onorig = WebSocket.prototype.onmessage; Object.defineProperty(WebSocket.prototype, "onmessage", { set(fn) { this._onmsg = fn; this.addEventListener("message", e => { try{window.__wsFrames.push(e.data)}catch{} ; fn?.(e); }) }, get() { return this._onmsg }});'
   ```
   Send another message, then:
   ```
   chrome-devtools-axi eval 'window.__wsFrames.filter(f => typeof f === "string" && f.includes("messages-changed")).map(JSON.parse).every(e => (e.messages ?? [e.message]).every(m => "parentId" in m))'
   ```
   **Expected:** `true`.

### VP2 — Client reducer unit test

Write `apps/orchestrator/src/features/agent-orch/use-coding-agent.test.ts` cases covering:
- `operation:'full-replay'` with 3 messages → `messagesCollection` contains exactly those 3.
- `operation:'upsert-single'` with `echoOf` → optimistic row with id === echoOf is gone, canonical row present.
- `operation:'upsert-single'` without `echoOf` → canonical row upserted, no deletes.

Run:
```
pnpm --filter @duraclaw/orchestrator test -- use-coding-agent
```
**Expected:** All three cases pass.

### VP3 — `echoOf` correlation E2E

Using dual-browser helpers:
```
scripts/verify/dev-up.sh
scripts/verify/axi-dual-login.sh
scripts/verify/axi-a open http://127.0.0.1:$VERIFY_ORCH_PORT
```
Create/enter a session. Install the WS snoop (VP1 step 3). Send "hello echoOf test". Then:
```
scripts/verify/axi-a eval 'window.__wsFrames.filter(f => typeof f === "string" && f.includes("send-message")).map(JSON.parse).map(e => ({echoOf: e.message?.echoOf, id: e.message?.id}))'
```
**Expected:** One row with `echoOf` matching a prior optimistic-id string AND `id` starting with `usr-` (not `usr-optimistic-`).

### VP4 — Gap recovery (happy path + failure modes)

**VP4a — Happy path.** With a session open, dispatch a synthetic gap event to the `onMessage` hook via the agent's test harness (or a direct `chrome-devtools-axi eval` injecting into `window.__agentOnMessage?.({type:'gap',dropped_count:2,from_seq:5,to_seq:7})`). Assert:
- `console.warn` line `[messages] gap recovery` visible in devtools.
- A subsequent `getMessages` RPC fires (network panel).
- The `messagesCollection` is fully repopulated (visible messages match the DO's history).

**VP4b — RPC failure + retry.** In a vitest integration test, mock `connection.call('getMessages', ...)` to reject once with `new Error('network')`. Dispatch a gap frame. Assert:
- `console.error('[messages] gap recovery failed', ...)` logs exactly once.
- Exactly one retry attempt fires ~1s later.
- No user-visible error surfaces (no toast, no thrown error out of `onMessage`).

**VP4c — Dedupe under rapid gaps.** Dispatch two `gap` frames 50ms apart while the first `getMessages` call is still pending (mock `connection.call` to resolve after 200ms). Assert:
- Only one `getMessages` RPC fires.
- `console.warn('[messages] gap recovery already in flight, skipping')` logs for the second frame.
- After the first RPC resolves, the collection reflects its result exactly once (no double-write).

**Expected:** VP4a observable in the UI; VP4b and VP4c passing as vitest integration tests (`pnpm --filter @duraclaw/orchestrator test -- use-coding-agent`).

### VP5 — Branch derivation

With a session carrying 2 turns, resubmit the first user message with new content. Observe:
- Branch counter under the resubmitted user message shows "1/2" on the original, "2/2" on the new.
- Network panel: zero outgoing `getBranches` RPCs during the flow.
- `chrome-devtools-axi snapshot` shows both chevron arrows enabled on the branch position indicator.

**Expected:** All three visible.

### VP6 — Rewind / resubmit / navigate round-trip (single-flow confidence test)

Master E2E. Run against local stack:
```
scripts/verify/dev-up.sh
scripts/verify/axi-login a
scripts/verify/axi-a open http://127.0.0.1:$VERIFY_ORCH_PORT
```
1. Log in, create a new session in a test project.
2. Send message "hi there".
3. Wait for assistant reply.
4. Send message "now list files".
5. Wait for assistant reply (and tool uses).
6. Rewind to turn 0 via the rewind UI.
7. Observe: messagesCollection shrinks to just the first user + first assistant turn.
8. Resubmit the first user message with text "different prompt".
9. Wait for assistant reply.
10. Click branch navigation prev arrow on the new user message — should jump back to the original branch.
11. Reload the page (`chrome-devtools-axi eval 'location.reload()'`).
12. Observe: the thread reloads with the current leaf's messages intact; optimistic rows do not reappear.

**Expected:** All 12 steps succeed without console errors. The capstone confidence test.

### VP7 — Optimistic rollback on RPC failure

Unit test in `use-coding-agent.test.ts`: mock `connection.call('sendMessage', ...)` to reject with `{ok:false, error:'boom'}`. Call `sendMessage('test')`. Assert:
- Optimistic row appears in `messagesCollection` momentarily.
- After the rejection, the optimistic row is gone from the collection.
- `sendMessage`'s return value is `{ok:false, error:'boom'}`.

Run:
```
pnpm --filter @duraclaw/orchestrator test -- use-coding-agent.test
```
**Expected:** Pass.

### VP8 — Schema-bump OPFS drop + no-dead-code audit

1. Bump schema version in `messages-collection.ts` (by B11 tasks).
2. Reload the browser post-deploy. Open DevTools → Application → Storage → OPFS.
3. Observe: previous-version rows are dropped; collection briefly empty; onConnect full-replay repopulates.
4. Run the grep audit suite:
   ```
   rg 'turnHint|maxServerTurn|clearOldestOptimisticRow|insertOptimistic|replaceAllMessages|hydratedRef' apps/orchestrator/src/ | grep -v '\.test\.' | wc -l
   ```
   **Expected:** 0.
5. LOC check:
   ```
   wc -l apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
   ```
   **Expected:** ≤ 450.

## Implementation Hints

### Key Imports

```ts
// New files introduce these primitives:
import {
  createCollection,
  localOnlyCollectionOptions,
  createLiveQueryCollection,
  createOptimisticAction,
  writeBatch,
  writeInsert,
  writeDelete,
} from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'

// Existing codebase pattern for OPFS-backed collection setup:
import { dbReady } from '~/db/db-instance'
import { persistedCollectionOptions } from '~/db/persistence'

// Event type lives alongside session-do:
import type { MessagesChangedEvent } from '~/agents/messages-channel'

// Shared types update:
import type { SessionMessage } from '@duraclaw/shared-types'  // now carries parentId, echoOf
```

### Code Patterns

**1. DO emit helper (P1):**
```ts
// apps/orchestrator/src/agents/session-do.ts
private emitMessagesChanged(event: MessagesChangedEvent) {
  const count = event.messages?.length ?? (event.message ? 1 : 0)
  console.log('[sessionDO] messages-changed', {
    operation: event.operation,
    reason: event.reason,
    count,
    sessionId: event.sessionId,
  })
  this.broadcastToClients(JSON.stringify(event))
}

// Replace every broadcastMessage(msg) call:
// OLD:
this.broadcastToClients(JSON.stringify({ type: 'message', message: enriched }))
// NEW:
this.emitMessagesChanged({
  type: 'messages-changed',
  sessionId: this.state.session_id,
  operation: 'upsert-single',
  message: this.hydrateWithParentId(enriched),
  reason: 'partial-assistant',
})
```

**2. parentId hydrate-at-read (P1):**
```ts
// apps/orchestrator/src/agents/session-do.ts
// Single-row variant — uses .toArray()[0] (NOT .one(), which throws on 0 rows).
private hydrateWithParentId(msg: SessionMessage): SessionMessage {
  try {
    const rows = this.ctx.storage.sql
      .exec<{ parent_id: string | null }>(
        'SELECT parent_id FROM assistant_messages WHERE id = ? LIMIT 1',
        msg.id,
      )
      .toArray()
    const parentId = rows[0]?.parent_id ?? null
    return { ...msg, parentId }
  } catch (err) {
    console.error('[sessionDO] parentId hydrate failed', { id: msg.id, err })
    return { ...msg, parentId: null }
  }
}

// Bulk variant — same tolerance, wrapped once at the caller boundary.
private hydrateHistoryWithParentIds(msgs: SessionMessage[]): SessionMessage[] {
  if (msgs.length === 0) return msgs
  try {
    const ids = msgs.map(m => m.id)
    const rows = this.ctx.storage.sql
      .exec<{ id: string; parent_id: string | null }>(
        `SELECT id, parent_id FROM assistant_messages WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
      .toArray()
    const parentIdMap = new Map(rows.map(r => [r.id, r.parent_id]))
    return msgs.map(m => ({ ...m, parentId: parentIdMap.get(m.id) ?? null }))
  } catch (err) {
    console.error('[sessionDO] bulk parentId hydrate failed', { count: msgs.length, err })
    return msgs.map(m => ({ ...m, parentId: null }))
  }
}
```

**3. Client reducer (P2):**
```ts
// apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
function onMessagesChanged(event: MessagesChangedEvent) {
  console.log('[messages] in', {
    operation: event.operation,
    reason: event.reason,
    count: event.messages?.length ?? (event.message ? 1 : 0),
  })
  // Top-level try/catch keeps onMessage alive on any reducer failure —
  // the next full-replay reconciles and the WS subscription stays intact.
  try {
    switch (event.operation) {
      case 'full-replay': {
        const newIds = new Set(event.messages!.map(m => m.id))
        const staleIds: string[] = []
        for (const [id, row] of messagesCollection as Iterable<[string, CachedMessage]>) {
          if (row.sessionId === agentName && !newIds.has(id)) staleIds.push(id)
        }
        messagesCollection.utils.writeBatch(
          ...staleIds.map(id => writeDelete(id)),
          ...event.messages!.map(m => writeInsert(toRow(m, agentName))),
        )
        return
      }
      case 'upsert-single': {
        const msg = event.message!
        if (msg.role === 'user' && msg.echoOf) {
          // Atomic optimistic replacement. Nested try/catch — echoOf
          // may reference a row that was never inserted (e.g., recovery
          // frame after a reload); swallowing keeps upsert on the fast path.
          try { messagesCollection.delete(msg.echoOf) } catch {}
        }
        upsert(msg)
        return
      }
      case 'trim':
        // Reserved for future per-range trim. No emitter exists today;
        // log and no-op so a premature emitter is visible without
        // silently corrupting state.
        console.warn('[messages] trim not implemented, ignoring', event)
        return
      default: {
        // Forward-compat: unknown operation from a newer DO.
        const unknownOp = (event as { operation?: string }).operation
        console.warn('[messages] unknown operation', unknownOp)
        return
      }
    }
  } catch (err) {
    console.error('[messages] reducer failed', {
      operation: event.operation,
      reason: event.reason,
      err,
    })
  }
}
```

**4. createOptimisticAction (P3):**
```ts
// apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
const sendMessage = useMemo(() => createOptimisticAction<
  { content: string | ContentBlock[]; submitId?: string },
  { ok: boolean; error?: string }
>({
  onMutate: ({ content }) => {
    const optimisticId = `usr-optimistic-${Date.now()}`
    messagesCollection.insert({
      id: optimisticId,
      sessionId: agentName,
      role: 'user',
      parts: contentToParts(content),
      createdAt: new Date(),
      echoOf: optimisticId,
      parentId: null,  // server will set on canonical row
    })
    return { optimisticId }
  },
  mutationFn: async ({ content, submitId }, { optimisticId }) => {
    const result = await connection.call('sendMessage', [
      { content, echoOf: optimisticId, submitId },
    ])
    if (!result.ok) throw new Error(result.error ?? 'Send failed')  // auto-rollback
    return result
  },
}), [connection, agentName])
```

**5. Derived branchInfo (P4):**
```ts
// apps/orchestrator/src/db/branch-info-collection.ts
import { createLiveQueryCollection } from '@tanstack/db'
import { messagesCollection } from './messages-collection'

export const branchInfoCollection = createLiveQueryCollection({
  id: 'branch_info',
  query: (q) =>
    q.from({ m: messagesCollection })
      .where(({ m }) => m.parentId !== null && m.role === 'user')
      .groupBy(({ m }) => m.parentId),
  getKey: (group) => group.parentId,
})

// apps/orchestrator/src/hooks/use-branch-info.ts
export function useBranchInfo(sessionId: string, currentLeafId: string | null) {
  const { data } = useLiveQuery((q) => q.from({ b: branchInfoCollection }))
  return useMemo(() => {
    const map = new Map<string, { current: number; total: number; siblings: string[] }>()
    for (const group of data ?? []) {
      const siblingsInSession = group.siblings
        .filter(s => s.sessionId === sessionId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      if (siblingsInSession.length < 2) continue
      for (const [idx, sib] of siblingsInSession.entries()) {
        map.set(sib.id, {
          current: idx + 1,
          total: siblingsInSession.length,
          siblings: siblingsInSession.map(s => s.id),
        })
      }
    }
    return map
  }, [data, sessionId])
}
```

### Gotchas

- **`createOptimisticAction` + WS race.** If the `upsert-single` frame arrives before `mutationFn` resolves, the canonical row lands first via `onMessagesChanged`. When `mutationFn` then resolves, the optimistic insert is either committed (no-op, canonical already present, id collision dedupes) or rolled back (canonical stays, optimistic row by different id is removed). Document this inline; it's safe but easy to misread.
- **`parent_id` SQL read inside DO emit path.** Keep the query indexed (`idx_assistant_msg_parent` exists) and use bulk IN-list for `getHistory` results. Per-row lookups inside tight emit loops can add latency under streaming partials.
- **`createLiveQueryCollection` query language — preferred approach with documented fallback.** The TanStack DB 0.6.4 query builder uses a D-Query-ish syntax. `groupBy` returns grouped rows; the projection shape may need explicit `.select(({m}) => ({...}))`. **Verification step in P4:** before writing `branch-info-collection.ts`, write a 5-line spike that calls `createLiveQueryCollection` with `groupBy` and inspects the returned row shape (run in the browser console via `chrome-devtools-axi eval`). If the shape matches the hint code, proceed as specified. **Fallback if `groupBy` doesn't support the assumed projection:** drop `branchInfoCollection` entirely and implement `useBranchInfo` as a single `useLiveQuery` over `messagesCollection` that filters `parentId !== null && role === 'user'` and groups client-side inside the same `useMemo` that today builds the Map. This is the safe path — no derived-collection API surface, just straight `useLiveQuery` + vanilla JS grouping. The external behavior is identical (B12 `Verify` step unchanged); only the internal wiring differs. Record the decision (derived-collection vs client-group) in a code comment at the top of `use-branch-info.ts` so reviewers don't relitigate it.
- **Schema bump timing.** Bump `schemaVersion` on `messages-collection.ts` in the SAME commit that removes `turnHint` from `CachedMessage` — otherwise rows with stale fields will deserialize to a type-error state.
- **`echoOf` and back-compat.** If a user has an OLD client tab open during deploy (stale bundle), their `sendMessage` RPC won't include `echoOf`. DO must tolerate this — treat missing `echoOf` as `null` and emit without it. Client-side reducer handles missing `echoOf` gracefully (no delete attempted).
- **`broadcastToClients` filters.** `session-do.ts:~526-535` filters out gateway-role connections. `emitMessagesChanged` MUST use `broadcastToClients`, not the raw `connection.send` loop — otherwise gateway WS gets messages it can't parse.
- **Latent `setTimeout` leak.** The retire-hydrate-ladder task explicitly removes this; don't leave a dangling timer. Verify no `setTimeout` remains in the hook after P2.
- **Test harness — per-phase update policy.** P1+P2 delete `replaceAllMessages`, `hydrateMessages`, `hydratedRef`, and change the wire frame type. Tests in `use-coding-agent.test.ts` that assert on these will fail. Policy: **update tests in the same PR as the code they cover** — P1+P2 must update any test that references old frame types / deleted helpers; P3 must update optimistic-lifecycle tests; P5 handles the remaining `events` / shadow-mirror test migration (per existing P5 task 3). Do NOT skip broken tests and fix in P5 — that creates a red CI between phases.
- **Test harness — context_usage migration.** Tests that previously asserted on `result.current.events[0].type === 'context_usage'` need migration (see spec #12 P2 test-migration pattern). Assert on `upsertSessionLiveState` mock calls for context_usage instead.
- **`toRow` helper.** P2 task 2 references a local `toRow(m, agentName)` that converts a wire `SessionMessage` to a `CachedMessage`. This is a new helper — keep it adjacent to `onMessagesChanged` in `use-coding-agent.ts`. Contract: `(msg: SessionMessage, sessionId: string) => CachedMessage` mapping `{id, role, parts, createdAt: new Date(msg.createdAt), sessionId, parentId: msg.parentId ?? null, echoOf: msg.echoOf ?? null}`. The old `replaceAllMessages` helper (:165-187) contains the current mapping logic — reuse the field-level conversions before deleting it.
- **`createOptimisticAction` lifecycle on session switch.** `useMemo(() => createOptimisticAction(...), [connection, agentName])` recreates the action on session switch. If an in-flight `mutationFn` is pending at the moment of recreation, its rollback closure still runs against the PREVIOUS action's optimistic state (captured via closure) — this is safe because the rollback still references the correct optimisticId and the collection is global. The new action handles subsequent sends. No `useEffect` cleanup is required, but add an inline comment documenting this so a future refactor doesn't introduce a spurious cleanup that breaks the rollback path.

### Reference Docs

- **TanStack DB 0.6 release blog** — https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes. Covers persistence, derived collections, virtual props. Useful for the pattern reference on `createLiveQueryCollection` + optimistic actions.
- **`createOptimisticAction` reference** — https://tanstack.com/db/latest/docs/reference/functions/createOptimisticAction. Signature, onMutate/mutationFn contract, rollback semantics.
- **`createLiveQueryCollection` reference** — https://tanstack.com/db/latest/docs/reference/functions/createLiveQueryCollection. Query builder surface + `groupBy` + derived-collection lifecycle.
- **Mutations guide** — https://tanstack.com/db/latest/docs/guides/mutations. Explains `writeBatch` / `writeInsert` / `writeDelete`, handler semantics, error-throw rollback contract.
- **Prior art in this repo** — `planning/specs/12-client-data-layer-unification.md` (patterns to mirror), `planning/specs/33-tanstackdb-session-state.md` (earlier thinking on collection-based state), `planning/research/2026-04-19-gh14-unify-messages-transport.md` (this spec's research doc).
- **Duraclaw CLAUDE.md** — the "Client data flow" section + "Verify-mode local stack" describe the test infra for VP3 / VP6.
