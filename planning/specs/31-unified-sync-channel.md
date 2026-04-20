---
initiative: unified-sync-channel
type: project
issue_type: feature
status: approved
priority: high
github_issue: 31
created: 2026-04-20
updated: 2026-04-20
phases:
  - id: p1
    name: "Persist messageSeq in kv (GH#25 fix)"
    tasks:
      - "In `apps/orchestrator/src/agents/session-do.ts`: move `messageSeq` from the non-persisted in-memory field at line 113 into the existing kv storage pattern used by `turnCounter` / `gateway_conn_id` / `sdk_session_id` / `active_callback_token`. Reuse the same kv table; no schema change."
      - "On DO `onStart()` / rehydrate, load `messageSeq` from kv (default 0 if unset). Set the in-memory field from the loaded value before any `broadcastMessages()` call can fire."
      - "In `broadcastMessages()` (helper added in spec #14 P1), persist the new `messageSeq` to kv inside the same synchronous block that increments it. Re-use `persistTurnState()`-style INSERT OR REPLACE. Target cost: <= 1ms per broadcast (same as existing turnCounter writes)."
      - "Do NOT persist on targeted sends (`opts.targetClientId` branch) — those don't advance `messageSeq`, so no write is required. This matches the existing rule in spec #14's Gotchas."
      - "Add a DO cold-start test: persist 3 broadcasts, force DO eviction (via `/admin/evict-do` or unit-test DO reset), reopen. Next broadcast carries `seq = lastPersistedSeq + 1`, not `seq = 1`."
    test_cases:
      - id: "messageseq-persists-across-rehydrate"
        description: "Unit test: broadcast 5 deltas, reset DO instance state, broadcast another delta. Sixth frame's seq is 6, not 1."
        type: "unit"
      - id: "no-client-gap-after-rehydrate"
        description: "Integration smoke: open session, send 3 messages, force DO eviction, send a 4th message. Client's lastSeq transitions cleanly without triggering a requestSnapshot RPC."
        type: "integration"
      - id: "targeted-snapshot-no-persist"
        description: "Call requestSnapshot() RPC (targeted send — no seq increment). Verify no kv write occurred for messageSeq (spy on persistTurnState or observe kv unchanged)."
        type: "unit"

  - id: p2
    name: "branchInfo delta support + remove dead gateway_event re-broadcast"
    tasks:
      - "Extend `DeltaPayload` in `packages/shared-types/src/index.ts` with optional `branchInfo?: { upsert?: BranchInfoRow[]; remove?: string[] }`. Snapshot payloads already carry `branchInfo` per spec #14 — this brings deltas to parity."
      - "In `session-do.ts` `sendMessage` handler (~line 607), after appending the new user turn and before `broadcastMessages({kind:'delta', upsert:[msg]})`, compute the affected parent's sibling list via `this.session.getBranches(parentId)` and piggyback onto the same delta: `broadcastMessages({kind:'delta', upsert:[msg], branchInfo: {upsert: siblingRows}})`. One extra DB call per user turn; scoped recomputation is O(1)."
      - "In `session-do.ts` `forkWithHistory` (~line 1794), apply the same pattern: after the first user-echo delta, include `branchInfo.upsert` for the parent whose sibling list changed."
      - "Client `use-coding-agent.ts` onMessage handler: in the `frame.payload.kind === 'delta'` branch (~line 201-290 in the post-#14 layout), if `payload.branchInfo?.upsert` is set, upsert each row into `branchInfoCollection`. If `payload.branchInfo?.remove` is set, delete those keys. Mirror the exact pattern already used for snapshot payloads in spec #14 B7."
      - "Delete dead `broadcastGatewayEvent` re-broadcast paths in `session-do.ts handleGatewayEvent()` switch (~line 2097): the 7 event types that are already persisted as messages AND whose parallel broadcast is pure duplication (`partial_assistant`, `assistant`, `tool_result`, `ask_user`, `permission_request`, `file_changed`, `error`) no longer need their `gateway_event` broadcasts. The messages channel is now the only live source for these. Keep the event→message persistence path (call to `broadcastMessage()` / `broadcastMessages()`); delete only the `broadcastGatewayEvent()` call alongside it."
      - "Keep `broadcastGatewayEvent` emission for `result`, `context_usage`, and `kata_state` in this phase. These have different removal timelines: (a) `result` is removed in P4 once `useDerivedStatus` replaces the implicit `running → idle` transition client-side; (b) `context_usage` and `kata_state` are retained through P5 and removed by the deferred consumer-migration issue (NOT this spec) — their client handlers are the sole populators of `sessionLiveStateCollection.contextUsage` / `.kataState`, and deleting the broadcast before REST consumer hooks ship would blank those fields in the active UI. Authoritative removal timeline lives in P3 tasks 5-7 and P5's narrowing task; P2 just establishes the retention."
      - "Delete the client-side `gateway_event` dispatch branches for the 7 event types whose `gateway_event` broadcasts were just removed, in `use-coding-agent.ts` (~lines 359-392). Keep `context_usage`, `kata_state`, `result` branches — those stay until P4 derivations land."
    test_cases:
      - id: "delta-carries-branchinfo"
        description: "Send two messages to a thread that has existing siblings. Capture WS frames; the delta frame for the second message includes `payload.branchInfo.upsert` with the parent's full sibling list. No second snapshot required."
        type: "integration"
      - id: "resubmit-updates-branchinfo-via-delta"
        description: "Resubmit a user turn. The resubmit flow still broadcasts a snapshot (per spec #14 B2), but subsequent normal user turns on the new branch carry branchInfo deltas — no separate snapshot needed per new sibling."
        type: "integration"
      - id: "dead-gateway-event-rebroadcast-removed"
        description: "`rg 'broadcastGatewayEvent' apps/orchestrator/src/agents/session-do.ts` shows calls ONLY for `result`, `context_usage`, and `kata_state` (the three P4-migration candidates). The 7 deleted call sites return zero matches."
        type: "audit"
      - id: "branchinfo-collection-converges"
        description: "Open a session with 2 branches. branchInfoCollection row for the parent has `siblings.length === 2`. Send a message on branch A, then resubmit to create a third sibling. Between operations, no snapshot fires for the send — only the resubmit — and branchInfoCollection still converges to siblings.length === 3."
        type: "integration"

  - id: p3
    name: "REST endpoints for contextUsage and kataState"
    tasks:
      - "Add two new DO methods in `apps/orchestrator/src/agents/session-do.ts`: `async getContextUsage(): Promise<ContextUsage | null>` and `async getKataState(): Promise<KataState | null>`. These replace the live WS `gateway_event` push."
      - "`getContextUsage` implementation: (a) read from the existing kv-cached field (populated by `handleGatewayEvent` `context_usage` branch); (b) if the kv value's `cachedAt` is older than 5 seconds AND a gateway connection exists, send a `get-context-usage` GatewayCommand over the existing DialBack WS, await the response via a one-shot promise, cache, return; (c) if no gateway connection, return the stale kv value (or null if unset). Implement in-flight dedupe: if a probe is already awaiting response, subsequent calls within that window await the same promise (single-flight pattern). **Probe MUST have a 3-second timeout** — if the gateway is connected but unresponsive (CPU-bound on a long tool call), the probe promise is rejected; all waiting callers fall through to the stale kv value (or null) rather than blocking the Worker up to its CPU limit. The timeout clears `contextUsageProbeInFlight` so the next caller can retry. Errors during probe (gateway disconnected mid-flight, malformed response) follow the same fallback path: log, return stale/null, clear the in-flight promise."
      - "Existing kv values for `context_usage` were written as raw `ContextUsage` (pre-spec shape). The new getter reads `{ value: ContextUsage; cachedAt: number }` — on first access after deploy, `cached.cachedAt` is `undefined`, `Date.now() - undefined` is `NaN`, the `< 5000` check fails, and the value is treated as stale. This is correct-by-construction one-time migration behavior — DO NOT add a stricter type guard (`typeof cached.cachedAt === 'number'`) that would change the fallback. First post-deploy call triggers a fresh probe and writes the new shape. Document this in a code comment at the getter."
      - "`getKataState` implementation: read from D1 `agent_sessions.kataMode / kataIssue / kataPhase` columns (already written by `syncKataToD1()` at session-do.ts:820-868). No gateway probe needed — D1 is the source of truth once mirrored. Return `null` if the row exists but kata fields are all null (no kata session bound)."
      - "Add HTTP route handlers in the orchestrator's TanStack Start API directory (`apps/orchestrator/src/routes/api/sessions/$id/context-usage.ts` and `kata-state.ts`). Each handler: (a) validates session ownership against the authenticated user (same auth middleware as other `/api/sessions/:id/*` routes); (b) forwards to the SessionDO via the existing RPC pattern (env.SESSION_DO.idFromName + get(id).fetch(...) or the SDK's `getAgentByName`); (c) returns JSON. Response shape: `{ contextUsage: ContextUsage | null, fetchedAt: string }` and `{ kataState: KataState | null, fetchedAt: string }`."
      - "KEEP emitting `gateway_event` frames for `context_usage` and `kata_state` in P3. The client's `gateway_event` handlers for these two types (use-coding-agent.ts:363-380) are the sole writers to `sessionLiveStateCollection.contextUsage` and `.kataState` — deleting the server broadcast here would blank those fields immediately, creating a regression window until consumer-issue REST hooks ship. Rule: the REST endpoints go live in P3; removing the redundant WS broadcast is owned by the deferred consumer-migration issue (which also lands the REST consumer hooks). This keeps P3 purely additive — no user-visible change, no regression risk."
      - "KEEP the client-side `gateway_event` dispatch branches for `context_usage` and `kata_state` in `use-coding-agent.ts` (lines 363-380). They continue to populate `sessionLiveStateCollection` exactly as today. The deferred consumer-migration issue swaps them out when the REST consumer hooks take over."
      - "Do NOT implement the client REST consumer hooks yet — collection consolidation is scoped to a separate issue (deferred per interview). This phase lands the REST endpoints ONLY. The client continues to read `contextUsage` / `kataState` from `sessionLiveStateCollection` (populated by the retained WS handlers above) — zero regression in active-session UI. When the consumer issue ships, it migrates readers to the REST endpoints AND deletes the now-redundant WS broadcasts + client handlers in one cutover. P5 of THIS spec does not touch these fields on `sessionLiveStateCollection` either; they live there until the consumer issue cleans up."
    test_cases:
      - id: "context-usage-rest-returns-cached-then-probes"
        description: "Hit `GET /api/sessions/:id/context-usage` twice in quick succession. First call fires a get-context-usage GatewayCommand (observable in gateway logs) and response body has `isCached: false`. Second call within 5s returns the cached value without a second probe and has `isCached: true`. 6s later, third call re-probes and `isCached: false` again."
        type: "integration"
      - id: "context-usage-legacy-kv-migration"
        description: "Seed kv with a legacy-shape `context_usage` entry (raw `ContextUsage`, no `cachedAt` field). Hit the endpoint. Verify: (a) the NaN freshness check routes to the probe branch; (b) a fresh `get-context-usage` probe fires; (c) response `fetchedAt` is a valid ISO string (not `\"Invalid Date\"`); (d) `isCached: false`; (e) post-request kv row is rewritten in `{ value, cachedAt: number }` shape. No `typeof cached.cachedAt === 'number'` guard is needed on the freshness branch for this to pass."
        type: "integration"
      - id: "context-usage-legacy-kv-no-gateway"
        description: "Seed kv with a legacy-shape `context_usage` entry. Kill the gateway connection. Hit the endpoint. Response returns the legacy value (200), `fetchedAt` is a valid ISO string (wall clock, not `\"Invalid Date\"`), `isCached: true`. This exercises the `legacyOrMissing` serialization guard in the no-gateway fallback branch."
        type: "integration"
      - id: "context-usage-inflight-dedupe"
        description: "Fire 10 parallel GET requests to `/context-usage` when cache is cold. Gateway receives exactly 1 `get-context-usage` command. All 10 HTTP responses return the same value."
        type: "integration"
      - id: "kata-state-reads-d1"
        description: "Set kataMode='planning' via the normal flow (kata_state event persists to D1). Hit `GET /api/sessions/:id/kata-state`. Response contains the mode. Shut down the runner (no gateway conn). Hit again — still returns the D1 value (no probe needed)."
        type: "integration"
      - id: "context-usage-no-gateway-returns-stale"
        description: "Populate kv with a stale context_usage value. Kill the gateway connection. Hit the endpoint. Response returns the stale value (not 503). `fetchedAt` reflects the kv timestamp, not wall clock."
        type: "integration"
      - id: "context-usage-probe-timeout"
        description: "Mock the gateway DialBack WS so it acks the `get-context-usage` command but never responds with the value. Hit the REST endpoint with a populated (stale) kv cache. Within 3.5s, the response returns (not hangs) with the stale kv value. `contextUsageProbeInFlight` is cleared post-timeout (verified by a follow-up call firing a new probe, not awaiting the stuck one)."
        type: "integration"
      - id: "context-usage-probe-error-fallback"
        description: "Mock the gateway probe to reject (e.g., gateway disconnects mid-probe). Endpoint returns the stale kv value (or null if unset) with 200 status — not 500. Subsequent call retries the probe (in-flight promise was cleared on error)."
        type: "integration"
      - id: "context-usage-ws-broadcast-retained"
        description: "Send a message that triggers context_usage emission. Capture WS frames. `{type:'gateway_event', payload:{type:'context_usage'}}` frames continue to arrive (P3 intentionally retains the broadcast — removal is owned by the deferred consumer-migration issue). `sessionLiveStateCollection.contextUsage` still updates via the retained client handler. Parallel verification: the new REST endpoint `GET /api/sessions/:id/context-usage` returns the same value."
        type: "integration"
      - id: "kata-state-ws-broadcast-retained"
        description: "Trigger a kata_state change (e.g., `kata enter planning`). Capture WS frames. `{type:'gateway_event', payload:{type:'kata_state'}}` frames arrive as today (retained until consumer issue). `sessionLiveStateCollection.kataState` updates. REST endpoint returns the same value."
        type: "integration"

  - id: p4
    name: "Client derivations — status, gate, sort by seq"
    tasks:
      - "Create `apps/orchestrator/src/hooks/use-derived-status.ts`. Export `useDerivedStatus(sessionId: string): SessionStatus`. Implementation: `useLiveQuery` over `messagesCollection` sorted descending by `seq` (wire seq, not createdAt — see next task for the seq field addition); scan at most the last 10 messages; return `'running'` if last assistant part has `state:'streaming'`, `'waiting_gate'` if an unresolved `tool-permission` or `tool-ask_user` part exists, `'running'` if the last message is `role:'user'`, `'idle'` otherwise. Memoized via TanStack DB reactivity — only re-runs when the sorted window changes."
      - "Add `seq: number` to `CachedMessage` in `apps/orchestrator/src/db/messages-collection.ts` schema (bump version). Populated on WS frame write — the delta handler receives the frame's `seq` and stamps it onto every row in the payload. Snapshot rows get their frame's `version` stamped onto every row (they all share the snapshot's seq watermark; intra-snapshot ordering falls back to `createdAt`)."
      - "Rewrite sort key in `apps/orchestrator/src/hooks/use-messages-collection.ts`. Composite: `[seq ?? Number.POSITIVE_INFINITY, turnOrdinal ?? Number.POSITIVE_INFINITY, createdAt]`, where `turnOrdinal = parseTurnOrdinal(row.canonical_turn_id)` reuses the existing helper from spec #14 P3 (returns `N` for `usr-N`, `undefined` otherwise). `canonical_turn_id` is an existing field on `CachedMessage` from spec #14 B6 — no new schema field is introduced for this tiebreaker. Optimistic rows (no `seq` yet — not yet broadcast) fall through to the `turnOrdinal` branch; optimistic user rows (with a client-generated id, no `canonical_turn_id` until echo) fall through to `createdAt`. **This directly fixes Bug 1** (user messages reliably in-order): the wire `seq` is authoritative and monotonic; client-side `createdAt` clock skew no longer matters."
      - "Create `apps/orchestrator/src/hooks/use-derived-gate.ts`. Export `useDerivedGate(sessionId: string): GatePayload | null`. Implementation: `useLiveQuery` that finds the most recent message part with `type === 'tool-permission' || type === 'tool-ask_user'` AND `state === 'approval-requested'`. Return the gate payload if found; `null` otherwise. No OR-logic against `SessionState.gate` — messages are the sole source. **This directly fixes Bug 3** (ask_user not hiding): when the tool-result arrives and mutates the part state to `approval-given` / `approval-denied`, the derivation returns `null` in the same live-query tick."
      - "Rewrite `isPendingGate` in `apps/orchestrator/src/features/chat/ChatThread.tsx` (~lines 91-107) to call `useDerivedGate(sessionId)` and return `gate !== null`. Delete the current `state.gate || msg.state === 'approval-requested'` OR-logic. Drop the `state` dependency entirely — the component stops reading from `useSessionLiveState`."
      - "Rewrite `apps/orchestrator/src/lib/display-state.ts` `deriveDisplayState()` signature from `deriveDisplayState(state, wsReadyState)` to `deriveDisplayState(derivedStatus, wsReadyState)`. Consumer classification (explicit):\n\n  - **Active-session consumers — migrate to `useDerivedStatus(sessionId)`:**\n    - `status-bar.tsx` (renders status for the currently-focused session)\n    - `tab-bar.tsx` (renders live status for tabs of active sessions in the current browser — each tab's DO has a live WS; the derivation runs per tab)\n    - `features/chat/ChatThread.tsx` and any other component scoped to the active session\n\n  - **Non-active-session consumers — keep reading from D1 REST (no change):**\n    - `SessionCardList.tsx:95` (dashboard card list — shows every session, many without a live WS)\n    - `SessionListItem.tsx:68` (sidebar list items — same rationale)\n    - `SessionHistory.tsx` (archived/historical sessions — no WS connection at all)\n\n  The rule: if the component can only render when the session's DO has a live WebSocket (i.e., you're currently viewing or editing that session), migrate to the derivation hook. If it renders a session's status without connecting to the session's DO, keep D1 REST. Migration path for each component: change the prop passed into `deriveDisplayState` — active consumers pass `useDerivedStatus(sessionId)`, non-active pass the D1-sourced status string they already read today.\n\n  **This directly fixes Bug 2** (stop/send button desync): the active-session consumers (which are the ones affected by Bug 2) now reflect messages-truth, not coarse state broadcast. Non-active consumers are already on D1 which was never affected by Bug 2."
      - "Delete the `onStateUpdate` callback body in `use-coding-agent.ts:296-310`. Leave the prop wired through `useAgent({...})` as a no-op for P4 (gets removed in P5). `sessionLiveStateCollection` stops receiving writes from active-session chat — other writers (sidebar hydrate) remain."
      - "Delete the `broadcastGatewayEvent` call for `result` in `session-do.ts handleGatewayEvent()` switch (~line 2097). `useDerivedStatus` now drives the `running → idle` transition when the terminal `result` message persists to `messagesCollection`; the parallel `gateway_event` channel is dead. Keep the side-effects on the same branch (D1 sync of cost/duration via `syncResultToD1()`) — delete ONLY the push broadcast."
      - "Delete the client-side `gateway_event` dispatch branch for `result` in `use-coding-agent.ts` (~lines 383-392). Cost/duration were previously extracted here and written to `sessionLiveStateCollection.sessionResult`; since P5 removes the `sessionResult` field from the collection (narrowing, per P5's `sessionlivestatecollection-narrowed` test), and the UI surfaces cost/duration via D1 REST for non-active reads and via derivation hooks for active reads, the client handler has nothing to do. Keep the `kata_state` and `context_usage` branches intact (they're retained until the deferred consumer issue). Audit: `rg \"event.type === 'result'\" apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` should return zero matches at end of P4; other `gateway_event` branches (for `kata_state` and `context_usage`) must still be present."
      - "Add minimal axi smoke test: open a session, trigger all three bug scenarios (rapid send, stop-while-streaming, ask_user resolution) — assert no regressions. Use `scripts/verify/axi-a` per CLAUDE.md patterns."
    test_cases:
      - id: "derived-status-matches-messages"
        description: "Unit test: construct a messagesCollection fixture with (a) last message is streaming assistant → expect 'running'; (b) last part is unresolved ask_user → expect 'waiting_gate'; (c) last message is user turn → expect 'running'; (d) last message is finalized assistant + result → expect 'idle'."
        type: "unit"
      - id: "derived-gate-resolves-on-tool-result"
        description: "Insert a message with an `approval-requested` permission part. `useDerivedGate` returns the payload. Insert the corresponding tool-result (mutates part state to `approval-given`). `useDerivedGate` returns null within one live-query tick."
        type: "unit"
      - id: "sort-by-seq-stable"
        description: "Send 3 messages rapidly (bursts within 10ms). UI shows them in send order with no reordering flicker. Force a clock-skew scenario (mock Date.now client-side to go backwards 100ms between sends); order still matches seq."
        type: "integration"
      - id: "bug1-messages-in-order-smoke"
        description: "axi smoke: send 5 messages in rapid succession via `scripts/verify/axi-a fill + click` pairs. Accessibility snapshot shows messages in submit order. No 'grouped at top' anomaly."
        type: "smoke"
      - id: "bug2-stop-button-synced-smoke"
        description: "axi smoke: send a long-running message. While streaming, input area shows 'Stop' button. When result arrives, button transitions to 'Send' within 500ms. Repeat 3 times — no desync observed."
        type: "smoke"
      - id: "bug3-ask-user-hides-smoke"
        description: "axi smoke: trigger an ask_user prompt (via a tool that requires approval). Prompt renders. Click 'Approve'. Prompt disappears within 500ms and does NOT reappear. Repeat for 'Deny'."
        type: "smoke"
      - id: "result-gateway-event-removed"
        description: "After P4 ships, `rg 'broadcastGatewayEvent' apps/orchestrator/src/agents/session-do.ts | wc -l` returns exactly 2 — the retained calls for `context_usage` and `kata_state` (owned by the deferred consumer-migration issue, NOT this spec). The `result` broadcast is absent. `rg 'broadcastGatewayEvent.+result' apps/orchestrator/src/agents/session-do.ts` returns 0 matches."
        type: "audit"
      - id: "result-client-handler-removed"
        description: "`rg \"event.type === 'result'\" apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` returns 0 matches. Branches for `event.type === 'kata_state'` and `event.type === 'context_usage'` remain (retained until consumer issue)."
        type: "audit"

  - id: p5
    name: "Delete SessionState + sessionLiveStateCollection (active-session path)"
    tasks:
      - "Extend `shouldSendProtocolMessages()` in `session-do.ts:288` to return `false` for browser connections as well as gateway connections. Before this change it suppresses SDK protocol frames only for `role=gateway`; after, it suppresses for all connections. The SDK's `setState()` → `state_update` broadcast stops reaching the client entirely. Verify via wire capture: no `{type:'cf_agent_state'}` frames after the change."
      - "Delete every `this.setState(...)` / `updateState()` call in `session-do.ts`. Call sites (per research R1): lines 402, 468, 492, 559, 1346, 1411, 1594, 1705, 1714, 1801, 1860, 2018, 2277, 2309, 2439, 2500, 2570. Replace with explicit kv writes for operational fields that actually need persistence: `active_callback_token`, `sdk_session_id`, `gateway_conn_id` (already in kv; just stop mirroring into SessionState). For fields that are pure D1 mirrors (status, model, project, prompt, numTurns, durationMs, totalCostUsd, messageCount, kataMode, kataIssue, kataPhase), call the existing `syncStatusToD1()` / `syncResultToD1()` / `syncKataToD1()` helpers directly — skip the SessionState stopover."
      - "Delete `DEFAULT_STATE` constant and `updateState()` helper in `session-do.ts`."
      - "Change DO class declaration from `class SessionDO extends Agent<Env, SessionState>` to `class SessionDO extends Agent<Env>` (drop the second generic). Agents SDK v0.11.0 accepts this — state becomes implicit `unknown` and `initialState` is no longer required."
      - "Delete `SessionState` type from `packages/shared-types/src/index.ts`. Grep for any remaining importers and fix compile errors by using more specific types (or delete dead imports)."
      - "Narrow `apps/orchestrator/src/db/session-live-state-collection.ts`: remove fields that are now derived (`status`, `gate`, `sessionResult`) and their writer paths. KEEP the collection file and the `contextUsage` / `kataState` fields on it — they are still populated by the retained `gateway_event` handlers (see P3 rationale) and consumed by the current active-session UI until the deferred consumer-migration issue swaps them to REST. The full-file deletion is explicitly the consumer issue's scope, NOT this spec's. Callers of `useSessionLiveState` that read `status` / `gate` / `sessionResult` migrate to derivation hooks or D1 REST; callers that read `contextUsage` / `kataState` stay on the hook untouched. Do NOT delete `upsertSessionLiveState` — it still has two legitimate callers (the retained gateway_event handlers)."
      - "Delete the `onStateUpdate` prop wiring in `use-coding-agent.ts`. The hook's return shape loses its `liveState` field (or equivalent). Update consumers to source from the derivation hooks."
      - "Update CLAUDE.md 'Client data flow (session live state)' section: remove `sessionLiveStateCollection` from the list of three sources. Now two: `messagesCollection` (primary live source) and `branchInfoCollection` (sibling metadata). Add a paragraph on the derivation pattern (`useDerivedStatus`, `useDerivedGate`) and the REST endpoints for `contextUsage` / `kataState`."
      - "Final grep-audit: `rg 'SessionState|sessionLiveStateCollection|onStateUpdate|setState\\(' apps/orchestrator/src/ packages/shared-types/src/` returns zero matches (aside from possibly comments or docs referencing the historical type)."
    test_cases:
      - id: "no-cf-agent-state-frames"
        description: "Open a session. Capture WS frames for 30 seconds of normal activity. Zero frames with `type === 'cf_agent_state'` or any SDK-originated state protocol frame. Messages-channel frames continue normally."
        type: "integration"
      - id: "sessionstate-deleted"
        description: "`rg 'SessionState' apps/orchestrator/src/ packages/shared-types/src/` returns 0 matches."
        type: "audit"
      - id: "sessionlivestatecollection-narrowed"
        description: "`apps/orchestrator/src/db/session-live-state-collection.ts` still exists. The `SessionLiveState` type no longer includes `status`, `gate`, or `sessionResult` fields (removed in this spec); it retains `contextUsage` and `kataState` (owned by the deferred consumer-migration issue). Callers of `useSessionLiveState` for status/gate/result return 0 matches; callers for contextUsage/kataState continue to work."
        type: "audit"
      - id: "d1-mirror-still-populates"
        description: "Send a message through to completion. Query D1 `agent_sessions` row — `status`, `numTurns`, `totalCostUsd`, `messageCount`, `updatedAt` are all populated correctly. Sidebars still render correct data (integration smoke via axi)."
        type: "integration"
      - id: "full-flow-smoke"
        description: "axi end-to-end: login → create session → send 3 messages → stop mid-stream → ask_user prompt + approve → rewind → resubmit → reconnect after WS drop. All three bugs (ordering, stop button, ask_user hide) stay fixed; no console errors; no lingering state protocol frames."
        type: "smoke"
