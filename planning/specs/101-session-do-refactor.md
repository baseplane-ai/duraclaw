---
initiative: session-do-refactor
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 101
created: 2026-04-25
updated: 2026-04-25
phases:
  - id: p1
    name: "Hygiene split — extract 10 modules from session-do.ts"
    tasks:
      - "Create `apps/orchestrator/src/agents/session-do/` directory and `index.ts` that re-exports the SessionDO class"
      - "Extract `types.ts` — define `SessionDOContext` interface: `{ do: SessionDO, state: SessionMeta, session: Session, sql: SqlStorage, env: Env, ctx: DurableObjectState, broadcast: (msg) => void, getConnections: () => Connection[], logEvent: (...) => void }` plus any shared enums/constants currently at file top"
      - "Extract `hydration.ts` — `onStartRestore()`, `hydrateMetaFromSql()`, D1 discovery (#53), migration runner call, turn-state loading from `assistant_config`"
      - "Extract `history.ts` — `safeAppendMessage()`, `safeUpdateMessage()`, `computeSnapshotOps()`, streaming-aggregation collation (partial_assistant → in-memory message building), turnCounter management. Note: `computeBranchInfo()` belongs in `branches.ts` (not here)"
      - "Extract `broadcast.ts` — consolidate `broadcastMessage()`, `broadcastMessages()`, `broadcastBranchInfo()`, `broadcastStatusFrame()`, `broadcastToClients()`, `broadcastSessionRow()`, `broadcastSyncedDelta()` into a single module. Minor cleanup: collapse the 3-layer indirection (`broadcastMessage → broadcastMessages → broadcastSyncedDelta`) where layers add no value"
      - "Extract `gates.ts` — `findPendingGatePart()`, `resolveGateOnRunner()`, `clearPendingGateParts()`, `isPendingGatePart()`, `promoteToolPartToGate()`. Consolidate gate-type predicates into a `GATE_PART_TYPES` set"
      - "Extract `runner-link.ts` — `triggerGatewayDial()`, `sendToGateway()`, `maybeRecoverAfterGatewayDrop()`, callback-token minting + timing-safe validation, `getGatewayConnectionId()`, `forceStopViaHttp()`"
      - "Extract `status.ts` — `updateState()` wrapper, `persistMetaPatch()`, `syncStatusToD1()`, `syncResultToD1()`, `syncKataAllToD1()`, status state-machine transitions"
      - "Extract `branches.ts` — `rewind()` logic, `resubmitMessage()` branch creation, `forkWithHistory()`, `serializeHistoryForFork()`, `computeBranchInfo()` (sole owner — NOT in history.ts)"
      - "Extract `resume-scheduler.ts` — CAAM rotation logic: `planRateLimitAction()`, `pendingResume` persistence, alarm-driven delayed-resume dispatch (the `pendingResume.at` check from the alarm handler), system-breadcrumb insertion for rotation/waiting_profile states. This is where all CAAM-related DO logic lives post-extraction"
      - "Extract `watchdog.ts` — alarm body: recovery-grace expiry, stale-session detection, awaiting-response timeout (#80 B7), `scheduleWatchdog()`, self-rescheduling logic"
      - "Extract `event-log.ts` — `logEvent()`, `getEventLog()` RPC handler, 7-day pruning query"
      - "Extract `title.ts` — `handleTitleUpdate()` with explicit `titleResolutionPolicy(prev, incoming)` function replacing inline never-clobber logic"
      - "Extract `gateway-event-handler.ts` — the `handleGatewayEvent()` case dispatch (~800 LoC), which delegates to the above modules for side effects"
      - "Rewrite `session-do.ts` (now `index.ts`) as thin facade: Agent base class, 16 @callable RPC stubs (~5-10 LoC each = ~120 LoC) that delegate to modules, onConnect/onMessage/onClose/onRequest routing, alarm() that delegates to watchdog + resume-scheduler, onStart() that constructs SessionDOContext. Target ≤700 LoC (validated: 16 stubs + 5 handlers + wiring = ~400-500 LoC with room to spare)"
      - "Absorb `session-do-helpers.ts` (515 LoC) — distribute its functions into the appropriate new modules: `deriveSnapshotOps` → `history.ts`, `staleThresholdMs` → `watchdog.ts`, `timingSafeEqual` → `runner-link.ts`, `loadTurnState` → `hydration.ts`. Delete the original helper file once empty"
      - "Update all imports across `apps/orchestrator/` that import from `~/agents/session-do` — the barrel export must maintain the same public surface"
      - "Recommended extraction order (leaf modules first, orchestrating modules last): (1) types.ts, (2) event-log.ts, title.ts, gates.ts (no cross-module deps), (3) broadcast.ts, status.ts (used by many), (4) watchdog.ts, resume-scheduler.ts (alarm delegates), (5) history.ts, runner-link.ts, branches.ts (Session-dependent), (6) gateway-event-handler.ts (delegates to all above), (7) hydration.ts (wires everything in onStart), (8) facade index.ts (last — once all modules exist)"
      - "Verify: `pnpm typecheck` passes, `pnpm test` passes, existing session-do.test.ts + gateway-event-mapper.test.ts pass unchanged"
    test_cases:
      - id: "typecheck-clean"
        description: "pnpm typecheck succeeds with zero errors across all packages"
        type: "build"
      - id: "existing-tests-pass"
        description: "pnpm test passes — session-do.test.ts, gateway-event-mapper.test.ts, and all other suites unchanged"
        type: "regression"
      - id: "facade-loc-budget"
        description: "session-do/index.ts is ≤700 LoC (wc -l); total module LoC ≈ original 5,461 ± 10% (no lost code)"
        type: "metric"
      - id: "barrel-export-surface"
        description: "Every symbol previously importable from `~/agents/session-do` remains importable from the same path"
        type: "regression"
  - id: p2
    name: "Multi-SDK prep — capabilities relay + runner_session_id rename + pricing delegation"
    tasks:
      - "Add `AdapterCapabilities` type to `packages/shared-types/src/index.ts` — 10 boolean flags + provider roster. Match spec #30 §B2 (lines 187-199). Local definitions for implementer reference: `supportsRewind` (can trim history and re-run from a point), `supportsThinkingDeltas` (emits thinking/reasoning blocks in partial_assistant), `supportsPermissionGate` (emits permission_request events the DO can gate on), `supportsSubagents` (emits task_started/progress/notification for background work), `supportsPermissionMode` (responds to set-permission-mode command), `supportsSetModel` (responds to set-model command mid-session), `supportsContextUsage` (responds to get-context-usage with token counts), `supportsInterrupt` (responds to interrupt command cleanly), `supportsCleanAbort` (abort produces a well-formed result event, not a crash), `emitsUsdCost` (result event includes accurate total_cost_usd from the SDK — false means DO should expect null and defer to packages/pricing). Plus `availableProviders: ReadonlyArray<{provider: string, models: string[]}>` for model-picker UI"
      - "Add `capabilities?: AdapterCapabilities` to `SessionInitEvent` in `packages/shared-types/src/index.ts`"
      - "Add migration v18 to `session-do-migrations.ts` — two operations: (1) rename column `sdk_session_id` → `runner_session_id` in `session_meta` table, (2) add `capabilities_json TEXT` column to `session_meta`"
      - "Add D1 migration: rename `sdkSessionId` → `runnerSessionId` in `agent_sessions` table (Drizzle schema + D1 migration SQL); add `capabilitiesJson TEXT` column"
      - "Rename `sdk_session_id` → `runner_session_id` across the codebase: `SessionMeta` type, `SessionInitEvent`, `ExecuteCommand`, `ResumeCommand`, `GatewayEvent` result event, session-runner types, gateway types, API handlers, UI components, CLAUDE.md session-lifecycle rule. Mechanical find-replace guarded by typecheck"
      - "In `hydration.ts`: on `session.init` event, persist `capabilities` to `session_meta.capabilities_json` (JSON.stringify) and broadcast via `broadcastSessionRow()` so the synced-collection row includes capabilities"
      - "In `status.ts`: add `capabilities` to `SessionMeta` type (typed as `AdapterCapabilities | null`, default null). Hydrate from `capabilities_json` on cold start"
      - "In `runner-link.ts`: stop computing `total_cost_usd` from result events inside the DO. Instead, store the `total_cost_usd` value the runner emits in `result` events directly. When `emitsUsdCost` capability is false, leave cost as null (future: `packages/pricing` module per spec #30 P2 will fill it)"
      - "In `branches.ts`: generalize `forkWithHistory()` — remove assumption that the runner has a JSONL transcript on disk. Always emit the serialized history as `<prior_conversation>` system prompt prefix in the `ExecuteCommand`. The runner decides whether to use transcript-resume or prompt-prefix based on its adapter's capabilities"
      - "Verify: `pnpm typecheck`, `pnpm test`, manual smoke test of a Claude session (spawn → stream → gate → resolve → idle → resume) confirming `runner_session_id` flows end-to-end and capabilities are broadcast on session row"
    test_cases:
      - id: "v18-migration-rename"
        description: "After migration v18, `session_meta` table has `runner_session_id` column (not `sdk_session_id`) and `capabilities_json` column. SELECT confirms both"
        type: "migration"
      - id: "d1-schema-rename"
        description: "D1 agent_sessions table has `runnerSessionId` and `capabilitiesJson` columns after migration"
        type: "migration"
      - id: "typecheck-clean-post-rename"
        description: "pnpm typecheck succeeds — zero residual references to `sdk_session_id` in .ts files"
        type: "build"
      - id: "capabilities-relay-e2e"
        description: "Start a Claude session; session.init event carries `capabilities` with `supportsRewind=true`; session row broadcast includes `capabilitiesJson` field; UI can read it"
        type: "integration"
      - id: "runner-session-id-resume"
        description: "Idle-reaped session resumes correctly via `runner_session_id` (not broken by rename)"
        type: "integration"
      - id: "fork-with-history-no-transcript"
        description: "forkWithHistory() succeeds without a JSONL file on disk — the serialized history is embedded in the ExecuteCommand prompt"
        type: "integration"
  - id: p3
    name: "Move event-shape translation into session-runner (speculative, ahead of spec #30 P1)"
    # GO/NO-GO: P3 ships if and only if (1) P1+P2 are on main, AND
    # (2) P3 test cases event-translator-text, event-translator-thinking,
    # event-translator-tool-use, and event-translator-tool-result all pass
    # in vitest with mocked SDK message shapes. P3 does NOT depend on spec
    # #30 P1 (RunnerAdapter interface) — it moves existing Claude
    # translation logic into the existing claude-runner.ts. If spec #30 P1
    # lands first, P3 adapts by putting the translator inside ClaudeAdapter
    # instead of claude-runner.ts directly. Either path produces the same
    # outcome.
    tasks:
      - "Move `apps/orchestrator/src/agents/gateway-event-mapper.ts` logic into `packages/session-runner/src/event-translator.ts` — a new module that takes raw Claude SDK message shapes and emits `SessionMessagePart[]` arrays ready for the DO to persist directly"
      - "Update `packages/session-runner/src/claude-runner.ts`: import `event-translator.ts` and call it in the `partial_assistant` and `assistant` event emission paths. The `GatewayEvent` payloads emitted over the WSS dial-back now contain pre-translated `SessionMessagePart` arrays instead of raw Claude SDK content blocks"
      - "Update `apps/orchestrator/src/agents/session-do/gateway-event-handler.ts`: strip the content-block translation logic. The handler now receives pre-translated parts and persists them directly. `gateway-event-mapper.ts` becomes a thin identity pass-through or is deleted"
      - "Define `WireMessagePart` type in `packages/shared-types/src/index.ts` — a transport-layer mirror of the DO-internal `SessionMessagePart` (from `agents/experimental/memory`). This decouples the wire type from the SDK's internal type. Shape: `{ type: 'text' | 'thinking' | 'tool-use' | 'tool-result' | 'ask-user' | 'permission-request', [key: string]: unknown }` with discriminated union variants matching the existing `SessionMessagePart` shapes. The DO maps `WireMessagePart → SessionMessagePart` on arrival (trivially — the shapes are identical today, but the indirection allows them to diverge if the SDK type changes)"
      - "Update `packages/shared-types/src/index.ts`: extend `PartialAssistantEvent` and `AssistantEvent` with a `parts?: WireMessagePart[]` field (optional for backward compat during rollout; when present, DO maps to `SessionMessagePart` and persists directly instead of translating `content`)"
      - "Verify: `pnpm typecheck`, `pnpm test`, manual smoke test of Claude session (text + thinking + tool-use + tool-result all render correctly). Confirm no regression in streaming smoothness or message persistence"
    test_cases:
      - id: "event-translator-text"
        description: "event-translator converts a Claude SDK text content block into a SessionMessagePart with type='text' and correct content"
        type: "unit"
      - id: "event-translator-thinking"
        description: "event-translator converts thinking_delta blocks into parts with type='thinking'"
        type: "unit"
      - id: "event-translator-tool-use"
        description: "event-translator converts tool_use blocks into tool-typed parts with toolCallId, toolName, input, state='input-available'"
        type: "unit"
      - id: "event-translator-tool-result"
        description: "applyToolResult matches by toolCallId and updates state + output on the correct part"
        type: "unit"
      - id: "do-receives-pretranslated"
        description: "When GatewayEvent carries `parts` field, DO persists them directly without running the old mapper. Message renders identically in UI"
        type: "integration"
      - id: "backward-compat-no-parts"
        description: "Unit test in gateway-event-handler.test.ts: construct a PartialAssistantEvent with `content` array but no `parts` field. Pass to the event handler. Assert the handler falls back to translating `content` into SessionMessagePart[] and persists correctly. Construct the same event WITH `parts` field. Assert the handler uses `parts` directly, ignoring `content`. Both paths produce identical persisted messages for the same logical content."
        type: "unit"
