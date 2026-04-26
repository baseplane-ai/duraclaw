---
initiative: sdk-peelback
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 102
created: 2026-04-25
updated: 2026-04-25
last_review_score: 92
last_review_status: PASS
related_issues: [101, 100, 30]
related_specs:
  - planning/specs/101-session-do-refactor.md
  - planning/specs/30-runner-adapter-pluggable.md
  - planning/specs/50-status-ttl.md
related_research:
  - planning/research/2026-04-25-sdk-interference-peelback.md
  - planning/research/2026-04-23-sdk-mid-stream-input-api.md
  - planning/research/2026-04-25-session-do-refactor-multi-sdk-prep.md
phases:
  - id: p0
    name: "Verification spike — lock the contract before deletion"
    tasks:
      - "Spike test: spawn a real Claude session in dev, exhaust enough tokens to trigger auto-compact, capture every `SDKMessage` variant emitted between spawn and compact-complete. Confirm `SDKStatusMessage{status:'compacting'}` is emitted (and that it's distinct from `SDKSessionStateChangedMessage`). **Contingency:** if `SDKStatusMessage{status:'compacting'}` is NOT emitted in the captured trace, drop the `compacting` state from B1's wire enum; the residual watchdog (B2) then treats compact as a quiet-but-active interval (`SDKCompactBoundaryMessage` arrival is itself activity). Document the chosen path in the addendum"
      - "Spike test: trigger a `SDKAPIRetryMessage` by forcing a 529 (set `ANTHROPIC_API_KEY` to an invalid value mid-turn, or proxy-inject a 529). Capture the message shape and confirm the SDK does not also emit a `session_state_changed` for the retry"
      - "Spike test: trigger `reloadPlugins()` and confirm whether `session_state_changed` fires (research marked [uncertain])"
      - "Spike test: `Query.interrupt()` survival contract on a lifetime async-iterable. Construct a `PushPullQueue` prototype, pass it to `query({prompt: queue})`, push two SDKUserMessages with a `q.interrupt()` between them. Confirm: (a) the `for await` loop yields the interruption sentinel (typically a `result` message with `subtype: 'interrupted'`) without throwing, (b) the next pushed message is consumed by the same Query without re-construction, (c) `q.interrupt()` does NOT call `transport.endInput()` or otherwise close the prompt iterable. This is the single most load-bearing assumption of Reduction B; if it fails, B's design is wrong"
      - "Confirm `ContextBar` rendering path: grep that it reads `contextUsage` from `sessionsCollection` (D1-synced row) and not from a `context_usage`-only client subscription. Verify the `result` event invalidation in `use-coding-agent.ts` will keep ContextBar fresh after Reduction A folds context_usage into result"
      - "Confirm `SDKCompactBoundaryMessage` shape in dev: only `pre_tokens` (no `post_tokens`); `preserved_segment` uuids when present; emission timing (before vs after the SDK has written the compacted transcript)"
      - "Document findings in `planning/research/2026-04-26-sdk-peelback-spike.md` (a thin addendum to the umbrella research) before any P1+ code lands"
    test_cases:
      - id: "spike-state-trigger-matrix"
        description: "A documented matrix of which SDK message fires for each runtime event (turn-start, turn-end, gate-open, gate-resolved, compact-start, compact-complete, api-retry, plugin-reload, clean-stop, abort)"
        type: "research"
      - id: "spike-compact-shape"
        description: "Sample SDKCompactBoundaryMessage from a real session captured in the addendum, with all field values redacted-but-typed (e.g. `pre_tokens: <number>`)"
        type: "research"
      - id: "spike-interrupt-survives-lifetime-iterable"
        description: "Reduction B's load-bearing assumption: q.interrupt() called between two pushed messages on a lifetime PushPullQueue does NOT close the prompt iterable, the for-await loop yields a clean interruption sentinel, and the next push is consumed by the same Query. Reproducible test script + transcript captured in the addendum"
        type: "research"
      - id: "context-bar-decoupled"
        description: "ContextBar's data source is `sessionsCollection` (D1-synced); cutting the WS context_usage event does not break it because the `result` event triggers the same query invalidation"
        type: "research"
  - id: p1
    name: "Reduction C — session_state_changed liveness; delete heartbeat"
    tasks:
      - "Add `SDKSessionStateChangedMessage` translation in `packages/session-runner/src/claude-runner.ts` `processQueryMessages` switch — emit a new `session_state_changed` GatewayEvent with `{ state: 'idle' | 'running' | 'requires_action', sdk_session_id, ts }`"
      - "Add `SDKStatusMessage` translation — when `status === 'compacting'`, emit a `session_state_changed` with `state: 'compacting'` (extends the wire enum beyond SDK's three values to capture the residual states the SDK tracks via SDKStatusMessage)"
      - "Add `SDKAPIRetryMessage` translation — emit a `session_state_changed` with `state: 'api_retry'` plus the api_retry payload (covered by Reduction D's dedicated event; this entry covers the liveness signal only)"
      - "Add `SessionStateChangedEvent` type to `packages/shared-types/src/index.ts` GatewayEvent union — include the extended state enum (`idle | running | requires_action | compacting | api_retry`)"
      - "DO ingestion: in the gateway-event switch, on `session_state_changed`, update `lastGatewayActivity` (rename to `lastAnyEventTs` in this phase) AND update SessionMeta state-derived fields. Reframe the alarm cycle's stale check from 'no heartbeat in N seconds' to 'no event of any kind in 90 seconds AND WS to runner is not OPEN' — matches B2's threshold; staleness is ONLY declared when both conditions hold (a quiet session with an OPEN WS is healthy)"
      - "Map `session_state_changed.state` → `SessionMeta.status` in `apps/orchestrator/src/agents/session-do.ts` (or in the eventual `status.ts` module per #101 P1). Mapping rules: `idle` → `idle`; `running` → `running`; `requires_action` → look up the most recent unresolved gate part via `findPendingGatePart()` (already exists in session-do.ts) — if its `type` is `permission-request` map to `waiting_permission`; if `ask-user` map to `waiting_input`; otherwise (no pending gate found, which shouldn't happen but is defensive) map to generic `waiting_gate`; `compacting` and `api_retry` → do NOT change `SessionMeta.status` (status stays at whatever its previous value was — typically `running`). Persist the transient state separately in a new `SessionMeta.transient_state` field (`null | 'compacting' | 'api_retry'`). **This field is SCAFFOLD-ONLY in this spec** — added so the data is not lost on the DO side, but no UI consumer reads it yet, no broadcast frame includes it, no migration test asserts on it beyond presence. A future UX spec (transcript-seam design — see Non-Goals) will wire it. The only requirement here: the field exists on `SessionMeta`, is updated on `compacting`/`api_retry` arrival, and is reset to `null` on the next non-transient state-change event"
      - "Delete `HeartbeatEvent` from `packages/shared-types/src/index.ts:179-183` and from the `GatewayEvent` union"
      - "Delete the heartbeat emit loop in `packages/session-runner/src/main.ts:36,473-479` (the `setInterval`, the `HEARTBEAT_INTERVAL_MS` constant, the heartbeat send call)"
      - "Delete the DO `case 'heartbeat':` no-op handler at `apps/orchestrator/src/agents/session-do.ts:5442-5446`"
      - "Update `packages/shared-types/src/index.test.ts` to drop heartbeat-related test cases"
      - "Update `apps/orchestrator/src/agents/session-do.test.ts` for the lastGatewayActivity → lastAnyEventTs rename and the new event-source for liveness"
      - "Verify: `pnpm typecheck`, `pnpm test`, manual smoke (spawn → stream → idle for 60s → confirm session stays connected without heartbeat; UI status remains `running` during compact and api_retry; status transitions to `idle` after turn complete; SIGKILL the runner → DO marks session stale within ~90s via residual watchdog)"
    test_cases:
      - id: "session-state-changed-emitted"
        description: "After spawn, the runner emits a session_state_changed event with state='running' on first SDK turn-start, state='requires_action' when a gate opens, state='idle' on turn complete. Captured in dev via wrangler tail or event_log"
        type: "integration"
      - id: "compact-still-tracked"
        description: "During a real auto-compact event, runner emits session_state_changed{state:'compacting'} — DO records it as activity, status remains 'running' from the user's perspective"
        type: "integration"
      - id: "heartbeat-fully-deleted"
        description: "grep -r 'HeartbeatEvent\\|heartbeat' packages/ apps/ --include='*.ts' returns only test fixtures or comments — no live emit/handle code. Specifically: HEARTBEAT_INTERVAL_MS constant gone from main.ts; case 'heartbeat' gone from session-do.ts"
        type: "metric"
      - id: "residual-watchdog-fires-on-sigkill"
        description: "Spawn a session, kill -9 the runner PID. Within 90s the DO transitions the session to a recovery/error state via the alarm cycle (no event in N seconds + WS disconnected = recover)"
        type: "integration"
      - id: "ui-contract-stable"
        description: "useSessionStatus output for a normal Claude session pre- and post-Reduction-C is identical (same status transitions in the same sequence). No UI hook changes required"
        type: "regression"
  - id: p2
    name: "Reduction B — one Query per session via lifetime AsyncIterable; fix streamInput half-close bug"
    tasks:
      - "Implement `PushPullQueue<T>` utility in `packages/session-runner/src/push-pull-queue.ts` (per `planning/research/2026-04-23-sdk-mid-stream-input-api.md` §`PushPullQueue` recommendation): a queue with `push(item)`, `close()`, and an async iterator that yields enqueued items in FIFO order and resolves to `done:true` after `close()` flushes"
      - "Refactor `claude-runner.ts:780-846` to use a single `query({ prompt: queue, options })` call constructed once at session start. Drop the per-turn re-call pattern. The lifetime queue receives the initial user message at session-start and every subsequent stream-input"
      - "Wire `stream-input` GatewayCommand → `queue.push(SDKUserMessage)` (no Query construction)"
      - "Wire `interrupt` GatewayCommand → `q.interrupt()` ONLY. Do NOT touch the queue. The current turn's iteration yields a sentinel result message; the next pushed stream-input is consumed by the same Query. (Locked by P0 `spike-interrupt-survives-lifetime-iterable`.)"
      - "Wire `stop` GatewayCommand → `queue.close()` followed by SIGTERM watchdog (Query exhausts naturally; subprocess exits)"
      - "Delete the multi-turn loop in `claude-runner.ts:796-846` — the `for await` consumes the single Query for the session lifetime. `processQueryMessages` body remains unchanged (it processes whichever message is in the iterator)"
      - "Delete `claude-runner.ts:780-786` (`initialPrompt` async generator) and `claude-runner.ts:830-836` (`followUpPrompt` async generator) — both replaced by the lifetime queue"
      - "Delete `claude-runner.ts:183-247` (`createMessageQueue`) — replaced by `PushPullQueue`"
      - "Delete `commands.ts:11-87` (`QueueableCommand` union, `handleQueryCommand`) — once Query is always live after `system.init`, the 'queue commands until Query is ready' plumbing is unnecessary. Direct method calls on `ctx.query` replace the dispatch"
      - "Delete the `q.streamInput()` call at `main.ts:178` (the bug). The lifetime queue replaces it; no mid-flight `streamInput()` call needed"
      - "Confirm `forkWithHistory` orphan recovery still works — spawning a fresh runner with a serialized history prefix is unaffected because forkWithHistory always starts a new runner process (and now a fresh lifetime Query)"
      - "Update `packages/session-runner/src/types.ts` `RunnerSessionContext`: drop the queueable-command queue field, keep `query: Query | null` (only null briefly during init)"
      - "Verify: `pnpm typecheck`, `pnpm test`. Manual smoke: spawn → first turn streams → second turn via stream-input streams (no resume re-query) → interrupt mid-second-turn → third turn via stream-input streams → stop → runner exits cleanly. Compare `event_log` per-turn timing pre vs post: turn-2 should have lower latency (no query-construction overhead)"
    test_cases:
      - id: "single-query-lifetime"
        description: "claude-runner constructs exactly one Query per spawn. Confirmed by adding a counter log on `query()` call and verifying it logs once for a multi-turn session"
        type: "integration"
      - id: "stream-input-no-half-close"
        description: "After the first user turn completes, send a second stream-input. The runner's stdin to the CLI subprocess is not half-closed. Verified by confirming the CLI process responds to the second message (not the bug where the second send goes to closed stdin)"
        type: "regression"
      - id: "interrupt-leaves-query-alive"
        description: "Send a long-running message → interrupt mid-turn → send another stream-input. The second message processes successfully without re-spawning the runner or re-constructing the Query"
        type: "integration"
      - id: "stop-closes-cleanly"
        description: "Send `stop` → runner closes the queue, subprocess receives SIGTERM, exits within 2s without orphaned children"
        type: "integration"
      - id: "queueable-command-queue-deleted"
        description: "grep -r 'QueueableCommand\\|handleQueryCommand' packages/session-runner/src/ returns zero hits. commands.ts is empty or deleted"
        type: "metric"
      - id: "loc-delta-budget"
        description: "Net deletion in claude-runner.ts ≥ 200 LoC. Net deletion across packages/session-runner ≥ 250 LoC. Measured via git diff stat"
        type: "metric"
  - id: p3
    name: "Reduction A — wire surface shrink (14→6 commands, 26→~14 events)"
    tasks:
      - "Delete `RewindCommand` from `packages/shared-types/src/index.ts` (verified CUT-SAFE — no UI button). Delete `case 'rewind'` handler in `packages/session-runner/src/main.ts:247-271` and the corresponding test fixtures in `packages/shared-types/src/index.test.ts:163,285`"
      - "Delete `AbortCommand` from shared-types — collapsed into `interrupt` (cancel current turn) + `stop` (terminate runner). Update any call site that emits `abort` to emit one of those instead. Verify zero remaining `type: 'abort'` emissions"
      - "Delete `SetModelCommand` and `SetPermissionModeCommand` from shared-types. The corresponding handlers in `commands.ts` are already deleted under Reduction B (P2). Re-confirm zero UI surface emits these (audit finding: zero hits in apps/orchestrator/src). The `--model` and `--permission-mode` are set at execute-time via `ExecuteCommand.options` which remains unchanged"
      - "Delete `GetContextUsageCommand` from shared-types. The `context_usage` is folded into `ResultEvent` as a new optional `context_usage?: { input_tokens, output_tokens, total_tokens, max_tokens, percentage, model, auto_compact_at? }` attachment. The DO HTTP endpoint at `session-do.ts:693-698` (REST `GET /context-usage`) stays — it backs admin/debug, not the live UI"
      - "Delete `StopTaskCommand` from shared-types. The `stop-task` wire verb was never wired through to `Query.stopTask()` (research finding). Defer until needed"
      - "Delete `ContextUsageEvent` from shared-types — its data is now an attachment on `ResultEvent`"
      - "Delete `RewindResultEvent` from shared-types — its data is now an attachment on `ResultEvent` (since `rewind` is also being cut, this is doubly-redundant)"
      - "Delete the four `mode_transition*` events from shared-types: `ModeTransitionEvent`, `ModeTransitionTimeoutEvent`, `ModeTransitionPreambleDegradedEvent`, `ModeTransitionFlushTimeoutEvent`. Audit finding: zero wire emission, DO-internal only (acp-codex-runner research line 100 confirms). DO-internal mode-transition logic stays — only the wire types are deleted"
      - "Update `ResultEvent` shape in `packages/shared-types/src/index.ts`: add optional `context_usage?: WireContextUsage` attachment. Define `WireContextUsage` in shared-types using snake_case (matches all other wire types). The UI-side camelCase `ContextUsage` in `apps/orchestrator/src/stores/status-bar.ts` stays — add a transform function at the synced-collection ingest boundary that maps wire snake_case → store camelCase. Do NOT move `ContextUsage` out of stores/status-bar.ts; the wire type is a sibling, not a replacement"
      - "Update the runner's `result` event emission in `claude-runner.ts` to populate `context_usage` from the most recent SDK context-state observation (it's already tracked internally for the now-deleted `get-context-usage` command)"
      - "Update the DO's `case 'result':` handler at `apps/orchestrator/src/agents/session-do.ts` to consume `event.context_usage` from the result and trigger the existing context_usage D1-write debounce (line 2576-2599)"
      - "Update `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:565-572` to drop the `context_usage` event-type branch — `result` events already trigger sessions-query invalidation, which refreshes ContextBar"
      - "Out of scope (NOT cut here): `chain_advance`/`chain_stalled` events — wired to chain UI per audit (use-coding-agent.ts:577,583; chain-status-item.tsx:149-152). Defer per research recommendation until kata chains are fully wired"
      - "Out of scope (NOT cut here): `permission-response`, `answer` commands and `ask_user`, `permission_request` events — owned by #100"
      - "Update `packages/shared-types/src/index.test.ts` — delete tests for cut types"
      - "Verify: `pnpm typecheck` clean across all workspaces. `pnpm test` clean. Manual smoke: full session (spawn → multi-turn → gate → resolve → result) — ContextBar shows percentage updates after each result. No regressions in chain UI (chain_advance/stalled still flow)"
    test_cases:
      - id: "wire-commands-six-only"
        description: "GatewayCommand union in shared-types/src/index.ts has exactly: execute, resume, stream-input, interrupt, stop, ping, plus the gate-related verbs owned by #100 (permission-response, answer). Total ≤ 8. No abort, set-model, set-permission-mode, get-context-usage, rewind, stop-task"
        type: "metric"
      - id: "wire-events-shrunk"
        description: "GatewayEvent union has: session.init, session_state_changed (new), partial_assistant, assistant, tool_use_summary, tool_result, ask_user, permission_request, file_changed, result, error, stopped, gap, title_update, kata_state, chain_advance, chain_stalled, rate_limit, plus the two adoptions in P4 (compact_boundary, api_retry). No heartbeat, context_usage, rewind_result, mode_transition* (×4)"
        type: "metric"
      - id: "context-usage-on-result"
        description: "After a normal Claude turn completes, the result event payload includes context_usage with input_tokens/output_tokens/total_tokens/max_tokens/percentage. ContextBar updates on the next render"
        type: "integration"
      - id: "no-rewind-callsites"
        description: "grep -r \"type: 'rewind'\\|RewindCommand\\|RewindResultEvent\" packages/ apps/ --include='*.ts' returns zero hits in src files (test fixtures may keep references for deletion-confirmation tests)"
        type: "metric"
      - id: "chain-events-still-flow"
        description: "chain_advance and chain_stalled events still flow runner→DO→client. Chain UI (chain-status-item.tsx) renders correctly during a chain run"
        type: "regression"
  - id: p4
    name: "Reduction D — adopt compact_boundary and api_retry SDK signals"
    tasks:
      - "Add `CompactBoundaryEvent` type to `packages/shared-types/src/index.ts` GatewayEvent union: `{ type: 'compact_boundary', session_id, seq, trigger: 'manual' | 'auto', pre_tokens: number, preserved_segment?: { head_uuid: string, anchor_uuid: string, tail_uuid: string }, ts: number }`. NOTE: there is NO `post_tokens` field — the SDK message does not carry it (verified via P0 spike)"
      - "Add `ApiRetryEvent` type to `packages/shared-types/src/index.ts` GatewayEvent union: `{ type: 'api_retry', session_id, seq, attempt: number, max_attempts: number, delay_ms: number, error_class: 'rate_limit' | 'server_error' | 'overloaded' | 'billing_error' | 'unknown', error_message?: string, ts: number }`. The error_class enum captures the structured failure family the SDK reports"
      - "Translate `SDKCompactBoundaryMessage` (sdk.d.ts:2008-2025) to `compact_boundary` in `claude-runner.ts processQueryMessages`. Pass through `trigger` and `pre_tokens`; pass through `preserved_segment` if present"
      - "Translate `SDKAPIRetryMessage` (sdk.d.ts:1974-1982) to `api_retry`. Map the SDK `error_class` enum to our wire enum via this table (1:1 today, plus `default → 'unknown'` for forward-compat against new SDK enum values): `'rate_limit' → 'rate_limit'`; `'server_error' → 'server_error'`; `'overloaded' → 'overloaded'`; `'billing_error' → 'billing_error'`; **any other SDK-emitted value → `'unknown'`** (do not throw, do not skip the event — log a warn-level event_log entry with the unmapped value so we can spot SDK enum drift). Document this exact table in a code comment at the `mapErrorClass()` site so future SDK upgrades have a single review point"
      - "DO event-handler: persist `compact_boundary` events to a new SessionMessagePart (or as a system-flavored entry in the message stream — implementer decides between (a) a synthetic `system-event` SessionMessagePart with type='compact_boundary' or (b) a separate `compact_boundaries` SQLite table). Recommend (a) for consistency with how `system` messages already render in the transcript"
      - "DO event-handler: do NOT persist `api_retry` events to the message stream. Broadcast them as a transient frame on the WS only (so an in-tab session displays a banner) and emit one logEvent entry per retry for diagnostic replay. Once the retry succeeds (next `partial_assistant` or `result` arrives), the banner UI clears via timeout"
      - "Add `compact_boundary` and `api_retry` cases to the DO's `handleGatewayEvent` switch — both pass through `broadcastGatewayEvent` so the client receives them"
      - "Add `compact_boundary` consumer in `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` — appends a stub `system-event` SessionMessagePart with the seam metadata. Transcript-seam UI rendering (history dimming, token-savings chip) is OUT OF SCOPE — sibling spec owns that. This phase ships the wire/DO plumbing only; the system-event part renders as plain text 'Context compacted at <pre_tokens> tokens' until the UX spec lands"
      - "Add `api_retry` consumer in `use-coding-agent.ts` — fan out to a transient `apiRetryStore` (new file `apps/orchestrator/src/stores/api-retry-store.ts`) that drives a banner component. Use the existing banner pattern from `apps/orchestrator/src/components/disconnected-banner.tsx` as the reference; copy its bg-warning/20 + border-icon + dismiss layout. Banner content: 'Retrying request (attempt N of M, retrying in Xs)…' plus error_class chip"
      - "Add `ApiRetryBanner` component at `apps/orchestrator/src/components/api-retry-banner.tsx`. Mount it once in `__root.tsx` alongside the existing connection banners. Auto-clear on next non-retry event (partial_assistant, assistant, result) or 30s timeout, whichever first"
      - "Update `packages/shared-types/src/index.test.ts` — add tests for the two new event types"
      - "Verify: `pnpm typecheck`, `pnpm test`. Manual smoke: trigger a real auto-compact (long session) → verify a system-event part is appended with pre_tokens. Force an api_retry (proxy 529 mid-turn) → verify ApiRetryBanner appears and clears after retry succeeds"
    test_cases:
      - id: "compact-boundary-emitted-on-real-compact"
        description: "In dev, build context past auto-compact threshold; runner emits a compact_boundary event with trigger='auto' and pre_tokens > 0. The event reaches the DO and is persisted to messagesCollection as a system-event part"
        type: "integration"
      - id: "api-retry-banner-shows-and-clears"
        description: "Inject a 529 via proxy mid-turn; ApiRetryBanner appears with attempt/delay info; on retry success the banner auto-dismisses"
        type: "integration"
      - id: "compact-boundary-shape-matches-sdk"
        description: "Unit test in claude-runner: given a synthetic SDKCompactBoundaryMessage with all fields populated, the resulting CompactBoundaryEvent has correct trigger, pre_tokens, preserved_segment values. Verifies no field is lost in translation"
        type: "unit"
      - id: "api-retry-error-class-mapping"
        description: "Unit test: each SDK error-class value maps to the documented wire enum value. Unknown SDK classes map to 'unknown' (forward-compat)"
        type: "unit"
      - id: "no-message-stream-pollution-on-retry"
        description: "api_retry events do NOT append a SessionMessagePart to messagesCollection. They flow through the transient store only. Verified by counting messagesCollection rows before/after a triggered retry — count unchanged"
        type: "regression"