---

# Spec: Unified Sync Channel — Messages as Sole Live-State Source

## Overview

After GH#14 landed the seq'd `{type:'messages'}` wire protocol, three user-
visible bugs persist — all rooted in the client composing live UI state
from three independent push channels (seq'd messages, unreliable
`gateway_event`, SDK `onStateUpdate`). This spec collapses the three
channels to one: messages is the sole live-state source, ancillary state
(`contextUsage`, `kataState`) moves to on-demand REST, and derivations
replace broadcast for `status` and `gate`. `SessionState` is deleted
entirely — it was a redundant duplicate of the D1 mirror that already
serves every non-active-session reader.

This fixes GH#31 bugs 1-3, resolves GH#25 (non-persisted `messageSeq`),
and removes ~400 LOC of dead gateway_event re-broadcast and
state-update dispatch machinery.

## Feature Behaviors

### B1: Persist `messageSeq` across DO rehydrate (resolves GH#25)

**Core:**
- **ID:** messageseq-persisted
- **Trigger:** DO eviction (30min idle, redeploy, random CF rehydration)
  between a broadcast on the old instance and the first broadcast on the
  new instance.
- **Expected:** New instance loads `messageSeq` from kv on `onStart()`.
  Next broadcast carries `seq = persistedValue + 1`, not `seq = 1`.
  Client's `lastSeq` check (`frame.seq === lastSeq + 1`) passes cleanly.
  No silent drops, no spurious gap + snapshot recovery.
