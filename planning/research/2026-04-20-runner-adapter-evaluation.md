---
date: 2026-04-20
topic: runner adapter evaluation — Codex, Gemini CLI, pi-mono, Hermes
type: library-eval
status: complete
github_issue: null
items_researched: 5
supersedes: planning/research/2026-04-10-pluggable-agent-gateway.md
supersedes_spec: planning/specs/0016-pluggable-agent-gateway.md
---

# Research: Runner Adapter Evaluation — Codex, Gemini CLI, pi-mono, Hermes

## Context

Duraclaw's `session-runner` is a per-session Bun subprocess that wraps
`@anthropic-ai/claude-agent-sdk` and dials a Cloudflare Durable Object
over WebSocket via `BufferedChannel` + `DialBackClient`. We want to
replace the hardcoded Claude SDK with a pluggable `RunnerAdapter` so
other coding-agent backends can slot in.

There is prior art:

- `planning/research/2026-04-10-pluggable-agent-gateway.md` — earlier
  evaluation of agent backends
- `planning/specs/0016-pluggable-agent-gateway.md` — approved spec from
  2026-04-10 defining `ClaudeAdapter` + `CodexAdapter` + `OpenCodeAdapter`

Both targeted the **pre-migration** architecture where the gateway
(`cc-gateway`) embedded the SDK. The session-runner migration
(spec #1) moved the SDK into per-session subprocesses, which
invalidates spec #16's architectural assumptions. This research
re-targets the adapter interface at the runner layer and evaluates a
different candidate set: Codex, Gemini CLI, pi-mono (`PI agent`),
Hermes-agent. **OpenCode is removed from scope** (never shipped, user
directive).

## Scope

Five items deep-dived in parallel by Explore agents:

0. Current session-runner contract (baseline)
1. OpenAI Codex (`@openai/codex-sdk` / `codex` CLI)
2. Google Gemini CLI (`@google/gemini-cli`)
3. pi-mono / `@mariozechner/pi-coding-agent` (the "PI agent")
4. Nous Research `hermes-agent`

Fields evaluated per item: invocation, streaming shape, session+resume,
multi-turn, tool-use + permissions, abort semantics, auth surface,
context-usage reporting, maturity, gap vs Claude SDK, adapter
complexity.

## Findings

### 0. Current runner contract (baseline)

The adapter interface must satisfy this surface without changes to the
gateway or DO protocols.

**Process lifecycle** (`packages/session-runner/src/main.ts:47-498`):

- Gateway spawns detached via `Bun.spawn({ detached: true, stdio: ['ignore', logFd, logFd] }).unref()` with 7 positional argv: `sessionId cmdFile callbackUrl bearer pidFile exitFile metaFile`
- Runner reads `.cmd` JSON, writes `.pid` + `.meta.json` (every 10s) + `.exit` (single-writer via `link`+EEXIST)
- Stays alive across turns; blocks on `queue.waitForNext()` after each `type=result`
- Terminal paths: natural completion / failed / aborted (SIGTERM, 2s grace) / crashed (5 consecutive meta-write failures)

**Dial-back WS protocol** (`packages/shared-transport/src/dial-back-client.ts`):

- URL: `{callbackUrl}?token={bearer}` (query param, not header — CF Workers limitation)
- Backoff: `[1s, 3s, 9s, 27s, 30s×]`, reset after 10s stable
- Terminal close codes: `4401 invalid_token`, `4410 token_rotated`, `4411 mode_transition`
- Post-connect exhaustion: 20 failed reconnects without 10s stability window

**BufferedChannel** (`packages/shared-transport/src/buffered-channel.ts`):

- Caps: 10K events / 50MB bytes, drop-oldest on overflow
- Gap sentinel on replay: `{ type: 'gap', dropped_count, from_seq, to_seq }`
- Every event stamped with monotonic `ctx.nextSeq`

**Event surface** (runner → DO, 16 types):

| Event | Key fields | Source |
|---|---|---|
| `session.init` | `session_id`, `sdk_session_id`, `project`, `model`, `tools[]` | `claude-runner.ts:485` |
| `partial_assistant` | `content[]` with `text_delta` / `thinking_delta` | `claude-runner.ts:513` |
| `assistant` | final `content[]` | `claude-runner.ts:568` |
| `tool_result` | tool execution outputs | `claude-runner.ts:579` |
| `ask_user` | `tool_call_id`, `questions[]` | `claude-runner.ts:247` |
| `permission_request` | `tool_call_id`, `tool_name`, `input` | `claude-runner.ts:274` |
| `file_changed` | `path`, `tool`, `timestamp` | `claude-runner.ts:441` |
| `result` | `subtype`, `duration_ms`, `total_cost_usd`, `num_turns` | `claude-runner.ts:686` |
| `rate_limit` | `rate_limit_info` | `claude-runner.ts:603` |
| `session_state_changed` | `state` (idle/running/requires_action) | `claude-runner.ts:593` |
| `task_started`/`progress`/`notification` | subagent lifecycle | `claude-runner.ts:613-655` |
| `heartbeat` | 15s cadence | `claude-runner.ts:146` |
| `kata_state` | workflow state push | `claude-runner.ts:79` |
| `error` | uncaught exceptions | `claude-runner.ts:770` |

**Command surface** (DO → runner, 11 types):

| Command | Payload | Source |
|---|---|---|
| `stream-input` | `message: {role, content}`, `client_message_id?` | `main.ts:151` |
| `permission-response` | `tool_call_id`, `allowed` | `main.ts:182` |
| `answer` | `tool_call_id`, `answers` (dict) | `main.ts:189` |
| `abort` / `stop` | — | `main.ts:196` |
| `interrupt` | — | `main.ts:201`, `commands.ts:54` |
| `get-context-usage` | — | `commands.ts:58` |
| `set-model` | `model?` | `commands.ts:71` |
| `set-permission-mode` | `mode` | `commands.ts:75` |
| `stop-task` | `task_id` | `main.ts:215` |
| `rewind` | `message_id`, `dry_run?` | `main.ts:222` |
| `ping` | — | `main.ts:260` |

**SDK coupling sites** (every line an adapter must abstract):

- `claude-runner.ts:384` — `await import('@anthropic-ai/claude-agent-sdk') → { query }`
- `claude-runner.ts:674` — `{ getSessionInfo }`
- `claude-runner.ts:410-423` — `options.canUseTool` callback
- `claude-runner.ts:426-460` — `options.hooks.PostToolUse`
- `claude-runner.ts:717-721` — initial `query({ prompt, options })`
- `claude-runner.ts:758-761` — resume `query({ prompt, options: { resume } })`
- `claude-runner.ts:466-704` — `for await (const message of iter)` (all event dispatch)

**Multi-turn loop** (`claude-runner.ts:724-764`):

- Initial turn: `query({ prompt: initialPrompt(), options })`
- After each `result`: `await queue.waitForNext()` blocks for next `stream-input`
- Auto-nudge: if result text === `"No response requested."` (idle stop), auto-resume with `"continue"` without DO input
- Loop exits on `queue.done()`, abort signal, or missing `sdk_session_id`

---

### 1. OpenAI Codex

**Summary / verdict: good fit.** Active, stable, in-process TS SDK
with thread-based resume and structured event streaming. Closest
architectural match to Claude SDK. Main gap: no native abort API
(issue [#5494](https://github.com/openai/codex/issues/5494)), no
`canUseTool` equivalent (full-auto only).

**Invocation** — `@openai/codex-sdk` (v0.120.0, Apr 2026). Node 18+.

```ts
import { Codex } from '@openai/codex-sdk'
const codex = new Codex()
const thread = codex.startThread({ workingDirectory: '/path' })
const result = await thread.runStreamed('Fix the bug in auth.py')
for await (const event of result.events) { /* process */ }
```

SDK internally spawns `codex` CLI over stdin/stdout JSONL; caller sees
typed objects.

**Streaming events** —

```ts
{ type: 'item.started',   id, item: { type: 'text' | 'tool_use', ... } }
{ type: 'item.updated',   id, item: { type: 'text', content: 'delta' } }
{ type: 'item.completed', id, item: { ... } }
{ type: 'turn.completed', duration_ms, usage: { input_tokens, output_tokens, cached_tokens } }
```

**Session + resume** — `thread.id` persisted in
`~/.codex/sessions/`. Resume via `codex.resumeThread(threadId)`.

**Multi-turn** — `thread.runStreamed()` called sequentially on same
thread. Matches Claude SDK's `AsyncGenerator` pattern.

**Tool-use + permissions** — Built-in tools: `bash`, `read_file`,
`edit_file`, `apply_patch`. No `canUseTool` callback in TS SDK (Elixir
SDK has `review_tool`). Must run full-auto (`--full-auto` CLI flag /
`approvalMode: 'never'`).

**Abort** — **Missing.** [#5494](https://github.com/openai/codex/issues/5494)
open. Workaround: track subprocess handle, SIGKILL.

**Auth** — Two paths:
1. ChatGPT OAuth (cached in `~/.codex/`, enables "fast mode")
2. `OPENAI_API_KEY` env var (programmatic, Platform pricing)

**Context usage** — `turn.completed.usage` provides token counts.
No USD cost in stream (vs Claude SDK's `total_cost_usd`).

**Maturity** — Very active: v0.121.0 Apr 2026, 718 releases, 5.5k+
commits, ~1.5M monthly npm downloads. Stable.

**Gaps vs Claude** — No hooks, no per-tool approval, no thinking
deltas, no subagent API, no USD cost, **no abort**.

**Adapter complexity: Moderate** (~250 LOC).

Sources:
[SDK docs](https://developers.openai.com/codex/sdk),
[npm @openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk),
[noninteractive mode](https://developers.openai.com/codex/noninteractive),
[abort issue #5494](https://github.com/openai/codex/issues/5494).

---

### 2. Google Gemini CLI

**Summary / verdict: medium fit.** Subprocess-only with a
**one-shot-per-turn** invocation model that breaks our
"runner-stays-alive" invariant. Known **broken signal handling**
(issues [#15873](https://github.com/google-gemini/gemini-cli/issues/15873),
[#3385](https://github.com/google-gemini/gemini-cli/issues/3385),
[#4956](https://github.com/google-gemini/gemini-cli/issues/4956)).

**Invocation** — `@google/gemini-cli` v0.36.0, Apache-2.0, 102k stars.
Headless auto-detected on non-TTY or when `-p` provided.

```bash
gemini -p "prompt" --output-format stream-json -m gemini-2.5-pro
echo "prompt" | gemini --output-format json --resume <session_id>
```

**Streaming events** — JSONL (`--output-format stream-json`). Event
types documented informally:

```jsonc
{ "type": "init", "session_id": "uuid", "model": "..." }
{ "type": "message", "role": "assistant", "content": "...", "chunk_index": 1 }
{ "type": "tool_use", "tool_name": "...", "input": {...}, "tool_call_id": "..." }
{ "type": "tool_result", "tool_call_id": "...", "output": "..." }
{ "type": "result", "final_response": "...", "stats": { "input_tokens": ..., "output_tokens": ..., "tool_calls": ... } }
```

Exact schema not fully documented; field names [uncertain].

**Session + resume** — Checkpoints in
`~/.gemini/tmp/<project_hash>/chats/`. Resume by ID or index:
`gemini --resume <UUID>`, `gemini --resume 5`, `gemini --resume`.

**Multi-turn — the core problem.** Gemini CLI does not support a
long-lived process accepting multiple user turns over stdin. Each
turn = one process: `gemini --resume <id> -p "turn"`. This is the
architectural mismatch with session-runner.

**Resolution**: wrap the respawn loop inside the existing long-lived
session-runner. The runner stays up on the dial-back WS; for each
`stream-input`, it spawns a fresh `gemini --resume` subprocess,
pipes its JSONL to the WS, and blocks on next `stream-input`.

**Tool-use + permissions** — Built-in: Google Search, file ops, shell,
fetch, MCP. **No per-tool permission gating in headless mode**
[uncertain]. MCP config via `~/.gemini/settings.json`.

**Abort** — **Broken.** SIGINT kills entire session instead of current
operation; orphaned processes documented (100% CPU for 47+ days).
Fix proposed but not shipped. Adapter must use
SIGTERM → 2s → SIGKILL.

**Auth** — `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_APPLICATION_CREDENTIALS`, ADC via `gcloud`, or OAuth
(interactive only).

**Context usage** — `result.stats` emits `input_tokens`,
`output_tokens`, `cached_tokens`. No native USD cost.

**Maturity** — Pre-1.0 (v0.36.0) but very active: nightly + weekly
releases, 5.8k commits, 2.4k open issues. Apache-2.0.

**Gaps vs Claude** — Subprocess-per-turn architecture, broken signals,
no `canUseTool`, no thinking, no hooks, no subagents.

**Adapter complexity: Heavy** (~600 LOC). Respawn loop + robust
signal fallback + per-project credential isolation needed.

Sources:
[GitHub](https://github.com/google-gemini/gemini-cli),
[Headless docs](https://geminicli.com/docs/cli/headless/),
[Session mgmt](https://geminicli.com/docs/cli/session-management/),
[npm](https://www.npmjs.com/package/@google/gemini-cli).

---

### 3. pi-mono (the "PI agent")

**Summary / verdict: good engineering fit, but conceptually
misaligned.** TypeScript monorepo by Mario Zechner (libGDX). In-process
SDK + CLI + JSONL RPC. 37.7k stars, MIT, v0.67.68 (Apr 2026).
**Critical**: pi-mono is itself a multi-provider abstraction wrapping
13+ LLM providers. We've adopted **strategy (C) hybrid** — pi-mono
becomes the "any-raw-LLM" adapter, not a peer agent.

**Invocation** — Three modes:
1. CLI: `pi`, `pi -c` (continue), `pi -r` (resume), `pi --session <path>`
2. In-process library: `createAgentSession()` / `.prompt()` / `.steer()` / `.followUp()`
3. JSONL RPC subprocess (stdin/stdout, **strict LF framing** — Node `readline` is non-compliant)

**Streaming events** — JSONL with `type` + optional correlation `id`:

```jsonc
{ "type": "agent_start", "id": "..." }
{ "type": "tool_execution_start", "id": "...", "tool": "read", "args": {...} }
{ "type": "tool_execution_update", "id": "...", "output": "..." }
{ "type": "tool_execution_end", "id": "...", "exitCode": 0 }
{ "type": "message_update", "id": "...", "delta": "..." }
{ "type": "message_end", "id": "...", "content": "..." }
{ "type": "agent_end", "id": "..." }
```

Protocol note: "Split records on `\n` only. Do not use generic line
readers that treat Unicode separators as newlines."

**Session + resume** — JSONL tree in `~/.pi/agent/sessions/` organised
by cwd. Supports branching (`/tree` jumps to any prior node),
continuation (`-c`), browse/pick (`-r`), ephemeral (`--no-session`).

**Multi-turn** — Full conversational. Enter = "steering" (interrupt
remaining tools), Alt+Enter = "follow-up" (queue after current work).

**Tool-use + permissions** — Four built-in tools: `read`, `write`,
`edit`, `bash`. **No built-in approval** — "full YOLO" by default.
Community extensions ([pi-permission-system](https://github.com/MasuRii/pi-permission-system),
[pi-permissions](https://github.com/bu5hm4nn/pi-permissions))
add approval layers but are not first-party.

**Provider model** — THE defining trait. Wraps: OpenAI (+ Azure),
Anthropic, Google (Gemini, Vertex AI), Mistral, Groq, Cerebras, xAI,
OpenRouter, GitHub Copilot, Amazon Bedrock, Ollama, vLLM, LM Studio.
Unified type-safe API: `getModel('provider', 'model-name')`.

**Under strategy (C)** this is exactly the niche we want it in:
"bring-your-own raw LLM, any provider, no agent features assumed."

**Abort** — Escape key (race bug [#2716](https://github.com/badlogic/pi-mono/issues/2716)
when Escape fires during long bash). `Agent.abort()` +
`session.abort()` (async, waits for idle).

**Auth** — BYO API keys per provider (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, etc.). No centralized creds.

**Maturity** — 37.7k stars, 4.4k forks, 197 releases, MIT,
3.6k+ commits, main branch active (last commit 2025-02-09 per
research — [uncertain], may be stale cite). Production-ready.

**Gaps vs Claude** — No built-in thinking support [uncertain],
no hooks system, no subagent API, no built-in approval, fewer
built-in tools (4 vs Claude's full set).

**Adapter complexity: Moderate** (~300 LOC) — use in-process SDK,
map JSONL events to GatewayEvent, bridge BYO credentials through
env, expose pi-mono's provider picker via adapter capabilities.

Sources:
[GitHub](https://github.com/badlogic/pi-mono),
[coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md),
[RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md),
[Mario Zechner's post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).

---

### 4. Nous Research hermes-agent

**Summary / verdict: medium fit — general-purpose, not a coding
agent.** Python 3.11+ autonomous agent framework with messaging-platform
gateways (Telegram/Discord/Slack/WhatsApp/Signal). 104k stars, MIT,
current. Scheduled as **P5 / low priority**; useful only if Nous
hosting or skill-learning becomes a requirement.

**Invocation** — Python, `uv`-managed. Interactive TUI via
`prompt_toolkit` + `Rich`, or messaging gateways. Single-shot:
`hermes chat -q "prompt"`. **No documented HTTP server or in-process
library mode.**

**Streaming events** — Token-by-token LLM output streams to TUI;
animated tool-execution feeds; no documented structured JSONL event
bus for subprocess piping. **[uncertain]** — adapter would require
instrumenting the `AIAgent` class in `run_agent.py` to emit
structured events.

**Session + resume** — Strong. SQLite FTS5 (`~/.hermes/state.db`) +
JSONL transcripts (`~/.hermes/sessions/`). `hermes --continue` / `-c`
resumes most recent. Context auto-compression at 85%.
Three-layer memory: in-context / MEMORY.md (env facts, 2.2k chars) /
USER.md (profile, 1.3k chars).

**Multi-turn** — Long-lived conversational process. Periodic "nudge"
prompt to trigger reflection without user input.

**Tool-use + permissions** — Binary approval (not per-tool granular).
Three modes: manual (default), smart (LLM-judges risk), off (trusted
env only). Toolsets (`web`, `terminal`, `file`, `browser`, `vision`,
`image_gen`, `moa`, `skills`, `delegation`) can be enabled/disabled
per platform. Dangerous-command approval is at the action level.

**Provider model** — Zero vendor lock-in. Supports Nous Portal,
OpenRouter, OpenAI, Anthropic, Gemini, Ollama, vLLM, llama.cpp,
LM Studio, HF Inference, Copilot, NVIDIA NIM, z.ai/GLM, Kimi/Moonshot,
MiniMax, Xiaomi MiMo. Wizard: `hermes model`.

**Overlap with pi-mono is significant** — both cover Ollama/vLLM/
local. Hermes's unique value: Nous Portal, skill-learning, messaging
gateways.

**Abort** — Ctrl+C interrupts (double-press = force exit). Typing new
message interrupts current work; terminal commands get SIGTERM then
SIGKILL after 1s.

**Auth** — `~/.hermes/.env` or env vars, per-provider
(`OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `HF_TOKEN`, …).
Multi-profile via `HERMES_PROFILE`.

**Maturity** — 104k stars, MIT, 2k+ open issues, 3.7k+ PRs.
Production-ready.

**Gaps vs Claude** — No thinking deltas, no explicit hooks, no
per-tool fine-grained permissions, **not a coding-specific agent**
(general framework), structured subprocess event stream
**[uncertain]**, Python bridge required.

**Adapter complexity: Heavy** (~800 LOC + Python bridge).
Likely ship as P5 wrapping via a small Python shim that
translates `AIAgent` loop events to our GatewayEvent shape.

Sources:
[GitHub](https://github.com/nousresearch/hermes-agent),
[Docs](https://hermes-agent.nousresearch.com/docs/),
[Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers/),
[DeepWiki context mgmt](https://deepwiki.com/NousResearch/hermes-agent/4.3-context-management-and-compression).

---

## Comparison

| Dimension | Claude SDK | Codex | Gemini CLI | pi-mono | Hermes |
|---|---|---|---|---|---|
| **Process model** | In-proc TS | In-proc TS (wraps CLI) | Subprocess, one-shot/turn | In-proc TS + SDK + JSONL RPC | Python, long-lived |
| **Streaming** | Typed iter | Typed iter | JSONL (schema loose) | JSONL (strict LF) | TUI-oriented, no structured bus |
| **Session+resume** | `sdk_session_id` + disk | `threadId` + disk | `--resume` + disk | JSONL tree (branching) | SQLite FTS5 + JSONL |
| **Multi-turn** | `AsyncGenerator` + `streamInput` | `thread.run()` sequential | Respawn per turn | Full conversational | Full conversational |
| **Tool-use gate** | `canUseTool` callback | None (full-auto) | None in headless | None (YOLO) | Binary dangerous-cmd |
| **Abort** | AbortController | **Missing** (#5494) | **Broken** (#15873, #3385) | Escape (race #2716) | Ctrl+C, clean |
| **Auth** | `ANTHROPIC_API_KEY` / OAuth | `OPENAI_API_KEY` / ChatGPT OAuth | `GEMINI_API_KEY` / ADC / OAuth | BYO per-provider | BYO per-provider |
| **Context/USD** | Tokens + USD | Tokens only | Tokens only | Per-provider | Per-provider |
| **Thinking deltas** | Yes | No | No | [uncertain] | No |
| **Hooks (18)** | Yes | No | No | No | No |
| **Subagents** | Yes | No | No | No | Delegation toolset |
| **Maturity** | Stable (v0.2.98) | v0.121.0, very active | v0.36.0 pre-1.0, active | v0.67.68, active | MIT, active |
| **License** | Anthropic terms | Apache-2.0 (likely) | Apache-2.0 | MIT | MIT |
| **Adapter LOC estimate** | — (baseline) | ~250 | ~600 | ~300 | ~800 + Python |

## Proposed RunnerAdapter interface

Sketch — not final API. Lives in `packages/shared-types/src/runner-adapter.ts`.
Existing `claude-runner.ts` becomes `ClaudeAdapter` implementing this
interface with no behaviour change.

```ts
import type { AbortController } from 'node:abort-controller'
import type { GatewayEvent, GatewayCommand, ExecuteCommand, ResumeCommand } from './index.js'

/** Per-adapter feature declaration — drives DO/UI capability gating */
export interface AdapterCapabilities {
  /** Adapter supports `rewind` command (file checkpointing). Claude-only. */
  supportsRewind: boolean
  /** Adapter emits `partial_assistant.thinking_delta` blocks. Claude-only. */
  supportsThinkingDeltas: boolean
  /** Adapter can intercept tool calls with per-call user approval. */
  supportsPermissionGate: boolean
  /** Adapter emits `task_started/progress/notification` (subagents). */
  supportsSubagents: boolean
  /** Adapter honours `set-permission-mode`. */
  supportsPermissionMode: boolean
  /** Adapter honours `set-model` mid-session. */
  supportsSetModel: boolean
  /** Adapter emits USD cost in `result`. If false, compute from tokens. */
  emitsUsdCost: boolean
  /** Adapter honours `interrupt` (mid-turn steering via streamInput). */
  supportsInterrupt: boolean
  /** Adapter can be cleanly aborted. If false, runner SIGKILLs. */
  supportsCleanAbort: boolean
  /** Providers / models this adapter can speak (for model-picker UI). */
  availableProviders: ReadonlyArray<{ provider: string, models: readonly string[] }>
}

export interface AdapterStartOptions {
  cmd: ExecuteCommand | ResumeCommand
  abortController: AbortController
  /** Runner-supplied emit: adapter calls this to forward events. */
  emit: (event: GatewayEvent) => void
  /** Runner-supplied request for user input (ask_user / permission_request).
   * Adapter awaits; runner forwards to DO and fulfils when answer arrives. */
  requestUserInput: (req: UserInputRequest) => Promise<UserInputResponse>
  /** cwd, env, sdk_session_id, etc. */
  context: AdapterContext
}

export interface RunnerAdapter {
  readonly name: 'claude' | 'codex' | 'gemini-cli' | 'pi-mono' | 'hermes'
  readonly capabilities: AdapterCapabilities

  /** Start or resume the agent. Runs until queue.done() or abort.
   * Responsible for emitting session.init (with sdk_session_id) before
   * first assistant output. */
  run(opts: AdapterStartOptions): Promise<AdapterRunResult>

  /** Inject a user turn mid-session. Runner calls this on stream-input
   * command. Should be idempotent wrt duplicate client_message_id. */
  streamInput(message: UserMessage): Promise<void>

  /** Mid-turn interrupt (keep session alive, stop current turn). */
  interrupt(): Promise<void>

  /** Return NotSupported for adapters without rewind. */
  rewind(args: { messageId: string, dryRun?: boolean }): Promise<RewindResult | NotSupported>

  /** Current context-window usage. Adapter synthesises if backend doesn't
   * emit explicitly; returns NotSupported only if truly unavailable. */
  getContextUsage(): Promise<ContextUsage | NotSupported>

  setModel(model?: string): Promise<void | NotSupported>
  setPermissionMode(mode: PermissionMode): Promise<void | NotSupported>

  /** Graceful shutdown. Runner already signalled abortController; this
   * lets the adapter flush and release resources. */
  dispose(): Promise<void>
}

export type NotSupported = { kind: 'not_supported', reason: string }

export interface AdapterRunResult {
  exitState: 'completed' | 'failed' | 'aborted'
  error?: string
}
```

**Runner responsibilities** (unchanged, adapter-agnostic):

- `packages/session-runner/src/main.ts` — process lifecycle, argv, pid/meta/exit files, SIGTERM, dial-back WS
- `packages/shared-transport/*` — BufferedChannel, DialBackClient, seq stamping
- `messageQueue` + `waitForNext()` — lives in runner, not adapter; runner calls `adapter.streamInput()` when DO sends `stream-input`

**Adapter responsibilities** (everything backend-specific):

- Backend invocation (`query()` / `thread.runStreamed()` / `spawn('gemini', ...)` / `createAgentSession()` / Python subprocess)
- Event normalization to `GatewayEvent`
- Session-ID persistence (emit in `session.init`)
- Tool-use gate translation (where supported) to `ask_user` / `permission_request`
- Capability declaration

## Per-adapter event mapping

### ClaudeAdapter (baseline, current behaviour)

| Claude SDK message | → | GatewayEvent |
|---|---|---|
| `system.init` | → | `session.init` (1:1) |
| `stream_event.content_block_delta.text_delta` | → | `partial_assistant` (text) |
| `stream_event.content_block_delta.thinking_delta` | → | `partial_assistant` (thinking) |
| `assistant` (partial=false) | → | `assistant` |
| `tool_use_summary` | → | `tool_result` |
| `canUseTool('AskUserQuestion')` callback | → | `ask_user` + awaited `answer` command |
| `canUseTool(other)` callback | → | `permission_request` + awaited `permission-response` |
| `hooks.PostToolUse` (Edit/Write) | → | `file_changed` |
| `system.session_state_changed` | → | `session_state_changed` |
| `system.task_started/progress/notification` | → | `task_*` |
| `rate_limit_event` | → | `rate_limit` |
| `result` | → | `result` (includes `total_cost_usd`) |

### CodexAdapter

| Codex event | → | GatewayEvent | Notes |
|---|---|---|---|
| (implicit start) | → | `session.init` | Synthesise from `thread.id` + workingDirectory |
| `item.started` (type=text) | → | `partial_assistant` (start block) | |
| `item.updated` (type=text) | → | `partial_assistant` (text delta) | |
| `item.completed` (type=text) | → | `assistant` | Finalise block |
| `item.started` (type=tool_use) | → | (internal) | Track for `tool_result` |
| `item.completed` (type=tool_use) | → | `tool_result` | |
| (none) | → | `ask_user` / `permission_request` | **Not emitted** — full-auto |
| (none) | → | `file_changed` | **Not emitted** — no PostToolUse hook. Could synthesise from `apply_patch` tool calls [uncertain]. |
| `turn.completed` | → | `result` | `total_cost_usd` computed from `usage.input_tokens`/`output_tokens` × rate card |
| (none) | → | `partial_assistant.thinking` | Not supported |

Capabilities: `supportsRewind=false`, `supportsThinkingDeltas=false`,
`supportsPermissionGate=false`, `supportsSubagents=false`,
`supportsCleanAbort=false` (SIGKILL fallback until #5494).

### GeminiCliAdapter

| Gemini CLI JSONL | → | GatewayEvent | Notes |
|---|---|---|---|
| `init` | → | `session.init` | Synthesise fields from adapter context |
| `message` (role=assistant, chunk) | → | `partial_assistant` (text delta) | |
| (implicit turn end) | → | `assistant` | Collect full message, emit on next turn/EOF |
| `tool_use` | → | (internal) | Track for `tool_result` |
| `tool_result` | → | `tool_result` | |
| `result` with `stats` | → | `result` | `total_cost_usd` synthesised from tokens |

Adapter wrapper loop (pseudocode):

```ts
while (!aborted) {
  const msg = await queue.waitForNext()
  if (!msg) break
  const child = Bun.spawn(['gemini', '--resume', sessionId, '--output-format', 'stream-json'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...env, GEMINI_API_KEY },
  })
  child.stdin.write(msg.content)
  for await (const line of readJsonlLines(child.stdout)) {
    emit(mapGeminiEventToGateway(line))
  }
  // SIGTERM → 2s → SIGKILL if child hasn't exited (Gemini signal bugs)
}
```

Capabilities: `supportsRewind=false`, `supportsThinkingDeltas=false`,
`supportsPermissionGate=false`, `supportsSubagents=false`,
`supportsCleanAbort=false`.

### PiMonoAdapter (strategy C — raw-LLM-any-provider)

| pi-mono JSONL | → | GatewayEvent | Notes |
|---|---|---|---|
| `agent_start` | → | `session.init` | |
| `message_start` (role=assistant) | → | (open partial block) | |
| `message_update` (delta) | → | `partial_assistant` (text delta) | |
| `message_end` | → | `assistant` | |
| `tool_execution_start` | → | (internal) | |
| `tool_execution_update` | → | (internal, progressive) | |
| `tool_execution_end` | → | `tool_result` | |
| `agent_end` | → | `result` | Compute `total_cost_usd` per provider rate card |

Capabilities: `supportsRewind=false`, `supportsThinkingDeltas`
depends on selected provider (e.g. Claude via pi-mono → possibly yes),
`supportsPermissionGate=false` (or optional via
`pi-permission-system` extension),
`availableProviders` = pi-mono's full roster.

**Positioning**: model-picker UI exposes pi-mono's full provider/model
matrix under the label "Raw LLM (any provider)". Claude Code + Codex +
Gemini CLI remain first-class entries with their agent-specific
features; pi-mono covers everything else.

### HermesAdapter (P5 — Python bridge)

Requires a Python shim that hosts `hermes-agent`'s `AIAgent` loop and
translates events to our JSONL protocol. The adapter in TS-land
subprocess-spawns this Python bridge.

| Hermes internal event (via shim) | → | GatewayEvent | Notes |
|---|---|---|---|
| session opened | → | `session.init` | |
| LLM token stream | → | `partial_assistant` (text delta) | |
| LLM message complete | → | `assistant` | |
| tool call started | → | (internal) / optional `permission_request` if dangerous-mode fires | |
| tool call completed | → | `tool_result` | |
| dangerous-command approval trigger | → | `permission_request` | Binary, maps cleanly |
| periodic nudge | → | (internal) | Don't forward as user-visible event |
| session compaction at 85% | → | `session_state_changed` | Or custom event |
| final | → | `result` | |

Capabilities: minimal. Primarily useful for (a) Nous-hosted inference
and (b) skill-learning mode. Defer until explicit demand.

## Recommendations

**Strategy**: (C) hybrid. Ship four first-class adapters plus pi-mono
as the catch-all raw-LLM adapter. Hermes as P5.

**Shipping order**:

1. **P1 — `RunnerAdapter` interface extraction**
   - Define interface in `packages/shared-types/src/runner-adapter.ts`
   - Refactor `packages/session-runner/src/claude-runner.ts` into `ClaudeAdapter` implementing the interface
   - No behaviour change; regression-test via existing session lifecycle tests
   - Publish capability declarations; wire capability bitmap through `session.init` event so UI can gate controls
2. **P2 — `CodexAdapter`**
   - `@openai/codex-sdk` in-process
   - Full-auto mode; tool-gate emits `permission_request` with `allowed=true` auto-response path OR declares `supportsPermissionGate=false`
   - Abort via subprocess-handle + SIGKILL until #5494 lands
   - Token→USD synthesis from OpenAI rate card
3. **P3 — `GeminiCliAdapter`**
   - Subprocess wrapper inside long-lived session-runner
   - Respawn `gemini --resume` per turn
   - Robust SIGTERM→SIGKILL + orphan reaper
   - Validates the CLI-wrapping pattern for future CLI backends
4. **P4 — `PiMonoAdapter`** (strategy C niche)
   - Use in-process `@mariozechner/pi-coding-agent` SDK
   - Expose pi-mono's full provider roster through
     `availableProviders` capability
   - Optional: pre-integrate
     [pi-permission-system](https://github.com/MasuRii/pi-permission-system)
     to give pi-mono permission parity
5. **P5 — `HermesAdapter`** (deferred, ship only if Nous
   inference / skill-learning / messaging-gateway use-cases
   become concrete)

**Removals**:

- Drop `OpenCodeAdapter` references in planning docs (user directive:
  "remove open code")
- Mark spec `planning/specs/0016-pluggable-agent-gateway.md` as
  `status: superseded` with pointer to the new spec that follows this
  research

**Known risks / hard truths**:

- `rewind` is Claude-only. DO must tolerate `not_supported` responses
  and the UI must hide the rewind arrow when the current session's
  adapter doesn't support it.
- `partial_assistant` thinking deltas are Claude-only. Non-Claude
  sessions show text-only streaming.
- `ask_user` / `permission_request` gates are Claude-only for the
  coding-agent backends (Codex/Gemini are full-auto). pi-mono via
  community permission extension is the best second-tier option.
- Abort is best-effort for Codex, Gemini CLI, and pi-mono (race
  conditions documented). Gateway reaper remains the final safety net.
- Gemini CLI's per-turn respawn is strictly slower than Claude's
  in-process stream; users will notice latency per follow-up.
- `total_cost_usd` is a Claude-SDK gift. Everyone else needs a rate-card
  service (probably a small `packages/pricing` module keyed on
  `provider × model`).

## Open questions

- **[uncertain]** Codex TS SDK's actual tool-hook surface — docs show
  Elixir SDK has `review_tool`, TS SDK doesn't explicitly document
  equivalent. Worth a 1-hour spike before P2.
- **[uncertain]** Gemini CLI's exact JSONL schema — most field names
  inferred from community docs, not the official reference. Worth
  paving a small reverse-engineering spike (run with
  `--output-format stream-json` against a known prompt) before P3.
- **[uncertain]** pi-mono maturity — research cites last-commit as
  2025-02-09, which conflicts with v0.67.68 Apr 2026. Verify repo
  activity is current before P4.
- **[uncertain]** Whether Hermes exposes any structured subprocess
  event stream today, or whether the Python bridge must instrument the
  agent loop from scratch.
- Model-picker UX: should the user see 3 agent options (Claude / Codex /
  Gemini) plus pi-mono's full provider × model matrix, or a flatter
  list where every pi-mono provider×model is a first-class picker
  entry? Affects `availableProviders` payload shape.
- Per-provider auth surface: does the DO hold user API keys, or does
  each worktree BYO via env? Current architecture suggests the latter
  (session-runner inherits env from gateway); explicit user-settings
  path for hosted providers is a follow-up.
- `emitsUsdCost=false` adapters — do we compute cost client-side or
  server-side? Server-side is more honest (rate cards change, single
  source of truth) but requires a pricing service.

## Next steps

1. Open a feature issue in `baseplane-ai/duraclaw` — *"feat(runner):
   pluggable adapter interface — Claude, Codex, Gemini CLI, pi-mono,
   Hermes"* — link this research doc.
2. Enter `planning` mode against the new issue; write the spec using
   `planning/spec-templates/` with phases P1–P5 as above. Include
   verification plan per adapter.
3. Mark `planning/specs/0016-pluggable-agent-gateway.md` as
   `status: superseded` pointing at the new spec.
4. Spike the three `[uncertain]` items above (Codex tool hooks,
   Gemini JSONL schema, pi-mono current activity) — 2–3 hours total.
5. Implementation follows per-phase, starting P1 (pure refactor,
   low risk).
