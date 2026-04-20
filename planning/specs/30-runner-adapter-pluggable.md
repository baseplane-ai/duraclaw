---
initiative: runner-adapter-pluggable
type: project
issue_type: feature
status: approved
priority: medium
github_issue: 30
created: 2026-04-20
updated: 2026-04-20
supersedes: planning/specs/0016-pluggable-agent-gateway.md
phases:
  - id: p1
    name: "RunnerAdapter interface + ClaudeAdapter extraction (no behaviour change)"
    tasks:
      - "Audit current `packages/session-runner/test/` coverage against the 8 Claude SDK coupling sites listed in B1 Source; add missing regression tests FIRST (before any refactor) for: abort mid-stream, rewind round-trip, permission callback acceptance/denial, resume-via-sdk_session_id, partial_assistant ordering, tool_result ordering. These tests must pass against the pre-refactor code and continue passing after the refactor — they are the regression net."
      - "Define `RunnerAdapter` + `AdapterCapabilities` + `AdapterStartOptions` in `packages/shared-types/src/runner-adapter.ts`"
      - "Add `agent` (default `'claude'`) + `model` optional fields to `ExecuteCommand` / `ResumeCommand` in `packages/shared-types/src/index.ts`"
      - "Extract `ClaudeAdapter` from `packages/session-runner/src/claude-runner.ts`; keep all existing behaviour"
      - "Introduce adapter registry at `packages/session-runner/src/adapters/index.ts` — `Record<AgentName, () => RunnerAdapter>`"
      - "Rewire `packages/session-runner/src/main.ts` to select adapter via `cmd.agent ?? 'claude'`, call `adapter.run(opts)`"
      - "Wire `capabilities` into the outgoing `session.init` event; add `AdapterCapabilities` to `GatewayEvent.session.init` type"
      - "Update `apps/orchestrator` DO to persist `capabilities` on `SessionState` and relay to the UI"
      - "UI: capability-gate the rewind arrow, thinking stream toggle, `ask_user` / `permission_request` modals"
      - "Implement set-model cross-adapter validation in `apps/orchestrator/src/durable-objects/session-do.ts` — reject models whose provider is absent from `capabilities.availableProviders` with 400 `{ error: 'model_not_available_for_adapter', current_adapter }`"
      - "Add `GET /capabilities` endpoint on `packages/agent-gateway/src/server.ts` returning `{ adapter: { <name>: { ready: bool, missing: string[] } } }` based on env-var presence"
      - "UI: add StatusBar red banner component (`apps/orchestrator/src/components/missing-credential-banner.tsx`) that polls `GET /capabilities` on login and renders missing env var names + link to `.env.example`"
    test_cases:
      - id: "claude-adapter-baseline-execute"
        description: "A new Claude session streams the same events as before the refactor (seq-stamped, partial + final assistant, tool_result, result)"
        type: "integration"
      - id: "claude-adapter-baseline-resume"
        description: "An idle-reaped Claude session resumes via ResumeCommand and picks up sdk_session_id"
        type: "integration"
      - id: "capability-bitmap-claude"
        description: "session.init carries `capabilities.supportsRewind=true`, `supportsThinkingDeltas=true`, `supportsPermissionGate=true`"
        type: "integration"
      - id: "default-agent-claude"
        description: "ExecuteCommand without `agent` field defaults to ClaudeAdapter"
        type: "unit"
      - id: "set-model-cross-adapter-rejected"
        description: "POST /api/sessions/<claude-session-id>/set-model with `{model:'gpt-5.1'}` returns 400 with `error='model_not_available_for_adapter'` and `current_adapter='claude'`; same request with `claude-4-opus` returns 200"
        type: "integration"
      - id: "capabilities-endpoint-env-probing"
        description: "Gateway started without OPENAI_API_KEY: `GET /capabilities` returns `adapter.codex.ready=false`, `adapter.codex.missing=['OPENAI_API_KEY']`; with the key set, `ready=true`, `missing=[]`. Test operates on the gateway layer only — no adapter spawn required."
        type: "integration"
      - id: "unknown-agent-rejected-at-do"
        description: "POST /api/sessions with `{ agent: 'nonexistent', ... }` returns 400 with body `{ error: 'unknown_agent', agent: 'nonexistent', known: ['claude','codex','gemini-cli','pi-mono','hermes'] }`. No SessionDO row created. No runner spawn attempt."
        type: "integration"
      - id: "unknown-agent-runner-fallback"
        description: "If a malformed .cmd file with agent='bogus' bypasses DO validation and reaches the runner, `registry[agent]` miss emits type:'error' GatewayEvent with code='unknown_agent', retryable=false; runner writes .exit and shuts down cleanly within 1s"
        type: "unit"
  - id: p2
    name: "CodexAdapter (in-process @openai/codex-sdk, full-auto)"
    tasks:
      - "Add `@openai/codex-sdk` dependency to `packages/session-runner/package.json`"
      - "Implement `CodexAdapter` at `packages/session-runner/src/adapters/codex.ts`"
      - "Map Codex `item.started/updated/completed` + `turn.completed` to `partial_assistant` / `assistant` / `tool_result` / `result`"
      - "Synthesize `session.init` from `thread.id` + cwd + model; emit before first adapter output"
      - "Abort: grab subprocess handle via SDK internals or wrap in AbortController race; SIGKILL fallback"
      - "Add `packages/pricing/src/index.ts` with Codex + OpenAI model rate cards; compute `total_cost_usd` from `turn.completed.usage`"
      - "Write `packages/pricing/README.md` documenting rate-card schema + manual refresh process (pull from provider pricing pages, open PR against `src/rate-cards/*.json`)"
      - "Declare capabilities: rewind=false, thinking=false, permissionGate=false, subagents=false, cleanAbort=false, emitsUsdCost=false (we synthesize)"
      - "Integration test with mocked Codex SDK covering execute + abort + resume-by-threadId"
    test_cases:
      - id: "codex-adapter-execute"
        description: "CodexAdapter starts a thread, emits session.init, streams text via partial_assistant, finishes with result"
        type: "integration"
      - id: "codex-adapter-resume"
        description: "CodexAdapter with ResumeCommand calls `codex.resumeThread(threadId)` and continues from prior context"
        type: "integration"
      - id: "codex-adapter-abort-sigkill"
        description: "Abort during a long turn terminates within 3s even without native SDK abort"
        type: "integration"
      - id: "pricing-module-codex"
        description: "Pricing.compute('openai', 'o4-mini', usage) returns USD cost within 0.1% of OpenAI's published rate card"
        type: "unit"
      - id: "codex-adapter-missing-credential"
        description: "ExecuteCommand.agent='codex' with OPENAI_API_KEY unset emits a type:'error' GatewayEvent with code='missing_credential_openai_api_key', retryable=false, before any SDK call is attempted"
        type: "integration"
  - id: p3
    name: "GeminiCliAdapter (subprocess respawn-per-turn inside long-lived runner)"
    tasks:
      - "Implement `GeminiCliAdapter` at `packages/session-runner/src/adapters/gemini-cli.ts`"
      - "Per turn: spawn `gemini --output-format stream-json --resume <sid> -p <prompt>` via `Bun.spawn`"
      - "JSONL parser: split on `\\n` only (no Unicode-whitespace line reader); map 6 event types (init, message, tool_use, tool_result, error, result)"
      - "Signal handler: on abort, SIGTERM → 2s → SIGKILL; track PID in adapter context for orphan cleanup"
      - "Session ID from `init` event captured on first turn; reused on all subsequent respawns"
      - "Pricing: add Google Gemini rate card to `packages/pricing`"
      - "Declare capabilities: rewind=false, thinking=false, permissionGate=false, subagents=false, cleanAbort=false"
      - "Integration test with a stubbed `gemini` binary (bash script emitting canned JSONL) covering multi-turn + abort"
    test_cases:
      - id: "gemini-cli-adapter-multi-turn"
        description: "First stream-input spawns `gemini` with no --resume; captures session_id from init event; second stream-input spawns `gemini --resume <captured_id>`"
        type: "integration"
      - id: "gemini-cli-adapter-abort-timeout"
        description: "Abort during in-flight gemini subprocess SIGKILLs after 2s SIGTERM grace; adapter emits `result.subtype='interrupted'`"
        type: "integration"
      - id: "gemini-cli-adapter-jsonl-parse"
        description: "Parser correctly handles partial lines at buffer boundaries; no event dropped, no event duplicated"
        type: "unit"
  - id: p4
    name: "PiMonoAdapter (raw-LLM catch-all via @mariozechner/pi-coding-agent)"
    tasks:
      - "Add `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` dependencies to `packages/session-runner/package.json`"
      - "Implement `PiMonoAdapter` at `packages/session-runner/src/adapters/pi-mono.ts` using `createAgentSession()` in-process API"
      - "Map pi-mono JSONL events (`agent_start`, `message_start/update/end`, `tool_execution_*`, `agent_end`) to GatewayEvents"
      - "Populate `AdapterCapabilities.availableProviders` from pi-mono's provider/model registry at adapter construction"
      - "`set-model` command: translate to pi-mono `getModel(provider, modelName)` — parse `model` string as `<provider>/<model-id>`"
      - "Pricing: pi-mono emits per-provider token usage; route through `packages/pricing` keyed on `provider × model`"
      - "Declare capabilities: rewind=false, thinking=(provider-dependent), permissionGate=false, subagents=false, cleanAbort=true (modulo race bug #2716)"
      - "Integration test with pi-mono pointed at a mock OpenAI-compatible server"
    test_cases:
      - id: "pi-mono-adapter-execute-openrouter"
        description: "PiMonoAdapter with model `openrouter/meta-llama-3.1-70b-instruct` streams a response and emits result with token usage"
        type: "integration"
      - id: "pi-mono-adapter-available-providers"
        description: "session.init.capabilities.availableProviders lists all 13 pi-mono providers with non-empty model arrays"
        type: "integration"
      - id: "pi-mono-adapter-model-switch"
        description: "set-model command from `anthropic/claude-4-sonnet` to `openai/gpt-5.1` succeeds without restarting the adapter"
        type: "integration"
      - id: "pi-mono-adapter-resume-continuity"
        description: "After runner reap + respawn with ResumeCommand, the restored pi-mono session continues the prior conversation (e.g. turn 1 says 'my name is Alice', turn 2 after respawn asks 'what is my name?' and answer references Alice). Covers both resume strategies from B7 Data Layer — whichever path the implementer chose must pass this test."
        type: "integration"
  - id: p5
    name: "HermesAdapter (deferred — scaffold only, implementation parked)"
    tasks:
      - "Add empty `packages/session-runner/src/adapters/hermes.ts` that throws `NotImplementedError` on `run()`"
      - "Register `hermes` in adapter registry so `ExecuteCommand.agent='hermes'` returns a clear error at spawn time"
      - "Document the Python-bridge design in `planning/design/hermes-adapter-bridge.md` (sketch only — no code)"
      - "Add capability declaration so UI can grey-out the Hermes option with tooltip 'Coming soon'"
    test_cases:
      - id: "hermes-adapter-not-implemented-error"
        description: "ExecuteCommand.agent='hermes' fails fast with a structured error event (not a silent crash)"
        type: "integration"