---

# Spec: SessionDO Refactor — Split into Focused Modules and Prep Agent-Shape Boundary

## Overview

SessionDO (`apps/orchestrator/src/agents/session-do.ts`) is a 5,461-line god-class that concentrates ~10 distinct concerns in a single file: runner lifecycle, message history, broadcast, gate handling, status state machine, branch/rewind, event log, CAAM rotation, title generation, and alarm watchdog. This spec extracts those concerns into focused modules behind a thin facade (Phase 1), lands the DO-side changes needed for non-Claude runners per spec #30 (Phase 2), and speculatively moves event-shape translation into the session-runner so the DO receives pre-translated message parts (Phase 3).

## Feature Behaviors

### B1: Module extraction preserves all existing behavior

**Core:**
- **ID:** module-extraction-no-regression
- **Trigger:** Any SessionDO operation (spawn, sendMessage, resolveGate, rewind, forkWithHistory, alarm fire, WS connect/disconnect)
- **Expected:** Behavior is byte-for-byte identical to pre-refactor. All RPC methods, WS handlers, HTTP routes, alarm behavior, and broadcast patterns produce the same outputs for the same inputs.
- **Verify:** Full `pnpm test` passes. Manual smoke test: spawn Claude session → send message → receive streaming response → trigger gate → resolve gate → rewind → fork → resume after idle reap. All actions produce the same WS frames and D1 state as current `main`.
**Source:** `apps/orchestrator/src/agents/session-do.ts` (entire file)