- **Verify:** Test `messageseq-persists-across-rehydrate` (unit) and
  `no-client-gap-after-rehydrate` (integration). After forced DO eviction
  mid-session, the next message flows through without a `requestSnapshot`
  RPC call.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:113` (move field
  into kv); `broadcastMessages()` helper (persist inside the increment
  block).

#### Data Layer
Reuses existing kv table (no schema change). Row: `{ key: 'messageSeq',
value: <number>, sessionId: <id> }`. Same INSERT OR REPLACE pattern as
`turnCounter` and `gateway_conn_id`.

---

### B2: `branchInfo` on delta payloads

**Core:**
- **ID:** branchinfo-delta
- **Trigger:** A user-turn mutation that affects a parent's sibling list
  (new message on a branched parent; `forkWithHistory` spawn).
- **Expected:** DO piggybacks the parent's updated sibling list onto the
  same delta frame that carries the user-turn upsert. Client upserts into
  `branchInfoCollection` in the same `onMessage` dispatch. Sibling counts
  in the UI update without a snapshot round-trip.
- **Verify:** Test `delta-carries-branchinfo`: after sending a message on
  a branched parent, capture the delta frame and assert
  `payload.branchInfo.upsert` is present.
- **Source:** `session-do.ts sendMessage` (~line 607), `forkWithHistory`
  (~1794); `use-coding-agent.ts` delta-dispatch branch (~201-290);
  `packages/shared-types/src/index.ts` `DeltaPayload` type.

#### API Layer
```ts
interface DeltaPayload {
  kind: 'delta'
  upsert?: SessionMessage[]
  remove?: string[]
  branchInfo?: {
    upsert?: BranchInfoRow[]
    // Forward-looking only. No current DO call site populates `remove`
    // — parent sibling-list shrinkage happens only via rewind or
    // branch-navigate, both of which broadcast full snapshots (spec #14
    // B2). The field exists so the client handler is correct-by-
    // construction if a future feature (e.g., message deletion reducing
    // siblings) adds a producer. Until then, deltas never emit it and
    // `branchInfoCollection.delete(payload.branchInfo.remove)`
    // short-circuits on empty/undefined arrays. No test coverage this
    // phase — the emitter-less field is benign.
    remove?: string[]
  }
}
```

Snapshot payloads already carry `branchInfo` (spec #14 B7). Deltas now
reach parity.

---

### B3: Dead `gateway_event` re-broadcasts removed

**Core:**
- **ID:** gateway-event-rebroadcast-removed
- **Trigger:** Server emits a `GatewayEvent` for one of: `partial_assistant`,
  `assistant`, `tool_result`, `ask_user`, `permission_request`,
  `file_changed`, `error`.
- **Expected:** DO persists the event as a message and broadcasts via the
  messages channel (unchanged). DO no longer calls `broadcastGatewayEvent`
  for these 7 event types — they were redundantly pushed on both the
  messages channel AND the `gateway_event` channel. Client's
  `gateway_event` dispatch branches for these 7 types are deleted.
  **`result` is NOT in this phase's deletion list** — its client handler
  drives the implicit `running → idle` status transition that
  `useDerivedStatus` will replace in P4. Deleting it earlier would create
  a regression window where session completion isn't detected. `result`
  broadcast is deleted in P4 alongside the derivation cutover.
- **Verify:** Test `dead-gateway-event-rebroadcast-removed` (audit grep).
  Client WS capture shows zero `gateway_event` frames for these 7 event
  types (but `result`, `context_usage`, `kata_state` continue to arrive
  until P4 / P3 respectively).
- **Source:** `session-do.ts handleGatewayEvent()` switch (~line 2097);
  `use-coding-agent.ts gateway_event` handler (~lines 359-392).

#### API Layer
No wire protocol change. Client handler simply stops listening to a set
of frames that no longer arrive.

---

### B4: REST endpoint for `contextUsage` (replaces gateway_event push)

**Core:**
- **ID:** context-usage-rest
- **Trigger:** Component needs `contextUsage` data.
- **Expected:** HTTP GET `/api/sessions/:id/context-usage` returns
  `{ contextUsage: ContextUsage | null, fetchedAt: string, isCached: boolean }`. Handler:
  (a) auth check; (b) DO call to `getContextUsage()`; (c) JSON response.
  Inside `getContextUsage()`: return kv-cached value if `fresh < 5s old`;
  else probe gateway via existing `get-context-usage` GatewayCommand
  (in-flight dedupe via single-flight promise, **3-second timeout on the
  probe** — on timeout or probe error, fall through to the stale kv value
  and clear the in-flight promise so the next call retries cleanly).
  `fetchedAt` is the wall-clock timestamp when the value was most
  recently cached (new probe → `Date.now()`; stale-kv fallback →
  `cached.cachedAt`).
- **Verify:** Tests `context-usage-rest-returns-cached-then-probes`,
  `context-usage-inflight-dedupe`, `context-usage-no-gateway-returns-stale`,
  `gateway-event-context-usage-stopped`.
- **Source:** New route `apps/orchestrator/src/routes/api/sessions/$id/
  context-usage.ts`. New DO method `getContextUsage()` in `session-do.ts`.

#### API Layer
```
GET /api/sessions/:id/context-usage
Auth: session cookie (standard)
Response 200: { contextUsage: ContextUsage | null, fetchedAt: string, isCached: boolean }
Response 401: { error: 'unauthorized' }
Response 404: { error: 'session_not_found' }
```

`fetchedAt` is an ISO timestamp; `isCached` is `true` when the value
came from the kv cache (without a fresh probe), `false` when a fresh
probe just completed. Consumers that need stale-detection should read
`isCached` rather than comparing `fetchedAt` timestamps across
endpoints (see B5 for the contrasting semantic).

Error body shape (`{ error: string }`) mirrors the convention established
by the existing `/api/sessions/:id` route — consumers can rely on
`response.json().error` across all three REST endpoints.

The DO internally reuses the existing `get-context-usage` GatewayCommand
(runner already responds via the live WS). Single-flight dedupe: a
`Promise<ContextUsage>` is stashed in-memory during an in-flight probe; all
concurrent callers await the same promise.

#### Data Layer
Cache: kv table `context_usage` field (existing; populated by
`handleGatewayEvent`). Augment with `cachedAt` timestamp for the 5s TTL
check. No new DB tables.

---

### B5: REST endpoint for `kataState` (reads D1 mirror)

**Core:**
- **ID:** kata-state-rest
- **Trigger:** Component needs kata session metadata.
- **Expected:** HTTP GET `/api/sessions/:id/kata-state` returns
  `{ kataState: KataState | null, fetchedAt: string }`. DO method reads
  from D1 `agent_sessions.kataMode / kataIssue / kataPhase` columns (the
  existing mirror populated by `syncKataToD1()`). Returns `null` if no
  kata session is bound.
- **Verify:** Test `kata-state-reads-d1`. After setting kataMode, REST
  returns the value; after killing the runner, REST still returns the
  value (D1 is source of truth once mirrored).
- **Source:** New route `apps/orchestrator/src/routes/api/sessions/$id/
  kata-state.ts`. New DO method `getKataState()` in `session-do.ts`.

#### API Layer
```
GET /api/sessions/:id/kata-state
Auth: session cookie
Response 200: { kataState: KataState | null, fetchedAt: string }
Response 401: { error: 'unauthorized' }
Response 404: { error: 'session_not_found' }
```

Error shapes mirror B4 exactly — same auth middleware, same 404
behavior, same `{ error: string }` body contract.

`fetchedAt` is the handler's wall-clock timestamp at response time
(`new Date().toISOString()`). Unlike B4's `fetchedAt`, it does NOT
reflect a cache age — D1 is the source of truth and reads are always
fresh from the implementer's perspective. No `isCached` field on this
endpoint since there's no cache layer. Consumers comparing `fetchedAt`
across `/context-usage` and `/kata-state` should rely on B4's
`isCached` to distinguish stale-cache from fresh reads; `fetchedAt` on
`/kata-state` is always effectively "fresh."

No gateway probe — D1 is authoritative. Existing `syncKataToD1()`
(session-do.ts:820-868) writes on every kata_state event, giving us a
consistent snapshot without a live round-trip.

---

### B6: Derived `status` from messages (resolves Bug 2 — stop/send button)

**Core:**
- **ID:** derived-status
- **Trigger:** Any component previously reading `state.status` from
  `sessionLiveStateCollection`.
- **Expected:** New hook `useDerivedStatus(sessionId)` computes status
  from the last ~10 messages of `messagesCollection`:
  - Last assistant part with `state:'streaming'` → `running`
  - Unresolved gate (`approval-requested` permission/ask_user part) →
    `waiting_gate`
  - Last message is `role:'user'` → `running`
  - Otherwise → `idle`
- **Verify:** Test `derived-status-matches-messages` (unit, 4 fixtures);
  smoke `bug2-stop-button-synced-smoke`. Stop/Send button transitions
  within 500ms of result arrival over 3 consecutive sends.
- **Source:** New file `apps/orchestrator/src/hooks/use-derived-status.ts`.
  **Active-session callers** (migrate to this hook): `status-bar.tsx`,
  `tab-bar.tsx`, `ChatThread.tsx`. **Non-active callers keep reading
  D1 REST** (no migration): `SessionCardList.tsx:95`,
  `SessionListItem.tsx:68`, `SessionHistory.tsx`. See P4 task 6 for the
  classification rule (component needs a live WS per session → active;
  renders status without a session-scoped WS → D1).

#### API Layer
Pure client-side derivation; no server change.

---

### B7: Derived `gate` from messages (resolves Bug 3 — ask_user hide)

**Core:**
- **ID:** derived-gate
- **Trigger:** `ChatThread.tsx` rendering the gate-prompt UI.
- **Expected:** New hook `useDerivedGate(sessionId)` returns the gate
  payload if a message part with type `tool-permission` or `tool-ask_user`
  AND state `approval-requested` exists; else `null`. When the tool-result
  arrives (which mutates the part state to `approval-given` /
  `approval-denied` / adds a matching tool-result row), the derivation
  returns `null` in the same live-query tick. OR-logic with
  `SessionState.gate` is deleted.
- **Verify:** Test `derived-gate-resolves-on-tool-result` (unit);
  smoke `bug3-ask-user-hides-smoke`. Prompt disappears within 500ms of
  approve/deny click.
- **Source:** New file `apps/orchestrator/src/hooks/use-derived-gate.ts`.
  Rewrite `isPendingGate` in `features/chat/ChatThread.tsx:91-107`.

---

### B8: Sort messages by wire `seq` (resolves Bug 1 — message ordering)

**Core:**
- **ID:** sort-by-seq
- **Trigger:** Any render of `useMessagesCollection(sessionId)`.
- **Expected:** Sort key becomes `[seq ?? Infinity, turnOrdinal ??
  Infinity, createdAt]`, where `turnOrdinal = parseTurnOrdinal(
  row.canonical_turn_id)` reuses the spec #14 P3 helper. Wire `seq` is
  stamped onto every `CachedMessage` row at WS-frame apply time.
  Optimistic rows (no seq yet) sort last within their group — they briefly
  appear below not-yet-echoed rows, then snap into place on echo. No new
  schema field is introduced for the tiebreaker — `canonical_turn_id`
  already exists from spec #14 B6.
- **Verify:** Test `sort-by-seq-stable`; smoke
  `bug1-messages-in-order-smoke`. 5 rapid sends render in submit order;
  clock-skew scenarios do not perturb order.
- **Source:** `apps/orchestrator/src/db/messages-collection.ts` (schema
  bump adds `seq` field); `apps/orchestrator/src/hooks/
  use-messages-collection.ts` (sort key); `use-coding-agent.ts` delta
  handler (stamp seq onto rows).

#### Data Layer
`CachedMessage` schema bump (e.g., v4→v5). Field `seq?: number` added.
Old rows load with `seq: undefined`; they sort by the fallback `createdAt`
branch, which is their existing behavior. On first WS apply after the
bump, rows gain `seq` and sort authoritatively.

---

### B9: Suppress SDK state broadcast via `shouldSendProtocolMessages()`

**Core:**
- **ID:** suppress-sdk-state-broadcast
- **Trigger:** Any `this.setState(...)` call in the DO (during P5 migration
  these get deleted, but even before deletion the broadcast must stop).
- **Expected:** `shouldSendProtocolMessages(connection)` returns `false`
  for ALL connections (previously only `role=gateway`). SDK protocol
  frames (`cf_agent_state`, etc.) stop reaching the browser. Wire capture
  shows zero `{type:'cf_agent_state'}` frames. The messages channel is
  the only live-state channel on the wire.
- **Verify:** Test `no-cf-agent-state-frames`. Capture 30s of WS traffic;
  zero state-protocol frames.
- **Source:** `session-do.ts:288` (extend the filter; one-line change).

---

### B10: Delete `SessionState` + `sessionLiveStateCollection`

**Core:**
- **ID:** delete-session-state
- **Trigger:** P5 cleanup after B6-B9 land.
- **Expected:** `SessionState` type deleted from shared-types. 17
  `setState()` / `updateState()` call sites in `session-do.ts` deleted or
  replaced with direct kv / D1-sync calls. `Agent<Env, SessionState>`
  generic collapses to `Agent<Env>`. `onStateUpdate` callback body
  deleted. Client file `db/session-live-state-collection.ts` is
  **narrowed, not deleted** — `status` / `gate` / `sessionResult` fields
  are removed (now derived); `contextUsage` / `kataState` stay until the
  deferred consumer-migration issue swaps them to REST. Every migrated
  caller reads from one of: derivation hook (B6/B7), REST endpoint
  (B4/B5), or D1 REST for sidebar-style reads. Collection full-deletion
  is explicitly out of scope here.
- **Verify:** Tests `sessionstate-deleted`, `sessionlivestatecollection-
  narrowed`, `d1-mirror-still-populates`, `full-flow-smoke`.
- **Source:** See P5 task list for full migration.

#### Data Layer
D1 mirror (`agent_sessions` table) is the permanent durable record.
`syncStatusToD1()` / `syncResultToD1()` / `syncKataToD1()` helpers
unchanged — they already capture every field sidebars need. The DO's
in-memory `SessionState` was always a redundant projection.

---

## Non-Goals

Explicitly out of scope for this feature:

- **No SDK fork or upgrade.** Stay on `@cloudflare/agents@0.11.0`. The
  state-suppression uses `shouldSendProtocolMessages()` — an existing
  escape hatch. No dependency bump.
- **No Session SQLite schema changes.** Message history format unchanged.
- **No runner / transport changes.** `packages/session-runner` and
  `packages/shared-transport` are untouched. All changes live in
  `apps/orchestrator` and `packages/shared-types`.
- **No sidebar / tab-bar redesign.** Those already read D1 REST; they
  continue to, unchanged. Freshness characteristics (minute-level) are
  preserved.
- **No dead GatewayEvent type cleanup.** 10+ `GatewayEvent` variants are
  defined-but-never-emitted (per research R2); they stay as dead type
  definitions. A future janitor pass removes them.
- **No shadow-mode / dual-write rollout.** Each phase is a hard cutover.
  If a bug surfaces post-merge, we revert the phase PR rather than live
  with parallel-path complexity. This was the explicit choice at interview.
- **No feature flags.** Per interview: hard cutover per phase, no gated
  rollout.
- **No client collection consolidation.** Whether to fold `contextUsage`
  and `kataState` into `sessionLiveStateCollection` (or its successor)
  and with what polling strategy — deferred to a separate issue. This
  spec lands the REST endpoints only; consumer hooks and collection
  integration come later. Active-session code continues to read these
  fields via whatever path exists pre-P5 until the consumer issue lands.
- **No server-side delta-replay on reconnect.** Reconnect still triggers
  a full snapshot (spec #14 B2). Adding delta-replay requires a DO
  retention window; deferred.
- **No cross-DO state sync or fan-out changes.** Messages still live in
  Session SQLite on the DO; REST endpoints still hit the owning DO via
  the existing routing; no ProjectRegistry changes.

## Open Questions

All P1-blocking questions were resolved in the interview:

- [x] SessionState fate — **delete entirely**, D1 is the durable mirror.
- [x] `contextUsage` / `kataState` transport — **REST endpoints**, not
  sidecar on MessagesFrame.
- [x] SDK state suppression — **`shouldSendProtocolMessages()` filter**.
- [x] GH#25 scope — **fold in as Phase 1** (prerequisite).
- [x] Gate representation — **pure derivation** from message parts.
- [x] `branchInfo` deltas — **extend DeltaPayload** with optional field.
- [x] Client consumer shape for REST endpoints — **deferred to separate
  issue** (collection consolidation).
- [x] Rollout model — **hard cutover per phase, no flags**.

Residual items that may surface during implementation but do not block:

- [ ] **5-second cache TTL for contextUsage** — chosen as a reasonable
  default; tune if polling pattern causes gateway load (monitor via
  gateway logs in production).
- [ ] **`onStateUpdate` no-op vs removed** — P4 makes it a no-op; P5
  removes the prop entirely. If consumers elsewhere rely on the hook's
  return shape, adjust during P5.

## Implementation Phases

See YAML frontmatter `phases:` above. Each phase is independently
shippable on its own PR against a single `feature/31-unified-sync-channel`
branch (one feature branch, phased PRs — per interview).

- **P1** persists `messageSeq` — purely server-side; no user-visible
  change; unblocks the cleaner post-eviction path.
- **P2** adds `branchInfo` on deltas and removes dead
  `broadcastGatewayEvent` calls — partial wire cleanup; no user-visible
  change.
- **P3** adds REST endpoints — no consumer migration yet, just the
  endpoints go live; no user-visible change alone.
- **P4** lands the derivations and fixes all three bugs. This is the
  user-visible phase. Axi smoke tests are mandatory before merge. **P4
  is larger than the other phases** (7 tasks, 3 new hooks, schema bump,
  sort-key rewrite, 6+ consumer files, callback deletion). If it cannot
  complete in a single session, split as follows:
  - **P4a — data + derivation hooks**: schema bump on
    `messagesCollection` (adds `seq`), delta handler stamps seq onto
    rows, sort-key rewrite in `useMessagesCollection`, create
    `useDerivedStatus` and `useDerivedGate` hooks. No consumer
    migration. Hooks exist but nothing reads them yet. Sort-by-seq
    silently fixes Bug 1 alone. Shippable.
  - **P4b — consumer migration + smoke**: migrate `ChatThread.tsx`
    `isPendingGate` to `useDerivedGate`, migrate status-bar / sidebar /
    tab-bar callers to `useDerivedStatus` + rewritten
    `deriveDisplayState`, delete `onStateUpdate` body, run axi smoke.
    Fixes Bug 2 and Bug 3.
  Split only if P4a tasks run long — otherwise land together. The P4b
  cutover depends on P4a hooks existing, so order is fixed.
- **P5** deletes `SessionState` + `sessionLiveStateCollection` + SDK
  state broadcast. Final cleanup; reverts are cheap because nothing
  depends on the deleted surface after P4.

If P4 surfaces a regression, P1-P3 remain functional (server still emits
SessionState broadcasts). If P5 surfaces a regression, P1-P4 remain
functional. No phase creates a state that's hard to back out of.

## Verification Strategy

### Test Infrastructure
- **Vitest** for unit tests (existing config).
- **Integration tests** use the DO connection mock pattern from spec #14.
- **chrome-devtools-axi** via `scripts/verify/axi-a` for smoke tests —
  per CLAUDE.md "UI Testing" section.
- No new test infrastructure required.

### Build Verification
`pnpm build && pnpm typecheck && pnpm test` at repo root.

### Pre-merge gate per phase
- `pnpm typecheck` clean.
- All unit tests in the phase pass.
- Axi smoke for the phase's behaviors runs clean (P4 and P5 only; P1-P3
  are server-side).

## Verification Plan

Concrete executable steps. Run from repo root with local verify stack up
(`scripts/verify/dev-up.sh`).

### VP1: Persisted messageSeq survives DO eviction (B1)

Steps:

1. `scripts/verify/axi-a open $VERIFY_ORCH_URL/dashboard`
   Expected: dashboard loads; login if needed.
2. Create a new session. Send 3 messages.
3. Install WS capture hook (same pattern as spec #14 VP1):
   ```
   scripts/verify/axi-a eval 'window.__wsFrames = []; const o =
   WebSocket.prototype.addEventListener; WebSocket.prototype.addEventListener
   = function(ev, cb) { if (ev === "message") return o.call(this, ev, (e) =>
   { try { window.__wsFrames.push(JSON.parse(e.data)); } catch {} cb(e); });
   return o.apply(this, arguments); };'
   ```
4. `scripts/verify/axi-a eval 'window.__wsFrames.filter(f => f.type ===
   "messages").map(f => f.seq)'`
   Expected: a strictly monotonic sequence e.g. `[1, 2, 3, 4, 5, 6]`.
