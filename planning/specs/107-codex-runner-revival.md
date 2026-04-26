---
initiative: codex-runner-revival
type: project
issue_type: feature
status: approved
priority: high
github_issue: 107
created: 2026-04-26
updated: 2026-04-26
supersedes:
  - planning/specs/30-runner-adapter-pluggable.md
research:
  - planning/research/2026-04-26-codex-runner-revival.md
  - planning/research/2026-04-25-acp-codex-runner.md
phases:
  - id: p1
    name: "RunnerAdapter interface + ClaudeAdapter extraction (zero behaviour change)"
    tasks:
      - "Define `RunnerAdapter` interface and `AdapterStartOptions` type in `packages/session-runner/src/adapters/types.ts` (runner-internal; NOT in shared-types — wire types already live there)"
      - "Define `type AgentName = 'claude' | 'codex'` in `packages/shared-types/src/index.ts`; narrow `ExecuteCommand.agent` and `ResumeCommand.agent` from `string` to `AgentName | undefined`"
      - "Extract `ClaudeAdapter` from `packages/session-runner/src/claude-runner.ts` into `packages/session-runner/src/adapters/claude.ts` implementing `RunnerAdapter`; preserve every existing behaviour"
      - "Introduce adapter registry at `packages/session-runner/src/adapters/index.ts` — `Record<AgentName, () => RunnerAdapter>` seeded with `claude` only"
      - "Rewire `packages/session-runner/src/main.ts` to select adapter via `cmd.agent ?? 'claude'`; unknown agent emits `error{code:'unknown_agent', retryable:false}` and writes `.exit`"
      - "ClaudeAdapter declares full capability bitmap on `session.init` (all existing Claude capabilities = true; `availableProviders: [{ provider: 'anthropic', models: ['claude-4-sonnet', 'claude-4-opus', 'claude-4-haiku'] }]`)"
    test_cases:
      - id: "claude-adapter-baseline-execute"
        description: "A new Claude session through the adapter produces the same GatewayEvent sequence as before the refactor (structural equality: same type ordering, same subtype/stop_reason/usage, normalised seq/timestamps)"
        type: "integration"
      - id: "claude-adapter-baseline-resume"
        description: "An idle-reaped Claude session resumes via ResumeCommand and picks up runner_session_id"
        type: "integration"
      - id: "default-agent-claude"
        description: "ExecuteCommand without `agent` field defaults to ClaudeAdapter"
        type: "unit"
      - id: "unknown-agent-error"
        description: "ExecuteCommand with `agent='bogus'` emits `error{code:'unknown_agent', retryable:false}`, writes `.exit{state:'failed'}`, exits within 1s"
        type: "unit"
      - id: "agent-name-type-narrowing"
        description: "`pnpm typecheck` passes; `ExecuteCommand.agent` and `ResumeCommand.agent` accept only `AgentName | undefined`"
        type: "unit"
  - id: p2
    name: "D1 `codex_models` table + admin CRUD API + settings UI"
    tasks:
      - "Create D1 migration `0024_codex_models.sql`: `CREATE TABLE codex_models (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, context_window INTEGER NOT NULL, max_output_tokens INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))` seeded with `INSERT INTO codex_models (id, name, context_window) VALUES ('gpt-5.1', 'gpt-5.1', 1000000), ('o4-mini', 'o4-mini', 200000)`"
      - "Add admin-only Hono routes at `apps/orchestrator/src/routes/api/admin/codex-models.ts`: `GET /api/admin/codex-models` (list), `POST /api/admin/codex-models` (create — requires `name` + `context_window`), `PUT /api/admin/codex-models/:id` (update), `DELETE /api/admin/codex-models/:id` (delete). Auth-gated to admin role."
      - "Add admin settings panel at `apps/orchestrator/src/components/admin/codex-models-panel.tsx`: table view with inline add/edit/delete. Name + context_window are required fields. Conservative 128k default shown as placeholder."
      - "Wire `codex_models` query into `triggerGatewayDial` (runner-link.ts): on `cmd.agent === 'codex'`, read D1 `SELECT name, context_window FROM codex_models WHERE enabled = 1`, inject as `cmd.codex_models` array on the spawn payload"
      - "Extend `ExecuteCommand` and `ResumeCommand` in shared-types with optional `codex_models?: ReadonlyArray<{ name: string; context_window: number }>`"
    test_cases:
      - id: "codex-models-crud"
        description: "Admin can create, list, update, delete codex model entries via the API. Non-admin gets 403."
        type: "integration"
      - id: "codex-models-seed"
        description: "After migration 0024, `SELECT * FROM codex_models` returns gpt-5.1 (1M) and o4-mini (200k)"
        type: "integration"
      - id: "codex-models-inject-spawn"
        description: "When `triggerGatewayDial` fires for a codex session, the `.cmd` JSON contains a `codex_models` array with all enabled models"
        type: "integration"
  - id: p3
    name: "CodexAdapter implementation"
    tasks:
      - "Add `@openai/codex-sdk` dependency to `packages/session-runner/package.json`"
      - "Implement `CodexAdapter` at `packages/session-runner/src/adapters/codex.ts` — `startThread` / `resumeThread` / `runStreamed` lifecycle"
      - "Map Codex `item.started/updated/completed` + `turn.completed` to `partial_assistant` / `assistant` / `tool_result` / `result` GatewayEvents"
      - "Synthesize `session.init` from `thread.id` + project + model + capability bitmap before first adapter output"
      - "Synthesize `session_state_changed: 'running'` at turn start, `'idle'` at turn end (no `compacting` / `api_retry`)"
      - "Synthesize `result.context_usage` from `turn.completed.usage` + `codex_models` context-window lookup; fall back to 128k + warning event for unknown models"
      - "Resume: `codex.resumeThread(runner_session_id)`. On throw (file missing), catch → emit `session_state_changed: 'error'` with reason → trigger forkWithHistory auto-fallback"
      - "forkWithHistory: receive `<prior_conversation>` preamble as first user turn to `codex.startThread()`"
      - "Abort: SIGKILL fallback for internal subprocess (no native SDK abort per openai/codex#5494). Declare `supportsCleanAbort: false`"
      - "Read `cmd.codex_models` from spawn payload; use for `availableProviders` capability and context-window math"
      - "Add `'codex'` to the adapter registry"
    test_cases:
      - id: "codex-adapter-execute"
        description: "CodexAdapter starts a thread, emits session.init with correct capabilities, streams text via partial_assistant, finishes with result including context_usage"
        type: "integration"
      - id: "codex-adapter-resume"
        description: "CodexAdapter with ResumeCommand calls `codex.resumeThread(threadId)` and continues from prior context"
        type: "integration"
      - id: "codex-adapter-resume-fallback"
        description: "When `resumeThread()` throws (file missing), adapter emits error state then triggers forkWithHistory with history preamble"
        type: "integration"
      - id: "codex-adapter-abort-sigkill"
        description: "Abort during a long turn terminates within 3s even without native SDK abort; no orphan subprocess"
        type: "integration"
      - id: "codex-adapter-context-usage"
        description: "`result.context_usage` carries correct `percentage` computed from `turn.completed.usage.total_tokens / codex_models[model].context_window`"
        type: "unit"
      - id: "codex-adapter-capabilities"
        description: "session.init.capabilities matches expected bitmap: rewind=false, thinkingDeltas=false, permissionGate=false, subagents=false, permissionMode=false, setModel=false, contextUsage=true, interrupt=false, cleanAbort=false, emitsUsdCost=false"
        type: "unit"
      - id: "codex-adapter-missing-credential"
        description: "ExecuteCommand.agent='codex' with OPENAI_API_KEY unset emits error{code:'missing_credential_openai_api_key', retryable:false} before any SDK call"
        type: "integration"
  - id: p4
    name: "End-to-end verification + polish"
    tasks:
      - "E2E smoke: spawn codex session via UI, prompt → tool call → result; verify SessionMeta.capabilities reflects Codex bitmap; verify useSessionStatus works"
      - "E2E smoke: idle-reap codex session, send follow-up, verify resume continuity"
      - "E2E smoke: resume failure (delete thread file), verify auto-fallback to forkWithHistory"
      - "E2E smoke: mixed Claude + Codex tabs open simultaneously, no cross-talk"
      - "E2E smoke: admin adds a new model via settings panel, starts a session with it, verify it appears in capabilities"
      - "Update `.env.example` with `OPENAI_API_KEY` documentation"
      - "Mark Spec #30 as superseded in its frontmatter (`status: superseded`, `superseded_by: planning/specs/107-codex-runner-revival.md`)"
    test_cases:
      - id: "e2e-codex-full-cycle"
        description: "Codex session: spawn → tool use → result → idle-reap → resume → follow-up → result. All events match expected types."
        type: "smoke"
      - id: "e2e-mixed-agent-tabs"
        description: "Claude tab and Codex tab open simultaneously; events route to correct sessions with no cross-talk"
        type: "smoke"
      - id: "e2e-admin-model-management"
        description: "Admin adds 'o3' model with 200k context, spawns a codex session selecting it, session.init.capabilities.availableProviders includes o3"
        type: "smoke"
