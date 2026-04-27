---
initiative: gemini-cli-runner
type: project
issue_type: feature
status: draft
priority: medium
github_issue: 110
created: 2026-04-27
updated: 2026-04-27
supersedes: null
research:
  - planning/research/2026-04-26-gemini-runner-adapter.md
  - planning/research/2026-04-26-gemini-fixtures/
  - planning/research/2026-04-20-runner-adapter-evaluation.md (Gemini section)
phases:
  - id: p1
    name: "AgentName extension + shared-types wire changes"
    tasks:
      - "Extend `AgentName` in `packages/shared-types/src/index.ts` from `'claude' | 'codex'` to `'claude' | 'codex' | 'gemini'`"
      - "Add optional `gemini_models?: ReadonlyArray<{ name: string; context_window: number }>` to `ExecuteCommand` and `ResumeCommand` in `packages/shared-types/src/index.ts` (parallel to `codex_models`)"
      - "Add `geminiModels?: ReadonlyArray<{ name: string; context_window: number }>` to `AdapterStartOptions` in `packages/session-runner/src/adapters/types.ts` (parallel to `codexModels`)"
      - "`pnpm typecheck` — verify no regressions; `ExecuteCommand.agent` still accepts `'claude' | 'codex' | 'gemini' | undefined`"
    test_cases:
      - id: "agent-name-gemini-accepted"
        description: "`pnpm typecheck` passes. `ExecuteCommand` with `agent: 'gemini'` compiles. `agent: 'bogus'` does not."
        type: "unit"
  - id: p2
    name: "D1 `gemini_models` table + admin CRUD API + settings panel"
    tasks:
      - "Create D1 migration `0026_gemini_models.sql`: `CREATE TABLE gemini_models (...)` with seed rows for `auto-gemini-3` (1M), `gemini-3-flash-preview` (200K), `gemini-3-pro-preview` (1M), `gemini-3.1-flash-preview` (200K), `gemini-3.1-pro-preview` (1M)"
      - "Add Drizzle schema entry `geminiModels` in `apps/orchestrator/src/db/schema.ts` mirroring `codexModels`"
      - "Add admin-only Hono routes at `apps/orchestrator/src/routes/api/admin/gemini-models.ts`: GET (list), POST (create), PUT (update), DELETE. Auth-gated to admin role. Mirror `admin-codex-models.ts` structure"
      - "Add admin settings panel at `apps/orchestrator/src/components/admin/gemini-models-panel.tsx` mirroring `codex-models-panel.tsx`: table with inline add/edit/delete"
      - "Wire `gemini_models` query into `triggerGatewayDial` (runner-link.ts): on `cmd.agent === 'gemini'`, read D1 `SELECT name, context_window FROM gemini_models WHERE enabled = 1`, inject as `cmd.gemini_models` on the spawn payload"
    test_cases:
      - id: "gemini-models-crud"
        description: "Admin can create, list, update, delete gemini model entries via the API. Non-admin gets 403."
        type: "integration"
      - id: "gemini-models-seed"
        description: "After migration 0026, `SELECT * FROM gemini_models` returns 5 rows with correct names and context windows"
        type: "integration"
      - id: "gemini-models-inject-spawn"
        description: "When `triggerGatewayDial` fires for a gemini session, the `.cmd` JSON contains a `gemini_models` array with all enabled models"
        type: "integration"
  - id: p3
    name: "GeminiCliAdapter implementation"
    tasks:
      - "Implement `GeminiCliAdapter` at `packages/session-runner/src/adapters/gemini.ts` — subprocess wrapper around `gemini` CLI with respawn-per-turn architecture"
      - "Implement JSONL line parser: read stdout from `Bun.spawn`, split on newlines, `JSON.parse` each line, dispatch by `event.type`"
      - "Map Gemini JSONL events to GatewayEvents: `init` -> `session.init`, `message{assistant,delta:true}` -> `partial_assistant`, `tool_use` -> buffered into `assistant` content blocks, `tool_result` -> `tool_result{status only}`, `result` -> `result{context_usage}`"
      - "Filter `message{role:user}` events (input echo — we already know the input)"
      - "Accumulate incremental `delta:true` text chunks into final assistant message; emit `assistant` when `result` arrives or next non-message event"
      - "Capture `session_id` from first `init` event as `runner_session_id`; use for subsequent `--resume <id>` invocations"
      - "Resume: spawn `gemini --resume <session_id>` with follow-up prompt. On non-zero exit / stderr containing 'not found', catch -> emit error -> return (triggers forkWithHistory auto-fallback)"
      - "Abort: SIGINT to child process, 2s timeout, then SIGKILL. Declare `supportsCleanAbort: false`"
      - "Multi-turn loop via `PushPullQueue<string>`: `pushUserTurn()` pushes to queue; main loop iterates queue, spawns fresh `gemini --resume` per turn"
      - "Synthesize `context_usage` from `result.stats`: aggregate `total_tokens` across all sub-models in `stats.models`; look up `gemini_models` for context window; 1M fallback + warning for unknown models"
      - "Read `cmd.gemini_models` from spawn payload; use for `availableProviders` capability and context-window math"
      - "Add `'gemini'` to the adapter registry at `packages/session-runner/src/adapters/index.ts`"
      - "Write unit tests at `packages/session-runner/src/adapters/gemini.test.ts` with JSONL fixtures from `planning/research/2026-04-26-gemini-fixtures/`"
    test_cases:
      - id: "gemini-adapter-execute"
        description: "GeminiAdapter spawns `gemini` subprocess, emits session.init with correct capabilities, streams text via partial_assistant, finishes with result including context_usage"
        type: "integration"
      - id: "gemini-adapter-tool-call"
        description: "GeminiAdapter processes tool_use + tool_result events, emits tool_result GatewayEvent with tool_name + status, assistant follow-up text arrives"
        type: "integration"
      - id: "gemini-adapter-resume"
        description: "GeminiAdapter with ResumeCommand spawns `gemini --resume <id>` and continues from prior context"
        type: "integration"
      - id: "gemini-adapter-resume-fallback"
        description: "When gemini --resume exits non-zero (session not found), adapter emits error event and returns (triggers forkWithHistory)"
        type: "integration"
      - id: "gemini-adapter-abort"
        description: "Abort during a long turn sends SIGINT, waits 2s, then SIGKILL; no orphan subprocess"
        type: "integration"
      - id: "gemini-adapter-context-usage"
        description: "`result.context_usage` carries correct `percentage` computed from aggregated stats.models token counts / gemini_models context_window"
        type: "unit"
      - id: "gemini-adapter-capabilities"
        description: "session.init.capabilities matches expected bitmap: rewind=false, thinkingDeltas=false, permissionGate=false, subagents=false, permissionMode=false, setModel=false, contextUsage=true, interrupt=true, cleanAbort=false, emitsUsdCost=false"
        type: "unit"
      - id: "gemini-adapter-delta-accumulation"
        description: "Multiple `message{delta:true}` events accumulate incrementally into a single assistant message; partial_assistant events emitted per chunk"
        type: "unit"
      - id: "gemini-adapter-user-echo-filtered"
        description: "`message{role:user}` events from JSONL stream are silently dropped, not emitted as GatewayEvents"
        type: "unit"
  - id: p4
    name: "Gateway preflight + end-to-end verification + polish"
    tasks:
      - "Add gateway preflight for Gemini sessions: check `GEMINI_API_KEY` env var is set; check `gemini --version` >= 0.32.0; return error to DO before spawn if either fails"
      - "E2E smoke: spawn gemini session via UI, prompt -> tool call -> result; verify SessionMeta.capabilities reflects Gemini bitmap; verify useSessionStatus works"
      - "E2E smoke: idle-reap gemini session, send follow-up, verify resume continuity"
      - "E2E smoke: resume failure (delete session dir), verify auto-fallback to forkWithHistory"
      - "E2E smoke: mixed Claude + Codex + Gemini tabs open simultaneously, no cross-talk"
      - "E2E smoke: admin adds a new model via settings panel, starts a session with it, verify it appears in capabilities"
      - "Update `.env.example` with `GEMINI_API_KEY` documentation"
    test_cases:
      - id: "e2e-gemini-full-cycle"
        description: "Gemini session: spawn -> tool use -> result -> idle-reap -> resume -> follow-up -> result. All events match expected types."
        type: "smoke"
      - id: "e2e-mixed-agent-tabs"
        description: "Claude tab, Codex tab, and Gemini tab open simultaneously; events route to correct sessions with no cross-talk"
        type: "smoke"
      - id: "e2e-admin-model-management"
        description: "Admin adds 'gemini-2.5-flash' model with 1M context, spawns a gemini session selecting it, session.init.capabilities.availableProviders includes it"
        type: "smoke"
      - id: "e2e-gateway-preflight-no-key"
        description: "Without GEMINI_API_KEY: spawning a gemini session returns an error from the gateway before any runner process starts"
        type: "smoke"
      - id: "e2e-gateway-preflight-old-version"
        description: "With gemini CLI <0.32.0 (simulated): spawn returns version error"
        type: "smoke"