#### Data Layer
No schema changes. No migration. No new tables. Module boundaries are purely code-organization.

---

### B2: Facade class is thin router under 700 LoC

**Core:**
- **ID:** facade-loc-budget
- **Trigger:** Code review / CI metric check
- **Expected:** `apps/orchestrator/src/agents/session-do/index.ts` is ≤700 lines. It contains only: class declaration extending `Agent`, `@callable` method stubs that delegate to modules, `onConnect`/`onMessage`/`onClose`/`onRequest` routing, `alarm()` dispatch, and `onStart()` wiring. No business logic.
- **Verify:** `wc -l apps/orchestrator/src/agents/session-do/index.ts` ≤ 700
**Source:** new file

---

### B3: SessionDOContext enables testable modules

**Core:**
- **ID:** context-interface
- **Trigger:** Module function invocation
- **Expected:** Every extracted module receives a `SessionDOContext` object (or a narrow subset) as its first argument. The context provides access to: `state` (SessionMeta), `session` (Session instance), `sql` (SqlStorage), `env` (Env bindings), `ctx` (DurableObjectState), and delegate functions for `broadcast()`, `getConnections()`, `logEvent()`. Tests can construct a mock context without instantiating a full DO.
- **Verify:** Type-check confirms modules accept `SessionDOContext` parameter. No module directly imports or references `SessionDO` class — only the context interface.
**Source:** new file `apps/orchestrator/src/agents/session-do/types.ts`