5. Force DO eviction. If `/admin/evict-do` endpoint exists:
   `curl -X POST $VERIFY_ORCH_URL/admin/evict-do?sessionId=<id>`. Else
   restart the orchestrator process (`pkill -f 'wrangler dev'`, re-launch).
6. Send a 4th message. Capture frames.
7. `scripts/verify/axi-a eval 'window.__wsFrames.filter(f => f.type ===
   "messages").slice(-3).map(f => ({seq: f.seq, kind: f.payload.kind}))'`
   Expected: new frames carry `seq` values greater than the pre-eviction
   max (e.g. `[7, 8]` or higher, depending on on-connect snapshot). No
   `seq: 1` restart. No client-side `requestSnapshot` call was triggered
   — confirm via `performance.getEntriesByType("resource").filter(r =>
   r.name.includes("requestSnapshot")).length === 0`.

### VP2: branchInfo arrives on delta (B2)

Steps:

1. Open a session. Send a message to create turn 1. Rewind turn 1 and
   send a different message — this creates a branch with 2 siblings.
2. Install WS capture hook (VP1 step 3).
3. Send a 3rd branched message (on the currently-active branch).
4. `scripts/verify/axi-a eval 'window.__wsFrames.filter(f => f.type ===
   "messages" && f.payload.kind === "delta").slice(-1)[0].payload'`
   Expected: payload contains `upsert: [{...newMessage}]` AND
   `branchInfo.upsert: [{parentMsgId: <p>, siblings: [...], activeId:
   <...>}]`. Sibling list reflects the updated state.
