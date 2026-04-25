---
initiative: acp-codex-runner
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 98
created: 2026-04-25
updated: 2026-04-25
amends: planning/specs/30-runner-adapter-pluggable.md
research: planning/research/2026-04-25-acp-codex-runner.md
phases:
  - id: p0a
    name: "Spec #30 P1 part 1: RunnerAdapter interface + ClaudeAdapter extraction (no behavior change)"
    tasks:
      - "Audit current `packages/session-runner/test/` coverage. Add regression tests FIRST (before any refactor) for: abort mid-stream, rewind round-trip, permission callback accept/deny, resume-via-sdk_session_id, partial_assistant ordering, tool_result ordering. These tests must pass against pre-refactor code."
      - "Define `RunnerAdapter` + `AdapterCapabilities` + `AdapterStartOptions` + `NotSupported` + `AgentName` in `packages/shared-types/src/runner-adapter.ts` (per Spec #30 §B1, lines 173–244, with one amendment: add `supportsAskUser: boolean` to `AdapterCapabilities` — Claude=true, ACP adapters declare per-server). This is the only divergence from Spec #30's interface; document the amendment in a code comment referencing this spec."
      - "Confirm `ExecuteCommand`/`ResumeCommand` `agent?: AgentName` discriminator at `packages/shared-types/src/index.ts:38` accepts the new union; if currently typed as `string`, narrow to `AgentName`"
      - "Extract `ClaudeAdapter` from `packages/session-runner/src/claude-runner.ts` to `packages/session-runner/src/adapters/claude.ts` implementing `RunnerAdapter`; behavior unchanged. Declare ClaudeAdapter capabilities (returned via session.init): `supportsRewind=true, supportsThinkingDeltas=true, supportsPermissionGate=true, supportsAskUser=true, supportsSubagents=true, supportsPermissionMode=true, supportsSetModel=true, supportsContextUsage=true, supportsInterrupt=true, supportsCleanAbort=true, emitsUsdCost=true, availableProviders=[{provider:'anthropic', models: <existing Claude SDK model list from claude-runner.ts>}]`. These match the existing Claude session feature set today — every capability is `true` because Claude defines the baseline."
      - "Introduce adapter registry at `packages/session-runner/src/adapters/index.ts` — `Record<AgentName, () => RunnerAdapter>` seeded with `claude`"
      - "Rewire `packages/session-runner/src/main.ts` to select adapter via `cmd.agent ?? 'claude'`, call `adapter.run(opts)`. Unknown agent at registry lookup emits `type:'error'` GatewayEvent with `code: 'unknown_agent'`, `retryable: false`, exits cleanly within 1s"
    test_cases:
      - id: "claude-baseline-execute"
        description: "Existing Claude session emits identical event stream pre/post refactor (seq-stamped)"
        type: "integration"
      - id: "claude-baseline-resume"
        description: "Idle-reaped Claude session resumes via ResumeCommand using sdk_session_id"
        type: "integration"
      - id: "default-agent-claude"
        description: "ExecuteCommand without `agent` field defaults to ClaudeAdapter"
        type: "unit"
      - id: "unknown-agent-runner-fallback"
        description: "Malformed .cmd file with agent='bogus' that bypasses DO validation reaches the runner; `registry[agent]` miss emits type:'error' GatewayEvent with code='unknown_agent', retryable=false; runner writes .exit and shuts down cleanly within 1s"
        type: "unit"
  - id: p0b
    name: "Spec #30 P1 part 2: capability plumbing — DO + gateway + UI"
    tasks:
      - "Wire `capabilities` into outgoing `session.init` event; add `AdapterCapabilities` to `GatewayEvent.session.init` type in `packages/shared-types/src/index.ts`"
      - "Update `apps/orchestrator/src/agents/session-do.ts` to persist `capabilities` on `SessionMeta` (extend interface at session-do.ts:85; add SQLite migration vN to add `session_meta.capabilities_json` column; rehydrate via `hydrateMetaFromSql()`)"
      - "Mirror `capabilities` to `sessionsCollection` row (D1 + WS broadcast via `broadcastSessionRow`) so client-side `useDerivedStatus`-style hooks can read it without a DO RPC"
      - "Implement set-model cross-adapter validation in `apps/orchestrator/src/agents/session-do.ts` — reject models whose provider is absent from `capabilities.availableProviders` with 400 `{ error: 'model_not_available_for_adapter', current_adapter, requested_model }`"
      - "Reject unknown agents at the DO API boundary: `POST /api/sessions { agent: 'nonexistent' }` returns 400 `{ error: 'unknown_agent', agent: 'nonexistent', known: [<AgentName[]>] }` BEFORE any session row is created or runner spawn attempted"
      - "Reject `ResumeCommand` for non-Claude agents at the DO API boundary: any `ResumeCommand` whose original session was started with `agent: 'codex' | 'gemini-cli'` (i.e., not `'claude'`) returns 400 `{ error: 'resume_not_supported_for_acp_agents', agent }`. Idle-reaped ACP sessions land in terminal `terminated` state, not the resumable `idle` state. See Non-Goals."
      - "UI: capability-gate the rewind arrow in `apps/orchestrator/src/features/agent-orch/ChatThread.tsx` (the `onRewind?` prop site at line 489 + invocation site); read capabilities via the session row in `sessionsCollection`"
      - "UI: capability-gate the `ContextBar` in `apps/orchestrator/src/components/status-bar.tsx:38` — if `capabilities.supportsContextUsage === false`, return null"
      - "UI: capability-gate ask_user rendering in `ChatThread.tsx` (parts that match `tool-AskUserQuestion` / `tool-ask_user` at lines 110–112). When `capabilities.supportsAskUser === false`, render the session-level error component for `code='ask_user_not_supported_on_acp'` instead of the question modal"
      - "Add `GET /capabilities` endpoint on `packages/agent-gateway/src/server.ts` returning `{ adapter: { <name>: { ready: bool, missing: string[] } } }` keyed off env-var presence (works at gateway layer only, no adapter spawn required)"
      - "Add StatusBar red banner component (`apps/orchestrator/src/components/missing-credential-banner.tsx`) that polls `GET /capabilities` on login + every 60s + on session-start failure; renders `missing` env var names with link to `.env.example`"
      - "Confirm `supportsAskUser` is read end-to-end (set by ClaudeAdapter to `true` in P0a; consumed by UI gate in this phase). The interface field itself is added in P0a's task list."
    test_cases:
      - id: "capability-bitmap-claude"
        description: "session.init carries `capabilities.supportsRewind=true`, `supportsThinkingDeltas=true`, `supportsPermissionGate=true`, `supportsAskUser=true` for Claude sessions"
        type: "integration"
      - id: "set-model-cross-adapter-rejected"
        description: "POST /api/sessions/<claude-session-id>/set-model with `{model:'gpt-5.1'}` returns 400 with `error='model_not_available_for_adapter'` and `current_adapter='claude'`; same request with `claude-4-opus` returns 200"
        type: "integration"
      - id: "capabilities-endpoint-env-probing"
        description: "Gateway started without OPENAI_API_KEY: `GET /capabilities` returns `adapter.codex.ready=false`, `adapter.codex.missing=['OPENAI_API_KEY']`; with the key set, `ready=true`, `missing=[]`"
        type: "integration"
      - id: "unknown-agent-rejected-at-do"
        description: "POST /api/sessions with `{ agent: 'nonexistent', ... }` returns 400 with body `{ error: 'unknown_agent', agent: 'nonexistent', known: ['claude','codex','gemini-cli'] }`. No SessionDO row created. No runner spawn attempt."
        type: "integration"
      - id: "missing-credential-banner-renders"
        description: "Login with gateway reporting adapter.codex.missing=['OPENAI_API_KEY']: banner renders with the env var name and a link to .env.example. Set the var, click refresh: banner disappears."
        type: "integration"
      - id: "capability-rehydrate"
        description: "DO evicted, re-instantiated: `hydrateMetaFromSql()` restores `capabilities` from `session_meta.capabilities_json` column without a runner round-trip"
        type: "integration"
      - id: "resume-rejected-for-acp-agents"
        description: "ResumeCommand for a session whose original ExecuteCommand had agent='codex' returns 400 `{ error: 'resume_not_supported_for_acp_agents', agent: 'codex' }`. Same request for agent='claude' resumes successfully (existing baseline)."
        type: "integration"
  - id: p1
    name: "ACPAdapter scaffold — subprocess + JSON-RPC framing"
    tasks:
      - "Add `@agentclientprotocol/sdk` dependency to `packages/session-runner/package.json`"
      - "Create `packages/session-runner/src/adapters/acp/index.ts` exporting `ACPAdapter` class implementing `RunnerAdapter`"
      - "Create `packages/session-runner/src/adapters/acp/registry.ts` defining `ACPAgentDefinition` (name, command, args, env, installHint) and registry table; seed with `codex` (placeholder, wired in P3) and `gemini-cli` (placeholder, wired in P4)"
      - "Implement subprocess lifecycle in `packages/session-runner/src/adapters/acp/subprocess.ts` — Bun.spawn with stdin/stdout pipes, `ndJsonStream` framing, dispose with SIGTERM→2s→SIGKILL escalation (mirrors forge `client.ts:174-186`, `subprocess.ts`)"
      - "Implement ACP `initialize` → `session/new` handshake in `ACPAdapter.run()`; capture protocol version + agent capabilities. Accept any minor version compatible with the spec major: parse `protocolVersion` as semver and require major+minor match (e.g. `0.12.x` accepted; `0.13.0` or `1.0.0` rejected). Bump the accepted minor in this spec when @agentclientprotocol/sdk's pinned schema bumps."
      - "Implement multi-turn dispatch: `RunnerAdapter.streamInput(message)` translates to a second `session/prompt` call on the existing sessionId. ACPAdapter MUST queue stream-input commands that arrive while a prior `session/prompt` is in flight (FIFO); do NOT issue concurrent `session/prompt` calls — ACP semantics are turn-serial. Implementation: a single-slot pending-prompt latch with an awaiter queue."
      - "Wire abort: runner-level `signal.abort()` triggers ACP `session/cancel` notification on the in-flight sessionId, then 2s grace, then subprocess SIGTERM (per Spec #30 interrupt-then-abort sequence)"
      - "Define `AgentName` extension: add `'codex'` and `'gemini-cli'` to the union (already in Spec #30); ACPAdapter constructor takes the agent name from the registry"
      - "Unit tests: ndJsonStream framing roundtrip; subprocess lifecycle (spawn, dispose idempotent, SIGKILL escalation); `initialize` handshake against a stub ACP server"
    test_cases:
      - id: "acp-handshake"
        description: "ACPAdapter.run() against stub ACP server: sends `initialize`, receives `InitializeResponse`, sends `session/new`, captures sessionId — completes within 2s"
        type: "integration"
      - id: "acp-subprocess-dispose-idempotent"
        description: "ACPAdapter.dispose() called twice does not throw; second call is a no-op; on first call, SIGTERM is sent, after 2s SIGKILL fires"
        type: "unit"
      - id: "acp-cancel-on-abort"
        description: "AbortSignal fired during in-flight `session/prompt` triggers ACP `session/cancel` notification before subprocess termination"
        type: "integration"
      - id: "acp-protocol-version-accept-minor"
        description: "Stub server responding with protocolVersion='0.12.5' is accepted (major+minor match); session proceeds. Stub responding with '0.13.0' or '1.0.0' emits `type:'error'` with `code='acp_protocol_version_mismatch'`, `retryable=false`"
        type: "unit"
      - id: "acp-stream-input-queues"
        description: "While a `session/prompt` is in flight, a second `stream-input` GatewayCommand does not issue a concurrent ACP request. Second prompt fires only after first stop_reason arrives. No interleaved chunks."
        type: "integration"
  - id: p2
    name: "ACP → GatewayEvent translator"
    tasks:
      - "Create `packages/session-runner/src/adapters/acp/translator.ts` with `toGatewayEvents(notification: SessionNotification): GatewayEvent[]` function"
      - "Implement 6 clean maps: `agent_message_chunk` → `partial_assistant`; `tool_call_update` → `tool_result`; `request_permission` → `permission_request`; ACP error content → `error`; session closure → `stopped`; `stop_reason`+`usage` → `result`"
      - "Synthesize `session.init` GatewayEvent from `initialize` response + `session/new` response (sessionId, model from `_meta.duraclaw`, available tools from server capabilities)"
      - "Synthesize `assistant` (finalized turn) by buffering `agent_message_chunk` until `stop_reason` arrives; emit aggregated content array (text/thinking/tool_use blocks)"
      - "Synthesize `file_changed` by inspecting `tool_call_update` events for tool_name in {Edit, Write, MultiEdit}; extract path from input"
      - "Define `ask_user` policy for ACP runners: when ACPAdapter receives a structured-question request that cannot be served via `request_permission`, emit `type:'error'` with `code='ask_user_not_supported_on_acp'`, `retryable=false`; UI shows a clear-error state"
      - "Skip `context_usage` for ACP runners — `getContextUsage()` returns `NotSupported`; UI hides context bar (already capability-gated by P0)"
      - "Translator unit tests: each of 6 clean maps + 5 syntheses, plus negative tests (unknown notification type → log + drop, no crash)"
    test_cases:
      - id: "translator-streaming-text"
        description: "Stream of `agent_message_chunk` notifications produces sequenced `partial_assistant` events with correct delta text"
        type: "unit"
      - id: "translator-tool-call-update"
        description: "`tool_call_update` with status='completed' produces `tool_result` event with matching tool_use_id and output"
        type: "unit"
      - id: "translator-finalized-assistant"
        description: "Sequence of agent_message_chunk + tool_call + stop_reason='end_turn' produces a single `assistant` GatewayEvent with all content blocks aggregated"
        type: "unit"
      - id: "translator-file-changed-synthesis"
        description: "`tool_call_update` for tool_name='Edit' with input.file_path='/tmp/x' produces `file_changed` event with path='/tmp/x'"
        type: "unit"
      - id: "translator-ask-user-rejected"
        description: "Structured-question request emits `type:'error'` with code='ask_user_not_supported_on_acp'; session does NOT receive `ask_user` event"
        type: "unit"
      - id: "translator-permission-request-roundtrip"
        description: "ACP `request_permission` emits `permission_request` GatewayEvent; DO response routed back as ACP `request_permission_response`"
        type: "integration"
  - id: p3
    name: "Codex agent: registry wiring + E2E + kill-switch"
    tasks:
      - "Wire registry entry for codex: `{ name: 'codex', command: 'codex-acp', args: [], env: ['OPENAI_API_KEY'], installHint: 'cargo install codex-acp || npm install -g @zed-industries/codex-acp' }`"
      - "Update `packages/agent-gateway/src/handlers.ts` `.cmd` JSON write to forward `OPENAI_API_KEY` from process env (mirrors `ANTHROPIC_API_KEY` propagation pattern at the same site)"
      - "Declare CodexAdapter capabilities (returned via ACP `initialize` _meta block): supportsRewind=false, supportsThinkingDeltas=false (codex-acp doesn't expose thinking), supportsPermissionGate=true (via ACP request_permission), supportsSubagents=false, supportsPermissionMode=false, supportsSetModel=true, supportsContextUsage=false, supportsInterrupt=true, supportsCleanAbort=false, emitsUsdCost=false, availableProviders=[{provider:'openai', models: <see Spec #30 P2 list>}]"
      - "Add `packages/pricing/src/index.ts` (per Spec #30 P2) with OpenAI rate cards; compute `total_cost_usd` from ACP `usage` field in result event (Codex won't send cost natively)"
      - "Add per-session kill-switch in `packages/session-runner/src/adapters/acp/subprocess.ts`: if `initialize` does not return within 5s wall-clock, OR if subprocess exits within 30s of session start with non-zero status, emit `type:'error'` with `code='codex_acp_kill_switch_tripped'` and a guidance message pointing to Gemini CLI fallback. This is per-session — does not disable the adapter globally."
      - "Add adapter-level kill-switch in `packages/agent-gateway/src/handlers.ts`: count consecutive sessions tripping the per-session kill-switch in a rolling 1-hour KV counter (`acp:codex:trips`). Once 3 consecutive trips, gateway reports `adapter.codex.ready=false, missing=['kill_switch_tripped']` until manual reset (`POST /capabilities/reset?adapter=codex` with bearer auth) or counter expires after 1 hour with no further trips."
      - "Document kill-switch criteria in `packages/session-runner/src/adapters/acp/README.md`: per-session vs adapter-level triggers, fallback procedure, manual reset endpoint"
      - "E2E test against real `codex-acp` binary in CI (gated by `CODEX_ACP_E2E=1` env to avoid CI cost): execute → stream → tool call → permission gate → result"
      - "Capability-detect at runner start: `which codex-acp` ↔ `installHint`; gateway `GET /capabilities` reports `adapter.codex.ready=false` if binary missing"
    test_cases:
      - id: "codex-execute-e2e"
        description: "ExecuteCommand with agent='codex' against real codex-acp: streams text, runs Bash tool, completes with result.subtype='success'"
        type: "e2e"
      - id: "codex-permission-gate"
        description: "Codex requests Edit on a file; ACP request_permission flows to DO as permission_request GatewayEvent; user-allow response routes back; Edit completes"
        type: "e2e"
      - id: "codex-multi-turn-in-process"
        description: "Within a single live runner: first prompt completes; second `stream-input` GatewayCommand triggers ACPAdapter.streamInput() which sends ACP `session/prompt` on the existing sessionId; second response streams without subprocess respawn"
        type: "integration"
      - id: "codex-pricing-synthesis"
        description: "Codex `usage` (input_tokens=1000, output_tokens=500, model='o4-mini') produces result event with total_cost_usd within 0.1% of OpenAI rate card"
        type: "unit"
      - id: "codex-kill-switch-init-slow"
        description: "Stub codex-acp delaying initialize by 6s triggers kill-switch; runner emits `type:'error'` with code='codex_acp_kill_switch_tripped'; gateway reports adapter.codex.ready=false on next probe"
        type: "integration"
      - id: "codex-missing-credential"
        description: "Gateway started without OPENAI_API_KEY: ExecuteCommand with agent='codex' emits `type:'error'` with code='missing_credential_openai_api_key' before subprocess spawn; gateway `GET /capabilities` reports adapter.codex.missing=['OPENAI_API_KEY']"
        type: "integration"
  - id: p4
    name: "Gemini CLI agent + Path B validation"
    tasks:
      - "Wire registry entry for gemini-cli: `{ name: 'gemini-cli', command: 'gemini', args: ['--acp'], env: ['GEMINI_API_KEY'], installHint: 'npm install -g @google/gemini-cli' }`"
      - "Forward `GEMINI_API_KEY` in `.cmd` JSON env block (same pattern as OPENAI_API_KEY)"
      - "Declare GeminiAdapter capabilities (via ACP _meta): supportsRewind=false, supportsThinkingDeltas=false, supportsPermissionGate=true, supportsSubagents=false, supportsContextUsage=false, supportsInterrupt=true, supportsCleanAbort=false, availableProviders=[{provider:'google', models:[{id:'gemini-2.5-pro'}, {id:'gemini-2.5-flash'}]}]"
      - "Add Google Gemini rate cards to `packages/pricing/src/rate-cards/google.json`"
      - "E2E test against real `gemini --acp` binary in CI (gated by `GEMINI_ACP_E2E=1`)"
      - "Document in `packages/session-runner/src/adapters/acp/README.md`: 'Adding a new ACP-speaking agent is a registry entry + rate card + capability declaration. No new adapter class.'"
    test_cases:
      - id: "gemini-execute-e2e"
        description: "ExecuteCommand with agent='gemini-cli' against real gemini --acp: streams text, completes with result.subtype='success'"
        type: "e2e"
      - id: "gemini-registry-only"
        description: "P4's commits modify ONLY: `packages/session-runner/src/adapters/acp/registry.ts` (new entry), `packages/agent-gateway/src/handlers.ts` (env propagation), `packages/pricing/src/rate-cards/google.json` (new file), and capability declarations. Zero new files under `packages/session-runner/src/adapters/acp/` other than the registry change. Verified by an explicit allowlist assertion in the test: `git diff --name-only $(git merge-base HEAD main)..HEAD -- ':!pnpm-lock.yaml' ':!**/tsconfig*.json' ':!**/*.md' ':!planning/**'` — exclude lockfiles, tsconfig, all markdown docs, and planning artifacts — then compare the remaining paths against the regex `^(packages/session-runner/src/adapters/acp/registry\\.ts|packages/agent-gateway/src/handlers\\.ts|packages/pricing/src/rate-cards/google\\.json|.*\\.(test|spec)\\.ts)$`. Any path outside the allowlist fails the test."
        type: "structural"
      - id: "path-b-validation"
        description: "Both codex and gemini-cli sessions emit identical event shapes (only metadata differs); UI handles both without agent-specific branches"
        type: "integration"