**Lifecycle:** `SessionDOContext` is constructed once in `onStart()` after migrations and Session initialization. It holds **live references** — `state` points to `this.state` (the Agent's reactive state object), `session` points to the single Session instance, `sql`/`env`/`ctx` are immutable DO properties. The context is stored as `this.moduleCtx` on the facade and passed to every module call. It is **never reconstructed** after `onStart()` — state mutations flow through `this.state` which the context references. Modules must not cache `ctx.state.fieldName` across await boundaries; always re-read from `ctx.state`.

---

### B3a: CAAM rotation logic is fully extracted

**Core:**
- **ID:** caam-extraction
- **Trigger:** Rate-limit event from runner, pendingResume alarm fire
- **Expected:** All CAAM-related DO logic lives in `resume-scheduler.ts`: `planRateLimitAction()`, `pendingResume` persistence, delayed-resume dispatch, system-breadcrumb insertion for rotation/waiting_profile states. The facade's alarm handler calls into `resume-scheduler` for the pendingResume check. No CAAM logic remains in the facade or other modules.
- **Verify:** Grep for `planRateLimitAction`, `pendingResume`, `waiting_profile` — all hits are in `resume-scheduler.ts` (or `types.ts` for type definitions). None in `index.ts`.

---

### B4: Broadcast layer consolidation

**Core:**
- **ID:** broadcast-consolidation
- **Trigger:** Any event that triggers a client broadcast (message append, status change, branch info, session row update)
- **Expected:** The session-scoped indirection is collapsed: `broadcastMessage` (single-message wrapper) is inlined into `broadcastMessages` (the real fanout with seq stamping). `broadcastSyncedDelta` (user-scoped, cross-DO via UserSettingsDO) stays as a separate function — it operates at a different scope (user, not session) and routes through a different DO. A single `broadcast.ts` module owns all fanout paths. Role-based filtering (gateway connections excluded from message broadcasts) is centralized.
- **Verify:** Grep for `broadcastMessage` as a standalone function — should not exist (inlined). `broadcastMessages` and `broadcastSyncedDelta` both live in `broadcast.ts`. WS frame output is unchanged (verified by existing tests + manual smoke).
**Source:** `apps/orchestrator/src/agents/session-do.ts` lines ~1875, 2302, 2348

---

### B5: Gate predicate consolidation

**Core:**
- **ID:** gate-predicate-set
- **Trigger:** Gate lifecycle operations (find, resolve, clear, promote)
- **Expected:** `gates.ts` defines a `GATE_PART_TYPES` set (e.g., `new Set(['ask-user', 'permission-request'])`) and all gate-type predicates use it. Adding a new gate type requires adding one entry to the set, not auditing multiple `=== 'ask-user'` string comparisons.
- **Verify:** Grep for `isPendingGatePart` — single definition in `gates.ts`. No raw string comparisons against gate type names outside `gates.ts`.
**Source:** `apps/orchestrator/src/agents/session-do.ts` gate handling sections

---

### B6: Title update policy extraction

**Core:**
- **ID:** title-policy-function
- **Trigger:** `title_update` event from runner
- **Expected:** `title.ts` exports `titleResolutionPolicy(currentSource, currentConfidence, incomingSource, incomingConfidence): 'accept' | 'reject'`. The inline never-clobber logic (if `title_source === 'user'` → freeze) is replaced by a call to this function. Adding new title sources (e.g., voice-name) requires updating the policy function, not auditing the event handler.
- **Verify:** Unit test: `titleResolutionPolicy('user', 'high', 'haiku', 'medium') === 'reject'`; `titleResolutionPolicy('haiku', 'medium', 'haiku', 'high') === 'accept'`; `titleResolutionPolicy(null, null, 'haiku', 'medium') === 'accept'`.
**Source:** `apps/orchestrator/src/agents/session-do.ts` `case 'title_update'` handler

---

### B7: Capabilities persisted and broadcast on session.init

**Core:**
- **ID:** capabilities-relay
- **Trigger:** Runner emits `session.init` event with `capabilities` field
- **Expected:** DO persists `capabilities` as JSON in `session_meta.capabilities_json`. DO broadcasts the capabilities to all browser connections via the session-row synced-collection delta. UI can read `capabilitiesJson` from the session row to gate affordances (rewind button, thinking toggle, permission modal).
- **Verify:** Start Claude session → inspect `session_meta` row → `capabilities_json` contains `{"supportsRewind":true,...}`. Browser WS receives session-row delta with `capabilitiesJson` field populated.
**Source:** new column in `session_meta` (migration v18), new column in D1 `agent_sessions`

#### Data Layer
- DO SQLite: migration v18 adds `capabilities_json TEXT` to `session_meta`
- D1: migration adds `capabilitiesJson TEXT` to `agent_sessions`

---

### B8: runner_session_id rename

**Core:**
- **ID:** runner-session-id-rename
- **Trigger:** Any code path that reads/writes the session's SDK session identifier
- **Expected:** The field is named `runner_session_id` in all types (`SessionMeta`, `SessionInitEvent`, `ExecuteCommand`, `ResumeCommand`, `GatewayEvent.result`), DO SQLite (`session_meta.runner_session_id`), D1 (`agent_sessions.runnerSessionId`), and UI code. The old name `sdk_session_id` does not appear in any `.ts` file.
- **Verify:** `grep -r sdk_session_id apps/ packages/ --include='*.ts' | wc -l` returns 0. `pnpm typecheck` clean. Resume-after-idle works (runner_session_id flows through ExecuteCommand → runner → session.init → DO persistence → ResumeCommand round-trip).
**Source:** ~22 files / ~142 occurrences across the monorepo (mechanical rename, type-guarded)

#### Data Layer
- DO SQLite: migration v18 renames `sdk_session_id` → `runner_session_id` in `session_meta`
- D1: migration renames `sdkSessionId` → `runnerSessionId` in `agent_sessions`

**Rollback plan:** Column renames in SQLite are destructive (no undo without a new migration). If P2 ships and must be reverted: (1) revert the code to use `sdk_session_id` everywhere, (2) add migration v20 that renames `runner_session_id` back to `sdk_session_id`, (3) apply D1 reverse migration manually per the ops runbook (`memory/ops_d1_remote_migration.md`). The rename is a single-step atomic operation in both stores — no data loss risk, only naming. Staged rollout: deploy the code with migration v18 to staging first, verify resume flow, then prod.

---

### B9: Cost delegation — DO stops recomputing

**Core:**
- **ID:** cost-delegation
- **Trigger:** Runner emits `result` event with `total_cost_usd`
- **Expected:** **Current behavior:** The DO receives `total_cost_usd` from the runner's `result` event and stores it directly in `SessionMeta.total_cost_usd` — there is no DO-side recomputation today (the runner computes cost via `getSessionInfo().costUsd` from the Claude SDK). **P2 change:** Formalize this as the contract. When `capabilities.emitsUsdCost` is false (non-Claude adapters), `total_cost_usd` remains null. A future `packages/pricing` module (spec #30 P2) will compute cost for adapters that don't emit it natively. The DO never computes cost itself.
- **Verify:** Start Claude session → complete → check `total_cost_usd` in D1 matches the runner's `result.total_cost_usd` exactly. Start a hypothetical non-Claude session with `emitsUsdCost=false` → cost is null in D1.
**Source:** `apps/orchestrator/src/agents/session-do.ts` result event handler

---

### B10: forkWithHistory uses runner_session_id and documents transcript-agnosticism

**Core:**
- **ID:** fork-transcript-agnostic
- **Trigger:** User triggers fork-with-history (resubmit, or DO detects orphan case)
- **Expected:** `forkWithHistory()` already serializes the DO's local message history into a `<prior_conversation>` prompt prefix (line 4107) — this behavior is preserved. The P2 change is: (1) the `sdk_session_id: null` reset at line 4141 becomes `runner_session_id: null`, and (2) `triggerGatewayDial` passes `runner_session_id` (not `sdk_session_id`) in the `ExecuteCommand`. No functional change for Claude sessions; for non-Claude adapters (future), the fork path already works without a JSONL transcript since it embeds history in the prompt.
- **Verify:** Call `forkWithHistory(content)` → inspect emitted `ExecuteCommand` → `prompt` field contains `<prior_conversation>` prefix, `runner_session_id` is null (new session). `pnpm typecheck` confirms no residual `sdk_session_id` references.
**Source:** `apps/orchestrator/src/agents/session-do.ts:4065-4144`

---

### B11: Event-shape translation moves to runner

**Core:**
- **ID:** pretranslated-parts
- **Trigger:** Runner emits `partial_assistant` or `assistant` GatewayEvent
- **Expected:** Claude runner emits events with a `parts: WireMessagePart[]` field (defined in `shared-types`) containing pre-translated parts (text, thinking, tool-use). DO maps `WireMessagePart → SessionMessagePart` (trivial identity today) and persists directly without running content-block translation. If `parts` is absent (backward compat with old runner), DO falls back to a thin identity mapper. `WireMessagePart` is a transport-layer type decoupled from the SDK-internal `SessionMessagePart` to avoid coupling `shared-types` to `@anthropic-ai/agents-sdk`.
- **Verify:** Start Claude session → inspect WS frames between runner and DO → `partial_assistant` events contain `parts` array with `WireMessagePart` shapes. Messages render identically in the UI.
**Source:** `apps/orchestrator/src/agents/gateway-event-mapper.ts` (moves to `packages/session-runner/src/event-translator.ts`)

#### API Layer
- New type `WireMessagePart` in `packages/shared-types/src/index.ts` — discriminated union mirroring `SessionMessagePart` shapes
- Extended `PartialAssistantEvent` and `AssistantEvent` in `packages/shared-types/src/index.ts`: add optional `parts?: WireMessagePart[]`
- When `parts` is present, DO maps to `SessionMessagePart` and persists. When absent, falls back to identity mapper.

---

## Non-Goals

- **PartyServer base-class migration** — Declined per `planning/research/2026-04-22-session-do-partyserver-migration-feasibility.md`. Session class dependency + @callable rewrite is a multi-week effort with high regression risk. Keep `extends Agent`.
- **RPC framework changes** — Keep `@callable` decorators. Facade has thin stubs that delegate to modules.
- **Wire protocol changes** — `GatewayCommand` / `GatewayEvent` shapes stay as-is (except `sdk_session_id` → `runner_session_id` rename and optional `parts` field in Phase 3).
- **Streaming-aggregation persistence** — Flagged as fragile (partial deltas lost on DO eviction) but deferred until prod evidence shows it bites. Phase 1 extraction makes a future fix localized to `history.ts`.
- **Migration sediment compaction** — 18 versions including legacy v1–v3. Works fine. Not worth the audit cost.
- **New test coverage in Phase 1** — Phase 1 is mechanical extraction. Existing tests must pass. Module-level unit tests come with Phase 2+ behavior changes.
- **UI capability gating** — Spec #30 P1 owns the UI work (hiding rewind for Codex, etc.). This spec lands the DO-side relay; UI consumption is out of scope.
- **ACP protocol adoption** — Issue #98 was closed. Sticking with spec #30's per-adapter RunnerAdapter pattern.

## Implementation Phases

See frontmatter for full task + test_case breakdowns.

### Phase 1: Hygiene split (no behavior change)
- Extract 10 modules + facade from session-do.ts
- Minor cleanup: collapse broadcast layers, extract title policy, consolidate gate predicates
- Target: facade ≤700 LoC, total LoC ≈ original ± 10%
- **Done when:** `pnpm typecheck` + `pnpm test` pass, facade under budget
- **Rollback:** `git revert` the P1 commits. No schema changes, no data migration, no wire-protocol change — pure code reorg. Revert is safe at any point.

### Phase 2: Multi-SDK prep
- Migration v19: `runner_session_id` rename + `capabilities_json` column (both DO SQLite and D1)
- Capabilities relay: session.init → persist → broadcast → session row
- Cost delegation: DO stores runner's value, no recomputation
- Fork generalization: always embed history in ExecuteCommand
- **Done when:** Rename is complete (zero `sdk_session_id` in .ts files), capabilities flow end-to-end, Claude sessions work identically

### Phase 3: Move event translation to runner
- New `event-translator.ts` in session-runner
- Claude runner emits pre-translated `parts` arrays
- DO receives and persists directly; backward-compat fallback when `parts` absent
- **Done when:** Messages render identically; gateway-event-mapper.ts is deleted or reduced to identity pass-through
- **Rollback:** The `parts` field is optional (B11 backward compat). Reverting the runner to emit events without `parts` restores pre-P3 behavior — the DO's fallback mapper handles it. No schema change to revert.

## Verification Plan

### VP1: Phase 1 — Extraction integrity

```
1. pnpm typecheck                    # expect: 0 errors
2. pnpm test                         # expect: all suites pass
3. wc -l apps/orchestrator/src/agents/session-do/index.ts
                                     # expect: ≤700
4. wc -l apps/orchestrator/src/agents/session-do/*.ts | tail -1
                                     # expect: total ≈ 4,900-6,000 (original 5,461 ± 10%)
5. grep -r 'from.*session-do' apps/orchestrator/src/ --include='*.ts' | grep -v node_modules | head -20
                                     # expect: all imports resolve (no broken paths)
6. # Manual smoke: start dev, create session, send message, wait for response,
   # trigger ask_user gate, resolve it, rewind, fork-with-history.
   # All actions succeed identically to pre-refactor.
```

### VP2: Phase 2 — Rename + capabilities

```
1. pnpm typecheck                    # expect: 0 errors
2. grep -r 'sdk_session_id' apps/ packages/ --include='*.ts' | wc -l
                                     # expect: 0
3. grep -r 'runner_session_id' packages/shared-types/src/index.ts
                                     # expect: present in SessionInitEvent, ExecuteCommand, ResumeCommand
4. # Start a Claude session via UI
5. # Inspect DO SQLite: SELECT runner_session_id, capabilities_json FROM session_meta
                                     # expect: runner_session_id populated, capabilities_json = '{"supportsRewind":true,...}'
6. # Inspect D1: SELECT runnerSessionId, capabilitiesJson FROM agent_sessions WHERE id = '<session-id>'
                                     # expect: same values
7. # Simulate idle-reap: kill the runner via gateway API
   curl -X POST http://localhost:$CC_GATEWAY_PORT/sessions/<session-id>/kill \
     -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN"
                                     # expect: 200 OK, runner process exits
8. # Send follow-up message in the UI → triggers resume via runner_session_id
                                     # expect: resume succeeds, new runner dials back, session continues streaming
9. # Trigger forkWithHistory (send while runner disconnected)
                                     # expect: new session starts with history prefix, no transcript-file dependency
```

### VP3: Phase 3 — Pre-translated parts

```
1. pnpm typecheck                    # expect: 0 errors
2. pnpm test                         # expect: all suites pass
3. # Start a Claude session
4. # Inspect runner → DO WS frames (via wrangler tail or event_log):
   #   partial_assistant event should have `parts` array
   #   assistant event should have `parts` array
5. # Verify parts shape: [{type:'text', content:'...'}, {type:'thinking', ...}]
6. # Check UI renders text, thinking blocks, tool-use, tool-results identically
7. # Verify backward compat via unit test:
   pnpm --filter @duraclaw/orchestrator test -- --grep "backward-compat-no-parts"
   # expect: test passes — handler falls back to content translation when parts absent
8. wc -l apps/orchestrator/src/agents/gateway-event-mapper.ts
                                     # expect: ≤50 lines (thin fallback) or file deleted
```

## Implementation Hints

### Key Imports

```typescript
// Session class (message persistence)
import { Session } from 'agents/experimental/memory'

// Agent base class + callable decorator
import { Agent } from '@anthropic-ai/agents-sdk'
import { callable } from '@anthropic-ai/agents-sdk/decorators'

// Shared types
import type { GatewayCommand, GatewayEvent, SessionMessage, SessionMessagePart } from '@duraclaw/shared-types'

// D1 schema
import { agentSessions } from '~/db/schema'
```

### Code Patterns

**Context injection pattern (match existing helpers):**
```typescript
// session-do-helpers.ts already uses this pattern:
// export function computeSnapshotOps(sql: SqlStorage, ...) { ... }
// Extend to all modules:
export function resolveGateOnRunner(ctx: SessionDOContext, gateId: string, response: GateResponse) {
  const part = findPendingGatePart(ctx, gateId)
  // ...
}
```

**@callable facade delegation:**
```typescript
// In index.ts (facade):
@callable()
async resolveGate(gateId: string, response: GateResponse) {
  return resolveGateOnRunner(this.moduleCtx, gateId, response)
}
```

**JSON blob column pattern (matches existing kataStateJson, contextUsageJson):**
```typescript
// In D1 schema:
capabilitiesJson: text('capabilitiesJson'),
// In DO hydration:
capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : null
```

### Gotchas

1. **SQLite column rename** — SQLite doesn't support `ALTER TABLE ... RENAME COLUMN` before version 3.25.0. Cloudflare Workers SQLite supports it (they run 3.45+), but verify the migration runs on miniflare too.
2. **D1 migration** — per ops runbook (`memory/ops_d1_remote_migration.md`), D1 migrations require `CLOUDFLARE_ACCOUNT_ID` env var and aren't auto-applied by the infra pipeline. Plan a manual migration step.
3. **Session class is Agent-SDK-internal** — `agents/experimental/memory` is not a stable API. The Session instance must stay facade-owned (created in `onStart`) and passed to modules via context. Don't try to construct it independently in `history.ts`.
4. **@callable decorator must be on the class** — decorators can't be on standalone functions. The facade keeps all `@callable` stubs; modules export plain functions.
5. **Backward compat for Phase 3** — The `parts` field on GatewayEvent must be optional. An older runner that doesn't emit `parts` must still work with the updated DO. Guard with `if (event.parts) { useDirect } else { fallbackMapper }`.

### Reference Docs

- Spec #30 (RunnerAdapter): `planning/specs/30-runner-adapter-pluggable.md` — AdapterCapabilities type, per-adapter capability declarations, pricing module plan
- PartyServer feasibility: `planning/research/2026-04-22-session-do-partyserver-migration-feasibility.md` — why we stay on `extends Agent`
- Session lifecycle: `.claude/rules/session-lifecycle.md` — spawn → resume → orphan flow
- Research: `planning/research/2026-04-25-session-do-refactor-multi-sdk-prep.md` — full inventory, smell catalog, multi-SDK touch points