5. UI assertion: branch arrow on the parent turn shows correct count
   without a page refresh.

### VP3: Dead gateway_event re-broadcasts gone (B3)

Steps:

1. Install WS capture hook.
2. Send a message that triggers a tool call + tool result.
3. `scripts/verify/axi-a eval 'window.__wsFrames.filter(f => f.type ===
   "gateway_event").map(f => f.payload.type)'`
   Expected after P2: the returned array contains NONE of:
   `partial_assistant`, `assistant`, `tool_result`, `ask_user`,
   `permission_request`, `file_changed`, `error`. It MAY contain
   `result`, `context_usage`, and `kata_state` — these survive P2 by
   design. After P4 ships, `result` also drops out (replaced by
   `useDerivedStatus`). `context_usage` and `kata_state` continue to
   arrive through P5 and beyond — their removal is scoped to the
   deferred consumer-migration issue, not this spec. The final expected
   array (post-P5, pre-consumer-issue) is a subset of `["context_usage",
   "kata_state"]`.

### VP4: contextUsage REST endpoint (B4)

Steps:

1. Active session with runner connected. Send one message to populate
   `context_usage` kv cache.
2. `curl -s -b "$(scripts/verify/axi-a eval 'document.cookie')"
   $VERIFY_ORCH_URL/api/sessions/<id>/context-usage`
   Expected: `200 OK`, body `{"contextUsage":{...},"fetchedAt":"<iso>"}`.
