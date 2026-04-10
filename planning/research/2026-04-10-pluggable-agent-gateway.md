---
date: 2026-04-10
topic: pluggable agent gateway
status: complete
github_issue: null
---

# Research: Pluggable Agent Gateway — AI Coding Agent Interfaces

**Date:** 2026-04-10
**Goal:** Understand how major AI coding agents expose programmatic/remote interfaces, to design a pluggable gateway that can orchestrate any of them over WebSocket.
**Context:** Pre-spec research for refactoring cc-gateway from Claude-only to multi-agent. Roadmap Phase 5.4 defines `AgentExecutor` interface; Phase 10.3 targets multi-provider routing.

---

## 1. Claude Code (Agent SDK) — Current Gateway Target

**Package:** `@anthropic-ai/claude-agent-sdk` (TS), `claude-agent-sdk` (Python)
**Current version:** ~v0.2.98 (TS), ~v0.1.48 (Python)

### Invocation

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"], cwd: "/path/to/project" }
})) {
  // process message
}
```

- `query()` returns an `AsyncIterable` of typed messages
- Prompt can be a string or an `AsyncGenerator` yielding `{ type: "user", message, parent_tool_use_id }` objects (enables streaming follow-up messages into a running session)
- Options include: `model`, `systemPrompt`, `allowedTools`, `maxTurns`, `maxBudgetUsd`, `permissionMode`, `cwd`, `env`, `resume` (session ID), `hooks`, `agents`, `mcpServers`, `settingSources`

### I/O Model

- **In-process async iterator** — no subprocess spawning, no stdin/stdout pipe
- Messages are typed JS/Python objects, not serialized JSON
- cc-gateway bridges this to WebSocket by JSON-serializing each message

### Message Types (streaming events)

| Message type | Subtype | Payload |
|---|---|---|
| `system` | `init` | `session_id`, `model`, `tools[]` |
| `system` | `compact_boundary` | Fired after context compaction |
| `assistant` | (partial=true) | Incremental content blocks (text deltas, tool_use input deltas) |
| `assistant` | (partial=false) | Complete assistant turn with content blocks |
| `tool_use_summary` | — | Tool execution results |
| `result` | `success` / `error` / `interrupted` | `total_cost_usd`, `num_turns`, `result` text |

### Session Lifecycle

- **Start:** Call `query()` with a prompt
- **Resume:** Call `query()` with `options.resume = sessionId` — full context restored from `~/.claude/projects/` session storage
- **Abort:** Pass `abortController` in options, call `ac.abort()` at any time
- **Pause/Stop:** Abort + retain session ID for later resume
- **No native pause** — abort is the mechanism, resume picks up from last checkpoint

### Tool Call Interception

- **`canUseTool(toolName, input, { id })`** — async callback, returns `{ behavior: "allow"|"deny", updatedInput?, message? }`
- Used by cc-gateway to relay `AskUserQuestion` to orchestrator and await answers
- Used for permission prompts (file edits, shell commands)
- **Hooks:** `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest` (18 hook events total)

### User Questions/Confirmations

- Built-in `AskUserQuestion` tool — intercepted via `canUseTool`, questions relayed to caller, answers injected via `updatedInput`
- Permission prompts for other tools handled the same way

### Output Format

- Typed objects in-process (not serialized)
- cc-gateway serializes to JSON over WebSocket

### Gateway Fit: EXCELLENT
The SDK is designed as a library. cc-gateway wraps it cleanly — one WebSocket per session, JSON serialized events. This is the reference architecture for the pluggable gateway.

---

## 2. OpenAI Codex CLI

**Package:** `@openai/codex` (CLI), `@openai/codex-sdk` (TS SDK)
**Current version:** v0.116.0 (CLI, March 2026)

### Invocation — CLI (Non-Interactive)

```bash
# Single task, exit when done
codex exec "fix the bug in auth.py"

# Pipe stdin as context
git diff | codex exec "review these changes"

# Read prompt from stdin
echo "fix bugs" | codex exec -

# Resume previous session
codex exec resume --last "follow-up instruction"
codex exec resume <SESSION_ID>
```

**Key flags:**
- `--json` — JSONL event stream on stdout (machine-readable)
- `--full-auto` — skip approval prompts
- `--sandbox read-only|workspace-write|danger-full-access`
- `--ephemeral` — don't persist session files
- `--output-schema <path>` — enforce JSON Schema on final output
- `-o <path>` / `--output-last-message <path>` — write final response to file

### Invocation — TypeScript SDK

```typescript
import Codex from "@openai/codex-sdk";