---

# Spec: SDK Interference Peel-back — Collapse the Runner↔DO Wire to the Essentials

## Overview

The runner↔DO wire surface has accreted into a near-1:1 proxy of the
Claude Agent SDK *plus* a parallel hand-rolled liveness/multi-turn
stack — 14 wire commands, 26 wire events, a per-turn `query({resume})`
loop instead of `Query.streamInput()`, a 5-layer liveness derivation,
and 11 SDK message variants dropped on the floor. This spec lands the
four reductions (A/B/C/D) that collapse the wire to ~6 verbs / ~14
events, switch to one `Query` per session, replace the heartbeat-driven
liveness with SDK-native `session_state_changed`, and adopt the three
high-UX-value SDK messages currently dropped (`session_state_changed`,
`compact_boundary`, `api_retry`). Reduction E — moving
`gateway-event-mapper.ts` from the DO to the runner — stays under spec
#101 Phase 3 and is referenced as a dependency, not re-owned here.

Net delete: ~600 LoC across runner + DO + shared-types, with **zero UI
hook contract changes**. The `useSessionStatus` output surface is
preserved exactly — only the input signal changes.

## Feature Behaviors

### B1: SDK-native liveness via `session_state_changed`

**Core:**
- **ID:** liveness-via-state-changed
- **Trigger:** Any of {SDK turn-start, SDK turn-end, SDK gate-open, SDK gate-resolve, SDK compact-start, SDK compact-end, SDK api-retry-start, SDK api-retry-end} fires inside the runner's Query message stream
- **Expected:** Runner translates the originating SDK message into a `session_state_changed` GatewayEvent with the appropriate `state` value (`idle | running | requires_action | compacting | api_retry`) and the next monotonic `seq`. DO ingests it as primary liveness input. UI status (`useSessionStatus`) derives the same status enum it does today (no contract change).
- **Verify:** With heartbeat fully deleted and no other liveness signal, a normal Claude session shows correct status transitions in the UI (idle → running → idle → running → waiting_gate → running → idle). Captured in dev via WS frame logging.
**Source:** `packages/session-runner/src/claude-runner.ts` `processQueryMessages` switch; `apps/orchestrator/src/agents/session-do.ts` (or `status.ts` post-#101)

#### API Layer
- New event in `packages/shared-types/src/index.ts`:
  ```typescript
  interface SessionStateChangedEvent {
    type: 'session_state_changed'
    session_id: string
    seq: number
    state: 'idle' | 'running' | 'requires_action' | 'compacting' | 'api_retry'
    ts: number
  }
  ```
- The `state` enum is wider than the SDK's three-value enum because `compacting` and `api_retry` are derived from `SDKStatusMessage` and `SDKAPIRetryMessage` respectively (the SDK does not emit `session_state_changed` for those — verified in P0 spike).

---

### B2: Residual watchdog covers SIGKILL, network partition, and SDK stalls

**Core:**
- **ID:** residual-watchdog
- **Trigger:** No event of any kind has arrived from the runner for ≥ 90 seconds AND the WS to the runner is not OPEN
- **Expected:** DO transitions the session through the existing recovery-grace path. **In the pre-#101 world** (this spec lands ahead of #101): the alarm handler in `apps/orchestrator/src/agents/session-do.ts` already implements this path today — it checks `lastGatewayActivity` against `staleThresholdMs` (`session-do-helpers.ts`), and when the threshold is exceeded with no live WS, calls `updateState({status: 'error'})` after a recovery grace period and emits a `stopped` event with a recovery reason. This spec preserves that behavior: only the input timestamp source flips from "last heartbeat" to "last anything (`lastAnyEventTs`)." **In the post-#101 world**: same logic, relocated into `watchdog.ts`. Either way, the watchdog is a strict last-resort safety net — compaction and api_retry produce activity events (B1) so they do NOT trip it.
- **Verify:** `kill -9` the runner PID mid-turn; within 90s the DO marks the session stale (D1 `agent_sessions.status` = `error` or recovery-pending) and broadcasts the recovery-state frame to connected clients.
**Source:** `apps/orchestrator/src/agents/session-do.ts` alarm handler (or `watchdog.ts` post-#101); `apps/orchestrator/src/agents/session-do-helpers.ts` `staleThresholdMs`

---

### B3: HeartbeatEvent fully removed

**Core:**
- **ID:** heartbeat-deleted
- **Trigger:** Code-search audit; CI metric check
- **Expected:** No file in `apps/`, `packages/` references `HeartbeatEvent`, `HEARTBEAT_INTERVAL_MS`, the `setInterval` heartbeat emit, or `case 'heartbeat':` outside test fixtures explicitly verifying the deletion. The `GatewayEvent` union does not contain `heartbeat`.
- **Verify:** `grep -r 'HeartbeatEvent\|HEARTBEAT_INTERVAL_MS' packages/ apps/ --include='*.ts' | wc -l` returns 0 in production code paths.
**Source:** `packages/shared-types/src/index.ts:179-183`; `packages/session-runner/src/main.ts:36,473-479`; `apps/orchestrator/src/agents/session-do.ts:5442-5446`

---

### B4: One Query per session via lifetime AsyncIterable

**Core:**
- **ID:** one-query-per-session
- **Trigger:** Runner spawn; subsequent stream-input commands during the session
- **Expected:** Exactly one `query()` call is made per runner process. The `prompt` argument is a `PushPullQueue<SDKUserMessage>` (lifetime async iterable). The first user turn is pushed at session start; subsequent stream-input commands push onto the same queue. The Query object survives `interrupt()` and only terminates on `stop` or fatal error.
- **Verify:** Add a counter log on `query()` invocation. After a 5-turn session with one interrupt, the counter shows exactly 1.
**Source:** `packages/session-runner/src/claude-runner.ts:529-846` (multi-turn loop replaced); `packages/session-runner/src/main.ts:178` (mid-flight streamInput call deleted)

**Interrupt contract (locked by P0 spike):**
- `interrupt` GatewayCommand → calls `q.interrupt()` directly. The PushPullQueue is NOT touched by interrupt — the queue stays open and continues to await the next push.
- The current turn's `for await (const message of q)` iteration yields a sentinel SDK message (typically `SDKResultMessage` with `subtype: 'interrupted'`) and the iteration continues normally on the next pushed message.
- If the P0 spike `spike-interrupt-survives-lifetime-iterable` fails (i.e., `q.interrupt()` actually does close the prompt iterable in the SDK we ship against), Reduction B's design is wrong — escalate to the user before P2 implementation. Fallback design under that contingency: keep one Query per push (essentially today's per-turn pattern but cleaner), which preserves Reductions A/C/D but loses the LoC delete budget for B.

**`execute` vs `resume` under the lifetime-queue model:**
Both wire commands map to a single `query()` invocation per runner process — exactly one Query for the runner's lifetime. The difference is in `query()`'s `options`:
- `execute` → `query({ prompt: queue, options: { ...common, model, permissionMode } })`
- `resume` → `query({ prompt: queue, options: { ...common, model, permissionMode, resume: sdk_session_id } })`
The lifetime queue is constructed identically in both paths and primed with the initial user message from the spawn `cmd` file. After construction, both paths converge on the same `for await (const message of q)` loop and the same stream-input/interrupt/stop handlers. Resume therefore loses no functionality under Reduction B — it just sets one extra option at construction.

The orphan-recovery path (forkWithHistory, see `.claude/rules/session-lifecycle.md` §4) is unaffected: it always spawns a fresh runner with serialized history embedded in the initial prompt; the runner constructs its lifetime queue normally.

#### API Layer
- No wire-protocol change. The `stream-input`, `execute`, and `resume` GatewayCommand shapes are preserved.

---

### B5: streamInput half-close bug fixed by replacement

**Core:**
- **ID:** stream-input-bug-fixed
- **Trigger:** Second user turn in a Claude session
- **Expected:** The runner does not call `q.streamInput()` mid-flight. The lifetime queue (B4) replaces it. The CLI subprocess's stdin remains open for the lifetime of the session.
- **Verify:** Send a second stream-input after the first turn completes. The CLI responds normally (does not hang on closed stdin). Latent bug at `main.ts:178` is gone.
**Source:** `packages/session-runner/src/main.ts:178`

**Note:** The bug was identified independently in research `2026-04-25-sdk-interference-peelback.md` (Item 3 / "bug-shaped finding"). Per user direction in the planning interview, the fix posture is delete-as-part-of-B (full Reduction B replaces it), not a one-line band-aid.

---

### B6: QueueableCommand queue removed

**Core:**
- **ID:** command-queue-deleted
- **Trigger:** Code-search audit; runner internals review
- **Expected:** `commands.ts` no longer exports `QueueableCommand`, `handleQueryCommand`, or any "queue commands until Query is ready" logic. After Reduction B, `ctx.query` is non-null from immediately after `system.init`; commands invoke methods directly. The plumbing for the pre-Query-available state collapses.
- **Verify:** `grep -r 'QueueableCommand\|handleQueryCommand' packages/session-runner/src/ --include='*.ts'` returns zero hits. `commands.ts` may be deleted entirely or shrunk to a thin command-dispatch helper.
**Source:** `packages/session-runner/src/commands.ts:11-87`

---

### B7: Wire commands shrunk to six core verbs

**Core:**
- **ID:** wire-commands-six
- **Trigger:** Code review of `GatewayCommand` union in `packages/shared-types/src/index.ts`
- **Expected:** The union contains exactly `execute`, `resume`, `stream-input`, `interrupt`, `stop`, `ping`, plus `permission-response` and `answer` (owned by #100). Cut: `abort`, `set-model`, `set-permission-mode`, `get-context-usage`, `rewind`, `stop-task`. Total command types ≤ 8.
- **Verify:** `grep -E "type: '(abort|set-model|set-permission-mode|get-context-usage|rewind|stop-task)'" packages/ apps/ -r --include='*.ts'` returns zero hits in production code.
**Source:** `packages/shared-types/src/index.ts:3-18`

**Note on `ping`:** The `ping` verb in the keep-list is the existing transport keepalive used by `shared-transport`'s dial-back client to test liveness on the runner→DO WS independently of SDK activity. It is preserved as-is — neither cut nor expanded. Reduction C deletes the runner-emitted `heartbeat` *event* (the SDK-activity-loop signal); transport-level `ping` is a separate concern at the WS framing layer and stays.

---

### B8: context_usage folded into result event

**Core:**
- **ID:** context-usage-on-result
- **Trigger:** Runner emits `result` event at end of each turn
- **Expected:** `ResultEvent` carries an optional `context_usage?: WireContextUsage` attachment. **Wire convention is snake_case** to match the rest of the wire types (`pre_tokens`, `delay_ms`, `max_attempts`, etc.). The existing UI-store `ContextUsage` type stays camelCase; the synced-collection mapping in `apps/orchestrator/src/db/sessions-collection.ts` (or equivalent) transforms `WireContextUsage` (snake_case) → `ContextUsage` (camelCase) on ingest. The DO's existing 5s-debounced D1-write of context_usage_json (session-do.ts:2576-2599) reads from `event.context_usage` instead of from a separate `context_usage` event.
- **Verify:** After a turn completes, ContextBar in the status bar reflects the latest token counts. Standalone `context_usage` event no longer fires. Wire payload uses snake_case fields; UI components continue to read camelCase fields from the store.
**Source:** `packages/shared-types/src/index.ts` (ResultEvent extension + new `WireContextUsage` type); `apps/orchestrator/src/agents/session-do.ts:2576-2599`

#### API Layer
```typescript
// New in packages/shared-types/src/index.ts — wire-side, snake_case
interface WireContextUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  max_tokens: number
  percentage: number          // 0-100
  model: string
  auto_compact_at?: number    // tokens, when SDK reports it
}
// Existing UI-side ContextUsage in apps/orchestrator/src/stores/status-bar.ts
// stays camelCase; transform happens at the synced-collection ingest boundary.
```

#### Data Layer
- No schema change. `session_meta.context_usage_json` and `session_meta.context_usage_cached_at` columns stay; only the source event changes.

---

### B9: rewind_result and rewind command both deleted

**Core:**
- **ID:** rewind-cut
- **Trigger:** Code-search audit
- **Expected:** `RewindCommand`, `RewindResultEvent`, and the runner's `case 'rewind':` handler (main.ts:247-271) are deleted. The `q.rewindFiles()` SDK call is unused. No UI button exists today (audit verified).
- **Verify:** `grep -r "type: 'rewind'\|RewindCommand\|RewindResultEvent" packages/ apps/ --include='*.ts'` returns zero hits in production code.
**Source:** `packages/shared-types/src/index.ts:85-92,292-301`; `packages/session-runner/src/main.ts:247-271`

**Note:** If a rewind UX is later wanted, it returns under a new verb (e.g., `rewind-files`) and uses the SDK-native `q.rewindFiles()` directly. The current hand-rolled wire shape doesn't carry forward.

---

### B10: mode_transition events removed from wire

**Core:**
- **ID:** mode-transition-cut
- **Trigger:** Code-search audit
- **Expected:** `ModeTransitionEvent`, `ModeTransitionTimeoutEvent`, `ModeTransitionPreambleDegradedEvent`, `ModeTransitionFlushTimeoutEvent` are deleted from the `GatewayEvent` union. DO-internal mode-transition logic (which never crosses the wire) stays. Audit confirms zero wire emission today.
- **Verify:** `grep -r "ModeTransition" packages/shared-types/src/ --include='*.ts'` returns zero hits.
**Source:** `packages/shared-types/src/index.ts:226-258`

---

### B11: compact_boundary event adoption

**Core:**
- **ID:** compact-boundary-event
- **Trigger:** SDK emits `SDKCompactBoundaryMessage` (auto- or manual-triggered context compaction)
- **Expected:** Runner translates to a `compact_boundary` GatewayEvent carrying `trigger`, `pre_tokens`, and (when present) `preserved_segment` uuids. DO persists it as a system-flavored `SessionMessagePart` in `messagesCollection` so it appears in the transcript at the seam point. UI renders a plain "Context compacted at N tokens" stub until the sibling UX spec lands the full transcript-seam design (history dimming, token-savings chip).
- **Verify:** Build a session past the auto-compact threshold; the resulting transcript contains a system-event part with the seam data; ContextBar shows the post-compact reduced token count on the next result.
**Source:** new event type in `packages/shared-types/src/index.ts`; runner translation in `claude-runner.ts`; UI consumer stub in `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`

#### UI Layer
- Minimal: a system-event message part rendered as plain text. Full transcript-seam UX is OUT OF SCOPE — see Non-Goals.

#### API Layer
```typescript
interface CompactBoundaryEvent {
  type: 'compact_boundary'
  session_id: string
  seq: number
  trigger: 'manual' | 'auto'
  pre_tokens: number          // ONLY field — SDK does not provide post_tokens
  preserved_segment?: {
    head_uuid: string
    anchor_uuid: string
    tail_uuid: string
  }
  ts: number
}
```

#### Data Layer
- The system-event SessionMessagePart is appended to the existing `assistant_messages` table; no schema change.

---

### B12: api_retry event adoption

**Core:**
- **ID:** api-retry-event
- **Trigger:** SDK emits `SDKAPIRetryMessage` (transient API failure: 5xx, 529, rate-limit, billing)
- **Expected:** Runner translates to an `api_retry` GatewayEvent carrying `attempt`, `max_attempts`, `delay_ms`, `error_class`, and optional `error_message`. DO broadcasts it as a transient frame (NOT persisted to messagesCollection — retries are not transcript content). UI mounts an `ApiRetryBanner` driven by a transient `apiRetryStore`. Banner auto-clears on next non-retry event or 30s timeout.
- **Verify:** Inject a 529 via proxy; ApiRetryBanner appears with "Retrying (attempt 2/10, 5s)" plus an error-class chip; on retry success the banner clears.
**Source:** new event type in `packages/shared-types/src/index.ts`; runner translation in `claude-runner.ts`; new banner component at `apps/orchestrator/src/components/api-retry-banner.tsx`; new store at `apps/orchestrator/src/stores/api-retry-store.ts`

#### UI Layer
- New component `ApiRetryBanner` follows the existing banner pattern (`bg-warning/20`, border-icon, dismissable) from `disconnected-banner.tsx`.
- Mounted once in `__root.tsx`.
- Auto-clear on (a) next `partial_assistant`/`assistant`/`result` event, or (b) 30s elapsed since last retry, whichever first.

#### API Layer
```typescript
interface ApiRetryEvent {
  type: 'api_retry'
  session_id: string
  seq: number
  attempt: number
  max_attempts: number
  delay_ms: number
  error_class: 'rate_limit' | 'server_error' | 'overloaded' | 'billing_error' | 'unknown'
  error_message?: string
  ts: number
}
```

---

### B13: UI status contract preserved end-to-end

**Core:**
- **ID:** ui-contract-stable
- **Trigger:** Any user-facing status display that consumes `useSessionStatus`
- **Expected:** The `SessionStatus` enum exposed to UI components (`idle | pending | running | waiting_input | waiting_permission | waiting_gate | error`) is unchanged. The hook's output frame-by-frame is identical between pre- and post-peel-back for any equivalent SDK input. The DO's internal status derivation logic ingests `session_state_changed` instead of `heartbeat` + ad-hoc activity inference, but the output projection is preserved.
- **Verify:** Snapshot test: capture `useSessionStatus` outputs across a representative session pre-peel-back. Run the same scripted session post-peel-back; outputs match exactly. No UI component file changes for status display.
**Source:** `apps/orchestrator/src/db/session-local-collection.ts:126-129` (the hook); not modified.

---

## Non-Goals

- **Reduction E (move `gateway-event-mapper.ts` to runner)** — Owned by **spec #101 P3 / B11** (`pretranslated-parts`). This spec references it as a sibling but does not re-own it. Coordination point only.
- **`chain_advance` / `chain_stalled` event removal** — Currently wired to chain UI (`use-coding-agent.ts:577,583`, `chain-status-item.tsx:149-152`). Cannot be safely cut until kata chains are fully wired and either (a) the events are no longer needed, or (b) the chain UI is rewritten to read from a different source. Defer per the umbrella research.
- **`forkSession()` SDK adoption** — Verified in P0: `forkSession()` requires a JSONL transcript on disk, which only Claude provides. The hand-rolled `forkWithHistory` (which embeds history in a `<prior_conversation>` prompt prefix) is the multi-SDK-compatible approach and is preserved per spec #101 B10. NOT a follow-up.
- **`compact_boundary` transcript-seam UX design** — History dimming, token-savings chip, anchor-uuid relinking. Sibling UX spec owns this. This spec ships only the wire/DO plumbing and a plain-text stub render.
- **`api_retry` banner visual polish** — The banner uses the existing `disconnected-banner.tsx` pattern; final styling tuning, dismissable affordance, error-class iconography is sibling design work.
- **Gate verbs** (`permission-response`, `answer`, `ask_user`, `permission_request`) — Owned by **#100**. This spec assumes #100 lands either before, alongside, or after; the six core verbs (B7) explicitly exclude gates from the cut list. If #100 ships gate verbs in a renamed shape, this spec accommodates by reference, not redefinition.
- **`stream-input` mid-turn correctness audit** — Reduction B replaces the entire mid-turn pattern; the previous bug is a non-issue post-replacement. No additional audit needed.
- **`get-context-usage` REST endpoint** at `session-do.ts:693-698` — Stays. It backs admin/debug, not the live UI. Only the WS RPC verb is cut.
- **Streaming-aggregation persistence** — Flagged in #101 research as fragile (no transactional boundary on partial deltas). Out of scope for this spec; defer until prod evidence shows it bites.
- **Migration sediment cleanup** — 18 SQLite migrations including legacy v1–v3. Out of scope. Independent of this work.
- **PartyServer base-class migration** — Declined per `2026-04-22-session-do-partyserver-migration-feasibility.md`. Stays declined here.

## Implementation Phases

See frontmatter for full task and test_case breakdowns.

### Phase 0: Verification spike

- Spike test `session_state_changed` trigger matrix across compact/retry/plugin-reload to lock the contract before any code lands
- Verify `SDKCompactBoundaryMessage` shape (no `post_tokens`)
- Confirm ContextBar's data path (sessionsCollection-driven; result-invalidation keeps it fresh)
- Document findings as a thin addendum at `planning/research/2026-04-26-sdk-peelback-spike.md`
- **Done when:** Trigger matrix is documented; contract for B1's wire enum is locked; no surprises remain
- **Rollback:** Spike-only — no code changes to revert

### Phase 1: Reduction C — session_state_changed liveness

- Add `SessionStateChangedEvent` to wire types
- Translate `SDKSessionStateChangedMessage`, `SDKStatusMessage{compacting}`, `SDKAPIRetryMessage` to the new event
- Reframe DO `lastGatewayActivity` → `lastAnyEventTs`
- Delete `HeartbeatEvent` and the entire heartbeat plumbing (emit loop, no-op handler, type, tests)
- **Done when:** Heartbeat is gone, residual watchdog catches SIGKILL within 90s, UI status contract is identical
- **Rollback:** Single-PR. Revert restores heartbeat plus the new event (which is additive — keeping it is harmless even if liveness flips back to heartbeat). Or: full revert returns to pre-change state.

### Phase 2: Reduction B — one Query per session + bug fix

- Implement `PushPullQueue` utility
- Refactor `claude-runner.ts` to lifetime queue
- Delete multi-turn loop, `initialPrompt`/`followUpPrompt` generators, `createMessageQueue`, `QueueableCommand` queue
- Delete `streamInput()` mid-flight call at `main.ts:178`
- **Done when:** Single Query per session, second/third user turns work, interrupt + resume work, ≥250 LoC deleted from `packages/session-runner/`
- **Rollback:** Single-PR. The lifetime-queue pattern is contained in `claude-runner.ts`; revert restores the per-turn pattern.

### Phase 3: Reduction A — wire shrink

- Cut `abort`, `set-model`, `set-permission-mode`, `get-context-usage`, `rewind`, `stop-task` commands
- Cut `context_usage`, `rewind_result`, `mode_transition*` (×4) events
- Fold `context_usage` data onto `ResultEvent` as optional `context_usage?` attachment
- Hoist `ContextUsage` type from UI store into shared-types
- Update DO and UI to consume context_usage from result instead of standalone event
- **Done when:** GatewayCommand union has ≤ 8 types, GatewayEvent union has ≤ 18 types (excluding the two adoptions in P4), ContextBar still updates correctly
- **Rollback:** Single-PR. Revert restores the cut types. The `context_usage`-on-result fold is forward-compat — old runners still work because DO's case `'context_usage'` would still be present in the reverted code.

### Phase 4: Reduction D — compact_boundary + api_retry adoption

- Add `CompactBoundaryEvent` and `ApiRetryEvent` types
- Translate `SDKCompactBoundaryMessage` and `SDKAPIRetryMessage` in runner
- DO ingestion: persist compact_boundary as system-event part; broadcast api_retry as transient frame
- UI: stub render for compact_boundary system-event part; new `ApiRetryBanner` component
- **Done when:** Real auto-compact in dev produces a persisted system-event in messagesCollection; injected 529 produces a banner that auto-clears
- **Rollback:** Single-PR. Both are additive — revert simply drops the new events; existing UI continues to work without the banner / seam stub.

## Verification Plan

### VP0: Phase 0 — Spike verification

```
1. # In dev, spawn a Claude session and force auto-compact by pasting a
   # large file (~200K tokens) into the conversation.
2. wrangler tail --format json | grep -E 'compact|state_changed|status_message|api_retry'
3. # Confirm captured messages: SDKStatusMessage{status:'compacting'}
                                # appears before SDKCompactBoundaryMessage
                                # and after compact-complete the SDK
                                # emits the next SDKAssistantMessage normally.
4. # Force an api_retry by injecting a 529 via a proxy (mitmproxy --set
   # block-list='*api.anthropic.com/*:529-once' or similar)
5. # Capture the SDKAPIRetryMessage shape; record fields in the addendum.
6. # Audit ContextBar's data source:
   grep -n 'contextUsage' apps/orchestrator/src/components/status-bar.tsx
                                # expect: reads from useSession() / sessionsCollection
   grep -n 'context_usage' apps/orchestrator/src/features/agent-orch/use-coding-agent.ts
                                # expect: triggers query invalidation only
                                # (no separate WS subscription)
7. # Write addendum at planning/research/2026-04-26-sdk-peelback-spike.md
```

### VP1: Phase 1 — Liveness via session_state_changed

```
1. pnpm typecheck                    # expect: 0 errors
2. pnpm test                         # expect: all suites pass
3. # Spawn a Claude session via UI; observe wrangler tail:
   #   - On first user turn: session_state_changed{state:'running'}
   #   - On turn complete:   session_state_changed{state:'idle'}
   #   - On gate trigger:    session_state_changed{state:'requires_action'}
   #   - During compact:     session_state_changed{state:'compacting'}
4. # Verify heartbeat is gone:
   grep -r 'HeartbeatEvent\|HEARTBEAT_INTERVAL_MS' packages/ apps/ \
     --include='*.ts'
                                     # expect: only test fixtures or comments
5. # Verify residual watchdog: kill -9 the runner PID mid-session
   # Within 90s, the DO updates the session to status='error' on the D1
   # agent_sessions row (this is the existing recovery-grace endpoint —
   # session-do.ts alarm handler calls updateState({status: 'error'})
   # after the recovery grace expires with WS still down). Verify with:
   #   wrangler d1 execute duraclaw-auth --remote \
   #     --command "SELECT id, status FROM agent_sessions WHERE id='<sid>'"
   #                                  # expect: status='error'
   # AND a 'stopped' GatewayEvent with reason indicating recovery is
   # broadcast on the WS. (No intermediate 'recovery-pending' value
   # exists in D1 today — recovery is an in-DO grace timer, not a
   # persisted status. If this spec lands after #101 and the recovery
   # status is renamed, update this expectation accordingly.)
6. # UI contract verification: in dev, observe the status badge during
   # a normal session; confirm it shows the same labels as before
   # (running / idle / waiting_gate)
```

### VP2: Phase 2 — One Query per session

```
1. pnpm typecheck                    # expect: 0 errors
2. pnpm test                         # expect: all suites pass
3. # In claude-runner.ts, temporarily add console.count('query()') before
   # the query() call. Spawn a session and run 5 user turns.
   # tail the runner log: /run/duraclaw/sessions/<session-id>.log
                                     # expect: query() count = 1
4. # Send a stream-input mid-session:
   #   - First turn: "hello" → completes
   #   - Second turn: "what did I just say?"
   # Verify the second turn streams successfully (no half-closed stdin)
5. # Interrupt during a long turn:
   #   - Send a long-running prompt, click interrupt
   #   - Send another stream-input → confirms Query is alive
6. # Stop verification: send `stop` command, confirm runner exits cleanly
   # (no orphaned subprocess, exit file written)
7. # LoC delta:
   git log --oneline main..HEAD --stat -- packages/session-runner/
                                     # expect: net deletion ≥ 250 LoC
8. # Verify the queue is gone:
   grep -r 'QueueableCommand\|handleQueryCommand' \
     packages/session-runner/src/ --include='*.ts'
                                     # expect: 0 hits
```

### VP3: Phase 3 — Wire shrink

```
1. pnpm typecheck                    # expect: 0 errors across workspaces
2. pnpm test                         # expect: all suites pass
3. # Wire commands audit:
   grep -E "type: '(abort|set-model|set-permission-mode|get-context-usage|rewind|stop-task)'" \
     packages/ apps/ -r --include='*.ts'
                                     # expect: 0 hits in src files
4. # Wire events audit:
   grep -r "ModeTransition\|RewindResultEvent\|ContextUsageEvent" \
     packages/shared-types/src/ --include='*.ts'
                                     # expect: 0 hits
5. # Manual smoke: full session flow
   #   - Spawn → first turn → ContextBar shows token %
   #   - Second turn → ContextBar updates after result event
   #   - Trigger gate → resolve → another turn
   #   - Confirm chain UI still works (chain_advance/stalled flow unchanged)
6. # ContextBar still works:
   #   Open status bar; ContextBar shows current context usage as a
   #   percentage bar with token tooltip. Confirm the value matches
   #   the latest result event's context_usage.total_tokens
7. # No-rewind audit:
   grep -E "type: 'rewind'" packages/ apps/ --include='*.ts' -r
                                     # expect: 0 hits
```

### VP4: Phase 4 — compact_boundary + api_retry

```
1. pnpm typecheck                    # expect: 0 errors
2. pnpm test                         # expect: all suites pass
3. # Trigger real auto-compact (long session):
   #   - Spawn → paste a large file → continue conversation until SDK
   #     auto-compacts (visible in wrangler tail)
   #   - Verify compact_boundary event reaches DO
   #   - Verify a system-event SessionMessagePart is appended to
   #     messagesCollection with type: 'system-event' and the seam metadata
   #     (trigger, pre_tokens, preserved_segment if present)
4. # Trigger api_retry via proxy (mitmproxy --set block-list='...:529-once'):
   #   - Send a turn while the proxy is rejecting one request
   #   - ApiRetryBanner appears with attempt count + delay
   #   - On retry success, banner clears (auto-dismiss within 30s of last retry)
   #   - No SessionMessagePart added to messagesCollection from the retry
5. # Unit tests pass:
   pnpm --filter @duraclaw/orchestrator test -- --grep "compact-boundary|api-retry"
                                     # expect: all pass
6. # Wire-shape lock:
   grep -A 20 'CompactBoundaryEvent' packages/shared-types/src/index.ts
                                     # expect: CompactBoundaryEvent has
                                     # pre_tokens but NOT post_tokens
```

## Implementation Hints

### Key Imports

```typescript
// SDK Query and message types
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKSessionStateChangedMessage,
  type SDKStatusMessage,
  type SDKAPIRetryMessage,
  type SDKCompactBoundaryMessage,
} from '@anthropic-ai/claude-agent-sdk'

// Wire types
import type {
  GatewayCommand,
  GatewayEvent,
  SessionStateChangedEvent,
  CompactBoundaryEvent,
  ApiRetryEvent,
  ResultEvent,
  ContextUsage,
} from '@duraclaw/shared-types'

// Buffered channel + dial-back
import type { BufferedChannel } from '@duraclaw/shared-transport'
```

### Code Patterns

**PushPullQueue scaffold (per the prior research):**

```typescript
// packages/session-runner/src/push-pull-queue.ts
export class PushPullQueue<T> {
  private items: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) throw new Error('PushPullQueue: push after close')
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const r of this.resolvers) r({ value: undefined, done: true })
    this.resolvers = []
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.closed) return
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}
```

**Lifetime Query construction (Reduction B):**

```typescript
// packages/session-runner/src/claude-runner.ts (sketch)
const queue = new PushPullQueue<SDKUserMessage>()
queue.push({ type: 'user', message: { role: 'user', content: initialPrompt } })

// `execute` uses options without `resume`; `resume` adds the SDK session id.
const sdkOptions = cmd.type === 'resume'
  ? { ...common, model, permissionMode, resume: cmd.sdk_session_id }
  : { ...common, model, permissionMode }

const q = query({ prompt: queue, options: sdkOptions })
ctx.query = q
ctx.streamInput = (msg: SDKUserMessage) => queue.push(msg)
ctx.interrupt = () => q.interrupt()              // queue untouched
ctx.stop = () => { queue.close() /* SIGTERM watchdog runs concurrently */ }

for await (const message of q) {
  await processQueryMessages(message, ctx, ch)  // unchanged
}
```

**SDK message → wire event translation (Reductions C + D):**

```typescript
// In processQueryMessages switch in claude-runner.ts
case 'session_state_changed': {
  send(ch, {
    type: 'session_state_changed',
    session_id: ctx.sessionId,
    state: message.state,           // 'idle' | 'running' | 'requires_action'
    ts: Date.now(),
  }, ctx)
  break
}
case 'compact_boundary': {
  send(ch, {
    type: 'compact_boundary',
    session_id: ctx.sessionId,
    trigger: message.trigger,
    pre_tokens: message.pre_tokens,
    preserved_segment: message.preserved_segment,
    ts: Date.now(),
  }, ctx)
  break
}
case 'api_retry': {
  send(ch, {
    type: 'api_retry',
    session_id: ctx.sessionId,
    attempt: message.attempt,
    max_attempts: message.max_attempts,
    delay_ms: message.delay_ms,
    error_class: mapErrorClass(message.error_class),
    error_message: message.error_message,
    ts: Date.now(),
  }, ctx)
  break
}
```

**Context-usage on result attachment (Reduction A):**

```typescript
// claude-runner.ts result emission — snake_case on the wire
const usage = await q.getContextUsage().catch(() => null)
send(ch, {
  type: 'result',
  session_id: ctx.sessionId,
  // ... existing result fields ...
  context_usage: usage ? {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    max_tokens: usage.max_tokens,
    percentage: (usage.total_tokens / usage.max_tokens) * 100,
    model: ctx.model,
    auto_compact_at: usage.auto_compact_at,
  } : undefined,
}, ctx)

// On the client, in sessions-collection ingest:
function wireContextUsageToStore(w: WireContextUsage): ContextUsage {
  return {
    totalTokens: w.total_tokens,
    maxTokens: w.max_tokens,
    inputTokens: w.input_tokens,
    outputTokens: w.output_tokens,
    percentage: w.percentage,
    model: w.model,
    autoCompact: w.auto_compact_at,
  }
}
```

**Banner pattern reuse (Reduction D):**

```tsx
// apps/orchestrator/src/components/api-retry-banner.tsx (sketch)
// Mirror disconnected-banner.tsx structure:
// - bg-warning/20 + border-warning
// - icon (RotateCw) + text + optional dismiss
// - mounted once at __root.tsx
// - reads from apiRetryStore (zustand-style transient store)
import { useApiRetryStore } from '~/stores/api-retry-store'

export function ApiRetryBanner() {
  const retry = useApiRetryStore((s) => s.current)
  if (!retry) return null
  return (
    <div className="bg-warning/20 border-warning border-b px-4 py-2 ...">
      <RotateCw className="size-4" />
      <span>Retrying request (attempt {retry.attempt} of {retry.max_attempts}, {Math.round(retry.delay_ms / 1000)}s)…</span>
      <span className="text-muted-foreground text-xs">{retry.error_class}</span>
    </div>
  )
}
```

### Gotchas

1. **`session_state_changed` does NOT cover compact or api_retry.** The SDK's enum is `idle | running | requires_action`. We extend the wire enum with `compacting` and `api_retry` derived from `SDKStatusMessage` and `SDKAPIRetryMessage` respectively. Don't conflate "SDK fires session_state_changed" with "DO sees session_state_changed" — the runner is the translator.
2. **`SDKCompactBoundaryMessage` has no `post_tokens`.** Only `pre_tokens`. Any UI mockup that says "Context compacted: A → B tokens" is wrong; the post-compact total has to be inferred from the next `result` event's `context_usage.total_tokens`.
3. **`stream-input` mid-flight bug is a Reduction B fix, not a separate patch.** Per user direction, do NOT land a one-line band-aid for `main.ts:178` first — the lifetime-queue rewrite replaces the entire pattern. If Reduction B slips, the bug stays open as known-and-tracked.
4. **`context_usage` REST endpoint stays.** Only the WS RPC verb (`get-context-usage` command + `context_usage` event) is cut. The HTTP route at `session-do.ts:693-698` remains for admin/debug.
5. **`chain_advance` / `chain_stalled` are NOT in the cut list.** They have wired UI consumers (`chain-status-item.tsx`). Do not touch them in this spec.
6. **Backward compat during rollout:** All deletions are coordinated in single-PR phases. There is no rollout where an old runner talks to a new DO or vice versa across the heartbeat boundary — the gateway redeploy is atomic per session, and the DO's WS handler is updated in the same PR.
7. **Coordination with #100 and #101:** No hard sequencing per user direction. First-to-merge eats the rebase cost. If #101 P1 lands first, the Reduction B/C deletions land in the new module structure (`runner-link.ts`, `status.ts`, `watchdog.ts`) instead of the monolithic `session-do.ts`. Same code, different file.
8. **`useSessionStatus` hook contract is sacred.** The hook is in `apps/orchestrator/src/db/session-local-collection.ts:126-129` and its output enum drives `deriveDisplayStateFromStatus` in three places (StatusBar, sidebar cards, tab bar). Do not change the enum, do not change the field names, do not change the snapshot contract. Only the input signal flips from heartbeat to session_state_changed.

### Reference Docs

- **Umbrella research:** `planning/research/2026-04-25-sdk-interference-peelback.md` — full inventory, four reductions, sequencing rationale, cuts list with file:line citations
- **Mid-stream input research:** `planning/research/2026-04-23-sdk-mid-stream-input-api.md` — `PushPullQueue` recommendation, multi-turn pattern endorsement
- **Sibling DO refactor:** `planning/specs/101-session-do-refactor.md` — Phase 3 owns Reduction E (mapper-to-runner). B10 owns the prefix-prompt fork generalization that this spec depends on
- **Spec #30 (RunnerAdapter):** `planning/specs/30-runner-adapter-pluggable.md` — `AdapterCapabilities` flow, multi-SDK contract
- **Spec #50 (status TTL):** `planning/specs/50-status-ttl.md` — already targets heartbeat deletion in P3; this spec absorbs that scope under Reduction C
- **SDK type definitions:** `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.98_*/sdk.d.ts:2008-2025` (`SDKCompactBoundaryMessage`), `:1974-1982` (`SDKAPIRetryMessage`), `:2730-2738` (`SDKSessionStateChangedMessage`), `:2758-2767` (`SDKStatusMessage`)
- **Session lifecycle rule:** `.claude/rules/session-lifecycle.md` — spawn / resume / orphan flow; this spec preserves all three paths
- **Client data flow rule:** `.claude/rules/client-data-flow.md` — `useSessionStatus` contract, seq'd wire protocol, snapshot semantics