---

# GeminiCliAdapter via RunnerAdapter Interface

> GitHub Issue: [#110](https://github.com/baseplane-ai/duraclaw/issues/110)
> Epic: [#30 — Pluggable RunnerAdapter](https://github.com/baseplane-ai/duraclaw/issues/30) (P3)
> Pattern precedent: [Spec #107 — Codex Runner Revival](./107-codex-runner-revival.md) (PR #108, merged)
> Research: [`planning/research/2026-04-26-gemini-runner-adapter.md`](../research/2026-04-26-gemini-runner-adapter.md)
> Fixtures: [`planning/research/2026-04-26-gemini-fixtures/`](../research/2026-04-26-gemini-fixtures/)

## Overview

Duraclaw's session-runner now supports Claude and Codex via the `RunnerAdapter` interface shipped in PR #108. This spec adds a third adapter — `GeminiCliAdapter` — that wraps Google's `gemini` CLI as a subprocess, parsing its `--output-format stream-json` JSONL output into `GatewayEvent`s. Unlike Codex (which uses a first-party SDK), Gemini has no TS SDK suitable for headless agent use — the adapter owns the JSONL parser, subprocess lifecycle, and signal handling directly. An admin-managed D1 `gemini_models` table (mirroring `codex_models`) stores model entries. A gateway preflight gate ensures `GEMINI_API_KEY` is set and the `gemini` binary is >= v0.32.0 before any spawn.

## Feature Behaviors

### B1: AgentName extends to include `'gemini'`

**Core:**
- **ID:** agent-name-gemini
- **Trigger:** Any code constructing an `ExecuteCommand` or `ResumeCommand` with `agent: 'gemini'`
- **Expected:** TypeScript compiler accepts `agent: 'gemini'`. The type `AgentName = 'claude' | 'codex' | 'gemini'` in `packages/shared-types/src/index.ts:15`. All existing `'claude'` and `'codex'` paths unaffected.
- **Verify:** `pnpm typecheck` passes. Adding `agent: 'gemini'` to an `ExecuteCommand` literal compiles. `agent: 'bogus'` still fails.
- **Source:** `packages/shared-types/src/index.ts:15` (modify existing)

#### Data Layer

New optional fields on `ExecuteCommand` (line ~52) and `ResumeCommand` (line ~123):

```ts
/** GH#110: Gemini model catalog injected by the DO from D1 at spawn time. */
gemini_models?: ReadonlyArray<{ name: string; context_window: number }>
```

New field on `AdapterStartOptions` in `packages/session-runner/src/adapters/types.ts`:

```ts
geminiModels?: ReadonlyArray<{ name: string; context_window: number }>
```

---

### B2: D1 `gemini_models` table with admin CRUD

**Core:**
- **ID:** gemini-models-table
- **Trigger:** Admin navigates to settings -> Gemini Models panel; or `triggerGatewayDial` fires for a gemini session
- **Expected:** D1 table `gemini_models` stores model entries (name, context_window, enabled). Seeded with 5 models via migration. Admin-only CRUD routes at `/api/admin/gemini-models`. Settings panel provides table view with inline add/edit/delete.
- **Verify:** After deploying migration 0026: `SELECT * FROM gemini_models` returns 5 rows. `POST /api/admin/gemini-models` with `{name: 'gemini-2.5-flash', context_window: 1000000}` returns 201. Non-admin `POST` returns 403.
- **Source:** new file `apps/orchestrator/migrations/0026_gemini_models.sql`, new file `apps/orchestrator/src/routes/api/admin/gemini-models.ts`

#### UI Layer

Admin settings panel: `apps/orchestrator/src/components/admin/gemini-models-panel.tsx`
- Mirror `codex-models-panel.tsx` structure and styling
- Table columns: Name, Context Window (tokens), Enabled toggle, Actions (edit / delete)
- Add row: Name (text input), Context Window (number input, placeholder "1000000"), Submit
- Validation: name required + unique, context_window required + positive integer

#### API Layer

```
GET    /api/admin/gemini-models           -> 200 [{id, name, context_window, enabled, created_at, updated_at}]
POST   /api/admin/gemini-models           -> 201 {id, name, context_window, ...}
         body: {name: string, context_window: number, max_output_tokens?: number}
PUT    /api/admin/gemini-models/:id       -> 200 {id, name, context_window, ...}
         body: {name?: string, context_window?: number, enabled?: boolean}
DELETE /api/admin/gemini-models/:id       -> 204
```

Error responses: identical shape to `admin-codex-models.ts` (400 missing field, 400 invalid context_window, 403 forbidden, 409 duplicate name).

#### Data Layer

D1 migration `0026_gemini_models.sql`:

```sql
CREATE TABLE IF NOT EXISTS gemini_models (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  context_window INTEGER NOT NULL,
  max_output_tokens INTEGER,           -- reserved for future use (mirrors codex_models schema); not consumed by adapter in v1
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO gemini_models (id, name, context_window) VALUES
  ('auto-gemini-3', 'auto-gemini-3', 1000000),
  ('gemini-3-flash-preview', 'gemini-3-flash-preview', 200000),
  ('gemini-3-pro-preview', 'gemini-3-pro-preview', 1000000),
  ('gemini-3.1-flash-preview', 'gemini-3.1-flash-preview', 200000),
  ('gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', 1000000);
```

---

### B3: Gemini model list injected via spawn payload

**Core:**
- **ID:** gemini-models-spawn-inject
- **Trigger:** `triggerGatewayDial` in `runner-link.ts` fires for a command where `cmd.agent === 'gemini'`
- **Expected:** DO reads `SELECT name, context_window FROM gemini_models WHERE enabled = 1` from D1, injects the result as `cmd.gemini_models` on the `ExecuteCommand` / `ResumeCommand`. Runner reads `cmd.gemini_models` at boot. No runtime HTTP fetch from the runner.
- **Verify:** Inspect `.cmd` JSON on disk after spawning a gemini session — `gemini_models` array present with all enabled models. If all models are disabled, array is empty (`[]`) — adapter proceeds with hardcoded 1M fallback and `availableProviders[0].models = []` (valid; UI shows no model options but the session still runs on the CLI's default).
- **Source:** `apps/orchestrator/src/agents/session-do/runner-link.ts:177-192` (add parallel block for gemini after existing codex block)

#### API Layer

New optional field on `ExecuteCommand` and `ResumeCommand` (already declared in B1):

```ts
gemini_models?: ReadonlyArray<{ name: string; context_window: number }>
```

---

### B4: GeminiCliAdapter — subprocess wrapper with respawn-per-turn architecture

**Core:**
- **ID:** gemini-adapter-core
- **Trigger:** `ExecuteCommand.agent === 'gemini'` reaches session-runner
- **Expected:** Adapter spawns `gemini -y --skip-trust --output-format stream-json --prompt <text>` as a child process via `Bun.spawn()`. Parses stdout line-by-line as JSONL. Captures `session_id` from the first `init` event as `runner_session_id`. Emits normalized `GatewayEvent`s. On follow-up turns via `pushUserTurn`, spawns a fresh `gemini -y --skip-trust --resume <session_id> --output-format stream-json --prompt <text>` subprocess (respawn-per-turn). Each turn is serialized via `PushPullQueue<string>`.
- **Verify:** Start a Gemini session with prompt `"Say only the word PONG."`. `session.init` arrives with `capabilities.supportsRewind=false`, `tools=[]`, `runner_session_id` is a UUID. `partial_assistant` arrives with `content: [{type:'text', delta:'PONG'}]`. `result` arrives with `context_usage` populated.
- **Source:** new file `packages/session-runner/src/adapters/gemini.ts`

**Why `tools: []`:** Gemini CLI manages its own tools internally (shell, file ops, etc.) — the adapter has no introspection into the CLI's tool list. This is identical to the Codex pattern (`codex.ts` also emits `tools: []`).

#### API Layer

**Spawn command construction:**

```
First turn:
  gemini -y --skip-trust --output-format stream-json [--model <model>] --prompt <text>

Follow-up turns:
  gemini -y --skip-trust --resume <session_id> --output-format stream-json [--model <model>] --prompt <text>
```

Spawn environment: `opts.env` spread into `Bun.spawn()` env (carries `GEMINI_API_KEY`).
Working directory: `opts.project` (critical — gemini CLI scopes sessions by project hash of cwd).

**Gemini JSONL -> GatewayEvent mapping** (confirmed via live fixtures):

| Gemini JSONL event | GatewayEvent emitted | Notes |
|---|---|---|
| `init{session_id, model}` | `session.init{runner_session_id: session_id, model, capabilities, tools: []}` | First turn only captures session_id; resume uses existing |
| `message{role:user}` | (filtered — not emitted) | Input echo; adapter already knows the prompt |
| `message{role:assistant, delta:true}` | `partial_assistant{content: [{type:'text', id: uuid(), delta: content}]}` | Incremental text chunks — accumulate for final `assistant` |
| `tool_use{tool_name, tool_id, parameters}` | (buffered) -> emitted as `{type:'tool_use', id: tool_id, tool_name, input: parameters}` content block inside `assistant` | Single event per tool call; `tool_id` is 8-char alphanumeric |
| `tool_result{tool_id, status}` | `tool_result{content: [{type:'tool_call', toolCallId: tool_id, toolName: <from buffered tool_use>, status}]}` | **No `output` field** — status only. Known capability gap |
| `result{status, stats}` | `result{total_cost_usd: null, context_usage: synthesized, is_error: status !== 'success'}` | Terminal event; also triggers final `assistant` emit for accumulated text |
| (synthesized on turn start) | `session_state_changed{state: 'running'}` | |
| (synthesized on turn end) | `session_state_changed{state: 'idle'}` | |
| unknown event type | (logged + skipped) | Defensive parsing for schema drift |

Events NOT emitted by GeminiCliAdapter (capability-excluded):
- `tool_use_summary` — Gemini's `tool_use` maps directly; no separate summary
- `ask_user` / `permission_request` — `supportsPermissionGate: false` (yolo mode forced)
- `task_started` / `task_progress` / `task_notification` — `supportsSubagents: false`
- `compact_boundary` — Gemini has no auto-compact
- `api_retry` — no retry signal exposed in JSONL

**GeminiCliAdapter capability bitmap:**

```ts
{
  supportsRewind: false,
  supportsThinkingDeltas: false,
  supportsPermissionGate: false,      // -y (yolo) forced; no per-tool gate
  supportsSubagents: false,
  supportsPermissionMode: false,
  supportsSetModel: false,             // model pinned at session creation
  supportsContextUsage: true,          // synthesized from result.stats
  supportsInterrupt: true,             // SIGINT works in v0.32.0+
  supportsCleanAbort: false,           // 2s SIGKILL fallback retained
  emitsUsdCost: false,                 // no pricing in Gemini JSONL
  availableProviders: [
    { provider: 'google', models: cmd.gemini_models.map(m => m.name) },
  ],
}
```

**Stderr handling:** Drain stderr to a capped buffer (max 4KB) per turn. On successful exit (code 0), log the buffer at `debug` level (may contain deprecation notices, routing info). On non-zero exit, include the buffer in the `error` GatewayEvent message (truncated to 500 chars). Do not consume stderr synchronously mid-stream — it risks deadlock if the pipe backs up.

**Subprocess lifecycle within `run()`:**

```
1. Validate opts (session_id, project present)
2. If opts.resumeSessionId: store as geminiSessionId
3. Spawn first turn (capture session_id from init event)
4. Emit session.init
5. Multi-turn loop:
   for await (const nextPrompt of turnQueue):
     spawn gemini --resume <geminiSessionId> --prompt <nextPrompt>
     parse JSONL -> emit events
     on result -> emit result + session_state_changed{idle}
6. On abort: SIGINT -> 2s -> SIGKILL to currentChild
7. dispose(): kill child, close queue, null refs (idempotent)
```

---

### B5: Gemini resume via `--resume` with forkWithHistory fallback

**Core:**
- **ID:** gemini-resume
- **Trigger:** `ResumeCommand.agent === 'gemini'` with `runner_session_id` set
- **Expected:** Adapter uses `gemini --resume <runner_session_id>` to restore prior context. Session transcript is stored on disk at `~/.gemini/tmp/<project_hash>/chats/`. On resume failure (non-zero exit, stderr containing "not found" or "no session"), adapter emits `error` event and returns immediately, triggering DO's `forkWithHistory` auto-fallback.
- **Verify:** Start a Gemini session, let it complete. Idle-reap the runner. Send a follow-up. Verify conversation continues with prior context. Then delete the session dir — verify forkWithHistory kicks in.
- **Source:** `packages/session-runner/src/adapters/gemini.ts` (resume branch)

**Resume failure recovery:**
1. Adapter catches non-zero exit from `gemini --resume`
2. Emits `error{error: 'Gemini session not found — falling back to history replay', code: 'gemini_resume_failed'}`
3. Returns immediately (run() resolves)
4. DO's existing `forkWithHistory` serializes message history as `<prior_conversation>...</prior_conversation>` preamble, spawns a fresh `execute` with a new `runner_session_id`

This matches the Codex pattern at `codex.ts:84-96`.

---

### B6: Gemini context-usage synthesis from `result.stats`

**Core:**
- **ID:** gemini-context-usage
- **Trigger:** GeminiCliAdapter receives `result` JSONL event with `stats` payload
- **Expected:** Adapter aggregates token counts across all sub-models in `stats.models` (the `auto-gemini-3` router delegates to multiple models per turn). Looks up `cmd.gemini_models` for the session's model to find `context_window`. Computes `WireContextUsage`:
  ```ts
  {
    input_tokens: aggregated input across stats.models,
    output_tokens: aggregated output across stats.models,
    total_tokens: stats.total_tokens,
    max_tokens: contextWindow,           // from gemini_models lookup
    percentage: stats.total_tokens / contextWindow,
    model: sessionModel,                 // e.g. 'auto-gemini-3'
  }
  ```
  If model not found in `gemini_models`, falls back to 1,000,000 and emits a warning event: `"Unknown model context window for '${model}' — using 1M default"`.
- **Verify:** Unit test: GeminiCliAdapter with `gemini_models: [{name:'auto-gemini-3', context_window: 1000000}]` receiving `stats: {total_tokens: 13681, ...}` produces `context_usage: {percentage: 0.013681, max_tokens: 1000000, ...}`.
- **Source:** new file `packages/session-runner/src/adapters/gemini.ts`

**`stats` shape from live fixture** (text-only.jsonl):

```json
{
  "total_tokens": 13681,
  "input_tokens": 13522,
  "output_tokens": 32,
  "cached": 0,
  "input": 13522,
  "duration_ms": 3231,
  "tool_calls": 0,
  "models": {
    "gemini-2.5-flash-lite": {"total_tokens": 881, "input_tokens": 757, "output_tokens": 30, "cached": 0, "input": 757},
    "gemini-3-flash-preview": {"total_tokens": 12800, "input_tokens": 12765, "output_tokens": 2, "cached": 0, "input": 12765}
  }
}
```

Use the top-level `total_tokens` / `input_tokens` / `output_tokens` (already aggregated). The per-model breakdown in `models` is informational — log it but don't parse for context_usage.

---

### B7: Abort via SIGINT -> 2s -> SIGKILL

**Core:**
- **ID:** gemini-abort
- **Trigger:** `interrupt()` called on user Stop, or `signal` fires from runner's SIGTERM watchdog
- **Expected:** Adapter sends SIGINT to the current child process. If the child hasn't exited after 2s, sends SIGKILL. After abort, emits `session_state_changed{state: 'idle'}` without a result frame (same as CodexAdapter per-turn abort at `codex.ts:247-257`).
- **Verify:** Start a Gemini session with a long prompt. Call `interrupt()` mid-stream. Child process exits within 3s. No orphaned `gemini` process. `session_state_changed{state: 'idle'}` emitted.
- **Source:** new file `packages/session-runner/src/adapters/gemini.ts`

**Signal handling context:** google-gemini/gemini-cli#15873 (orphaned-process bug) was fixed in v0.32.0 via PR #16965 (merged 2026-02-26). SIGINT is now handled cleanly. The 2s SIGKILL fallback is a safety net for edge cases, not load-bearing — contingent on the gateway version gate (B8) enforcing >= 0.32.0.

---

### B8: Gateway preflight gate for Gemini sessions

**Core:**
- **ID:** gemini-gateway-preflight
- **Trigger:** Gateway receives a spawn request for `agent === 'gemini'`
- **Expected:** Before spawning the runner, gateway checks:
  1. `GEMINI_API_KEY` env var is set and non-empty
  2. `gemini --version` returns a version >= 0.32.0
  If either check fails, gateway returns an error response to the DO **without spawning a runner**. Error shapes:
  - Missing key: `{error: 'missing_credential', detail: 'GEMINI_API_KEY environment variable is not set'}`
  - Old version: `{error: 'version_too_old', detail: 'gemini CLI v{X} found, >= 0.32.0 required'}`
- **Verify:** Without `GEMINI_API_KEY`: spawn gemini session -> gateway returns error within 1s, no runner PID file created. With old gemini: spawn -> version error returned.
- **Source:** `packages/agent-gateway/src/handlers.ts` (add preflight block in spawn handler, parallel to existing codex availability check if any)

**Rationale for hard gate:** Gemini CLI headless mode (`--prompt`) **requires** `GEMINI_API_KEY` — cached OAuth credentials from `gemini auth login` are rejected in non-interactive mode (confirmed in P1 spike: "When using Gemini API, you must specify the GEMINI_API_KEY environment variable."). The version gate prevents the SIGKILL fallback from being load-bearing in production.

---

## Non-Goals

Explicitly out of scope for this spec:

- **OAuth / service-account auth** — Gemini CLI headless mode requires `GEMINI_API_KEY`. OAuth device-code or `GOOGLE_APPLICATION_CREDENTIALS` are follow-up if the CLI surface changes. Spec only supports API-key auth.
- **Tool output in UI** — Gemini's `tool_result` JSONL has no `output` field (confirmed in fixtures). UI shows tool name + status only. Follow-up if Google adds output to the schema.
- **UI capability-gating refinements** — rewind arrow, thinking toggle, etc. already tolerate `false` from Codex; Gemini gets the same treatment. Follow-up spec.
- **Pricing module / `total_cost_usd`** — Gemini sessions emit `total_cost_usd: null`. Follow-up spec for `@duraclaw/pricing`.
- **Per-user API-key storage** — v1 uses gateway env only via `buildCleanEnv()`.
- **Model-picker UX redesign** — backend-only model selection in v1.
- **Kata-side Gemini driver** — `packages/kata` Gemini coexistence is GH#109's scope, not this spec.
- **pi-mono / Hermes adapters** — epic #30 P4/P5, independent issues.
- **Generic `models?:` field refactoring** — `geminiModels?:` mirrors `codexModels?:` for now. Generic refactor is a cleanup issue before P4 (pi-mono).
- **`AdapterStartOptions` field naming consolidation** — deferred to pre-P4 cleanup.
- **Resident-process (REPL) architecture** — respawn-per-turn chosen. See Architectural Bets.
- **`--debug` mode tool-output capture** — undocumented, fragile. Not v1.

## Open Questions

All planning-phase questions have been resolved. Decisions below are binding; revisit only via a new spec.

- [x] **JSONL schema** — captured via live spike (3 fixtures). `delta:true` is incremental, `tool_use` is single event, `tool_result` has no output. (Decision: spec from fixtures)
- [x] **Resume cold-start** — 6.8s wall, same as fresh spawn. No resume penalty. (Decision: acceptable)
- [x] **Binary version** — v0.39.1 on VPS (>= 0.32.0). (Decision: hard preflight gate)
- [x] **Admin UX panel** — in scope, mirror codex-models-panel. (Decision: locked)
- [x] **Field naming** — `geminiModels?:` parallel to `codexModels?:`. (Decision: locked, generic refactor deferred)
- [x] **Auth posture** — `GEMINI_API_KEY` required at gateway preflight, no OAuth in v1. (Decision: locked)
- [x] **Model default** — `auto-gemini-3` (Google's router). (Decision: locked)
- [x] **Model seed** — 5 models: auto-gemini-3, gemini-3-flash-preview, gemini-3-pro-preview, gemini-3.1-flash-preview, gemini-3.1-pro-preview. (Decision: locked)
- [x] **Tool-result UX** — accept gap, status only, model summarises. (Decision: locked)
- [x] **`--skip-trust` flag** — required for headless mode in untrusted folders. (Decision: always pass)

## Implementation Phases

See YAML frontmatter. Phases are ordered and gated:

- **P1** (~1h): Pure type changes. AgentName extension + wire type additions. Zero behaviour change. Gate: `pnpm typecheck` clean.
- **P2** (~3h): D1 migration + admin CRUD routes + settings panel + spawn-payload injection. Gate: admin can manage Gemini models, spawn payload includes model list.
- **P3** (~6h): GeminiCliAdapter implementation — the main feature work. Depends on P1 (types) and P2 (model catalog). Gate: Gemini sessions work end-to-end with resume.
- **P4** (~2h): Gateway preflight + E2E verification + polish. Gate: all smoke tests pass.

**PR strategy:** Single feature branch `feature/110-gemini-cli-runner`. P1 may land as a separate PR (pure types, safe to merge early) or combined at implementer's discretion.

## Verification Strategy

### Test Infrastructure

- **vitest** already configured across the workspace. No new test infra needed.
- GeminiCliAdapter: mock `Bun.spawn` in vitest setup; feed JSONL fixture lines to the mocked stdout stream; assert event normalization. Pattern: factory function returns a fake `Subprocess` with a controllable `ReadableStream` for stdout.
- Live fixtures in `planning/research/2026-04-26-gemini-fixtures/` — copy to `packages/session-runner/src/adapters/__fixtures__/gemini/` at P3 start.
- Admin CRUD: integration tests against miniflare D1 using existing test harness.

### Build Verification

- `pnpm typecheck` — enforces AgentName narrowing flows through all consumers.
- `pnpm build` — tsup at `packages/session-runner` ensures adapters compile to `dist/main.js`.
- `pnpm test` — full workspace test suite.

## Verification Plan

### VP1: Type regression (P1 gate)

Steps:
1. `pnpm typecheck`
   Expected: Clean across all packages. `ExecuteCommand.agent` accepts `'claude' | 'codex' | 'gemini' | undefined`.
2. `pnpm test`
   Expected: All existing tests pass. Zero failures. No Gemini-specific tests yet.

### VP2: Admin model management (P2 gate)

Steps:
1. After deploying migration 0026: `curl -H "Authorization: Bearer $TOKEN" http://localhost:$VERIFY_ORCH_PORT/api/admin/gemini-models`
   Expected: 200 with `[{name:'auto-gemini-3', context_window:1000000}, {name:'gemini-3-flash-preview', context_window:200000}, ...]` (5 rows)
2. `curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"gemini-2.5-flash","context_window":1000000}' http://localhost:$VERIFY_ORCH_PORT/api/admin/gemini-models`
   Expected: 201. Subsequent GET includes gemini-2.5-flash (6 rows).
3. Spawn a gemini session. Read the `.cmd` file from `/run/duraclaw/sessions/<id>.cmd`.
   Expected: `gemini_models` array present with all enabled models.

### VP3: Gemini adapter end-to-end (P3 gate)

Steps:
1. Set `GEMINI_API_KEY` in `.env`. `scripts/verify/dev-up.sh`.
2. Via UI or API: start a Gemini session with prompt `"Run echo HELLO and tell me what it printed."`.
   Expected: `session.init` arrives with `capabilities.supportsRewind=false`, `tools=[]`, `runner_session_id` is a UUID. `partial_assistant` events arrive with incremental text. `tool_result` event has `status: 'success'`, no output field. `result` arrives with `context_usage` populated.
3. Wait for `result` event.
   Expected: `result.total_cost_usd === null`. `result.context_usage` populated with `percentage` > 0.
4. Without `GEMINI_API_KEY`: spawn a gemini session via gateway.
   Expected: Gateway returns error before runner spawns. No PID file created.

### VP4: Resume + failure recovery (P3/P4 gate)

Steps:
1. Start a Gemini session. Say `"My name is Alice."` Let it complete. Note the `runner_session_id`.
2. Force-kill the runner: `kill -9 $(cat /run/duraclaw/sessions/<id>.pid | jq .pid)`.
3. Send a follow-up message `"What is my name?"` via UI.
   Expected: DO issues ResumeCommand. New runner spawns `gemini --resume <session_id>`. Response references "Alice".
4. Delete the session dir: `rm -rf ~/.gemini/tmp/$(ls ~/.gemini/tmp/ | grep -v agent-tools | head -1)/chats/` (find the project hash dir via `ls`; it's the SHA256 of the project cwd). Send another follow-up.
   Expected: Resume fails -> error event -> forkWithHistory auto-fallback -> fresh session with `<prior_conversation>` preamble -> conversation continues referencing prior context.

### VP5: Mixed agent tabs (P4 gate)

Steps:
1. Open a Claude session tab, a Codex session tab, and a Gemini session tab simultaneously.
2. Send a message in each tab within 2s of each other.
   Expected: Events route correctly to their respective sessions. No cross-talk. All three sessions complete independently.

### VP6: Gateway preflight (P4 gate)

Steps:
1. Unset `GEMINI_API_KEY` from gateway env. Attempt to spawn a Gemini session.
   Expected: Gateway returns `{error: 'missing_credential'}` within 1s. No runner process spawned.
2. Simulate old gemini version (rename binary, place a stub that outputs "0.31.0" on `--version`). Attempt to spawn.
   Expected: Gateway returns `{error: 'version_too_old'}`. No runner process spawned.

## Implementation Hints

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `bun` (global) | `Bun.spawn()` | P3 — subprocess management for gemini CLI |
| `@duraclaw/shared-types` | `{ AdapterCapabilities, GatewayEvent, ExecuteCommand, ResumeCommand, AgentName }` | Wire types shared by all adapters |
| `packages/session-runner/src/push-pull-queue.ts` | `{ PushPullQueue }` | Multi-turn queue — same pattern as Claude's lifetime queue, but each dequeue triggers a fresh subprocess |
| `packages/session-runner/src/adapters/types.ts` | `{ RunnerAdapter, AdapterStartOptions }` | Adapter interface contract |

### Code Patterns

**JSONL line parser** (core of the adapter):

```ts
async function* parseJsonlStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<GeminiEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          yield JSON.parse(trimmed) as GeminiEvent
        } catch {
          // Non-JSON line (stderr leak, debug noise) — skip
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
```

**Subprocess spawn per turn:**

```ts
private async spawnTurn(prompt: string): Promise<void> {
  const args = ['-y', '--skip-trust', '--output-format', 'stream-json']
  if (this.geminiSessionId) {
    args.push('--resume', this.geminiSessionId)
  }
  if (this.currentModel && this.currentModel !== 'auto-gemini-3') {
    args.push('--model', this.currentModel)
  }
  args.push('--prompt', prompt)

  const child = Bun.spawn(['gemini', ...args], {
    cwd: this.opts!.project,
    env: { ...this.opts!.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  this.currentChild = child

  // Parse stdout JSONL
  for await (const event of parseJsonlStream(child.stdout)) {
    this.handleGeminiEvent(event)
  }

  const exitCode = await child.exited
  if (exitCode !== 0) {
    // Resume failure or crash — surface as error
    const stderr = await new Response(child.stderr).text()
    this.opts!.onEvent({
      type: 'error',
      session_id: this.opts!.sessionId,
      error: `gemini exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
    })
  }
  this.currentChild = null
}
```

**Abort with SIGKILL fallback** (mirror codex.ts:472-496):

```ts
async interrupt(): Promise<void> {
  if (!this.currentChild) return
  this.currentChild.kill('SIGINT')
  const child = this.currentChild
  setTimeout(() => {
    try { child.kill('SIGKILL') } catch {}
  }, 2000)
}
```

**Adapter registry update** (`packages/session-runner/src/adapters/index.ts`):

```ts
const registry: Partial<Record<AgentName, () => RunnerAdapter>> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  gemini: () => new GeminiAdapter(),  // <-- add this
}
```

**Spawn payload injection** (in `runner-link.ts:triggerGatewayDial`, after existing codex block at line ~192):

```ts
if (cmd.agent === 'gemini') {
  try {
    const result = await ctx.env.AUTH_DB.prepare(
      'SELECT name, context_window FROM gemini_models WHERE enabled = 1 ORDER BY name',
    ).all<{ name: string; context_window: number }>()
    cmd = { ...cmd, gemini_models: result.results ?? [] }
  } catch (err) {
    // Proceed without — adapter falls back to hardcoded defaults
  }
}
```

### Gotchas

- **Gemini CLI has no TS SDK for headless agent use** — the adapter owns the JSONL parser entirely. Pin the `stream-json` event schema to the live fixtures captured in P1 spike; log and skip unknown event types.
- **`gemini --prompt` requires `GEMINI_API_KEY`** even if OAuth is cached — confirmed in P1 spike. Error message: "When using Gemini API, you must specify the GEMINI_API_KEY environment variable." The gateway preflight (B8) catches this before any runner spawns.
- **`--skip-trust` is required** — without it, yolo/auto-approve mode is overridden to "default" in untrusted project folders. Always pass it.
- **`tool_result` has no `output` field** — unlike Claude/Codex, Gemini's JSONL only carries `{tool_id, status}`. The UI cannot show tool stdout/stderr for Gemini sessions. This is a known capability gap, not a bug.
- **`delta:true` is incremental, not cumulative** — multiple `message{role:assistant, delta:true}` events carry successive text chunks. Adapter must accumulate. There is no `delta:false` finalisation event — the stream ends with `result`.
- **`tool_id` is 8-char alphanumeric, not UUID** — e.g. `"5fxxflvh"`. Use as-is for `toolCallId` in GatewayEvents.
- **`auto-gemini-3` routes to multiple sub-models** — `result.stats.models` shows per-model breakdown. Use top-level `stats.total_tokens` for context_usage (already aggregated); don't re-sum the per-model entries.
- **System prompt overhead is heavy** — 13.5k input tokens for a 4-char response. Context-usage percentage will look surprisingly high even for small prompts. This is normal for Gemini CLI's auto-router.
- **7s wall time per turn** — 4.2s CLI startup + model inference. Multi-turn conversations feel slower than Claude/Codex. The dial-back WS buffers fine but the user sees a "thinking" delay. Consider surfacing a "Starting Gemini..." indicator in UX (follow-up).
- **Gemini CLI scopes sessions by project hash of cwd** — adapter MUST spawn with `cwd: opts.project`. If cwd changes between turns, resume will fail to find the session.
- **Do NOT break the 7-positional-argv contract** between gateway and runner. Adapter selection happens inside the runner via `cmd.agent`, not via argv.
- **`runner_session_id` on the wire is already adapter-agnostic** — Gemini's `session_id` (UUID) fits the same slot as Claude's `sdk_session_id` and Codex's `Thread.id`.

### Reference Docs

- [Gemini CLI Headless Mode](https://geminicli.com/docs/cli/headless/) — `--output-format stream-json`, non-interactive mode reference.
- [Gemini CLI Session Management](https://geminicli.com/docs/cli/session-management/) — `--resume`, transcript persistence, retention settings.
- [Gemini CLI Authentication](https://geminicli.com/docs/get-started/authentication/) — API key vs OAuth, env var names.
- [PR #10883 — stream-json format](https://github.com/google-gemini/gemini-cli/pull/10883) — original implementation of JSONL streaming.
- [PR #14504 — session_id in JSON output](https://github.com/google-gemini/gemini-cli/pull/14504) — added session_id to init event.
- [PR #16965 — signal handler fix](https://github.com/google-gemini/gemini-cli/pull/16965) — SIGHUP/SIGTERM/SIGINT handling, v0.32.0.
- [Research doc](../research/2026-04-26-gemini-runner-adapter.md) — full evaluation, capability comparison, interview decisions.
- [Live JSONL fixtures](../research/2026-04-26-gemini-fixtures/) — 3 fixtures with README documenting exact event shapes.
- [Spec #107 — Codex Runner Revival](./107-codex-runner-revival.md) — pattern precedent (PR #108, merged).
- [Epic #30 — Pluggable RunnerAdapter](https://github.com/baseplane-ai/duraclaw/issues/30) — umbrella issue.