const codex = new Codex({ env: { PATH: "/usr/local/bin" } });
const thread = codex.startThread({ workingDirectory: "/path/to/project" });

// Blocking
const turn = await thread.run("fix the bug");

// Streaming
for await (const event of thread.runStreamed("fix the bug")) {
  // event.type: thread.started, turn.started, item.started,
  //             item.updated, item.completed, turn.completed
}
```

**Architecture:** The SDK wraps the CLI — it spawns `codex` as a child process and communicates via JSONL over stdin/stdout.

### I/O Model

- **CLI:** stdin/stdout JSONL (when `--json` flag used)
- **SDK:** Child process spawning + JSONL pipe (not in-process like Claude SDK)
- stderr: progress/status messages
- stdout (with `--json`): structured JSONL events

### JSONL Event Types

| Event | Payload |
|---|---|
| `thread.started` | Thread metadata |
| `turn.started` | Turn begin |
| `item.started` | Individual action begin (tool call, text gen) |
| `item.updated` | Incremental progress |
| `item.completed` | Action finished with result |
| `turn.completed` | Turn done, includes `usage` stats |
| `turn.failed` | Error in turn |
| `error` | Fatal error |

### Session Lifecycle

- **Start:** `codex exec "prompt"` or `codex.startThread()`
- **Resume:** `codex exec resume <SESSION_ID>` or `codex.resumeThread(threadId)` — sessions persist in `~/.codex/sessions`
- **Continue:** Call `thread.run()` repeatedly on same thread
- **Abort:** Kill process (CLI) or destroy thread (SDK) — no explicit abort API documented

### Tool Calls

- Built-in tools: `read_file`, `local_shell`, `apply_patch`
- `registerTool()` — register custom tools on the Codex instance
- Tool names matching built-ins replace the native implementation
- Tool authorization via sandbox modes, not callback hooks
- No async interception callback like Claude's `canUseTool`

### User Questions/Confirmations

- `--full-auto` bypasses all prompts
- Default mode requires interactive approval (not suited for remote orchestration without `--full-auto`)
- No programmatic approval callback in SDK

### Output Format

- JSONL on stdout (with `--json`)
- `--output-schema` for structured final output validation
- SDK: typed TypeScript event objects

### Gateway Fit: GOOD (via subprocess)
Best approach: spawn `codex exec --json --full-auto` as subprocess, pipe JSONL stdout over WebSocket. Resume via `codex exec resume <id>`. The SDK alternative spawns the CLI internally anyway, so direct CLI spawning is simpler for a gateway.

---

## 3. Cursor Agent CLI

**Status:** Beta (as of April 2026)
**Auth:** `CURSOR_API_KEY` environment variable (tied to Cursor subscription)

### Invocation

```bash
# Install
curl https://cursor.com/install -fsSL | bash

# Interactive
cursor-agent chat "find one bug and fix it"

# Headless (CI/CD)
CURSOR_API_KEY=... cursor-agent -p "review these changes"

# With auto-approval
cursor-agent -p --force "fix all linting issues"
```

**Key flags:**
- `-p` / `--print` — headless mode, no TUI
- `--force` — auto-approve file changes and commands
- `--output-format json` — single JSON result object
- `--output-format stream-json` — NDJSON streaming events
- `--model <n>` — model selection

### I/O Model

- **Headless stdout:** NDJSON events (with `--output-format stream-json`)
- **Single result:** JSON object (with `--output-format json`)
- No SDK library — CLI-only interface
- Third-party SDK exists: `@nothumanwork/cursor-agents-sdk` (Node.js wrapper)

### NDJSON Event Types (stream-json)

| Event | Description |
|---|---|
| System init | Session metadata |
| Text deltas | Streaming assistant text |
| Tool calls | Tool invocations and results |
| Result | Final completion |

(Exact schema not fully documented in public docs yet — beta status)

### Session Lifecycle

- **Start:** `cursor-agent -p "prompt"`
- **Resume:** Not documented — likely single-shot per invocation
- **Abort:** Kill process

### Tool Calls

- Built-in: file read/write, shell commands, codebase search
- MCP server integration supported
- Approval via `--force` flag (all-or-nothing)
- No programmatic tool interception

### User Questions/Confirmations

- `--force` bypasses all confirmations
- No callback mechanism for selective approval

### Output Format

- `--output-format json` — single JSON result
- `--output-format stream-json` — NDJSON event stream

### Gateway Fit: MODERATE
Spawn `cursor-agent -p --force --output-format stream-json` as subprocess, stream NDJSON over WebSocket. Limitations: requires Cursor subscription, no session resume, no selective tool approval. The `--force` flag means all-or-nothing permissions.

---

## 4. Aider

**Package:** `aider-chat` (pip install)
**Language:** Python

### Invocation — CLI

```bash
# Single message, exit after
aider --message "fix the login bug" --yes auth.py