---

# Pluggable RunnerAdapter — Claude, Codex, Gemini CLI, pi-mono, Hermes

> GitHub Issue: [#30](https://github.com/baseplane-ai/duraclaw/issues/30)
> Supersedes: [spec 0016](./0016-pluggable-agent-gateway.md) (stale post-session-runner migration)
> Research: [`planning/research/2026-04-20-runner-adapter-evaluation.md`](../research/2026-04-20-runner-adapter-evaluation.md)

## Overview

Duraclaw's `session-runner` currently hardcodes `@anthropic-ai/claude-agent-sdk`
in `packages/session-runner/src/claude-runner.ts` at 8 coupling sites.
This spec introduces a `RunnerAdapter` interface so the runner can host
any coding-agent backend while preserving every invariant of the
existing dial-back WS protocol. We ship 4 adapters (Claude refactor,
Codex, Gemini CLI, pi-mono) and scaffold Hermes for later.

## Feature Behaviors

### B1: RunnerAdapter interface is the only path into a backend SDK

**Core:**
- **ID:** runner-adapter-interface
- **Trigger:** `packages/session-runner/src/main.ts` reads `.cmd`, determines `agent = cmd.agent ?? 'claude'`, looks up `registry[agent]`, constructs the adapter
- **Expected:** No file outside `packages/session-runner/src/adapters/` imports a vendor SDK (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@mariozechner/pi-*`). `claude-runner.ts` is deleted; its logic moves to `adapters/claude.ts` implementing `RunnerAdapter`.
- **Verify:** `grep -RE "@(anthropic-ai/claude-agent-sdk|openai/codex-sdk|google/gemini-cli|mariozechner/)" packages/session-runner/src` returns matches only in `adapters/*.ts`.
- **Source:** `packages/session-runner/src/claude-runner.ts:384,674,410-423,426-460,717-721,758-761,466-704` (the 8 coupling sites listed in research)

#### UI Layer
N/A (backend refactor).

#### API Layer
`GatewayEvent.session.init` gains `capabilities: AdapterCapabilities`.

Canonical `RunnerAdapter` interface — lives in `packages/shared-types/src/runner-adapter.ts` and is the sole contract every adapter must implement:

```ts
export type AgentName = 'claude' | 'codex' | 'gemini-cli' | 'pi-mono' | 'hermes'

/** Permission modes mirror Claude Agent SDK semantics. Non-Claude adapters return NotSupported from setPermissionMode. */
export type PermissionMode = 'plan' | 'auto' | 'approve' | 'bypass'

export type ProviderEntry = {
  provider: string              // e.g. 'openai', 'anthropic', 'openrouter'
  models: ReadonlyArray<{
    id: string                  // canonical model id used in set-model ('o4-mini', 'claude-4-sonnet')
    displayName?: string
    contextWindow?: number      // tokens; optional metadata for UI
  }>
}

export type AdapterCapabilities = {
  supportsRewind: boolean
  supportsThinkingDeltas: boolean
  supportsPermissionGate: boolean     // per-tool approval callback (canUseTool / ask_user modal)
  supportsSubagents: boolean          // adapter can spawn child agents (Claude Task tool)
  supportsPermissionMode: boolean     // global plan/approve/bypass mode switch
  supportsSetModel: boolean           // mid-session model swap within adapter's provider family
  supportsContextUsage: boolean       // getContextUsage() returns real data (vs NotSupported)
  supportsInterrupt: boolean          // soft interrupt() available; false = runner skips to abort()
  supportsCleanAbort: boolean         // native abort leaves no orphan subprocess; false = runner applies SIGKILL fallback
  emitsUsdCost: boolean               // adapter's result events carry total_cost_usd; false = route through @duraclaw/pricing
  availableProviders: ReadonlyArray<ProviderEntry>
}

export type AdapterStartOptions = {
  sessionId: string
  project: string               // absolute path
  worktree?: string             // optional alternate cwd
  model?: string                // '<provider>/<model-id>' for multi-provider adapters, bare id for single-provider
  prompt: string                // first turn prompt
  resumeSessionId?: string      // adapter-native session id (Claude sdk_session_id, Codex thread.id, Gemini init.session_id)
  env: Readonly<Record<string, string>>
  signal: AbortSignal           // runner-level abort; adapter must race its work against this
  onEvent: (event: GatewayEvent) => void  // adapter -> runner channel; runner handles seq stamping + buffering
  onCommand: <T extends GatewayCommand>(handler: (cmd: T) => void) => () => void  // runner -> adapter command pump (stream-input, set-model, etc.); returns unsubscribe
}

export type NotSupported = { readonly _notSupported: true; readonly reason: string }

export interface RunnerAdapter {
  readonly name: AgentName
  readonly capabilities: AdapterCapabilities

  /** Drive the session until natural completion or abort. Resolves when no more turns remain (session-runner exits after). */
  run(opts: AdapterStartOptions): Promise<void>

  /** Inject a new user turn. Called from runner's command pump on `stream-input`. */
  streamInput(message: { content: string; attachments?: unknown[] }): Promise<void>

  /** Best-effort mid-turn interruption. Runner already owns `signal.abort()`; adapters that expose a cleaner mechanism call it here. */
  interrupt(): Promise<void>

  /** Not supported returns `NotSupported`; Claude returns rewind result. */
  rewind(args: { targetMessageId: string }): Promise<{ ok: true } | NotSupported>

  /** Context-window usage for the context-bar UI. */
  getContextUsage(): Promise<{ input_tokens: number; max_tokens: number } | NotSupported>

  /** Mid-session model swap within the adapter's provider family. Throws for cross-family requests — validation lives in DO. */
  setModel(model: string): Promise<void | NotSupported>

  /** Adapters with permission-mode awareness (Claude) accept PermissionMode; others return NotSupported. Invalid PermissionMode values are a TS compile-time error. */
  setPermissionMode(mode: PermissionMode): Promise<void | NotSupported>

  /** Release resources — kill child processes, close streams, flush state. Called on clean exit AND on abort. Must be idempotent. */
  dispose(): Promise<void>
}
```

**Adapter lifecycle contract.** `run()` is called exactly once per runner process — it drives the entire session until natural completion, abort, or fatal error. Within a single `run()` call:
- **First turn:** kicks off from `opts.prompt`.
- **Subsequent turns:** the runner calls `adapter.streamInput(message)` **directly** on each `stream-input` GatewayCommand — this is the canonical path and every adapter MUST implement it. The adapter MUST NOT interpret `streamInput` as "start a new `run()`" — the runner calls `run()` only once per process lifetime. Under the hood, adapters inject the message into their SDK's turn loop (Claude: `query.send()`; Codex: `thread.run()`; Gemini CLI: respawn `gemini --resume`; pi-mono: `agent.send()`).
- **`onCommand` vs direct methods — rule:** the runner dispatches every typed command through a direct interface-method call (`streamInput`, `interrupt`, `setModel`, `setPermissionMode`, `rewind`, `getContextUsage`, `dispose`). `opts.onCommand` is an **escape hatch** for future-added command types that the interface doesn't yet have methods for — it passes the raw GatewayCommand to the adapter unchanged. Adapters MUST NOT rely on `onCommand` for any of the commands that have a named method; doing so double-dispatches (runner already calls the method). Today, no adapter needs `onCommand` — it exists solely for forward-compatibility so new commands can ship without an interface-version bump. The P1 ClaudeAdapter does not subscribe to `onCommand` at all; use this as the canonical reference.
- **`interrupt()` vs `signal.abort()`:** runner fires `interrupt()` first when the user clicks Stop (soft — asks adapter to end the current turn gracefully if it knows how). If `interrupt()` doesn't settle within 2s, runner escalates to `opts.signal.abort()` (hard — runner itself aborts, adapter's `run()` promise rejects). `supportsInterrupt: false` tells the runner to skip the soft phase and go straight to abort. `supportsCleanAbort: false` tells the runner that, even after abort, the adapter may hold a subprocess — runner's exit path must follow `dispose()` with a best-effort SIGKILL of known child PIDs.
- **`dispose()`:** called exactly once on exit — after `run()` resolves, rejects, or the runner catches an unhandled error. Must be idempotent and must not throw. Typical work: kill child subprocesses, close streams, drop SDK handles.
- **`getContextUsage()`:** called by the runner on each `get-context-usage` GatewayCommand (polled by the UI via SessionDO at ~5s cadence while a session is focused). Adapters without cheap access to their own token counter return `NotSupported`; UI hides the context bar.

**Adapter error semantics.**
- Any throw from `run()` is caught by the runner main loop and emitted as a `type:'error'` GatewayEvent with `{ code, message, retryable: boolean }`. Session transitions to the `error` state in SessionDO (same as B9).
- `retryable: true` → UI shows a "Retry" affordance that re-spawns the runner with the same adapter + resume info (rate-limit, transient network). `retryable: false` → UI shows "Session failed" with no retry (bad credentials, SDK misuse, NotImplemented).
- `NotSupported` returns are expected and non-fatal — the runner translates them to a structured `not_supported` response on the originating command's reply channel (so the UI can grey-out the invoking control). `NotSupported` NEVER triggers session state change.
- **Unknown `cmd.agent` at registry lookup** (e.g. `'nonexistent'`): fail fast. DO rejects at the API boundary — `POST /api/sessions { agent: 'nonexistent' }` returns 400 `{ error: 'unknown_agent', agent: 'nonexistent', known: [<AgentName[]>] }`. Even if a bad value slips through, runner's `registry[agent]` miss emits a `type:'error'` GatewayEvent with `code: 'unknown_agent'`, `retryable: false`, and exits cleanly.

**Event determinism note (for P1 regression test `claude-adapter-baseline-execute`):** "same events" means *structural* equality of the GatewayEvent sequence — same `type` ordering, same `subtype`/`stop_reason`/`usage` field values for deterministic prompts, same `tool_use_summary`/`tool_result` pairs. Excluded fields: `seq` (monotonic but order-equivalent), timestamps, `session_id`, `sdk_session_id`, and any stringly-identified ids. Implement via a vitest custom matcher that normalizes these fields; see pattern in existing `packages/session-runner/test/helpers/normalize-events.ts` (create if absent in P1).

#### Data Layer
`ExecuteCommand` / `ResumeCommand` (shared-types) gain optional
`agent?: AgentName` (default `'claude'`) and optional `model?: string`. `SessionDO` state persists these on creation; they become immutable for the session's lifetime.

---

### B2: Capability bitmap drives UI control gating

**Core:**
- **ID:** capability-bitmap
- **Trigger:** Client connects to a session; DO forwards the cached `session.init.capabilities` (or receives fresh init from adapter on spawn)
- **Expected:** UI controls (rewind arrow, thinking-stream toggle, per-tool approval modals, context-usage bar, model switcher) are **rendered only if** the corresponding capability is `true`. Capability falsehood is graceful — no blank states, no error toasts.
- **Verify:** In a Codex session (`supportsRewind: false`), the rewind arrow is absent from the message-row toolbar. In a pi-mono session (`availableProviders.length > 0`), the model-picker in session settings lists all providers.

#### UI Layer
- Capability read via `useSessionLiveState(sessionId).capabilities` (added to `SessionLiveState` in `apps/orchestrator/src/lib/session-live-state.ts`).
- Rewind arrow in `apps/orchestrator/src/components/message-row.tsx` wraps with `capabilities.supportsRewind ? <RewindArrow /> : null`.
- Thinking-stream view in `apps/orchestrator/src/components/thinking-block.tsx` gated by `capabilities.supportsThinkingDeltas`.
- Model picker in session settings lists only models in `capabilities.availableProviders`; cross-provider entries are hidden.
- Per-tool approval modal (`apps/orchestrator/src/components/permission-modal.tsx`) rendered only if `capabilities.supportsPermissionGate`.
- Context-usage bar in StatusBar rendered only if `capabilities.supportsContextUsage` (derived client-side from `!(getContextUsage returns NotSupported)` — `session.init` includes a `supportsContextUsage: boolean` flag computed by the runner on adapter construction).
- **Stop button is ALWAYS visible** (the user can always ask to stop). Its gating flags are:
  - `supportsInterrupt: true` → clicking Stop sends an `interrupt` command; adapter attempts a soft stop within the current turn. UI shows "Stopping…" label.
  - `supportsInterrupt: false` → clicking Stop skips the soft phase; runner fires `signal.abort()` immediately. UI shows "Aborting…" label.
  - `supportsCleanAbort: false` → additionally, UI's post-abort "Continue conversation" affordance warns "Previous turn aborted — some tool outputs may be truncated." This flag does NOT hide any control; it purely annotates post-abort state.

#### API Layer
`session.init` event shape (shared-types):

```ts
type SessionInitEvent = {
  type: 'session.init'
  session_id: string
  sdk_session_id: string
  project: string
  model: string
  tools: readonly string[]
  capabilities: AdapterCapabilities  // NEW
}
```

#### Data Layer
`SessionState.capabilities` persisted in SessionDO's SQLite.

---

### B3: Adapter pinned at session creation; model switch allowed, adapter switch forbidden

**Core:**
- **ID:** adapter-pinning
- **Trigger:** User sends `set-model` command mid-session, OR user attempts to change `agent` via any API path
- **Expected:** `set-model` is forwarded to the active adapter and only affects subsequent turns within the same adapter's provider family (e.g. Claude → Claude-Opus-4 is fine, Claude → GPT-5 is rejected). To change *adapter*, user creates a new session via existing fork/branch UX (`forkWithHistory` in SessionDO).
- **Verify:** `curl -X POST /api/sessions/<id>/set-model -d '{"model":"gpt-5.1"}'` on a Claude session returns 400 `{ error: 'model_not_available_for_adapter', current_adapter: 'claude' }`. Same request with `claude-4-opus` succeeds.
- **Source:** `apps/orchestrator/src/durable-objects/session-do.ts` (set-model handler)

#### UI Layer
Model picker in session settings filters to the active adapter's `availableProviders`. Adapter switch UI sends user to "Fork with new agent" flow, not a silent in-place change.

#### API Layer
`POST /api/sessions/:id/set-model` — validates model against `capabilities.availableProviders` before forwarding to the runner.

---

### B4: Credentials via worktree env — BYO, no DO-side secret storage (P1–P4)

**Core:**
- **ID:** byo-credentials
- **Trigger:** Gateway spawns a session-runner subprocess for any adapter
- **Expected:** Subprocess env is inherited from gateway env (which loaded `.env`). No per-user, per-session, or DO-stored API keys in P1–P4. Documented in `.env.example`: required keys are `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Codex + pi-mono-via-OpenAI), `GEMINI_API_KEY` (Gemini CLI + pi-mono-via-Google), plus any pi-mono provider keys the user wants to enable.
- **Verify:** `echo $ANTHROPIC_API_KEY` inside a spawned runner reveals the gateway's value. Starting the gateway without `OPENAI_API_KEY` and spawning a Codex session emits a `session.init`-stage error event `missing_credential_openai_api_key`.
- **Source:** `packages/agent-gateway/src/server.ts:328-374` (spawn env plumbing), `.env.example`

#### UI Layer
On missing-credential error, StatusBar shows a red banner with the missing env var name and a link to `.env.example`.

#### API Layer
Gateway surfaces credential requirements via `GET /capabilities` (new endpoint, behind the same bearer-auth middleware as every other gateway endpoint — timing-safe compare against `CC_GATEWAY_API_TOKEN`).
- **Authed**: `200 { adapter: { claude: { ready, missing }, codex: { ready, missing }, ... } }`.
- **Unauthed / bad bearer**: `401 { error: 'unauthorized' }` — identical shape and header semantics to every other gateway endpoint. No bearer leak, no adapter info disclosed.
- **Mid-startup race**: gateway serves `GET /capabilities` only after env loading completes and the adapter probe has cached its result (probe is synchronous on startup). Requests arriving before probe completion (tiny window — well under 100ms) return `503 { error: 'gateway_warming_up', retry_after_ms: 500 }` so the UI can back off and retry. `GET /health` remains unaffected and can be used for liveness during startup.

#### Data Layer
None. Pure env.

---

### B5: CodexAdapter executes full-auto with SIGKILL-fallback abort

**Core:**
- **ID:** codex-adapter-core
- **Trigger:** `ExecuteCommand.agent === 'codex'` reaches session-runner
- **Expected:** Adapter calls `codex.startThread({ workingDirectory })` (or `resumeThread(threadId)` for resume), runs with `approvalPolicy: 'never'` (full-auto — confirmed by spike: TS SDK has no per-tool callback), iterates `runStreamed(prompt).events`, emits normalized `GatewayEvent`s. On abort, adapter first attempts `thread.abort?.()` if available; if not (pending issue openai/codex#5494) or it hangs >2s, it SIGKILLs the internal subprocess.
- **Verify:** Start a Codex session with a 30s-long task (e.g. `"sleep 20 in bash and report timestamps"`), abort after 5s, verify `result.subtype === 'interrupted'` lands within 3s of abort and the subprocess is gone from `ps -ef`.

#### API Layer
Same `GatewayEvent` surface; Codex-unique fields (empty `capabilities.supportsPermissionGate`, `availableProviders: [{ provider: 'openai', models: [...] }]`) populated by adapter.

#### Data Layer
`sdk_session_id` on SessionState holds the Codex `thread.id`.

---

### B6: GeminiCliAdapter respawns per turn inside long-lived runner

**Core:**
- **ID:** gemini-cli-adapter-core
- **Trigger:** `ExecuteCommand.agent === 'gemini-cli'` reaches session-runner
- **Expected:** Runner stays up on dial-back WS. Per turn, adapter spawns `gemini --output-format stream-json --resume <sid> -p <prompt>` (first turn omits `--resume`; session_id captured from `init` event). JSONL parser splits on `\n` only (not Unicode whitespace). On abort, SIGTERM → 2s → SIGKILL.
  **Minimum `gemini` binary version:** 0.6.0 (first release containing PR #10883 which introduced `--output-format stream-json`). Adapter probes `gemini --version` at construction time; if the major.minor is below 0.6 or `--version` itself fails, adapter declines to start and emits `type:'error'` with `code: 'gemini_cli_too_old'`, `retryable: false`, and a message pointing at the upgrade instructions.
- **Verify:** Two successive `stream-input` commands spawn two `gemini` subprocesses; `ps --ppid $(pidof session-runner)` shows no `gemini` process between turns, and `--resume <same_id>` is used on the second. Additionally, with `gemini` 0.5.x on PATH, ExecuteCommand.agent='gemini-cli' emits `code: 'gemini_cli_too_old'` without spawning.

#### API Layer
Unchanged.

#### Data Layer
`sdk_session_id` holds the Gemini `init.session_id`.

---

### B7: PiMonoAdapter exposes its full provider roster

**Core:**
- **ID:** pi-mono-adapter-core
- **Trigger:** `ExecuteCommand.agent === 'pi-mono'` with `model = '<provider>/<model-id>'`
- **Expected:** Adapter uses pi-mono's in-process `createAgentSession()` with `getModel(provider, modelId)`. `session.init.capabilities.availableProviders` enumerates every pi-mono provider + model at adapter construction time. `set-model` mid-session parses the new `<provider>/<model-id>` string and calls pi-mono's model-swap API.
- **Verify:** `session.init.capabilities.availableProviders` includes (at minimum) `{ provider: 'openai' }`, `{ provider: 'anthropic' }`, `{ provider: 'google' }`, `{ provider: 'openrouter' }`, `{ provider: 'ollama' }`, each with non-empty model arrays. Switching model from `anthropic/claude-4-sonnet` to `openrouter/meta-llama-3.1-70b-instruct` continues the same session.

#### API Layer
Unchanged (uses existing `set-model` command).

#### Data Layer
`SessionState.model` updated on successful swap; persisted to SQLite. **`SessionState.sdk_session_id` strategy for pi-mono:** adapter owns the ID (`crypto.randomUUID()` at construction). Since pi-mono exposes conversation history as a serializable array on the `AgentSession` instance (per the package's public API at v0.67.68), the adapter is responsible for persisting and restoring that state itself — NOT delegating to any `loadAgentSession` helper. Canonical design:
- **Write on every turn's `result`:** adapter serializes `agent.messages` (or equivalent conversation-state accessor the pi-mono public API provides) to `<project>/.duraclaw/pi-mono/<sdk_session_id>.json`.
- **Restore on resume:** adapter constructs a fresh `AgentSession`, then sets `agent.messages = JSON.parse(<file>)` before issuing the resumed prompt.
- **P4 implementation note:** if pi-mono's v0.67.68 surface doesn't expose messages as a settable field, the adapter falls back to "replay" resume — load the prior transcript and re-prime the agent by issuing `agent.send()` with a `<prior_conversation>...</prior_conversation>` system-style prefix, same pattern used by the Duraclaw orphan recovery path (`forkWithHistory` in SessionDO). The P4 implementer picks between these two at implementation time based on whatever pi-mono's actual surface exposes; both paths are acceptable and behaviorally equivalent from the Duraclaw-UX perspective.

---

### B8: Pricing module computes USD cost for adapters that don't emit it

**Core:**
- **ID:** pricing-module
- **Trigger:** Adapter emits `result` event. Runner inspects `adapter.capabilities.emitsUsdCost`.
- **Expected:**
  - `emitsUsdCost: true` (ClaudeAdapter — the Anthropic SDK already populates `total_cost_usd`): runner forwards the adapter's value verbatim. Pricing module is NOT consulted — the SDK is the source of truth.
  - `emitsUsdCost: false` (Codex, Gemini CLI, pi-mono): runner calls `pricing.compute(provider, model, usage)` and writes `result.total_cost_usd` before forwarding via `BufferedChannel`. If the pricing module returns `undefined` (unknown model), runner forwards `total_cost_usd: null` and logs a warning — session still succeeds.
  - Rate cards live in `packages/pricing/src/rate-cards/` as static JSON keyed on `<provider>/<model-id>`. ClaudeAdapter's `emitsUsdCost: true` is declared in its capability block.
- **Verify:** Unit test: `pricing.compute('openai', 'o4-mini', { input_tokens: 1000, output_tokens: 500 })` returns the published OpenAI rate × tokens (e.g. `$0.00075` — confirm actual numbers against the rate card JSON). Integration test: a ClaudeAdapter session's `result.total_cost_usd` equals the SDK's value bit-for-bit (pricing module not invoked).

#### API Layer
None (internal module).

#### Data Layer
Rate cards are static data; update via PR when provider pricing changes.

---

### B9: HermesAdapter scaffolded but not implemented

**Core:**
- **ID:** hermes-scaffold
- **Trigger:** `ExecuteCommand.agent === 'hermes'` reaches session-runner
- **Expected:** Adapter throws `NotImplementedError('hermes adapter scheduled for later; see planning/design/hermes-adapter-bridge.md')`. Runner catches, emits `error` event with `code: 'adapter_not_implemented'`, writes `.exit` with `state: 'failed'`, exits cleanly. UI surfaces a user-facing "Coming soon" message when attempting to pick Hermes.
- **Verify:** `curl -X POST /api/sessions -d '{"agent":"hermes",...}'` returns 200 (DO creates session); the session transitions to `error` state within 5s with `error.code === 'adapter_not_implemented'`.

#### UI Layer
Hermes option in agent picker is visible but disabled with tooltip: "Hermes support coming soon — [track progress](#)."

---

## Non-Goals

- **OpenCode adapter**: removed from scope per user directive. The P3 placeholder in spec #16 is abandoned.
- **Per-user API-key storage in DO**: deferred to a follow-up. P1–P4 use worktree env only (B4).
- **Model-picker UX redesign**: the two-step picker (agent → model) is agreed at the backend level (B1, B3); frontend picker-component design is a follow-up issue.
- **Mid-session adapter switch**: explicitly forbidden (B3). Users fork/branch to change adapters.
- **Claude SDK feature parity for non-Claude adapters**: thinking deltas, rewind, per-tool `canUseTool`, subagent spawning are Claude-only. Capability bitmap makes this explicit — no attempt to emulate on other backends.
- **Python bridge implementation for Hermes**: P5 ships scaffold only.
- **Runtime cost dashboards / billing**: `packages/pricing` produces `total_cost_usd` per turn; aggregation UI is out of scope.

## Open Questions

All planning-phase questions have been resolved. Decisions below are binding for P1–P5; revisit only via a new spec.

- [x] Adapter-selection entitlement gating — **Decision:** no gating in P1–P5. Every adapter is enabled for every authenticated user as long as the gateway's env supplies the credential. Entitlement plumbing is explicitly out of scope; revisit only if/when multi-tenant SaaS plans exist.
- [x] Rate-card refresh cadence for `packages/pricing` — **Decision:** static JSON committed to the repo, updated by manual PR against `packages/pricing/src/rate-cards/*.json`. No scraper, no runtime fetch. Cadence = "whenever a provider announces a change." A stale rate card produces wrong-but-bounded `total_cost_usd`; it cannot break sessions. Document refresh process in `packages/pricing/README.md`.
- [x] pi-mono model-id format — **Decision:** Duraclaw's external `set-model` API accepts `<provider>/<model-id>` (consistent with Ollama/OpenRouter convention). The PiMonoAdapter splits on the first `/` internally and calls pi-mono's `getModel(provider, modelId)` with the pieces. If pi-mono ever changes its internal API shape, the translation stays localized to `adapters/pi-mono.ts`. No external contract change possible post-P4.

## Implementation Phases

See YAML frontmatter. Each phase is 1–4 hours of focused work **except P1 which is ~6–8 hours** (largest refactor, pure no-behaviour-change work, highest regression risk — extra care).

**P1 sub-ordering and PR strategy.** P1 ships as **two separate PRs** — one atomic backend PR and one follow-up UI PR:

1. **P1a PR (backend-only, ~4h)** — single squash-merge PR containing tasks 1–7 + set-model validation + `GET /capabilities` endpoint. All backend tasks land together because the adapter interface, agent-field wiring, and capabilities plumbing are deeply interdependent (a partial land would break build). This PR is the P2 gate: do not open P2 PRs until this merges.
2. **P1b PR (UI only, ~2–3h)** — single squash-merge PR containing UI capability-gating + missing-credential banner. **Non-blocking for P2.** Depends only on P1a's shared-types/DO changes. UI can lag adapter work by a phase; absent gating degrades to rewind-arrow-that-does-nothing, not a crash.

Do NOT split P1a into sub-PRs (e.g. "just shared-types first"). A split exposes intermediate states where `session-runner` still imports `claude-runner.ts` but `shared-types` already removed the old types — build breaks on main. Do NOT combine P1a + P1b into one PR either — the review surfaces are too different (refactor vs. visual UI) and reviewers can't reasonably LGTM both.

**P2 → P3 / P4 dependency on `packages/pricing`:** P2 creates the `@duraclaw/pricing` package (scaffold + Codex/OpenAI rate card). P3 adds the Google Gemini rate card; P4 adds pi-mono provider rate cards. **P2 is the gate for P3 and P4's pricing additions.** After P2 merges, P3 and P4 parallelize freely — their rate-card JSONs live in separate files (`packages/pricing/src/rate-cards/google.json`, `openrouter.json`, etc.), so merge conflicts are impossible. Do not attempt P3 or P4 pricing work before P2's pricing scaffold lands.

## Verification Strategy

### Test Infrastructure

- **vitest** already configured across the workspace (`vitest.config.*` in each package). No new test infra needed.
- Claude adapter: existing session-runner integration tests in `packages/session-runner/test/` remain the regression gate — **plus the coverage-backfill suite added as P1 task 1** (audit-driven tests for abort, rewind, permission callbacks, resume, partial/tool ordering). Backfill tests land BEFORE the refactor and must stay green through it. This is the actual regression net; do not rely on the pre-existing suite alone.
- Codex adapter (P2): mock `@openai/codex-sdk` in a vitest setup; assert event normalization.
- Gemini CLI adapter (P3): stub `gemini` binary via a bash script in `packages/session-runner/test/fixtures/` that echoes canned JSONL on stdin, to exercise the respawn loop without real API calls.
- pi-mono adapter (P4): point pi-mono at a mock OpenAI-compatible server via its `baseURL` config.

### Build Verification

- `pnpm typecheck` (Turbo-cached across all packages). Enforces the capability type flows through `GatewayEvent.session.init` end-to-end.
- `pnpm build` (tsup) at `packages/session-runner` — ensures adapters compile to the `dist/main.js` binary with correct shebang.
- No wrangler / CF build changes required — DO code only touches shared-types and SessionState serialization.

## Verification Plan

### VP1: Claude regression (P1 gate)

Steps:
1. Check out post-P1 branch. Run `pnpm --filter @duraclaw/session-runner test`.
   Expected: All existing session-runner tests pass. Zero diff in event output for equivalent prompts.
2. In a dev worktree: `scripts/verify/dev-up.sh` then `scripts/axi open http://localhost:$VERIFY_ORCH_PORT/`. Log in as test user, start a session, send prompt `"list files in this repo"`.
   Expected: Session completes. `session.init` event in WS inspector shows `capabilities.supportsRewind=true`, `supportsThinkingDeltas=true`, `supportsPermissionGate=true`.
3. Click the rewind arrow on an assistant message.
   Expected: Rewind completes as before the refactor. No visual or behavioural change from pre-P1 baseline.

### VP2: Codex adapter end-to-end (P2 gate)

Steps:
1. Set `OPENAI_API_KEY` in `.env`. `scripts/verify/dev-up.sh`.
2. Via API (browser fetch or curl with auth cookie): `POST /api/sessions { "agent": "codex", "model": "o4-mini", "project": "<project>", "prompt": "Write a fib function in fib.py" }`.
   Expected: 200; session starts streaming. `session.init.capabilities.supportsRewind=false`. Rewind arrow is not rendered in the UI.
3. Wait for `result` event.
   Expected: `result.total_cost_usd` is populated (by `packages/pricing`, not by SDK). `result.subtype='success'`. File `fib.py` exists in the project.
4. Start another Codex session, send a 30s task, abort after 5s.
   Expected: `result.subtype='interrupted'` lands within 3s of abort. `ps -ef | grep codex` shows no orphan subprocess 5s after abort.

### VP3: Gemini CLI adapter respawn (P3 gate)

Steps:
1. Set `GEMINI_API_KEY`. `scripts/verify/dev-up.sh`.
2. Start a `gemini-cli` session with prompt `"say hello"`. Wait for result.
3. Tail gateway log: `tail -f /run/duraclaw/sessions/*.log` (or local equivalent).
4. Send a second `stream-input` via the UI: `"now say goodbye"`.
   Expected: Gateway log shows **two separate spawns** of `gemini` subprocess. The second spawn includes `--resume <session_id>` matching the first turn's `init.session_id`.
5. During turn 3 generation, click "Stop". Expected: `result.subtype='interrupted'`; `ps --ppid $(pidof session-runner)` returns no rows within 3s.

### VP4: pi-mono adapter with provider switch (P4 gate)

Steps:
1. Set `ANTHROPIC_API_KEY` + `OPENROUTER_API_KEY` in `.env`. `scripts/verify/dev-up.sh`.
2. Start a `pi-mono` session with `model: "anthropic/claude-4-sonnet"`, send `"say hi"`.
   Expected: Session.init.capabilities.availableProviders contains `anthropic`, `openai`, `google`, `openrouter`, etc. Assistant responds.
3. Call `POST /api/sessions/:id/set-model { "model": "openrouter/meta-llama-3.1-70b-instruct" }`.
   Expected: 200. Next user message is routed to OpenRouter's Llama; verify via `stats.provider='openrouter'` in the result event.
4. `POST /api/sessions/:id/set-model { "model": "anthropic/claude-4-sonnet" }` → continue.
   Expected: Works symmetrically.

### VP5: Hermes scaffold rejection (P5 gate)

Steps:
1. `POST /api/sessions { "agent": "hermes", ... }`.
   Expected: 200. Within 5s, session state transitions to `error`. `error.code === 'adapter_not_implemented'`.
2. UI picker shows Hermes with a disabled-state styling and tooltip "Coming soon".

## Implementation Hints

### Dependencies

```bash
# P2
pnpm --filter @duraclaw/session-runner add @openai/codex-sdk

# P4
pnpm --filter @duraclaw/session-runner add @mariozechner/pi-coding-agent @mariozechner/pi-ai

# P2 / P3 / P4 (shared)
pnpm add -w @duraclaw/pricing  # new internal package
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@duraclaw/shared-types/runner-adapter` | `{ RunnerAdapter, AdapterCapabilities, AdapterStartOptions, NotSupported }` | Adapter interface + capability typing |
| `@openai/codex-sdk` | `{ Codex }` | P2 — Codex execution + thread resume |
| `@mariozechner/pi-coding-agent` | `{ createAgentSession }` | P4 — pi-mono in-process session |
| `@mariozechner/pi-ai` | `{ getModel }` | P4 — provider/model lookup |
| `@duraclaw/pricing` | `{ compute }` | Synthesise `total_cost_usd` when adapter doesn't emit it |

### Code Patterns

**Adapter registry** (`packages/session-runner/src/adapters/index.ts`):

```ts
import type { RunnerAdapter } from '@duraclaw/shared-types/runner-adapter'
import { ClaudeAdapter } from './claude.js'
import { CodexAdapter } from './codex.js'
import { GeminiCliAdapter } from './gemini-cli.js'
import { PiMonoAdapter } from './pi-mono.js'
import { HermesAdapter } from './hermes.js'

export type AgentName = 'claude' | 'codex' | 'gemini-cli' | 'pi-mono' | 'hermes'

export const adapterRegistry: Record<AgentName, () => RunnerAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  'gemini-cli': () => new GeminiCliAdapter(),
  'pi-mono': () => new PiMonoAdapter(),
  hermes: () => new HermesAdapter(),
}
```

**Gemini CLI JSONL line splitter** (strict LF, not Unicode-whitespace-aware):

```ts
async function* readJsonlLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nlIdx
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIdx)
      buffer = buffer.slice(nlIdx + 1)
      if (line.length > 0) yield JSON.parse(line)
    }
  }
  if (buffer.trim().length > 0) yield JSON.parse(buffer)
}
```

**Codex interrupt with SIGKILL-fallback in dispose** (P2) — maps to the `RunnerAdapter.interrupt()` + `dispose()` methods on the interface; `interrupt()` attempts a soft stop, `dispose()` guarantees no orphan subprocess:

```ts
async interrupt(): Promise<void> {
  // Soft stop: try the SDK's abort if it exists (pending openai/codex#5494).
  if (this.thread?.abort) {
    await Promise.race([
      this.thread.abort(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  }
  // Runner will escalate to signal.abort() if this didn't settle the current turn.
}

async dispose(): Promise<void> {
  // Idempotent final cleanup — runs on every exit path.
  if (this.childPid) {
    try { process.kill(this.childPid, 'SIGKILL') } catch {}
    this.childPid = undefined
  }
  this.thread = undefined
}
```

**Capability declaration pattern**:

```ts
export class CodexAdapter implements RunnerAdapter {
  readonly name = 'codex' as const
  readonly capabilities: AdapterCapabilities = {
    supportsRewind: false,
    supportsThinkingDeltas: false,
    supportsPermissionGate: false,  // spike confirmed: TS SDK has no per-tool callback
    supportsSubagents: false,
    supportsPermissionMode: false,
    supportsSetModel: true,          // thread can reconfigure model between turns
    supportsContextUsage: true,      // turn.completed.usage provides running totals
    emitsUsdCost: false,             // we synthesise via @duraclaw/pricing
    supportsInterrupt: true,         // streamInput can inject mid-turn
    supportsCleanAbort: false,       // pending openai/codex#5494
    availableProviders: [{
      provider: 'openai',
      models: [
        { id: 'o4-mini', displayName: 'o4-mini', contextWindow: 200_000 },
        { id: 'gpt-5.1', displayName: 'GPT-5.1', contextWindow: 1_000_000 },
        // ... full rate-card-aligned list
      ],
    }],
  }
  // ...
}
```

### Gotchas

- **`@openai/codex-sdk` has no native abort** (issue [openai/codex#5494](https://github.com/openai/codex/issues/5494)). Track the internal subprocess PID and SIGKILL as a fallback. **Pin `@openai/codex-sdk` with a caret on the minor version** (e.g. `^0.x`) — the SIGKILL fallback depends on accessing internal subprocess state, which could shift across minor versions. Add a smoke test on adapter construction that asserts the `thread.abort` method (or internal PID handle, whichever path is chosen) is reachable; on assertion failure, emit `type:'error'` with `code: 'codex_sdk_incompatible'` and refuse to start.
- **Gemini CLI has broken SIGINT** ([gemini-cli#15873](https://github.com/google-gemini/gemini-cli/issues/15873), [#3385](https://github.com/google-gemini/gemini-cli/issues/3385)). Always fall through to SIGKILL after a 2s grace; implement an orphan reaper in the adapter on runner exit.
- **pi-mono JSONL protocol requires strict LF framing** — do not use Node's `readline` (treats Unicode separators as newlines). Use the `readJsonlLines` pattern above.
- **pi-mono has an abort race bug** ([pi-mono#2716](https://github.com/badlogic/pi-mono/issues/2716)) when Escape fires during long bash. Wrap adapter `abort()` in a try/catch; SIGKILL the host process on DOMException.
- **Codex TS SDK `approvalPolicy` is turn-level, not per-tool** (spike confirmed — contrast with Elixir SDK's `review_tool`). Adapter must run `approvalPolicy: 'never'` full-auto and declare `supportsPermissionGate: false`.
- **Gemini CLI's first turn has no `--resume`**; capture `session_id` from the `init` event of turn 1 and apply `--resume <id>` from turn 2 onwards. State this in the adapter's "first turn" branch explicitly.
- **Do NOT break the 7-positional-argv contract** between gateway and runner (`packages/agent-gateway/src/server.ts:328-374` ↔ `packages/session-runner/src/main.ts:47-64`). Adapter selection happens inside the runner via `cmd.agent`, not via argv.
- **`session.init.capabilities` adds bytes to every session's first frame** — include in the BufferedChannel size accounting. Unlikely to matter (capability payload ≤2KB) but note for the pi-mono case whose `availableProviders` can be large.

### Reference Docs

- [Codex TS SDK](https://developers.openai.com/codex/sdk) — `startThread`, `resumeThread`, `runStreamed`, `approvalPolicy` option.
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference) — `--ask-for-approval`, `--full-auto`, `--yolo` flags.
- [Gemini CLI Headless Mode](https://geminicli.com/docs/cli/headless/) — JSONL event list + exit codes (0/1/42/53).
- [Gemini CLI PR #10883](https://github.com/google-gemini/gemini-cli/pull/10883) — `stream-json` output format definition.
- [pi-mono coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) — `createAgentSession()` API.
- [pi-mono RPC protocol](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — JSONL framing rules.
- [Research doc](../research/2026-04-20-runner-adapter-evaluation.md) — full event-mapping tables, per-adapter field-by-field comparisons, `RunnerAdapter` TS interface sketch.
- [Superseded spec 0016](./0016-pluggable-agent-gateway.md) — historical context for what pre-session-runner design assumed.