---

# Codex Runner Revival — Path A per-SDK Adapter

> GitHub Issue: [#107](https://github.com/baseplane-ai/duraclaw/issues/107)
> Supersedes: [Spec #30 — Pluggable RunnerAdapter](./30-runner-adapter-pluggable.md) (all phases)
> Closed predecessor: [Spec #98 — ACP Codex Runner](./98-acp-codex-runner.md) (Path B pivot)
> Research: [`planning/research/2026-04-26-codex-runner-revival.md`](../research/2026-04-26-codex-runner-revival.md)

## Overview

Duraclaw's `session-runner` hardcodes `@anthropic-ai/claude-agent-sdk` at every coupling site. This spec introduces a `RunnerAdapter` interface, extracts `ClaudeAdapter` from the existing code (zero behaviour change), then ships a `CodexAdapter` backed by `@openai/codex-sdk` so users can run OpenAI Codex sessions through Duraclaw. An admin-managed D1 table stores Codex model entries (name + context window), injected into the runner at spawn time. This is the minimum viable multi-agent surface — no UI capability-gating, no pricing module, no `/capabilities` endpoint.

## Feature Behaviors

### B1: RunnerAdapter interface is the only path into a backend SDK

**Core:**
- **ID:** runner-adapter-interface
- **Trigger:** `packages/session-runner/src/main.ts` reads `.cmd`, determines `agent = cmd.agent ?? 'claude'`, looks up `registry[agent]`, constructs the adapter
- **Expected:** No file outside `packages/session-runner/src/adapters/` imports a vendor SDK (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`). `claude-runner.ts` logic moves to `adapters/claude.ts` implementing `RunnerAdapter`. `claude-runner.ts` becomes a thin re-export or is deleted.
- **Verify:** `grep -RE "@(anthropic-ai/claude-agent-sdk|openai/codex-sdk)" packages/session-runner/src` returns matches only in `adapters/*.ts` and `types.ts` (for SDK message type imports).
- **Source:** `packages/session-runner/src/claude-runner.ts` (all coupling sites), `packages/session-runner/src/main.ts:146-241` (handleIncomingCommand), `packages/session-runner/src/event-translator.ts`

#### API Layer

`RunnerAdapter` interface — lives in `packages/session-runner/src/adapters/types.ts` (runner-internal; NOT in shared-types):

```ts
import type {
  AdapterCapabilities,
  GatewayEvent,
  GatewayCommand,
} from '@duraclaw/shared-types'

export interface AdapterStartOptions {
  sessionId: string
  project: string
  model?: string
  prompt: string | ContentBlock[]
  resumeSessionId?: string       // adapter-native session id (Claude sdk_session_id, Codex thread.id)
  env: Readonly<Record<string, string>>
  signal: AbortSignal
  codexModels?: ReadonlyArray<{ name: string; context_window: number }>  // injected from D1 via spawn payload
  onEvent: (event: GatewayEvent) => void
}

export interface RunnerAdapter {
  readonly name: AgentName
  readonly capabilities: AdapterCapabilities

  /** Drive the session until natural completion or abort. */
  run(opts: AdapterStartOptions): Promise<void>

  /** Inject a new user turn (stream-input command). */
  pushUserTurn(message: { role: 'user'; content: string | ContentBlock[] }): void

  /** Best-effort mid-turn interruption. */
  interrupt(): Promise<void>

  /** Release resources — kill child processes, close streams. Idempotent. */
  dispose(): Promise<void>
}
```

**Adapter lifecycle contract:**
- `run()` called exactly once per runner process — drives the entire session.
- First turn from `opts.prompt`; subsequent turns via `pushUserTurn()`.
- `interrupt()` called on user Stop; runner escalates to `signal.abort()` if interrupt doesn't settle within 2s.
- `dispose()` called on every exit path (after `run()` resolves/rejects or on unhandled error). Must be idempotent, must not throw.

**Error semantics:**
- Any throw from `run()` → runner emits `error` GatewayEvent with `{code, message, retryable}`.
- Unknown `cmd.agent` at registry lookup → `error{code:'unknown_agent', retryable:false}` + `.exit{state:'failed'}` + `process.exit(1)`.

#### Data Layer

`AgentName` type added to `packages/shared-types/src/index.ts`:

```ts
export type AgentName = 'claude' | 'codex'
```

`ExecuteCommand.agent` narrowed from `string` to `AgentName | undefined`. `ResumeCommand.agent` narrowed identically. DO API boundary does NOT reject unknown agents at this time (defer to runner-side error).

---

### B2: AgentName narrows on the wire

**Core:**
- **ID:** agent-name-narrowing
- **Trigger:** Any code constructing an `ExecuteCommand` or `ResumeCommand`
- **Expected:** TypeScript compiler rejects `agent: 'bogus'` — only `'claude' | 'codex' | undefined` accepted. The type lives in `packages/shared-types/src/index.ts` so all consumers (DO, gateway, runner, tests) share the same constraint.
- **Verify:** `pnpm typecheck` passes. Adding `agent: 'foo'` to an `ExecuteCommand` literal causes a TS error.
- **Source:** `packages/shared-types/src/index.ts:15` (`ExecuteCommand.agent`), `packages/shared-types/src/index.ts:98` (`ResumeCommand.agent`)

#### Data Layer

No migration needed — `agent` is not persisted in D1 or DO SQLite today. `SessionMeta` does not carry an `agent` field; it's a spawn-time parameter only, opaque after `session.init`. (Future follow-up may persist it if needed for UI display.)

---

### B3: ClaudeAdapter extracted with zero behaviour change

**Core:**
- **ID:** claude-adapter-extraction
- **Trigger:** `cmd.agent === 'claude'` or `cmd.agent === undefined` (default)
- **Expected:** `ClaudeAdapter` at `packages/session-runner/src/adapters/claude.ts` implements `RunnerAdapter`. All existing Claude SDK coupling sites (query, resume, message loop, event emission, permission callbacks, ask_user, interrupt, PushPullQueue, titler integration) move into the adapter. `main.ts` becomes adapter-agnostic — it dispatches `handleIncomingCommand` to adapter methods and drives the meta-file/exit-file lifecycle.
- **Verify:** Run `pnpm --filter @duraclaw/session-runner test`. All existing tests pass unchanged. Start a Claude session via UI — identical behaviour to pre-refactor.
- **Source:** `packages/session-runner/src/claude-runner.ts:252-957` (message loop + send helper), `packages/session-runner/src/main.ts:146-241` (command dispatch)

#### API Layer

ClaudeAdapter capability bitmap:

```ts
{
  supportsRewind: true,
  supportsThinkingDeltas: true,
  supportsPermissionGate: true,
  supportsSubagents: true,
  supportsPermissionMode: true,
  supportsSetModel: true,
  supportsContextUsage: true,
  supportsInterrupt: true,
  supportsCleanAbort: true,
  emitsUsdCost: true,
  availableProviders: [
    { provider: 'anthropic', models: ['claude-4-sonnet', 'claude-4-opus', 'claude-4-haiku'] },
  ],
}
```

---

### B4: D1 `codex_models` table with admin CRUD

**Core:**
- **ID:** codex-models-table
- **Trigger:** Admin navigates to settings → Codex Models panel; or `triggerGatewayDial` fires for a codex session
- **Expected:** D1 table `codex_models` stores model entries (name, context_window, enabled). Seeded with `gpt-5.1` (1M) and `o4-mini` (200k) via migration. Admin-only CRUD routes at `/api/admin/codex-models`. Context window is a required field — admin enters it manually (OpenAI has no machine-readable source). Settings panel provides table view with inline add/edit/delete.
- **Verify:** After deploying migration 0024: `SELECT * FROM codex_models` returns 2 rows. `POST /api/admin/codex-models` with `{name: 'o3', context_window: 200000}` returns 201. Non-admin `POST` returns 403.
- **Source:** new file `apps/orchestrator/migrations/0024_codex_models.sql`, new file `apps/orchestrator/src/routes/api/admin/codex-models.ts`

#### UI Layer

Admin settings panel: `apps/orchestrator/src/components/admin/codex-models-panel.tsx`
- Table columns: Name, Context Window (tokens), Enabled toggle, Actions (edit / delete)
- Add row: Name (text input), Context Window (number input, placeholder "128000"), Submit
- Validation: name required + unique, context_window required + positive integer
- No "Discover from OpenAI" button in v1 — manual add only

#### API Layer

```
GET    /api/admin/codex-models           → 200 [{id, name, context_window, enabled, created_at, updated_at}]
POST   /api/admin/codex-models           → 201 {id, name, context_window, ...}
         body: {name: string, context_window: number, max_output_tokens?: number}
         id is set to name (id = name convention; the UNIQUE on name is a defensive double-check)
PUT    /api/admin/codex-models/:id       → 200 {id, name, context_window, ...}
         body: {name?: string, context_window?: number, enabled?: boolean}
DELETE /api/admin/codex-models/:id       → 204
```

Error responses:

| Status | Condition | Body |
|--------|-----------|------|
| 400 | Missing `name` or `context_window` | `{error: 'missing_required_field', field: '...'}` |
| 400 | `context_window` ≤ 0 or non-integer | `{error: 'invalid_context_window'}` |
| 403 | Non-admin caller | `{error: 'forbidden'}` |
| 409 | Duplicate `name` | `{error: 'duplicate_model_name', name: '...'}` |

All routes admin-gated (Better Auth role check). Non-admin → 403.

#### Data Layer

D1 migration `0024_codex_models.sql`:

```sql
CREATE TABLE IF NOT EXISTS codex_models (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  context_window INTEGER NOT NULL,
  max_output_tokens INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO codex_models (id, name, context_window) VALUES
  ('gpt-5.1', 'gpt-5.1', 1000000),
  ('o4-mini', 'o4-mini', 200000);
```

---

### B5: Codex model list injected via spawn payload

**Core:**
- **ID:** codex-models-spawn-inject
- **Trigger:** `triggerGatewayDial` in `runner-link.ts` fires for a command where `cmd.agent === 'codex'`
- **Expected:** DO reads `SELECT name, context_window FROM codex_models WHERE enabled = 1` from D1, injects the result as `cmd.codex_models` on the `ExecuteCommand` / `ResumeCommand`. Runner reads `cmd.codex_models` at boot. No runtime HTTP fetch from the runner.
- **Verify:** Inspect `.cmd` JSON on disk after spawning a codex session — `codex_models` array present with all enabled models. Update a model via admin API, spawn a new session — new session sees the updated list.
- **Source:** `apps/orchestrator/src/agents/session-do/runner-link.ts:157-268` (`triggerGatewayDial`)

#### API Layer

New optional fields on `ExecuteCommand` and `ResumeCommand` in `packages/shared-types/src/index.ts`:

```ts
/** Codex model catalog injected by DO from D1 at spawn time. Runner uses for availableProviders + context-window math. */
codex_models?: ReadonlyArray<{ name: string; context_window: number }>
```

#### Data Layer

No new persistence — this is a pass-through from D1 → spawn payload → runner memory.

---

### B6: CodexAdapter executes full-auto with SIGKILL-fallback abort

**Core:**
- **ID:** codex-adapter-core
- **Trigger:** `ExecuteCommand.agent === 'codex'` reaches session-runner
- **Expected:** Adapter calls `codex.startThread({ workingDirectory: cmd.project, approvalPolicy: 'never' })`, captures `thread.id` as `runner_session_id`, iterates `thread.runStreamed(prompt).events`, emits normalized `GatewayEvent`s. `session.init` carries `tools: []` (Codex SDK has no tool introspection). On abort, adapter SIGKILLs the internal subprocess (no native abort — openai/codex#5494 closed not-planned).
- **Verify:** Start a Codex session with prompt `"Write a fib function in fib.py"`. `session.init` arrives with `capabilities.supportsRewind=false`, `tools=[]`, `runner_session_id` is a UUID. `result` arrives with `context_usage` populated. File `fib.py` exists.
- **Source:** new file `packages/session-runner/src/adapters/codex.ts`

#### API Layer

Codex → GatewayEvent mapping:

| Codex SDK event | GatewayEvent emitted |
|---|---|
| `thread.id` after `startThread` | `session.init{runner_session_id: thread.id, capabilities, tools: [], model}` |
| `item.updated` (agent_message) | `partial_assistant{content: [{type:'text', delta}]}` |
| `item.completed` (agent_message) | `assistant{content: [full blocks]}` |
| `item.completed` (tool calls) | `tool_result{content: [per-tool output]}` |
| `turn.completed` | `result{total_cost_usd: null, context_usage: synthesized}` |
| (synthesized on turn start) | `session_state_changed{state: 'running'}` |
| (synthesized on turn end) | `session_state_changed{state: 'idle'}` |

Events NOT emitted by CodexAdapter (capability-excluded or inapplicable):
- `tool_use_summary` — Codex SDK tool calls map directly to `tool_result`; no separate summary event. DO/UI already tolerates `tool_result` arriving without a preceding `tool_use_summary` (Claude emits both, but the rendering path doesn't depend on summary).
- `ask_user` / `permission_request` — `supportsPermissionGate: false`
- `task_started` / `task_progress` / `task_notification` — `supportsSubagents: false`
- `compact_boundary` — Codex has no auto-compact
- `api_retry` — no retry signal exposed

CodexAdapter capability bitmap:

```ts
{
  supportsRewind: false,
  supportsThinkingDeltas: false,
  supportsPermissionGate: false,
  supportsSubagents: false,
  supportsPermissionMode: false,
  supportsSetModel: false,           // v1: model pinned at session creation
  supportsContextUsage: true,        // synthesized from turn.completed.usage + codex_models
  supportsInterrupt: false,          // SDK has no interrupt
  supportsCleanAbort: false,         // SIGKILL fallback
  emitsUsdCost: false,               // no pricing module in v1
  availableProviders: [
    { provider: 'openai', models: cmd.codex_models.map(m => m.name) },
  ],
}
```

#### Data Layer

`runner_session_id` on `SessionMeta` holds the Codex `Thread.id`. Same persistence path as Claude — `session.init` handler in `gateway-event-handler.ts:49-100` already handles this generically.

---

### B7: Codex resume via `resumeThread` with forkWithHistory fallback

**Core:**
- **ID:** codex-resume
- **Trigger:** `ResumeCommand.agent === 'codex'` with `runner_session_id` set
- **Expected:** Adapter calls `codex.resumeThread(runner_session_id)`. `Thread.id` is reasserted. Session continues from persisted thread state at `~/.codex/sessions/<id>`.
- **Verify:** Start a Codex session, let it complete. Idle-reap the runner (wait 30+ min or force-kill). Send a follow-up message. Verify `ResumeCommand` issued by DO, runner calls `resumeThread`, conversation continues with prior context.
- **Source:** `packages/session-runner/src/adapters/codex.ts` (resume branch), `apps/orchestrator/src/agents/session-do/rpc-messages.ts:239` (resume trigger)

**Resume failure recovery:**
When `codex.resumeThread(threadId)` throws (e.g. `~/.codex/sessions/<id>` JSONL file missing or corrupt):
1. Adapter catches the throw
2. Emits `session_state_changed{state: 'error'}` with reason `codex_thread_not_found`
3. Emits `error{error: 'Codex thread file missing — falling back to history replay', code: 'codex_resume_failed'}`
4. Triggers `forkWithHistory` auto-fallback: DO serializes message history as `<prior_conversation>...</prior_conversation>` preamble, spawns a fresh `execute` with a new `runner_session_id`
5. User sees brief error then seamless continuation

This matches the existing orphan-case self-healing pattern in `branches.ts:263-300`.

#### Data Layer

`runner_session_id` is dropped to `null` on forkWithHistory fallback (existing behaviour at `branches.ts:297`), then re-populated from the new `Thread.id` on the fresh `session.init`.

---

### B8: forkWithHistory works for Codex sessions

**Core:**
- **ID:** codex-fork-with-history
- **Trigger:** `forkWithHistory` called for a Codex session (orphan recovery, branch, or resume-failure fallback)
- **Expected:** DO serializes prior messages as `<prior_conversation>...</prior_conversation>` XML (existing logic at `branches.ts:263`). New runner spawns with `cmd.type === 'execute'` and the preamble as the prompt's first content. CodexAdapter passes the preamble to `codex.startThread()` + `thread.runStreamed(preamble + new_prompt)`. Codex processes the serialized history as context within its model's context window (200k–1M tokens).
- **Verify:** Start a Codex session, say "My name is Alice." Let it respond. Force-kill the runner (simulate orphan). Send "What is my name?" via UI. Verify the response references "Alice" — confirming history was injected via forkWithHistory.
- **Source:** `apps/orchestrator/src/agents/session-do/branches.ts:219-300` (forkWithHistory)

---

### B9: Codex context-usage synthesis from token counts + admin-managed context window

**Core:**
- **ID:** codex-context-usage
- **Trigger:** CodexAdapter receives `turn.completed` event with `usage: { input_tokens, output_tokens, total_tokens }`
- **Expected:** Adapter looks up `cmd.codex_models` for the session's model to find `context_window`. Computes `WireContextUsage`:
  ```ts
  {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    max_tokens: contextWindow,            // from codex_models lookup
    percentage: usage.total_tokens / contextWindow,
    model: sessionModel,
  }
  ```
  If model not found in `codex_models`, falls back to 128,000 and emits a warning event: `"Unknown model context window for '${model}' — using 128k default"`.
- **Verify:** Unit test: CodexAdapter with `codex_models: [{name:'o4-mini', context_window: 200000}]` and model `'o4-mini'` receiving `usage: {input_tokens: 50000, output_tokens: 10000, total_tokens: 60000}` produces `context_usage: {percentage: 0.3, max_tokens: 200000, ...}`.
- **Source:** new file `packages/session-runner/src/adapters/codex.ts`

---

### B10: Credential check before SDK initialization

**Core:**
- **ID:** codex-credential-check
- **Trigger:** `ExecuteCommand.agent === 'codex'` reaches adapter `run()`
- **Expected:** Before any `@openai/codex-sdk` call, adapter checks `opts.env.OPENAI_API_KEY`. If unset or empty, emits `error{error: 'OPENAI_API_KEY not set', code: 'missing_credential_openai_api_key', retryable: false}` and returns immediately (no SDK instantiation, no subprocess).
- **Verify:** Start gateway without `OPENAI_API_KEY`. Spawn codex session. Error event arrives within 1s with code `missing_credential_openai_api_key`. No subprocess spawned.
- **Source:** `packages/session-runner/src/adapters/codex.ts` (top of `run()`)

---

## Non-Goals

Explicitly out of scope for this spec:

- **UI capability-gating** — rewind arrow, thinking toggle, ask_user modal, context bar gating based on capabilities. For v1, Codex sessions render as-is; unsupported affordances are simply inert. Follow-up spec.
- **`GET /capabilities` endpoint** — gateway env-probing for adapter readiness. Follow-up.
- **Missing-credential banner** — UI red banner for missing `OPENAI_API_KEY`. Follow-up (B10's error event suffices for v1).
- **Pricing module / `total_cost_usd`** — Codex sessions emit `total_cost_usd: null`. Follow-up spec for `@duraclaw/pricing`.
- **DO API rejection of unknown agents** — runner-side error (B1) covers this. DO-level 400 is a follow-up.
- **Gemini CLI / pi-mono / Hermes adapters** — independent follow-up issues. Spec #30 is superseded entirely.
- **Per-user API-key storage** — v1 uses worktree env only via `buildCleanEnv()`.
- **Model-picker UX redesign** — backend-only model selection in v1.
- **Mid-session adapter switch** — users create a new session to change adapter.
- **"Discover from OpenAI" button** — admin UI is manual-add only in v1. Discover is v2.
- **ACP wire** — closed at Spec #98 pivot. Path B is dead.

## Open Questions

All planning-phase questions have been resolved. Decisions below are binding; revisit only via a new spec.

- [x] **Spec scope** — subsume Spec #30 P1 into a single spec (Decision: yes)
- [x] **Resume** — in scope for v1 (Decision: design now, Codex `resumeThread` + forkWithHistory fallback)
- [x] **Scope floor** — codex-only minimum, no UI gating / capabilities endpoint / pricing (Decision: locked)
- [x] **Spec #30 disposition** — supersede entirely (Decision: gemini-cli, pi-mono, hermes → independent issues)
- [x] **AgentName narrowing** — full wire narrowing `'claude' | 'codex'` (Decision: narrow on shared-types)
- [x] **Codex tools** — empty array `[]` on SessionInitEvent (Decision: no introspection)
- [x] **Task\* events** — DO tolerates non-arrival (Decision: no capability gate)
- [x] **Model management** — D1 table + admin CRUD UI (Decision: `codex_models` table seeded with 2 models)
- [x] **Context-window math** — admin-entered values, 128k fallback (Decision: no skip, compute from D1 table)
- [x] **Model list delivery** — inject via spawn payload (Decision: DO reads D1 on triggerGatewayDial)
- [x] **Discover UI** — manual add only for v1 (Decision: defer discover button)
- [x] **Resume failure** — auto-fallback to forkWithHistory (Decision: catch → error state → fork)
- [x] **Fork behavior** — startThread + preamble (Decision: works within Codex context windows)

## Implementation Phases

See YAML frontmatter. Phases are ordered and gated:

- **P1** (~4h): Pure refactor. ClaudeAdapter extraction + adapter registry + AgentName narrowing. Zero behaviour change for Claude sessions. Gate: all existing tests pass, `pnpm typecheck` clean.
- **P2** (~3h): D1 migration + admin CRUD routes + settings panel + spawn-payload injection. Gate: admin can manage models, codex spawn payload includes model list.
- **P3** (~6h): CodexAdapter implementation — the main feature work. Depends on P1 (adapter interface) and P2 (model catalog). Gate: codex sessions work end-to-end with resume.
- **P4** (~2h): E2E verification, polish, Spec #30 supersession. Gate: all smoke tests pass.

**PR strategy:** Single feature branch `feature/107-codex-runner-revival`. P1 may land as a separate PR (pure refactor, safe to merge early) or combined with P2-P3 at implementer's discretion based on review surface.

## Verification Strategy

### Test Infrastructure

- **vitest** already configured across the workspace. No new test infra needed.
- ClaudeAdapter: existing `packages/session-runner/test/` suite is the regression gate.
- CodexAdapter: mock `@openai/codex-sdk` in vitest setup; assert event normalization. Pattern: jest-mock the `Codex` constructor, return a fake `Thread` with controlled `runStreamed().events` async generator.
- Admin CRUD: integration tests against miniflare D1 using existing test harness.

### Build Verification

- `pnpm typecheck` — enforces AgentName narrowing flows through all consumers.
- `pnpm build` — tsup at `packages/session-runner` ensures adapters compile to `dist/main.js`.
- `pnpm test` — full workspace test suite.

## Verification Plan

### VP1: Claude regression (P1 gate)

Steps:
1. `pnpm --filter @duraclaw/session-runner test`
   Expected: All existing tests pass. Zero failures.
2. `pnpm typecheck`
   Expected: Clean across all packages. `ExecuteCommand.agent` only accepts `AgentName | undefined`.
3. In dev worktree: `scripts/verify/dev-up.sh`. Open `http://localhost:$VERIFY_ORCH_PORT/`. Start a Claude session, send `"list files in this repo"`.
   Expected: Session completes identically to pre-refactor. `session.init` event has `capabilities.supportsRewind=true`.

### VP2: Admin model management (P2 gate)

Steps:
1. After deploying migration 0024: `curl -H "Authorization: Bearer $TOKEN" http://localhost:$VERIFY_ORCH_PORT/api/admin/codex-models`
   Expected: 200 with `[{name:'gpt-5.1', context_window:1000000}, {name:'o4-mini', context_window:200000}]`
2. `curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"o3","context_window":200000}' http://localhost:$VERIFY_ORCH_PORT/api/admin/codex-models`
   Expected: 201. Subsequent GET includes o3.
3. Spawn a codex session. Read the `.cmd` file from `/run/duraclaw/sessions/<id>.cmd`.
   Expected: `codex_models` array present with all 3 enabled models.

### VP3: Codex adapter end-to-end (P3 gate)

Steps:
1. Set `OPENAI_API_KEY` in `.env`. `scripts/verify/dev-up.sh`.
2. Via UI or API: start a Codex session with prompt `"Write a hello world in hello.py"`.
   Expected: `session.init` arrives with `capabilities.supportsRewind=false`, `tools=[]`, `runner_session_id` is a UUID.
3. Wait for `result` event.
   Expected: `result.total_cost_usd === null`. `result.context_usage` populated with `percentage` > 0. File `hello.py` exists.
4. Without `OPENAI_API_KEY`: spawn a codex session.
   Expected: `error` event with `code: 'missing_credential_openai_api_key'` within 1s.

### VP4: Resume + failure recovery (P3/P4 gate)

Steps:
1. Start a Codex session. Let it complete. Note the `runner_session_id` (= Thread.id).
2. Force-kill the runner: `kill -9 $(cat /run/duraclaw/sessions/<id>.pid | jq .pid)`.
3. Send a follow-up message via UI.
   Expected: DO issues ResumeCommand. New runner calls `resumeThread(threadId)`. Conversation continues with context.
4. Delete the thread file: `rm -rf ~/.codex/sessions/<thread-id>`. Send another follow-up.
   Expected: Resume throws → error state → forkWithHistory auto-fallback → fresh session with `<prior_conversation>` preamble → conversation continues referencing prior context.

### VP5: Mixed agent tabs (P4 gate)

Steps:
1. Open a Claude session tab and a Codex session tab simultaneously.
2. Send a message in each tab within 2s of each other.
   Expected: Events route correctly to their respective sessions. No cross-talk. Both sessions complete independently.

## Implementation Hints

### Dependencies

```bash
# P3
pnpm --filter @duraclaw/session-runner add @openai/codex-sdk
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@openai/codex-sdk` | `{ Codex }` | P3 — thread creation, resume, streaming |
| `@duraclaw/shared-types` | `{ AdapterCapabilities, GatewayEvent, ExecuteCommand, ResumeCommand, AgentName }` | Wire types shared by all adapters |
| `packages/session-runner/src/event-translator.ts` | `{ assistantContentToWireParts, partialAssistantToWireParts }` | Reusable content-block → WireMessagePart translation (already extracted in #101 P1.3) |
| `packages/session-runner/src/push-pull-queue.ts` | `{ PushPullQueue }` | Lifetime async iterable for multi-turn — ClaudeAdapter already uses this; CodexAdapter uses `thread.runStreamed()` per turn instead (different lifecycle) |

### Code Patterns

**Adapter registry** (`packages/session-runner/src/adapters/index.ts`):

```ts
import type { AgentName } from '@duraclaw/shared-types'
import type { RunnerAdapter } from './types.js'
import { ClaudeAdapter } from './claude.js'

const registry: Record<string, () => RunnerAdapter> = {
  claude: () => new ClaudeAdapter(),
  // codex: () => new CodexAdapter(),  ← P3 adds this
}

export function createAdapter(agent: AgentName | undefined): RunnerAdapter {
  const name = agent ?? 'claude'
  const factory = registry[name]
  if (!factory) {
    throw new Error(`unknown_agent:${name}`)
  }
  return factory()
}
```

**CodexAdapter skeleton** (`packages/session-runner/src/adapters/codex.ts`):

```ts
import { Codex, type Thread, type StreamEvent } from '@openai/codex-sdk'
import type { AdapterCapabilities } from '@duraclaw/shared-types'
import type { RunnerAdapter, AdapterStartOptions } from './types.js'

export class CodexAdapter implements RunnerAdapter {
  readonly name = 'codex' as const
  private codex: Codex | null = null
  private thread: Thread | null = null
  private childPid: number | undefined
  private opts: AdapterStartOptions | null = null

  get capabilities(): AdapterCapabilities {
    const models = this.opts?.codexModels?.map(m => m.name) ?? ['gpt-5.1', 'o4-mini']
    return {
      supportsRewind: false,
      supportsThinkingDeltas: false,
      supportsPermissionGate: false,
      supportsSubagents: false,
      supportsPermissionMode: false,
      supportsSetModel: false,
      supportsContextUsage: true,
      supportsInterrupt: false,
      supportsCleanAbort: false,
      emitsUsdCost: false,
      availableProviders: [{ provider: 'openai', models }],
    }
  }

  async run(opts: AdapterStartOptions): Promise<void> {
    this.opts = opts
    if (!opts.env.OPENAI_API_KEY) {
      opts.onEvent({ type: 'error', session_id: opts.sessionId, error: 'OPENAI_API_KEY not set' })
      return
    }

    this.codex = new Codex({ env: opts.env })

    if (opts.resumeSessionId) {
      try {
        this.thread = await this.codex.resumeThread(opts.resumeSessionId)
      } catch {
        // Resume failed — signal for forkWithHistory fallback
        opts.onEvent({
          type: 'error', session_id: opts.sessionId,
          error: 'Codex thread file missing — falling back to history replay',
        })
        return
      }
    } else {
      this.thread = await this.codex.startThread({
        workingDirectory: opts.project,
        approvalPolicy: 'never',
      })
    }

    // Emit session.init
    opts.onEvent({
      type: 'session.init',
      session_id: opts.sessionId,
      runner_session_id: this.thread.id,
      project: opts.project,
      model: opts.model ?? 'gpt-5.1',
      tools: [],
      capabilities: this.capabilities,
    })

    // Run first turn
    await this.runTurn(typeof opts.prompt === 'string' ? opts.prompt : JSON.stringify(opts.prompt))
  }

  private async runTurn(input: string): Promise<void> {
    if (!this.thread || !this.opts) return
    const { events } = await this.thread.runStreamed(input)
    // ... iterate events, map to GatewayEvents, synthesize context_usage on turn.completed
  }

  pushUserTurn(message: { role: 'user'; content: string }): void {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    void this.runTurn(text)
  }

  async interrupt(): Promise<void> { /* no-op — SDK has no interrupt */ }

  async dispose(): Promise<void> {
    if (this.childPid) {
      try { process.kill(this.childPid, 'SIGKILL') } catch {}
      this.childPid = undefined
    }
  }
}
```

**Spawn payload injection** (in `runner-link.ts:triggerGatewayDial`):

```ts
// After existing titler_enabled injection (line ~172):
if (cmd.type === 'execute' || cmd.type === 'resume') {
  if ((cmd as { agent?: string }).agent === 'codex') {
    try {
      const rows = await ctx.env.DB.prepare(
        'SELECT name, context_window FROM codex_models WHERE enabled = 1'
      ).all<{ name: string; context_window: number }>()
      cmd = { ...cmd, codex_models: rows.results }
    } catch (err) {
      console.error(`[SessionDO] Failed to read codex_models from D1:`, err)
      // Proceed without — adapter falls back to hardcoded defaults
    }
  }
}
```

### Gotchas

- **`@openai/codex-sdk` has no native abort** (issue [openai/codex#5494](https://github.com/openai/codex/issues/5494), closed not-planned). Track the internal subprocess PID and SIGKILL as a fallback. Pin `@openai/codex-sdk` with a caret on the minor version.
- **Codex SDK `approvalPolicy` is turn-level, not per-tool** — no `canUseTool` callback exists. Adapter must run `approvalPolicy: 'never'` full-auto and declare `supportsPermissionGate: false`.
- **Thread file locality** — `~/.codex/sessions/<id>` is host-local. Multi-VPS deployments must ensure resume routes to the same host, or accept forkWithHistory fallback. Single-VPS is the v1 deployment model.
- **Do NOT break the 7-positional-argv contract** between gateway (`handlers.ts:192`) and runner (`main.ts:47-64`). Adapter selection happens inside the runner via `cmd.agent`, not via argv.
- **`OPENAI_API_KEY` already flows via `buildCleanEnv()`** at `handlers.ts:62-71`. No gateway code change needed — the key propagates through `spawn()` env opts at `handlers.ts:196`.
- **`runner_session_id` on the wire is already adapter-agnostic** — both Claude's `sdk_session_id` and Codex's `Thread.id` are UUIDs. Existing DO persistence, D1 mirroring, and forkWithHistory all work unchanged.
- **`session.init.capabilities` adds bytes to the first frame** — CodexAdapter's payload is small (~500 bytes). Not a BufferedChannel concern.
- **Codex SDK's `runStreamed()` is per-turn** (contrast with Claude's lifetime `PushPullQueue` feeding a single `query()`). CodexAdapter manages its own turn loop — `pushUserTurn()` triggers a new `thread.runStreamed()` call, not a queue push. This is the key architectural difference.

### Reference Docs

- [Codex TS SDK](https://developers.openai.com/codex/sdk) — `startThread`, `resumeThread`, `runStreamed`, `approvalPolicy` option.
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference) — background on approval modes.
- [Research: Codex runner revival](../research/2026-04-26-codex-runner-revival.md) — full event-mapping tables, wire delta analysis, SDK API surface.
- [Spec #98 (closed)](./98-acp-codex-runner.md) — prior ACP approach (Path B), closed with pivot to Path A.
- [Spec #30 (superseded)](./30-runner-adapter-pluggable.md) — original multi-adapter spec, now superseded by this spec.
- [Spec #101 (landed)](./101-session-do-refactor.md) — SessionDO split + AdapterCapabilities + runner_session_id rename.
- [Spec #102 (landed)](./102-sdk-peelback.md) — wire collapse, PushPullQueue, session_state_changed.