# From file
aider --message-file instructions.txt --yes src/*.py

# No streaming (better for scripts)
aider --message "add tests" --yes --no-stream

# Dry run
aider --message "refactor utils" --dry-run
```

**Key flags:**
- `--message` / `-m` — single instruction, process and exit
- `--message-file` / `-f` — read instruction from file
- `--yes` / `--yes-always` — auto-approve all confirmations
- `--no-stream` — disable streaming (buffered output)
- `--no-auto-commits` — don't auto-commit changes
- `--dry-run` — don't modify files
- `--no-pretty` — disable color/formatting

### Invocation — Python API (Unsupported)

```python
from aider.coders import Coder
from aider.models import Model
from aider.io import InputOutput

model = Model("claude-3.5-sonnet")
io = InputOutput(yes=True)  # auto-approve
coder = Coder.create(main_model=model, fnames=["auth.py"], io=io)
result = coder.run("fix the login bug")
```

**Caveat:** The Python API is explicitly **not officially supported** and may break between versions.

### I/O Model

- **CLI:** Plain text stdout (no structured JSON mode)
- **Python API:** In-process, returns text results
- No WebSocket, REST, or server mode
- No JSONL event stream

### Session Lifecycle

- **Start:** `aider --message "prompt"` — runs once and exits
- **No resume** — each `--message` invocation is a fresh session
- **No abort** — kill process
- Interactive mode supports `/undo`, `/clear`, but these are TUI-only

### Tool Calls

- Aider doesn't use a tool-call model — it uses edit-format protocols (whole file, diff, udiff, editor-diff) to communicate code changes
- The LLM produces diffs/edits in the chosen format, aider parses and applies them
- No tool interception or custom tools

### User Questions/Confirmations

- `--yes` auto-approves everything
- No selective approval mechanism
- No question relay protocol

### Output Format

- Plain text on stdout
- Applied edits shown as diffs in terminal
- No structured/machine-readable output mode

### Gateway Fit: LIMITED
Spawn `aider --message "..." --yes --no-stream --no-pretty` as subprocess, capture stdout. No structured events, no streaming protocol, no session resume. Would need stdout parsing for progress tracking. Functional but coarse — you get "done/failed" but not intermediate events.

---

## 5. Cline CLI

**Package:** `@anthropic/cline` (npm)
**Version:** CLI 2.0 (February 2026)
**Architecture:** Standalone Node.js process with gRPC API

### Invocation

```bash
# Interactive
cline "fix the bug in auth.py"

# Headless / autonomous
cline -y "fix the bug in auth.py"
cline --yolo "fix the bug in auth.py"

# Plan mode (no edits, just plan)
cline -p "refactor the auth module"

# JSON output
cline --json "fix the bug"

# Resume previous task
cline --continue
cline --taskId <id>

# Custom model
cline -m claude-sonnet-4-20250514 "fix the bug"
```

**Key flags:**
- `-y` / `--yolo` — auto-approve all actions, forces plain text output
- `--json` — JSONL streaming on stdout
- `-p` / `--plan` — plan mode (read-only analysis)
- `--continue` — resume most recent task
- `--taskId <id>` / `-T <id>` — resume specific task
- `-m` / `--model <id>` — model override
- `--thinking` — enable extended thinking
- `-c` / `--cwd <path>` — working directory
- `--config <path>` — custom config directory

### I/O Model

- **Headless (`-y`):** Everything streams to stdout, full stdin support for piping
- **JSON mode (`--json`):** JSONL events on stdout
- **gRPC API:** Cline Core exposes a gRPC service for programmatic control — supports multi-instance orchestration, custom UIs
- **Pipe mode:** Buffers messages, writes only final `completion_result`

### gRPC API

Cline CLI 2.0 is built on "Cline Core" — a standalone service exposing a gRPC API. This enables:
- Multiple parallel agent instances
- Custom frontends (the CLI itself is a client of Cline Core)
- Cross-editor support via ACP (Agent Client Protocol)
- Scriptable automation

(gRPC proto definitions not publicly documented in detail yet)

### Session Lifecycle

- **Start:** `cline "prompt"` or `cline --json "prompt"`
- **Resume:** `cline --continue` (latest) or `cline --taskId <id>`
- **History:** `cline history` lists past tasks with pagination
- **Abort:** Kill process or Ctrl+C

### Tool Calls

- Plan/Act mode separation — Plan mode analyzes, Act mode executes
- MCP server integration (`cline mcp add <name>`)
- Permission model via `CLINE_COMMAND_PERMISSIONS` env var (JSON: `allow`, `deny`, `allowRedirects`)
- No programmatic tool interception callback

### User Questions/Confirmations

- `--yolo` auto-approves everything
- No selective approval in headless mode

### Output Format

- `--json` — JSONL event stream (messages as JSON objects)
- `-y` mode — plain text to stdout
- Pipe mode — final result only

### Gateway Fit: GOOD
Two viable approaches:
1. **Subprocess:** Spawn `cline --json -y "prompt"`, stream JSONL over WebSocket
2. **gRPC client:** Connect to Cline Core's gRPC API for richer control (resume, parallel sessions, status queries)

The gRPC approach is architecturally superior but depends on proto definitions being stable/documented.

---

## 6. Goose (Block/Linux Foundation)

**Language:** Rust (core), CLI + Desktop + API
**Status:** Active development, donated to Linux Foundation's Agentic AI Foundation (Dec 2025)

### Invocation

```bash
# Interactive
goose session start

# Headless text mode
goose session start --text

# Background service
goose serve
```

- `--text` mode decoupled from TUI for clean headless output
- `goose serve` runs as background service with API

### I/O Model

- CLI: terminal TUI or `--text` for plain stdout
- `goose serve`: HTTP/API (details not fully documented publicly)
- 25+ LLM provider support (Anthropic, OpenAI, Google, Ollama, etc.)
- MCP integration for extensibility

### Session Lifecycle

- Start, resume via session management
- Recipes for scripted workflows

### Gateway Fit: MODERATE (NEEDS MORE RESEARCH)
The `goose serve` API mode is promising but under-documented. The Rust core + API architecture could support gateway integration, but the protocol isn't publicly specified yet.

---

## 7. Other Notable Agents

### Continue.dev
- **Interface:** IDE extension (VS Code, JetBrains) + CLI for CI checks
- **CLI focus:** PR review/linting checks, not general coding agent
- **Gateway fit:** NOT SUITABLE — focused on IDE integration and CI checks, not remote agent orchestration

### Sweep AI
- **Interface:** JetBrains IDE plugin, GitHub PR integration
- **No CLI or SDK** for programmatic agent orchestration
- **Gateway fit:** NOT SUITABLE

### Amazon Q Developer CLI
- **Interface:** CLI with agentic chat
- **Headless:** Feature requested but not available — requires interactive browser auth
- **Gateway fit:** NOT SUITABLE currently — no headless auth

---

## Comparison Matrix

| Feature | Claude SDK | Codex CLI/SDK | Cursor CLI | Aider | Cline CLI | Goose |
|---|---|---|---|---|---|---|
| **Invocation** | In-process library | Subprocess + JSONL | Subprocess | Subprocess | Subprocess or gRPC | Subprocess or API |
| **Structured output** | Typed objects | JSONL events | NDJSON events | Plain text only | JSONL events | Unknown |
| **Streaming** | AsyncIterable | JSONL on stdout | stream-json | Text stdout | JSONL on stdout | Unknown |
| **Session resume** | Yes (session ID) | Yes (session ID) | No | No | Yes (task ID) | Yes |
| **Tool interception** | canUseTool callback | registerTool | No | No | No | No |
| **Selective approval** | Per-tool callback | No (sandbox modes) | No (--force) | No (--yes) | No (--yolo) | Unknown |
| **User question relay** | AskUserQuestion tool | No | No | No | No | No |
| **Custom tools** | Via MCP + hooks | registerTool | Via MCP | No | Via MCP | Via MCP |
| **Abort** | AbortController | Kill process | Kill process | Kill process | Kill process | Kill process |
| **Gateway complexity** | Low (library) | Medium (subprocess) | Medium (subprocess) | High (text parsing) | Medium (subprocess/gRPC) | Unknown |

---

## Architecture Recommendations for Pluggable Gateway

### Adapter Pattern

Each agent needs an adapter that normalizes its interface to a common protocol:

```
WebSocket Client
    |
Gateway Router (picks adapter based on agent type)
    |
    +-- ClaudeAdapter    (in-process SDK, current cc-gateway)
    +-- CodexAdapter     (subprocess, JSONL pipe)
    +-- CursorAdapter    (subprocess, NDJSON pipe)
    +-- ClineAdapter     (subprocess JSONL or gRPC client)
    +-- AiderAdapter     (subprocess, text parsing)
```

### Common Gateway Protocol (what the orchestrator sees)

The existing cc-gateway protocol is already a good foundation. Normalize all agents to emit:

| Event | Description |
|---|---|
| `session.init` | Agent started, metadata (model, tools) |
| `partial_assistant` | Streaming text/tool deltas |
| `assistant` | Complete assistant turn |
| `tool_result` | Tool execution result |
| `ask_user` | Question needing user input |
| `permission_request` | Tool permission prompt |
| `file_changed` | File modification notification |
| `result` | Session complete (cost, duration, summary) |
| `error` | Fatal error |
| `stopped` | Graceful stop (resumable) |

### Key Design Decisions

1. **SDK-first adapters where available** — Claude, Codex, Gemini, and Pi all have TypeScript SDKs that run in-process. This is preferred over subprocess spawning — better type safety, event streaming, and lifecycle control. Reserve subprocess adapters for tools without SDKs.

2. **Full-auto by default** — all agents run with auto-approve permissions (`bypassPermissions`, `--full-auto`, `--yolo`, `--yes`). The permission interception in cc-gateway (`canUseTool`) is unnecessary overhead for the target use case. This eliminates the permission model gap as a concern.

3. **Subprocess adapters for CLI-only tools** — Cursor, Cline (if gRPC unavailable), Aider, OpenCode. Spawn with JSON flags, parse events, normalize.

4. **Cline gRPC is a stretch goal** — if/when proto definitions stabilize, a gRPC client adapter would give richer control than subprocess

5. **Aider is lowest priority** — no structured output means text parsing, no session resume, limited automation story

6. **Session resume** — Claude, Codex, Pi, and Cline support it. Cursor and Aider don't. The gateway should track session IDs per-adapter and handle resume where supported.

7. **Multi-model is a feature, not a constraint** — Pi, Hermes, OpenCode, and Gemini support 75-200+ models. The gateway should pass model selection through to adapters that support it, enabling model routing at the orchestrator level.

### Subprocess Manager Requirements

For subprocess-based adapters, the gateway needs:
- Process spawning with env/cwd control
- stdout line buffering + JSONL parsing
- stdin writing for follow-up prompts (Codex supports this)
- Process signal handling (SIGTERM for graceful stop, SIGKILL for abort)
- Exit code monitoring
- Memory/timeout limits

---

## Sources

- [Aider Scripting Docs](https://aider.chat/docs/scripting.html)
- [Aider Options Reference](https://aider.chat/docs/config/options.html)
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive)
- [Codex SDK Docs](https://developers.openai.com/codex/sdk)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference)
- [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Codex SDK Analysis (Morph)](https://www.morphllm.com/codex-sdk)
- [Cursor Headless CLI Docs](https://cursor.com/docs/cli/headless)
- [Cursor Agent CLI Blog](https://cursor.com/blog/cli)
- [Claude Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Cline CLI 2.0 Blog](https://cline.ghost.io/introducing-cline-cli-2-0/)
- [Cline CLI Commands (DeepWiki)](https://deepwiki.com/cline/cline/12.2-cli-commands-and-options)
- [Goose Docs](https://goose-docs.ai/)
- [Goose GitHub](https://github.com/block/goose)
- [Continue.dev](https://www.continue.dev/)
- [Amazon Q Developer CLI (GitHub)](https://github.com/aws/amazon-q-developer-cli)
- [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Gemini CLI SDK & Programmatic API (DeepWiki)](https://deepwiki.com/google-gemini/gemini-cli/5.9-sdk-and-programmatic-api)
- [Gemini CLI Headless Mode](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [Pi Coding Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [Pi Coding Agent (DeepWiki)](https://deepwiki.com/badlogic/pi-mono/4-pi-coding-agent:-coding-agent-cli)
- [OpenCode GitHub](https://github.com/opencode-ai/opencode)
- [OpenCode (InfoQ)](https://www.infoq.com/news/2026/02/opencode-coding-agent/)
- [Hermes Agent GitHub](https://github.com/nousresearch/hermes-agent)
- [Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/)
- [Oh My Pi GitHub](https://github.com/can1357/oh-my-pi)

---

## 8. Gemini CLI

**Package:** `@google/gemini-cli` (npm), `@google/gemini-cli-sdk` (programmatic SDK)
**Language:** TypeScript
**Stars:** 50k+ (open-sourced by Google)

### Invocation — CLI

```bash
# Interactive
gemini

# Headless (non-interactive)
gemini --prompt "fix the bug in auth.py"
gemini -p "fix the bug" --output-format json
echo "review this" | gemini

# Auto-approve
gemini -p "fix linting" --yolo
gemini -p "refactor" --approval-mode auto_edit
```

**Key flags:**
- `-p` / `--prompt` — headless mode
- `--output-format json` — structured JSON output with response + stats
- `--yolo` / `-y` — auto-approve all actions
- `--approval-mode auto_edit` — auto-approve edits only
- `-m` / `--model` — model selection (e.g. `gemini-2.5-flash`)

### Invocation — TypeScript SDK

```typescript
import { GeminiCliAgent, GeminiCliSession } from "@google/gemini-cli-sdk";

// Agent definition specifies model, tools, system instructions
const agent = new GeminiCliAgent(agentDefinition);
// Session manages conversation history and tool context
const session = new GeminiCliSession(config);
```

**SDK architecture:**
- `GeminiCliAgent` — primary autonomous loop entity
- `GeminiCliSession` — stateful conversation + tool registry
- `LocalAgentDefinition` — model, tools, system instructions config
- Zod-based typed I/O schemas
- `ToolRegistry` per agent instance (isolated for parallel execution)
- Tool confirmation via `MessageBus` (`TOOL_CONFIRMATION_REQUEST` events)
- Streaming callbacks for real-time monitoring
- Termination modes: `GOAL` (called `complete_task`), `MAX_TURNS` (default 30), `TIMEOUT` (default 10m)

### Remote Access

`@google/gemini-cli-a2a-server` exposes Agent-to-Agent (A2A) protocol over HTTP for remote/browser-based access. Implements `@a2a-js/sdk`.

### Session Lifecycle

- **Start:** `gemini -p "prompt"` or SDK agent creation
- **Resume:** Not documented in headless mode
- **Abort:** Kill process or timeout

### Gateway Fit: GOOD (via SDK or subprocess)
Two approaches:
1. **SDK:** Use `@google/gemini-cli-sdk` directly — in-process like Claude SDK, with typed events and tool confirmation callbacks
2. **Subprocess:** Spawn `gemini -p --output-format json --yolo`, parse JSON output
3. **A2A server:** Remote HTTP-based execution via A2A protocol

SDK approach is strongest — parallel agent instances, tool registry isolation, streaming callbacks.

---

## 9. Pi (pi-coding-agent)

**Package:** `@mariozechner/pi-coding-agent` (npm)
**Language:** TypeScript
**Architecture:** Modular stack: `pi-ai` (LLM) → `pi-agent-core` (tool loop) → `pi-coding-agent` (coding agent) → `pi-tui` (terminal UI)

### Four Operating Modes

1. **Interactive** — full TUI with message history
2. **Print** — single-shot CLI output (`-p` flag)
3. **RPC** — JSON-RPC protocol over stdio (ideal for gateway integration)
4. **SDK** — programmatic TypeScript embedding

### Invocation — SDK

```typescript
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry }
  from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: AuthStorage.create(),
  modelRegistry: ModelRegistry.create(authStorage),
});

await session.prompt("What files are in the current directory?");
```

### Invocation — RPC Mode

JSON-RPC over stdio — structured bidirectional protocol. Enables remote process control without text parsing.

### Session Management

- JSONL session files with tree structure (branching via `id`/`parentId`)
- `/fork` creates branches from existing sessions
- Steering messages (queued during agent work) and follow-up messages
- Multi-session runtime via `createAgentSessionRuntime()`

### Tool System

- Core tools: `read`, `write`, `edit`, `bash`
- Extensions API for custom tools (can replace built-ins)
- 75+ model support (Anthropic, OpenAI, Google, Ollama, etc.)

### Gateway Fit: EXCELLENT (via SDK or RPC)
Pi's architecture is ideal for gateway integration:
1. **SDK:** In-process like Claude — `createAgentSession()` + `session.prompt()`
2. **RPC mode:** JSON-RPC over stdio — structured protocol, no text parsing
3. Multi-session runtime built-in
4. Tree-structured session branching

---

## 10. OpenCode (→ Crush)

**Language:** Go
**Status:** Archived, continued as "Crush"

### Invocation

```bash
opencode -p "fix the bug" -f json
opencode -p "refactor" -f text -q
```

**Key flags:**
- `-p` / `--prompt` — non-interactive single prompt
- `-f` / `--output-format` — `text` or `json`
- `-q` / `--quiet` — suppress spinner
- `-c` / `--cwd` — working directory

### I/O Model

- JSON output via `-f json`
- SQLite session persistence
- Context compaction when approaching model limits
- Multi-provider: OpenAI, Anthropic, Gemini, Bedrock, Groq, etc.

### Gateway Fit: MODERATE (subprocess only)
Go binary — no SDK embedding. Spawn with `-p -f json`, parse JSON output. Session persistence via SQLite.

---

## 11. Hermes Agent

**Package:** `hermes-agent` (Nous Research)
**Language:** TypeScript
**Stars:** 33k+ (Feb 2026)

### Key Features

- Self-improving skills system (auto-creates reusable skill docs from completed tasks)
- 47 built-in tools
- Persistent cross-session memory
- Multi-platform: CLI, Telegram, Discord, Slack, WhatsApp, 15+ platforms
- Subagent spawning for parallel workstreams
- 200+ model support via OpenRouter
- Deployment: Docker, SSH, VPS, serverless

### I/O Model

- CLI TUI for interactive use
- `execute_code` for programmatic tool calling
- Subagent architecture for parallel execution

### Gateway Fit: MODERATE (NEEDS MORE RESEARCH)
The multi-platform gateway architecture is interesting — Hermes already acts as a gateway between platforms. The subagent spawning and skill system could map to the adapter pattern, but the CLI doesn't appear to have a documented headless/JSON mode yet.

---

## Updated Comparison Matrix

| Feature | Claude SDK | Codex SDK | Gemini SDK | Pi SDK | Cursor CLI | Cline CLI | Aider | OpenCode | Hermes |
|---|---|---|---|---|---|---|---|---|---|
| **Interface** | In-process lib | In-process (wraps CLI) | In-process lib | In-process lib / RPC | Subprocess | Subprocess / gRPC | Subprocess | Subprocess | Multi-platform |
| **Structured events** | Typed objects | Typed events | Typed + zod | SDK objects / JSON-RPC | NDJSON | JSONL | Plain text | JSON | Unknown |
| **Streaming** | AsyncIterable | AsyncGenerator | Streaming callbacks | SDK / RPC | stream-json | JSONL stdout | Text | No | Unknown |
| **Session resume** | Yes | Yes | No (headless) | Yes (tree branching) | No | Yes (task ID) | No | Yes (SQLite) | Yes (memory) |
| **In-process SDK** | Yes | Yes | Yes | Yes | No | No (gRPC stretch) | No (unsupported) | No (Go) | TBD |
| **Tool interception** | canUseTool callback | registerTool | MessageBus events | Extensions API | No | No | No | No | TBD |
| **Auto-approve flag** | bypassPermissions | --full-auto | --yolo | Config | --force | --yolo | --yes | N/A | N/A |
| **Models** | Claude only | OpenAI only | Gemini (+ others?) | 75+ providers | Cursor models | Multi-provider | Multi-provider | Multi-provider | 200+ via OpenRouter |
| **Gateway complexity** | Low | Low-Medium | Low-Medium | Low | Medium | Medium | High | Medium | Unknown |

---

## 12. Current cc-gateway Coupling Analysis

### Claude SDK Coupling Points

All SDK coupling lives in `packages/cc-gateway/src/sessions.ts`:

| Line(s) | Coupling | Severity |
|---|---|---|
| 111 | `import { query } from '@anthropic-ai/claude-agent-sdk'` | **Critical** — core execution |
| 113-119 | Options shape: `permissionMode`, `includePartialMessages`, `settingSources` | **High** — Claude-specific options |
| 122-131 | `model`, `systemPrompt`, `allowedTools`, `maxTurns`, `maxBudgetUsd`, `resume` | **Medium** — most agents have analogues |
| 134-225 | `canUseTool` callback (AskUserQuestion interception + permission prompts) | **Critical** — Claude-only API |
| 228-245 | `postToolUse` hook (Edit/Write file change tracking) | **High** — Claude tool name dependent |
| 248-257 | `messageGenerator()` async generator for streaming input | **High** — SDK-specific prompt format |
| 260-263 | `query({ prompt, options })` call | **Critical** — SDK entry point |
| 266-350 | Message iteration loop with Claude-specific types (`system/init`, `assistant/partial`, `tool_use_summary`, `result`) | **Critical** — 100% Claude message format |
| 329-330 | `getSessionInfo()` for SDK session summary | **Low** — optional enrichment |

### What's Already Agent-Agnostic

The **protocol layer** (shared-types) is actually fairly generic:

- `GatewayCommand` types (`execute`, `resume`, `abort`, `answer`, `permission-response`) — these map well to any agent
- `GatewayEvent` types (`session.init`, `assistant`, `tool_result`, `result`, `error`) — generic event model
- `SessionContext` — generic (sessionId, abortController, messageQueue)
- WebSocket transport + JSON serialization — agent-independent

### What Needs to Change

1. **Extract `AgentAdapter` interface** — match roadmap Phase 5.4's `AgentExecutor`:
   ```typescript
   interface AgentAdapter {
     execute(config: SessionConfig): AsyncIterable<GatewayEvent>
     resume(sessionId: string, prompt: string): AsyncIterable<GatewayEvent>
     abort(sessionId: string): void
     answer(sessionId: string, toolCallId: string, answers: Record<string, string>): void
     approvePermission(sessionId: string, toolCallId: string, allowed: boolean): void
     getCapabilities(): AdapterCapabilities
   }
   ```

2. **Move `executeSession` logic into `ClaudeAdapter`** — wraps current sessions.ts code

3. **Add `SubprocessAdapter` base class** — for Codex, Cursor, Cline:
   - Process spawning with env/cwd
   - JSONL stdout parsing + event normalization
   - stdin for follow-up prompts
   - Process signal handling (SIGTERM/SIGKILL)
   - Exit code → result event mapping

4. **Adapter registry in server.ts** — `ExecuteCommand` gets an `agent?: string` field, router picks adapter

5. **Capability-gated features** — orchestrator checks `getCapabilities()` to know what UI to show:
   - `canApproveTools: boolean` — only Claude has per-tool approval
   - `canResume: boolean` — Claude, Codex, Cline yes; Cursor, Aider no
   - `canStreamInput: boolean` — Claude yes; subprocess agents maybe
   - `canRewind: boolean` — Claude only (for now)

### Existing Roadmap Alignment

| Roadmap Item | Status | This Research |
|---|---|---|
| Phase 5.4: `AgentExecutor` interface | Defined in roadmap | Validated — the interface is correct, needs `getCapabilities()` |
| Phase 10.3: Multi-provider routing | Future | Research confirms feasibility for Codex, Cline, Cursor |
| Issue #13: SDK feature expansion | Approved | Should complete BEFORE pluggable refactor — hooks API migration reduces coupling |
| Tray app (Issue #15) | Approved | Sidecar architecture already supports multiple services |

---

## 9. Recommended Implementation Sequence

**Design principle:** Full-auto by default. No permission interception, no approval callbacks. All agents run autonomously.

1. **Ship Issue #13 first** — SDK feature expansion migrates to hooks API, stores Query object, adds command queue. This reduces the coupling surface and makes extraction cleaner.

2. **Define `AgentAdapter` interface** in shared-types (or a new `packages/agent-adapters/` package). Keep it minimal — `execute`, `resume`, `abort`, `getCapabilities`. No permission/answer methods (full-auto).

3. **Extract `ClaudeAdapter`** — move `executeSession` into a class implementing `AgentAdapter`. Strip `canUseTool` / permission interception. Use `bypassPermissions` mode. The server.ts WebSocket handler becomes adapter-agnostic.

4. **SDK-based adapters (parallel, highest value):**
   - **`CodexAdapter`** — `@openai/codex-sdk`, `startThread()` + `runStreamed()`, event normalization
   - **`GeminiAdapter`** — `@google/gemini-cli-sdk`, `GeminiCliAgent` + streaming callbacks
   - **`PiAdapter`** — `@mariozechner/pi-coding-agent`, `createAgentSession()` + `session.prompt()`, or RPC mode

5. **Build `SubprocessAdapter` base** — shared infra for CLI-only tools. JSONL/NDJSON parsing, process lifecycle, stdin injection.

6. **Subprocess adapters:**
   - **`ClineAdapter`** — `cline --json -y`, JSONL parsing (gRPC stretch goal)
   - **`CursorAdapter`** — `cursor-agent -p --force --output-format stream-json`, NDJSON parsing
   - **`AiderAdapter`** — `aider -m "..." --yes --no-stream`, text capture (lowest priority)

7. **Stretch goals:**
   - **`HermesAdapter`** — when headless JSON mode is documented
   - **`OpenCodeAdapter`** — if Crush (successor) adds a TS SDK

---

## 10. Open Questions

- **Adapter package location:** New `packages/agent-adapters/` or keep in cc-gateway? If adapters stay in cc-gateway, rename to `packages/agent-gateway/`.
- **Subprocess resource limits:** How to enforce memory/CPU/timeout per subprocess agent? Bun's `Bun.spawn` vs Node's `child_process`?
- **Cost tracking:** Claude SDK reports `total_cost_usd`. Codex has `usage` stats. Others don't report cost. Normalize or leave optional?
- **Rename cc-gateway?** If it becomes multi-agent, `agent-gateway` or `duraclaw-gateway` is more accurate.
- **Multi-model routing:** Pi/Hermes/OpenCode support 75-200+ models. Should the gateway expose model selection to the orchestrator, or leave it to per-adapter config?
- **A2A protocol:** Gemini's A2A server implements Agent-to-Agent protocol. Worth adopting as a standard, or too early?