3. Repeat the curl within 5s. Verify gateway logs via
   `journalctl -u duraclaw-agent-gateway --since '1 min ago' | grep -c
   get-context-usage` — count unchanged from step 2 (cache hit).
4. Wait 6s. Repeat. Gateway log count increments by 1 (cache miss →
   probe).
5. In-flight dedupe: fire 5 parallel curls (via `&` background):
   ```
   for i in 1 2 3 4 5; do curl -s ... &; done; wait
   ```
   Gateway log count increments by at most 1 — all 5 HTTP responses
   identical.

### VP5: kataState REST endpoint (B5)

Steps:

1. Active session with kata mode set (e.g., `kata enter planning`).
2. `curl -s -b "$(scripts/verify/axi-a eval 'document.cookie')"
   $VERIFY_ORCH_URL/api/sessions/<id>/kata-state`
   Expected: `200 OK`, body includes `"kataMode":"planning"` (or matching
   current mode).
3. Kill the runner: `pkill -f session-runner` on the VPS (or wait for
   reaper).
4. Repeat curl. Response still `200 OK` with the same kata state — served
   from D1 mirror.

### VP6: Bug 1 — message ordering (B8)

Steps:

1. Open active session. Rapidly send 5 messages within 1 second:
   ```
   for msg in one two three four five; do
     scripts/verify/axi-a fill @<input-ref> "message-$msg"
     scripts/verify/axi-a click @<submit-ref>
   done
   ```