---

# ACP-speaking session-runner with Codex as first non-Claude agent

## Overview

duraclaw's session-runner currently embeds `@anthropic-ai/claude-agent-sdk`
directly. To add more agents (Codex first), this spec ships a generic
**`ACPAdapter`** that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
to any ACP-compliant subprocess — eliminating the per-vendor adapter
explosion. Claude stays SDK-direct (the `@agentclientprotocol/claude-agent-acp`
adapter has structural gaps unfit for duraclaw — research doc §R6b).

This spec **amends Spec #30**. Spec #30 P1 (RunnerAdapter interface +
ClaudeAdapter extraction) is adopted unchanged as P0 of this spec. Spec #30
P2–P4 (separate per-SDK `CodexAdapter`/`GeminiCliAdapter`/`PiMonoAdapter`/
`HermesAdapter` classes, each importing a vendor SDK directly) are
**superseded** by this spec's `ACPAdapter` + registry pattern. New
non-Claude agents are added as registry entries, not new adapter classes.

## Feature Behaviors

### B1: RunnerAdapter interface lands; ClaudeAdapter extracted (Spec #30 P1 adoption)

**Core:**
- **ID:** `runner-adapter-interface`
- **Trigger:** Any session start (existing or new); refactor of `claude-runner.ts`
- **Expected:** `RunnerAdapter` + `AdapterCapabilities` + `AdapterStartOptions` types defined in `packages/shared-types/src/runner-adapter.ts`. `ClaudeAdapter` implements the interface in `packages/session-runner/src/adapters/claude.ts`. `main.ts` dispatches via `cmd.agent ?? 'claude'`. Claude session behavior is observably identical pre/post refactor.
- **Verify:** Run regression test suite added per Spec #30 P1 task list. All Claude integration tests pass without modification.
- **Source:** `packages/session-runner/src/claude-runner.ts:525-773` (existing); `packages/shared-types/src/index.ts:38` (`agent?: string` already exists, narrows to `AgentName` in P0a)