2. `scripts/verify/axi-a snapshot`
   Expected: messages appear in order `message-one, ..., message-five`.
3. `scripts/verify/axi-a eval '[...document.querySelectorAll("[data-test=\"user-message\"]")].map(el => el.textContent)'`
   Expected: ordered array `["message-one", ..., "message-five"]`.
4. Refresh the page. Repeat step 3. Order is stable.

### VP7: Bug 2 — stop/send button state (B6)

Steps:

1. Send a long-running message (e.g., "write a long story about X"). While
   the agent is streaming, assert:
   `scripts/verify/axi-a eval 'document.querySelector("[data-test=\"send-stop-button\"]").textContent'`
   Expected: `"Stop"` while `useDerivedStatus` returns `running`.
2. Wait for result. Re-run the eval. Expected: `"Send"` within 500ms of
   the terminal `result` message persisting.
3. Repeat 3 times. No instance of button stuck on wrong label.

### VP8: Bug 3 — ask_user prompt hides (B7)

Steps:

1. Trigger an ask_user flow (send a message like "use the ask_user tool
   to confirm foo").
2. `scripts/verify/axi-a snapshot` — expect prompt with approve/deny
   buttons present.
3. Click `@<approve-ref>`.
4. `scripts/verify/axi-a snapshot` within 500ms.
   Expected: prompt element is gone. No stale prompt. No re-render flash.
5. Trigger another ask_user. Click deny. Same assertion.

### VP9: SDK state suppression (B9)

Steps:

1. Install WS capture hook. Open a session, perform normal activity for
   30s (send messages, stop, resume).
2. `scripts/verify/axi-a eval 'window.__wsFrames.filter(f =>
   f.type === "cf_agent_state" || (typeof f.type === "string" &&
   f.type.startsWith("cf_agent"))).length'`
   Expected: `0`.

### VP10: Full deletion audit (B10)

Steps:

1. `rg 'SessionState' apps/orchestrator/src/ packages/shared-types/src/
   | wc -l`
   Expected: `0` (or only matches inside comments referencing the
   historical type — eyeball each).
2. Readers of the derived fields are migrated:
   `rg 'useSessionLiveState' apps/orchestrator/src/ -A 5 | grep -E
   'status|gate|sessionResult'`
   Expected: `0` matches (no caller destructures those fields from the
   hook). Callers destructuring `contextUsage` / `kataState` continue to
   exist — those are owned by the deferred consumer issue.
3. `rg 'this\.setState\(|updateState\(' apps/orchestrator/src/agents/ |
   wc -l`
   Expected: `0`. (The `onStateUpdate` PROP on `useAgent` may still be
   passed a no-op callback for API compatibility; that's fine.)
4. `test -f apps/orchestrator/src/db/session-live-state-collection.ts &&
   echo EXISTS || echo DELETED`
   Expected: `EXISTS` (narrowed, not deleted — full deletion is the
   consumer issue's scope). Confirm the `SessionLiveState` type no longer
   includes `status`, `gate`, or `sessionResult` via `grep -E
   'status|gate|sessionResult'
   apps/orchestrator/src/db/session-live-state-collection.ts` returning
   no type-field matches.
5. `pnpm typecheck` — clean.
6. D1 mirror unaffected: `curl ... /api/sessions` returns the same shape
   it did pre-refactor (sidebar test).

### VP11: Full integration smoke (all behaviors)

Steps:

1. `scripts/verify/axi-dual-login.sh` — two signed-in users.
2. User A: create session, send 3 messages rapidly — ordering holds (B8).
3. User A: during streaming, observe stop button (B6).
4. User A: trigger ask_user, approve, observe prompt hide (B7).
5. User A: rewind, send new message — branch arrows update (B2).
6. User A: force DO eviction via `/admin/evict-do` — next send does not
   gap-recover (B1).
7. User A: fetch `/api/sessions/<id>/context-usage` and `/kata-state` —
   both return current values (B4, B5).
8. Browser devtools Network tab — zero `cf_agent_state` frames (B9).
9. Grep audit passes (VP10).

## Implementation Hints

### Dependencies

No new dependencies. All existing:
- `@cloudflare/agents@0.11.0` (unchanged; using existing
  `shouldSendProtocolMessages` escape hatch)
- `@tanstack/db`, `@tanstack/react-db` (unchanged)
- TanStack Start for the new REST routes (already in use)

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@tanstack/react-db` | `useLiveQuery` | B6, B7 derivation hooks |
| `~/db/messages-collection` | `createMessagesCollection`, `CachedMessage` | B8 schema bump |
| `~/hooks/use-messages-collection` | `useMessagesCollection` | B6, B7 consume messages |
| `@duraclaw/shared-types` | `DeltaPayload`, `SnapshotPayload`, `BranchInfoRow`, `SessionStatus`, `ContextUsage`, `KataState` | B2, B4, B5 wire types |
| `~/agents/session-do` | `SessionDO` | adding `getContextUsage`, `getKataState` |

### Code Patterns

**B1 — Persist messageSeq in broadcastMessages** (`session-do.ts`):

```ts
private async broadcastMessages(
  payload: DeltaPayload | SnapshotPayload,
  opts: { targetClientId?: string } = {},
) {
  if (!opts.targetClientId) {
    this.messageSeq += 1
    // Same kv pattern as turnCounter — fire-and-forget within the
    // isolate's event loop (DO is single-threaded; subsequent reads
    // after await-boundary see the write).
    this.ctx.storage.put('messageSeq', this.messageSeq)
  }
  const frame: MessagesFrame = {
    type: 'messages',
    sessionId: this.name,
    seq: this.messageSeq,
    payload,
  }
  if (opts.targetClientId) this.sendToClient(opts.targetClientId, frame)
  else this.broadcastToClients(frame)
}

// onStart():
this.messageSeq = (await this.ctx.storage.get<number>('messageSeq')) ?? 0
```

**B2 — branchInfo on delta** (`session-do.ts sendMessage` path):

```ts
// After appending the user turn:
const siblings = this.session.getBranches(parentId)  // existing RPC
const branchInfoRow: BranchInfoRow = {
  parentMsgId: parentId,
  sessionId: this.name,
  siblings: siblings.map(s => s.id),
  activeId: msg.id,
  updatedAt: new Date().toISOString(),
}
this.broadcastMessages({
  kind: 'delta',
  upsert: [msg],
  branchInfo: siblings.length > 1 ? { upsert: [branchInfoRow] } : undefined,
})
```

**B4 — getContextUsage with in-flight dedupe** (`session-do.ts`):

```ts
private contextUsageProbeInFlight: Promise<ContextUsage | null> | null = null

type ContextUsageResponse = {
  contextUsage: ContextUsage | null
  fetchedAt: string
  isCached: boolean
}

async getContextUsage(): Promise<ContextUsageResponse> {
  const cached = await this.ctx.storage.get<{ value: ContextUsage; cachedAt: number }>('context_usage')
  const now = Date.now()
  if (cached && now - cached.cachedAt < 5_000) {
    return {
      contextUsage: cached.value,
      fetchedAt: new Date(cached.cachedAt).toISOString(),
      isCached: true,
    }
  }
  if (!this.getGatewayConnectionId()) {
    // No runner to probe — return stale or null.
    // Legacy kv rows (pre-spec shape) have no `cachedAt`; serialize
    // wall clock rather than Invalid Date to keep the ISO string valid.
    const legacyOrMissing = !cached || typeof cached.cachedAt !== 'number'
    return {
      contextUsage: cached?.value ?? null,
      fetchedAt: legacyOrMissing
        ? new Date().toISOString()
        : new Date(cached.cachedAt).toISOString(),
      isCached: true,  // either stale-kv or null — no fresh probe happened
    }
  }
  if (!this.contextUsageProbeInFlight) {
    this.contextUsageProbeInFlight = this.probeContextUsageWithTimeout()
      .finally(() => { this.contextUsageProbeInFlight = null })
  }
  try {
    const value = await this.contextUsageProbeInFlight
    const cachedAt = Date.now()
    await this.ctx.storage.put('context_usage', { value, cachedAt })
    return {
      contextUsage: value,
      fetchedAt: new Date(cachedAt).toISOString(),
      isCached: false,
    }
  } catch {
    // Timeout or probe error — fall back to stale kv (or null).
    const legacyOrMissing = !cached || typeof cached.cachedAt !== 'number'
    return {
      contextUsage: cached?.value ?? null,
      fetchedAt: legacyOrMissing
        ? new Date().toISOString()
        : new Date(cached.cachedAt).toISOString(),
      isCached: true,
    }
  }
}

private probeContextUsageWithTimeout(): Promise<ContextUsage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe_timeout')), 3_000)
    this.probeContextUsage()
      .then(v => { clearTimeout(timer); resolve(v) })
      .catch(e => { clearTimeout(timer); reject(e) })
  })
}

// probeContextUsage sends `get-context-usage` GatewayCommand and awaits
// the response via a one-shot correlation ID map (existing pattern for
// other mid-session RPCs).
```

**B6 — useDerivedStatus** (`hooks/use-derived-status.ts`):

```ts
export function useDerivedStatus(sessionId: string): SessionStatus {
  const collection = useMessagesCollection(sessionId)
  const { data } = useLiveQuery(
    collection,
    (q) => q.orderBy('seq', 'desc').limit(10),
  )
  return useMemo(() => {
    if (!data || data.length === 0) return 'idle'
    // Unresolved gate check first — always wins.
    for (const msg of data) {
      for (const part of msg.parts ?? []) {
        if (
          (part.type === 'tool-permission' || part.type === 'tool-ask_user') &&
          part.state === 'approval-requested'
        ) {
          return 'waiting_gate'
        }
      }
    }
    const last = data[0]
    if (last.role === 'assistant') {
      const lastPart = last.parts?.[last.parts.length - 1]
      if (lastPart?.state === 'streaming') return 'running'
      return 'idle'
    }
    if (last.role === 'user') return 'running'
    return 'idle'
  }, [data])
}
```

**B7 — useDerivedGate** (`hooks/use-derived-gate.ts`):

```ts
export function useDerivedGate(sessionId: string): GatePayload | null {
  const collection = useMessagesCollection(sessionId)
  const { data } = useLiveQuery(
    collection,
    (q) => q.orderBy('seq', 'desc').limit(20),
  )
  return useMemo(() => {
    if (!data) return null
    for (const msg of data) {
      for (const part of msg.parts ?? []) {
        if (
          (part.type === 'tool-permission' || part.type === 'tool-ask_user') &&
          part.state === 'approval-requested'
        ) {
          return toGatePayload(part)  // thin adapter for existing consumers
        }
      }
    }
    return null
  }, [data])
}
```

**B8 — Stamp seq onto cached rows** (`use-coding-agent.ts` delta
handler):

```ts
if (frame.payload.kind === 'delta') {
  if (frame.payload.upsert) {
    const stamped = frame.payload.upsert.map(m => ({ ...toCachedMessage(m), seq: frame.seq }))
    messagesCollection.upsert(stamped)
  }
  // ... remove, branchInfo as per B2
  lastSeq.current = frame.seq
}
```

**B9 — Extend shouldSendProtocolMessages** (`session-do.ts:288`):

```ts
// Before:
shouldSendProtocolMessages(connection: Connection): boolean {
  return connection.state?.role !== 'gateway'
}
// After:
shouldSendProtocolMessages(_connection: Connection): boolean {
  return false  // Messages channel is the sole live-state source.
}
```

### Gotchas

- **`this.ctx.storage.put` is async but enqueues synchronously** — the
  DO's transactional storage API means the put is observable to
  subsequent reads on the same DO even without awaiting. Don't block
  broadcasts on the await; fire-and-forget is idiomatic (see existing
  `persistTurnState`).
- **`messageSeq` kv read in onStart must await before first broadcast** —
  if `onStart` returns before the read resolves, a concurrent broadcast
  could use the default 0. Block `onStart` on the read. This is the
  existing pattern for `turnCounter`.
- **Schema bump on `messagesCollection`** — adding `seq?: number` as
  optional bumps schema; TanStack DB's persisted collection drops old
  rows and re-fetches via queryFn. First load after deploy shows a brief
  loading state — acceptable. Same pattern as spec #14 P2/P3 bumps.
- **`useDerivedStatus` + `useDerivedGate` re-run only on collection
  changes** — TanStack DB `useLiveQuery` with `.limit(10)` materializes
  only the last 10 rows; the derivation runs when those rows change.
  Don't manually memoize with unstable deps inside the selector.
- **`context_usage` kv shape is migrated in-place** — pre-spec writes stored
  raw `ContextUsage`; post-spec writes store `{ value, cachedAt }`. Two
  separate code paths interact with this legacy shape, with opposite
  type-guard rules:
  1. **Freshness check** (`Date.now() - cached.cachedAt < 5000`) — must
     NOT add a `typeof cached.cachedAt === 'number'` guard. On legacy
     rows, `cached.cachedAt` is `undefined`, `NaN < 5000` is `false`, and
     the value is correctly treated as stale. Tightening the check would
     flip this to fresh and skip the probe-refresh that brings the row
     into the new shape.
  2. **`fetchedAt` serialization** (returned in the response body) — MUST
     guard with `typeof cached.cachedAt === 'number'`. Without the guard,
     `new Date(undefined).toISOString()` produces `"Invalid Date"` in the
     response, breaking the ISO-string contract. On legacy rows the
     fallback returns `new Date().toISOString()` (wall clock) instead.
  The two rules coexist because the freshness check cares about the
  boolean outcome of a numeric comparison (where `NaN` usefully falls to
  false), while the serialization path cares about producing a valid
  string. Add code comments at both sites.
- **Probe timeout must clear `contextUsageProbeInFlight`** — the
  `.finally(() => { this.contextUsageProbeInFlight = null })` branch fires
  for both resolution paths and for timeout-reject. If a stuck probe
  eventually resolves after its timeout, the late resolution is harmless
  (its value is discarded); if it rejects, same thing. The critical
  invariant: no call path can leave `contextUsageProbeInFlight` set to a
  stuck promise beyond the 3s window.
- **REST endpoints need auth** — the new TanStack Start routes must
  enforce the same session-cookie check as other `/api/sessions/:id/*`
  routes. Copy the pattern from the existing `GET /api/sessions/:id`
  handler; do not roll a new auth flow.
- **In-flight dedupe uses DO-local in-memory promise** — this is safe
  because the DO is single-threaded. If the DO rehydrates mid-probe,
  the promise is lost and the next caller kicks off a fresh probe —
  acceptable (a single wasted gateway round-trip, not a correctness
  issue).
- **`syncKataToD1()` already populates kataMode** — `getKataState()`
  just reads the D1 row; don't duplicate the event-handling logic in
  the getter.
- **`shouldSendProtocolMessages` returning `false` affects ALL protocol
  frames, not just state** — the existing frames the SDK sends include
  state updates, schedule events, and some internal pings. Verify via WS
  capture after the change that no needed frame is accidentally
  suppressed. If any non-state protocol frame is needed, narrow the
  filter to block only state frames (`connection-state`-specific
  predicate); this is why it's a one-liner but deserves a careful wire
  capture before merging P5.
- **Deleting `this.setState` call sites without replacement loses D1
  sync** — every former `updateState({status:'running'})` call must be
  audited to ensure a corresponding D1-mirror call (`syncStatusToD1()`
  etc.) is either already present elsewhere on the same code path or
  added explicitly. Research R1 mapped all 17 sites; implementer
  follows the mapping.
- **`onStateUpdate` cannot safely be deleted from `useAgent` prop in
  older Agents SDK versions** — it may be a required prop. Pass a
  no-op `() => {}` in P4, remove the prop entirely only after confirming
  the SDK version accepts omitting it. Fallback: keep as no-op forever;
  costs nothing.

### Reference Docs

- [Cloudflare Agents SDK — `shouldSendProtocolMessages`](https://developers.cloudflare.com/agents/api-reference/agent/) — the existing escape hatch we're extending.
- [TanStack DB — Live Queries](https://tanstack.com/db/latest/docs/guides/live-queries) — `useLiveQuery` and selector patterns for B6/B7.
- [TanStack Start — API Routes](https://tanstack.com/start/latest/docs/framework/react/api-routes) — the pattern the new `/api/sessions/:id/context-usage` and `/kata-state` routes follow.
- [planning/specs/14-messages-transport-unification.md](./14-messages-transport-unification.md) — the predecessor spec establishing the seq'd messages channel that this one builds on.
- [planning/research/2026-04-20-unified-sync-channel.md](../research/2026-04-20-unified-sync-channel.md) — the research doc with all 7 deep-dive findings (R1-R7) and the decision matrix that drove this spec.
- [GH#25](https://github.com/baseplane-ai/duraclaw/issues/25) — the `messageSeq` rehydrate-drop bug resolved by P1.
- [GH#31](https://github.com/baseplane-ai/duraclaw/issues/31) — this spec's tracking issue, with the 3 user-visible bugs.