#### API Layer
`GatewayEvent.session.init` gains `capabilities: AdapterCapabilities`. The DO consumes this and stores it on `SessionMeta` (`apps/orchestrator/src/agents/session-do.ts:85` — note the codebase deleted the public `SessionState` type in #31; `SessionMeta` is the durable, DO-private interface, mirrored to `sessionsCollection` for client reads).

#### Data Layer
SQLite migration vN adds `session_meta.capabilities_json` column. `hydrateMetaFromSql()` restores it on DO rehydrate (per the existing pattern at `session-do.ts:383`). `sessionsCollection` rows gain a `capabilities` field, broadcast via `broadcastSessionRow` (existing fanout). No client storage migration — TanStack DB collections backfill on next session-init.

---

### B2: `ACPAdapter` implements `RunnerAdapter`

**Core:**
- **ID:** `acp-adapter`
- **Trigger:** `cmd.agent` matches a registry entry (initially `'codex'` or `'gemini-cli'`)
- **Expected:** ACPAdapter spawns the registered ACP server subprocess (`codex-acp`, `gemini --acp`), wraps stdio in `ndJsonStream`, builds a `ClientSideConnection` from `@agentclientprotocol/sdk`, completes the `initialize` + `session/new` handshake, and drives the session via `session/prompt` / `session/cancel`. On `dispose()`, escalates SIGTERM → 2s → SIGKILL. Subprocess never orphans across runner exit.
- **Verify:** Test `acp-handshake` (subprocess starts, handshake completes <2s); `acp-subprocess-dispose-idempotent` (double-dispose no-op); `acp-cancel-on-abort` (AbortSignal fires `session/cancel` before SIGTERM).
- **Source:** New: `packages/session-runner/src/adapters/acp/{index,registry,subprocess}.ts`

#### API Layer
ACP wire protocol: JSON-RPC 2.0 over stdio (NDJSON). Methods: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/request_permission`. Notifications: `session/update`. Schema v0.12.2.

---

### B3: ACP → GatewayEvent translator

**Core:**
- **ID:** `acp-translator`
- **Trigger:** Each ACP `session/update` notification or response from the subprocess
- **Expected:** Translator function emits 0..N GatewayEvents per ACP notification. The 6 clean maps (partial_assistant, tool_result, permission_request, error, stopped, result) and 5 syntheses (session.init, assistant finalization, file_changed, ask_user-as-error, skipped context_usage) cover every event type duraclaw emits today. Unknown notifications are logged via `logEvent('warn', 'acp', ...)` and dropped, never crashing the runner.
- **Verify:** Translator unit tests cover each of the 11 cases plus the unknown-type negative path.
- **Source:** New: `packages/session-runner/src/adapters/acp/translator.ts`. Reference for clean maps: research doc §R5.

#### API Layer
No new wire protocols. Translates ACP `SessionNotification` (typed by `@agentclientprotocol/sdk`) into `GatewayEvent` (typed by `@duraclaw/shared-types`).

---

### B4: `AdapterCapabilities` plumbed end-to-end; UI gates non-Claude features

**Core:**
- **ID:** `capability-gating`
- **Trigger:** `session.init` event arrives at DO; `SessionMeta.capabilities` updated; mirrored to `sessionsCollection`; UI re-renders.
- **Expected:** UI controls bound to `capabilities.supportsRewind`, `supportsContextUsage`, `supportsPermissionGate`, `supportsThinkingDeltas`, `supportsAskUser` are hidden / disabled / show "Not available for this agent" message when `false`. Codex sessions show no rewind arrow and no context bar. Claude sessions look identical to today.
- **Verify:** Open a Codex session: rewind UI absent. Open a Claude session: rewind UI present. Verified via `claude-baseline-execute` + `codex-execute-e2e`.
- **Source:** UI gating sites — `apps/orchestrator/src/features/agent-orch/ChatThread.tsx` (rewind handler at line 489; ask_user/permission part rendering at lines 110–112) and `apps/orchestrator/src/components/status-bar.tsx:38` (`ContextBar` component).

#### UI Layer
- **Rewind handler in `ChatThread.tsx`** (line 489 `onRewind?: (turnIndex: number) => void`): wrap invocation site in `capabilities.supportsRewind === true` check; pass undefined when false (existing optional-prop semantics suppress the UI affordance).
- **`ContextBar` in `status-bar.tsx:38`**: add early return when `capabilities.supportsContextUsage === false`. Existing `if (contextUsage.maxTokens <= 0) return null` covers null-data path; this gate covers the agent-doesn't-support path.
- **ask_user parts in `ChatThread.tsx:110-112`** (`tool-AskUserQuestion` / `tool-ask_user`): when `capabilities.supportsAskUser === false`, render a session-level error component for `code='ask_user_not_supported_on_acp'` instead of the question modal. Copy: "This agent doesn't support structured questions; rephrase your prompt or switch agents."
- **Thinking deltas**: existing rendering reads from message parts; capability gate filters thinking parts out at the runner layer (ACPAdapter does not synthesize thinking parts at all when `supportsThinkingDeltas=false`).

---

### B5: Codex agent end-to-end via `codex-acp` + kill-switch

**Core:**
- **ID:** `codex-e2e`
- **Trigger:** `ExecuteCommand` or `ResumeCommand` with `agent: 'codex'`
- **Expected:** Gateway forwards `OPENAI_API_KEY` to runner via `.cmd` env block. Runner instantiates ACPAdapter, spawns `codex-acp`, runs the session through to completion. Result event includes synthesized `total_cost_usd` from `@duraclaw/pricing`. Permission gates flow round-trip through DO. If kill-switch trips (init >5s p95, crash within 30s of start), runner emits `type:'error'` with `code='codex_acp_kill_switch_tripped'` and gateway reports `adapter.codex.ready=false` on next `/capabilities` probe.
- **Verify:** `codex-execute-e2e`, `codex-permission-gate`, `codex-multi-turn-in-process`, `codex-pricing-synthesis`, `codex-kill-switch-init-slow`, `codex-missing-credential` (test_cases under P3).
- **Source:** New: registry entry in `packages/session-runner/src/adapters/acp/registry.ts`. Modified: `packages/agent-gateway/src/handlers.ts:166` (env propagation).

#### API Layer
`POST /sessions/start` from DO accepts `agent: 'codex'`. `.cmd` JSON env block carries `OPENAI_API_KEY`. `GET /capabilities` returns `{adapter:{codex:{ready:bool, missing:string[]}}}` based on env-var presence.

#### Data Layer
`packages/pricing/src/rate-cards/openai.json` — new file. Schema documented in `packages/pricing/README.md`.

---

### B6: Gemini CLI registry entry validates Path B's plug-and-play promise

**Core:**
- **ID:** `gemini-registry`
- **Trigger:** Adding a second non-Claude agent through registry entry alone — no new adapter class.
- **Expected:** Gemini CLI works end-to-end with only: registry entry, rate card, capability declaration via ACP _meta, env propagation. Diff vs Codex is mechanical (different binary, args, env, model list). Zero new TypeScript files in `adapters/acp/`. `path-b-validation` test confirms event shapes are identical for both agents.
- **Verify:** `gemini-execute-e2e`, `gemini-registry-only` (structural test: directory tree compare), `path-b-validation`.
- **Source:** New: registry entry only. No new files in `adapters/acp/` for this behavior.

#### API Layer
Identical to B5 — `agent: 'gemini-cli'`, `GEMINI_API_KEY` env, `GET /capabilities` reports gemini-cli readiness.

---

## Non-Goals

- **Migrating Claude to ACP.** Research §R6b confirmed `@agentclientprotocol/claude-agent-acp` v0.31.0 has structural gaps (AskUserQuestion blocklisted, `task_*` events dropped, `rewindFiles` missing). Claude stays SDK-direct. Revisit Q3 2026 when adapter stabilizes.
- **Structured-question (`ask_user`) support for ACP runners.** ACP has `request_permission` but no native structured-Q&A primitive. v1 returns `type:'error'` with `code='ask_user_not_supported_on_acp'`. If upstream ACP adds support (track `agentclientprotocol/typescript-sdk` issues), revisit in a follow-up spec.
- **Orphan-recovery / `forkWithHistory` for ACP sessions.** ACP has `session/load` but no on-disk transcript convention; the existing self-healing path (`.claude/rules/session-lifecycle.md` §4) is Claude-SDK-specific. v1: ACP sessions are non-resumable across runner death and do not participate in orphan recovery. Document the gap; revisit in Phase 2 of a future spec.
- **`ResumeCommand` for ACP agents.** Per the line above, ACP sessions are non-resumable. The DO MUST reject `ResumeCommand{agent:'codex'|'gemini-cli'}` with 400 `{ error: 'resume_not_supported_for_acp_agents', agent }` and instead instruct the caller to issue a fresh `ExecuteCommand`. The 30-min idle reaper code path (`session-lifecycle.md` §3) still runs for ACP sessions but their post-reap state is `terminated` (terminal), not `idle`. Add this rejection in P0b's set of DO API guards (alongside the unknown-agent rejection); add a test case `resume-rejected-for-acp-agents` to P0b's `test_cases` list.
- **`task_*` background-task events for ACP runners.** ACP has no equivalent. Claude SDK feature stays Claude-only. Capability `supportsSubagents=false` for ACP agents.
- **`rewindFiles` for ACP runners.** Claude SDK feature; capability `supportsRewind=false` for ACP agents; UI hides the button.
- **`@openai/codex-sdk` direct integration.** Path A was rejected at interview D1. If Codex-via-ACP proves permanently unstable, this spec's kill-switch swaps to Gemini CLI; reverting to Path A would be a separate spec.
- **PiMono and Hermes adapters from Spec #30 P4+.** These are superseded — they ship as ACP registry entries when their ACP servers are available, or remain unimplemented otherwise. Out of scope here.

## Error-Code Registry

Every `type:'error'` GatewayEvent emitted by code introduced in this spec uses a code from this table. The DO routes the event through the existing error pipeline (`SessionMeta.error` field updated, `messagesCollection` upsert with the error part, status transition to `'error'`). Implementers MUST NOT introduce new codes without adding a row here.

| Code | `retryable` | Source | Trigger | DO action | UI render |
|---|---|---|---|---|---|
| `unknown_agent` | false | runner main.ts (P0a) + DO API boundary (P0b) | `cmd.agent` not in registry | Reject at API w/ 400; if past API, mark session `error` and emit | Session-level error: "Unknown agent type: {agent}" |
| `model_not_available_for_adapter` | false | DO `set-model` handler (P0b) | requested model's provider absent from `capabilities.availableProviders` | Return 400, do not change session model | Toast: "Model {model} not available on {adapter}; pick from: {list}" |
| `acp_protocol_version_mismatch` | false | ACPAdapter.run() (P1) | ACP server returned protocolVersion whose semver `major != 0` OR `minor != 12` (i.e., not 0.12.x) | Mark session `error`, emit | Session-level error: "ACP protocol version mismatch — agent binary may need upgrade" |
| `ask_user_not_supported_on_acp` | false | ACPAdapter (P2) | ACP agent attempts structured Q&A | Mark session `error`, emit | Session-level error: "This agent doesn't support structured questions; rephrase or switch agents" |
| `codex_acp_kill_switch_tripped` | true (retry = start a fresh session, NOT resume the dead one — ACP sessions are non-resumable per the Non-Goals section) | ACPAdapter subprocess monitor (P3) | per-session: init >5s OR exit within 30s; adapter-level: 3 consecutive trips in 1h | Mark session `error`, emit; gateway sets `adapter.codex.ready=false` if adapter-level | Session-level error with Retry button: "Codex agent unstable; click Retry to start a new session, or switch to agent=gemini-cli" |
| `missing_credential_openai_api_key` | false | ACPAdapter pre-spawn check (P3) | `OPENAI_API_KEY` env unset before subprocess spawn | Mark session `error`, emit | Banner (missing-credential-banner.tsx) lists env var + link to .env.example |
| `missing_credential_gemini_api_key` | false | ACPAdapter pre-spawn check (P4) | `GEMINI_API_KEY` env unset before subprocess spawn | Same as above, gemini variant | Same banner, gemini env var |

`retryable: true` codes show a Retry button in the UI that re-spawns the runner with the same adapter + resume info. `retryable: false` codes show no retry — user must take action (set env, switch agent, reset adapter).

## Verification Plan

After P0a:
1. `pnpm --filter @duraclaw/session-runner test` — all regression tests added in P0a's first task pass against pre-refactor code AND continue passing after `ClaudeAdapter` extraction.
2. Start orchestrator + gateway in dev (`scripts/verify/dev-up.sh`). Open browser, start a Claude session: streams normally — observable behavior identical to pre-refactor.
3. `cat packages/session-runner/src/adapters/index.ts` — registry exports `{ claude: () => new ClaudeAdapter() }`.

After P0b:
4. Restart dev. Start a Claude session. `curl http://localhost:$CC_GATEWAY_PORT/api/sessions/<id>/state` (or equivalent SessionMeta read endpoint) — payload includes `capabilities` field with `supportsRewind=true`, `supportsAskUser=true`, etc.
5. UI: rewind arrow visible, context bar visible. Issue `set-model` to a non-Anthropic model: 400 with `error='model_not_available_for_adapter'`.
6. `POST /api/sessions { agent: 'nonexistent', ... }` — 400 with `error='unknown_agent'`. No DO row created.
7. `curl http://localhost:$CC_GATEWAY_PORT/capabilities` — returns `{adapter:{claude:{ready:true,missing:[]},codex:{ready:false,missing:['OPENAI_API_KEY']},gemini-cli:{ready:false,missing:['GEMINI_API_KEY']}}}`.
8. With `OPENAI_API_KEY` unset, log into the UI: missing-credential banner renders listing `OPENAI_API_KEY` with a link to `.env.example`. Set the var, restart gateway, refresh: banner disappears.

After P1:
9. `pnpm --filter @duraclaw/session-runner test --grep "ACPAdapter"` — handshake, dispose, cancel-on-abort, version-mismatch all pass.
10. With `OPENAI_API_KEY` unset, attempt to start a Codex session: pre-spawn check emits `type:'error'` with `code='missing_credential_openai_api_key'`; no subprocess spawn attempt.

After P2:
11. `pnpm --filter @duraclaw/session-runner test --grep "translator"` — all 11 cases (6 maps + 5 syntheses) pass plus negative tests.

After P3:
12. Install `codex-acp` (`cargo install codex-acp` or `npm install -g @zed-industries/codex-acp`). Set `OPENAI_API_KEY`. Restart gateway.
13. `curl http://localhost:$CC_GATEWAY_PORT/capabilities` — `adapter.codex.ready=true`.
14. UI: start session with agent=codex, prompt "List the files in this repo and read the package.json". Observe: streams text → invokes Read tool → request_permission modal appears → click Allow → tool result → final text → result with cost USD.
15. Open Codex session, observe rewind arrow is absent, context bar is absent.
16. Send a second user turn within the same session: response streams without subprocess respawn (verifies in-process multi-turn via `stream-input` GatewayCommand → `ACPAdapter.streamInput` → ACP `session/prompt`).
17. Run `CODEX_ACP_E2E=1 pnpm --filter @duraclaw/session-runner test --grep "codex"` — passes.
18. Simulate slow init: stub codex-acp with 6s sleep before responding to `initialize`. Start a session: `type:'error'` event with `code='codex_acp_kill_switch_tripped'` (per-session). Repeat 3 times: `GET /capabilities` reports `adapter.codex.ready=false, missing=['kill_switch_tripped']`. `POST /capabilities/reset?adapter=codex` (with bearer auth) clears it.

After P4:
19. Install `@google/gemini-cli` (`npm install -g @google/gemini-cli`). Set `GEMINI_API_KEY`. Restart gateway.
20. `curl http://localhost:$CC_GATEWAY_PORT/capabilities` — `adapter.gemini-cli.ready=true`.
21. UI: start session with agent=gemini-cli, prompt "echo hello". Observe streamed response and final result.
22. Diff `git log --stat` for P4's commits — confirm no new files under `packages/session-runner/src/adapters/acp/`. Only registry entry + rate card + capability spec changes.
23. Run `path-b-validation` test: same prompt against both agents, compare GatewayEvent shapes — only metadata differs.

## Implementation Hints

### Key Imports

| Import | From | Purpose |
|---|---|---|
| `ClientSideConnection`, `ndJsonStream`, `Agent`, `Client` | `@agentclientprotocol/sdk` | ACP wire protocol client wrapper |
| `SessionNotification`, `InitializeRequest`, `InitializeResponse`, `RequestPermissionRequest` | `@agentclientprotocol/sdk` | ACP message types |
| `RunnerAdapter`, `AdapterCapabilities`, `AdapterStartOptions`, `NotSupported` | `@duraclaw/shared-types/runner-adapter` | Spec #30 interface contract |
| `GatewayEvent`, `GatewayCommand`, `ExecuteCommand`, `ResumeCommand` | `@duraclaw/shared-types` | Wire types between runner ↔ DO |
| `Pricing` | `@duraclaw/pricing` (new in P3) | USD cost synthesis from token usage |

### Code Patterns

**Subprocess spawning (mirror forge `client.ts:174-186`):**
```ts
import { ndJsonStream, ClientSideConnection } from '@agentclientprotocol/sdk'

const proc = Bun.spawn([def.command, ...def.args], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
  env: { ...process.env, ...env },
})
const stream = ndJsonStream(
  new WritableStream({ write: c => proc.stdin.write(c), close: () => proc.stdin.end() }),
  proc.stdout,
)
const conn = new ClientSideConnection(_agent => clientImpl, stream)
```

**ACPAdapter `run()` skeleton:**
```ts
async run(opts: AdapterStartOptions): Promise<void> {
  const def = registry[opts.cmd.agent]
  this.proc = spawnAcpSubprocess(def, opts.env)
  this.conn = buildClientConnection(this.proc, {
    onSessionUpdate: n => translator(n).forEach(opts.onEvent),
    onRequestPermission: r => this.routePermissionToDo(r, opts.onEvent),
  })
  const init = await this.conn.initialize({ protocolVersion: '0.12.2', clientCapabilities: {} })
  // Accept any 0.12.x (major+minor match); reject 0.13+ or 1.x. See P1 task 5.
  const [major, minor] = init.protocolVersion.split('.').map(Number)
  if (major !== 0 || minor !== 12) {
    opts.onEvent({ type: 'error', code: 'acp_protocol_version_mismatch', retryable: false,
                   message: `Server protocolVersion=${init.protocolVersion}; runner accepts 0.12.x only.` })
    return
  }
  const newSession = await this.conn.newSession({ cwd: opts.project, mcpServers: [] })
  this.sessionId = newSession.sessionId
  opts.onEvent({ type: 'session.init', sdk_session_id: newSession.sessionId, capabilities: this.capabilities, ... })
  await this.conn.prompt({ sessionId: this.sessionId, prompt: opts.prompt })
}
```

**Translator switch (translator.ts) — partial excerpt; see research doc §R5 for the complete 6-clean-maps + 5-syntheses case set required by B3:**
```ts
export function toGatewayEvents(n: SessionNotification, ctx: TranslatorContext): GatewayEvent[] {
  switch (n.update.sessionUpdate) {
    // === Clean maps (6 total — 2 shown) ===
    case 'agent_message_chunk':
      return [{ type: 'partial_assistant', content: [{ type: n.update.content_block.type, delta: n.update.content_block.text }], ... }]
    case 'tool_call_update':
      return [{ type: 'tool_result', ... }, ...maybeFileChanged(n)]
    // Other clean maps (not shown): request_permission, error content, session closure, stop_reason+usage
    // === Syntheses (5 total — see B3 task list) ===
    // session.init synthesised in ACPAdapter.run() before translator runs
    // assistant finalisation: buffer chunks until stop_reason
    // file_changed: maybeFileChanged() inspects tool_call_update for Edit/Write/MultiEdit
    // ask_user-as-error: structured-question detection in ACPAdapter, NOT translator
    // context_usage: skipped (capability=false), getContextUsage returns NotSupported
    case 'plan':
      return []  // Codex plan mode — not used in v1
    default:
      ctx.logEvent('warn', 'acp', `unknown sessionUpdate: ${(n.update as any).sessionUpdate}`)
      return []
  }
}
```

**Kill-switch monitor pattern (per-session: wall-clock, deterministic):**
```ts
// Per-session kill-switch — wall-clock, no statistics.
const INIT_TIMEOUT_MS = 5000
const initResult = await Promise.race([
  this.conn.initialize(...),
  new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), INIT_TIMEOUT_MS)),
])
if (initResult === 'timeout') {
  opts.onEvent({ type: 'error', code: 'codex_acp_kill_switch_tripped', retryable: true,
                 message: 'codex-acp init exceeded 5s; try agent=gemini-cli.' })
  await ctx.gatewayClient.recordKillSwitchTrip('codex')  // increments adapter-level KV counter
  return
}

// Adapter-level kill-switch lives in the gateway, not the runner — see
// packages/agent-gateway/src/handlers.ts. Counter increments per trip;
// reaches 3 within rolling 1h → adapter.codex.ready=false until manual
// reset or 1h-since-last-trip timeout.
```

### Gotchas

- **Bun's `WritableStream` differs from Node's** — forge's stdio wrapper is Bun-specific. duraclaw's session-runner runs under Bun (per `pnpm --filter @duraclaw/session-runner build` shebang `#!/usr/bin/env bun`), so this is fine — but if a future Node port is needed, the ndJsonStream wiring needs adjustment.
- **`@agentclientprotocol/sdk` v0.20.0+ ABI** — pin tightly. ACP schema is at v0.12.2 but the TS SDK has its own version cadence. Test version-mismatch handling explicitly (test case `acp-protocol-version-mismatch`).
- **`codex-acp` is a Rust binary** — `which codex-acp` capability check must handle both `cargo install` (`~/.cargo/bin/codex-acp`) and `npm install -g @zed-industries/codex-acp` (npm prefix bin). Probe both.
- **`AskUserQuestion` does not exist on the ACP wire** — `@agentclientprotocol/claude-agent-acp` blocklists it. ACPAdapter must NOT pass through any `AskUserQuestion`-shaped tool call from the agent; if one appears, error out (`code='ask_user_not_supported_on_acp'`).
- **SIGKILL fallback is mandatory for codex-acp** — Rust binary may not handle SIGTERM gracefully. Always escalate to SIGKILL after 2s grace (mirror Spec #30 P2 dispose pattern at `codex.ts:614-621`).
- **`request_permission` reply routing** — ACP request_permission is bidirectional (server → client → server). The DO must route the permission response back through the runner's command pump as a typed GatewayCommand; ACPAdapter forwards to the subprocess via `Client.requestPermission` callback. Don't try to short-circuit at the runner — the DO is the source of truth for user choice.
- **Env var leakage** — `OPENAI_API_KEY` and `GEMINI_API_KEY` must NOT appear in `.cmd` JSON written to disk in cleartext if the worktree is shared. The gateway already passes them via process env to the spawned runner; do NOT also write them into `.cmd`. Confirm against `packages/agent-gateway/src/handlers.ts:166`.
- **Kill-switch is deterministic, not statistical** — per-session triggers are wall-clock thresholds (`init > 5s` OR `exit-within-30s`), not p95 over a window. Adapter-level trip is `3 consecutive per-session trips within a rolling 1h KV window`. The earlier draft of this spec mentioned p95 windowing — that approach was rejected because n=10 is statistically meaningless and a single anomalous run skewed the gate. Do not reintroduce p95.

### Reference Docs

- [ACP Specification Overview](https://agentclientprotocol.com/protocol/overview) — message types, flow control, extension pattern
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) v0.20.0 — `ClientSideConnection`, `ndJsonStream`, schema types
- [forge ACP module](https://github.com/forge-agents/forge/tree/main/packages/forge/src/acp) — reference impl: `client.ts`, `translator.ts`, `subprocess.ts` (~2.5K LOC, copy-paste-able)
- [@zed-industries/codex-acp](https://zed.dev/acp/agent/codex-cli) — Codex ACP wrapper, install + flags
- [@google/gemini-cli ACP mode](https://geminicli.com/docs/acp/) — `gemini --acp` flag, env vars
- [@agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) — reference for what NOT to use for Claude (blocklist + gaps)
- [Research doc](../research/2026-04-25-acp-codex-runner.md) — full event-mapping tables, R6/R6b verdicts, comparison matrix
- [Spec #30](./30-runner-adapter-pluggable.md) — superseded for P2+, P1 adopted as P0 here
