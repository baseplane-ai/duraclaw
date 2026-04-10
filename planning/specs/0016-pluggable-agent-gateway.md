---
initiative: refactor-pluggable-agent-gateway
type: project
issue_type: feature
status: approved
priority: high
github_issue: 16
created: 2026-04-10
updated: 2026-04-10
phases:
  - id: p1
    name: "Adapter interface + ClaudeAdapter extraction"
    tasks:
      - "Define AgentAdapter interface in shared-types"
      - "Add agent field to ExecuteCommand"
      - "Extract ClaudeAdapter from sessions.ts"
      - "Add adapter registry to server.ts"
      - "Rename cc-gateway to agent-gateway"
    test_cases:
      - id: "claude-adapter-execute"
        description: "ClaudeAdapter executes a prompt and streams GatewayEvents"
        type: "integration"
      - id: "claude-adapter-resume"
        description: "ClaudeAdapter resumes a session by SDK session ID"
        type: "integration"
      - id: "claude-adapter-abort"
        description: "ClaudeAdapter aborts a running session"
        type: "integration"
  - id: p2
    name: "CodexAdapter — in-process SDK"
    tasks:
      - "Add @openai/codex-sdk dependency"
      - "Implement CodexAdapter with startThread/runStreamed"
      - "Normalize Codex events to GatewayEvents"
      - "Wire into adapter registry"
      - "Integration test"
    test_cases:
      - id: "codex-adapter-execute"
        description: "CodexAdapter executes a prompt via Codex SDK and streams events"
        type: "integration"
      - id: "codex-adapter-resume"
        description: "CodexAdapter resumes a thread by ID"
        type: "integration"
      - id: "codex-adapter-abort"
        description: "CodexAdapter aborts a running session via AbortController"
        type: "integration"
  - id: p3
    name: "OpenCodeAdapter — HTTP SDK + sidecar"
    tasks:
      - "Add @opencode-ai/sdk dependency"
      - "Implement OpenCodeAdapter connecting to opencode serve"
      - "Bridge SSE events to GatewayEvents"
      - "Add sidecar health check to server startup"
      - "Wire into adapter registry"
      - "Integration test"
    test_cases:
      - id: "opencode-adapter-execute"
        description: "OpenCodeAdapter creates session and streams events from opencode serve"
        type: "integration"
      - id: "opencode-adapter-abort"
        description: "OpenCodeAdapter aborts a running session"
        type: "integration"
---

# Pluggable Agent Gateway

> GitHub Issue: [#16](https://github.com/codevibesmatter/duraclaw/issues/16)

## Overview

The cc-gateway package is tightly coupled to the Claude Agent SDK -- every line of `sessions.ts` assumes Claude-specific types, hooks, and invocation patterns. To support multiple AI coding agents (Codex, OpenCode, and future providers), the gateway needs a pluggable adapter pattern that normalizes each agent's SDK into the existing GatewayEvent protocol. This refactor extracts an `AgentAdapter` interface, wraps the current Claude logic in a `ClaudeAdapter`, adds `CodexAdapter` (in-process SDK) and `OpenCodeAdapter` (HTTP SDK client), and renames the package from `cc-gateway` to `agent-gateway`.

## Feature Behaviors

### B1: AgentAdapter Interface and Registry

**Core:**
- **ID:** adapter-interface
- **Trigger:** Gateway receives any `ExecuteCommand` over WebSocket
- **Expected:** The `AgentAdapter` interface is defined with `execute()`, `resume()`, `abort()`, and `getCapabilities()` methods. A registry in `server.ts` maps agent name strings to adapter instances. The `ExecuteCommand` type gains an `agent?: string` field (default: `"claude"`).
- **Verify:** `pnpm typecheck` passes across the monorepo. Sending an `ExecuteCommand` without an `agent` field routes to ClaudeAdapter. Sending `agent: "unknown"` returns an error event.
- **Source:** `packages/shared-types/src/index.ts` (ExecuteCommand), `packages/agent-gateway/src/server.ts` (registry)

#### UI Layer

N/A -- backend only. Orchestrator UI changes are out of scope.

#### API Layer

`ExecuteCommand` gains an optional `agent` field:

```typescript
interface ExecuteCommand {
  type: 'execute'
  project: string
  prompt: string | ContentBlock[]
  agent?: string // "claude" | "codex" | "opencode", default "claude"
  model?: string
  system_prompt?: string
  allowed_tools?: string[]
  max_turns?: number
  max_budget_usd?: number
  org_id?: string
  user_id?: string
}

interface ResumeCommand {
  type: 'resume'
  project: string
  prompt: string | ContentBlock[]
  sdk_session_id: string
  agent?: string // must match the agent that created the session
}
```

The adapter interface:

```typescript
interface AgentAdapter {
  readonly name: string
  execute(ws: ServerWebSocket<WsData>, cmd: ExecuteCommand, ctx: SessionContext): Promise<void>
  resume(ws: ServerWebSocket<WsData>, cmd: ResumeCommand, ctx: SessionContext): Promise<void>
  abort(ctx: SessionContext): void
  getCapabilities(): AdapterCapabilities
}

interface AdapterCapabilities {
  canResume: boolean
  canStreamInput: boolean
  canApproveTools: boolean
  canRewind: boolean
}
```

#### Data Layer

N/A -- no schema changes. Adapter selection is per-session, not persisted.

---

### B2: ClaudeAdapter Extraction

**Core:**
- **ID:** claude-adapter-extract
- **Trigger:** `ExecuteCommand` with `agent: "claude"` (or no `agent` field) arrives over WebSocket
- **Expected:** The current `executeSession()` logic from `sessions.ts` is moved into `ClaudeAdapter.execute()` in `packages/agent-gateway/src/adapters/claude.ts`. The adapter runs in full-auto mode with `permissionMode: 'bypassPermissions'`, removing the `canUseTool` permission interception. `AskUserQuestion` interception is retained (relays questions to orchestrator). The `postToolUse` hook for `file_changed` events is retained. All existing GatewayEvent streaming behavior is preserved.
- **Verify:** Start the gateway, connect via WebSocket, send an `ExecuteCommand` with `agent: "claude"`. Receive `session.init`, `partial_assistant`, `assistant`, `tool_result`, and `result` events in the same format as before the refactor.
- **Source:** `packages/cc-gateway/src/sessions.ts:82-362` (current implementation)

#### UI Layer

N/A -- identical event stream to current behavior.

#### API Layer

ClaudeAdapter capabilities:

```typescript
{
  canResume: true,
  canStreamInput: true,
  canApproveTools: false, // full-auto, no permission callbacks
  canRewind: false        // not yet (pending Issue #13 P2)
}
```

#### Data Layer

N/A

---

### B3: CodexAdapter -- In-Process SDK

**Core:**
- **ID:** codex-adapter
- **Trigger:** `ExecuteCommand` with `agent: "codex"` arrives over WebSocket
- **Expected:** `CodexAdapter` instantiates `@openai/codex-sdk`, calls `codex.startThread({ workingDirectory })` then `thread.runStreamed(prompt)`. The SDK spawns the Codex CLI as a child process internally. Events from `runStreamed()` (`thread.started`, `turn.started`, `item.started`, `item.updated`, `item.completed`, `turn.completed`) are normalized into GatewayEvents (`session.init`, `partial_assistant`, `assistant`, `tool_result`, `result`). The Codex instance is created with `fullAutoMode: true` to bypass approval prompts.
- **Verify:** Start the gateway, send `ExecuteCommand` with `agent: "codex"` and a simple prompt. Receive `session.init` followed by streaming events and a `result` event. Verify `OPENAI_API_KEY` is required in environment.
- **Source:** `packages/agent-gateway/src/adapters/codex.ts` (new file)

#### UI Layer

N/A

#### API Layer

CodexAdapter capabilities:

```typescript
{
  canResume: true,   // thread.run() on existing thread
  canStreamInput: false,
  canApproveTools: false,
  canRewind: false
}
```

Event mapping from Codex SDK to GatewayEvents:

| Codex Event | GatewayEvent |
|---|---|
| `thread.started` | `session.init` (session_id, model, tools) |
| `item.started` (type=text) | `partial_assistant` (text block start) |
| `item.updated` (type=text) | `partial_assistant` (text delta) |
| `item.completed` (type=text) | `assistant` (complete content) |
| `item.started` (type=tool_use) | `partial_assistant` (tool_use block start) |
| `item.completed` (type=tool_use) | `tool_result` (tool output) |
| `turn.completed` | `result` (duration_ms, usage stats) |
| `turn.failed` / `error` | `error` |

#### Data Layer

N/A

---

### B4: OpenCodeAdapter -- HTTP SDK + Sidecar

**Core:**
- **ID:** opencode-adapter
- **Trigger:** `ExecuteCommand` with `agent: "opencode"` arrives over WebSocket
- **Expected:** `OpenCodeAdapter` uses `@opencode-ai/sdk` to connect to a persistent `opencode serve` sidecar process. On execute: calls `client.session.create()` then `client.session.prompt()` with the prompt. Subscribes to `client.event.subscribe()` for SSE event streaming. SSE events are normalized into GatewayEvents streamed over the WebSocket. On abort: calls `client.session.abort()`. The sidecar must be running before the gateway starts; the adapter checks sidecar health on registration and emits a warning log if unreachable.
- **Verify:** Start `opencode serve --port 4096`, start the gateway, send `ExecuteCommand` with `agent: "opencode"`. Receive `session.init` and streaming events. Send `AbortCommand` and verify the session stops.
- **Source:** `packages/agent-gateway/src/adapters/opencode.ts` (new file)

#### UI Layer

N/A

#### API Layer

OpenCodeAdapter capabilities:

```typescript
{
  canResume: true,   // session.prompt() on existing session
  canStreamInput: false,
  canApproveTools: false,
  canRewind: false
}
```

Configuration via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_URL` | `http://localhost:4096` | OpenCode sidecar base URL |
| `OPENCODE_SERVER_PASSWORD` | (none) | HTTP basic auth for sidecar |

#### Data Layer

N/A

---

### B5: Adapter Routing in Server

**Core:**
- **ID:** adapter-routing
- **Trigger:** Any `execute` or `resume` command arrives on the WebSocket
- **Expected:** `server.ts` reads `cmd.agent` (defaulting to `"claude"`), looks up the adapter in the registry, and calls `adapter.execute()` or `adapter.resume()`. If the agent name is not registered, the server sends an `ErrorEvent` with message `Unknown agent: "<name>". Available: claude, codex, opencode`. The `abort` and `stop` commands remain adapter-agnostic (they use `AbortController` on the `SessionContext`). The `stream-input` and `answer` commands are only forwarded if the adapter's capabilities indicate support.
- **Verify:** Send `ExecuteCommand` with `agent: "codex"` -- routes to CodexAdapter. Send with `agent: "bogus"` -- receive error listing available agents.
- **Source:** `packages/agent-gateway/src/server.ts:203-239` (current execute/resume switch case)

#### UI Layer

N/A

#### API Layer

The `/health` endpoint includes available adapters:

```json
{
  "status": "ok",
  "version": "0.2.0",
  "uptime_ms": 12345,
  "adapters": ["claude", "codex", "opencode"]
}
```

#### Data Layer

N/A

---

### B6: Package Rename

**Core:**
- **ID:** package-rename
- **Trigger:** Implementation of Phase 1 (done alongside adapter extraction)
- **Expected:** `packages/cc-gateway/` is renamed to `packages/agent-gateway/`. The `package.json` name changes from `@duraclaw/cc-gateway` to `@duraclaw/agent-gateway`. All internal imports, pnpm workspace references, systemd service file, turbo config, and `CLAUDE.md` references are updated. The systemd service name changes from `duraclaw-cc-gateway` to `duraclaw-agent-gateway`.
- **Verify:** `pnpm install` succeeds. `pnpm build` succeeds. `pnpm typecheck` succeeds. `bun run packages/agent-gateway/src/server.ts` starts the server. The old `packages/cc-gateway/` directory no longer exists.
- **Source:** `packages/cc-gateway/package.json`, `pnpm-workspace.yaml`, `turbo.json`

#### UI Layer

N/A

#### API Layer

N/A -- the HTTP/WebSocket protocol is unchanged. Console log prefix changes from `[cc-gateway]` to `[agent-gateway]`.

#### Data Layer

N/A

---

## Non-Goals

Explicitly out of scope for this feature:

- Cursor, Cline, Aider, Gemini, Pi, or Hermes adapters (future work)
- Subprocess-based adapter base class (not needed -- all three adapters are SDK-based)
- Orchestrator UI changes (agent selection dropdown, capability-aware UI)
- Permission interception or approval UI (all agents run full-auto)
- Issue #13 SDK feature expansion (dependency -- ships first, not part of this spec)
- Multi-agent collaboration (running multiple agents on the same session)
- A2A protocol support
- Cost normalization across agents (each adapter reports what its SDK provides)

## Implementation Phases

See YAML frontmatter `phases:` above. Each phase should be 1-4 hours of focused work.

**Phase 1 (P1): Adapter interface + ClaudeAdapter extraction** -- Define the `AgentAdapter` interface and `AdapterCapabilities` type in shared-types. Add the `agent` field to `ExecuteCommand`. Rename `packages/cc-gateway` to `packages/agent-gateway`. Extract `executeSession()` from `sessions.ts` into `ClaudeAdapter` class in `src/adapters/claude.ts`. Simplify to full-auto mode (`permissionMode: 'bypassPermissions'`). Build adapter registry in `server.ts` and route `execute`/`resume` commands through it. Update health endpoint to list adapters.

**Phase 2 (P2): CodexAdapter -- in-process SDK** -- Install `@openai/codex-sdk`. Implement `CodexAdapter` in `src/adapters/codex.ts` wrapping `startThread()` and `runStreamed()`. Map Codex streaming events to GatewayEvents. Register in the adapter registry. Integration test against a real Codex CLI installation.

**Phase 3 (P3): OpenCodeAdapter -- HTTP SDK + sidecar** -- Install `@opencode-ai/sdk`. Implement `OpenCodeAdapter` in `src/adapters/opencode.ts` using `createOpencodeClient()`. Bridge SSE event stream from `client.event.subscribe()` to GatewayEvents over WebSocket. Add sidecar health check on adapter registration. Integration test against a running `opencode serve` instance.

## Verification Strategy

### Test Infrastructure

Integration tests use `vitest` (config exists at `packages/agent-gateway/vitest.config.ts`). Tests run against real agent SDKs/CLIs -- no mocking. Each adapter test requires its respective agent to be installed and API keys configured:
- ClaudeAdapter: `@anthropic-ai/claude-agent-sdk` + `ANTHROPIC_API_KEY`
- CodexAdapter: `@openai/codex-sdk` + `codex` CLI + `OPENAI_API_KEY`
- OpenCodeAdapter: `@opencode-ai/sdk` + running `opencode serve` sidecar

Tests are tagged with the adapter name so they can be run selectively.

### Build Verification

```bash
pnpm typecheck          # Monorepo-wide type checking (catches shared-types changes)
pnpm build              # Full build including agent-gateway
bun run packages/agent-gateway/src/server.ts  # Smoke test: server starts
```

## Verification Plan

### VP1: Health Endpoint Lists Adapters

Steps:
1. `bun run packages/agent-gateway/src/server.ts &`
   Expected: Server starts on port 9877, logs `[agent-gateway] Listening on http://127.0.0.1:9877`
2. `curl -s http://127.0.0.1:9877/health | jq .`
   Expected: Response includes `"adapters": ["claude", "codex", "opencode"]` and `"status": "ok"`

### VP2: ClaudeAdapter Executes Session

Steps:
1. Connect WebSocket to `ws://127.0.0.1:9877?project=duraclaw` with auth header
2. Send: `{"type":"execute","project":"duraclaw","prompt":"What files are in the root directory? Just list them, no explanation.","agent":"claude"}`
   Expected: Receive `session.init` event with `session_id`, `model`, and `tools` array. Then receive `partial_assistant` and/or `assistant` events. Finally receive `result` event with `is_error: false`.

### VP3: Default Agent Routes to Claude

Steps:
1. Connect WebSocket to `ws://127.0.0.1:9877?project=duraclaw` with auth header
2. Send: `{"type":"execute","project":"duraclaw","prompt":"echo hello"}`
   Expected: Receive `session.init` event (confirms routing to ClaudeAdapter when `agent` field is omitted).

### VP4: Unknown Agent Returns Error

Steps:
1. Connect WebSocket to `ws://127.0.0.1:9877?project=duraclaw` with auth header
2. Send: `{"type":"execute","project":"duraclaw","prompt":"test","agent":"bogus"}`
   Expected: Receive `{"type":"error","session_id":null,"error":"Unknown agent: \"bogus\". Available: claude, codex, opencode"}`

### VP5: CodexAdapter Executes Session

Steps:
1. Ensure `OPENAI_API_KEY` is set and `codex` CLI is installed
2. Connect WebSocket to `ws://127.0.0.1:9877?project=duraclaw` with auth header
3. Send: `{"type":"execute","project":"duraclaw","prompt":"List the files in the current directory","agent":"codex"}`
   Expected: Receive `session.init` event. Then receive streaming events. Finally receive `result` event.

### VP6: OpenCodeAdapter Executes Session

Steps:
1. Start sidecar: `opencode serve --port 4096 &`
2. Ensure `OPENCODE_URL=http://localhost:4096` is set
3. Connect WebSocket to `ws://127.0.0.1:9877?project=duraclaw` with auth header
4. Send: `{"type":"execute","project":"duraclaw","prompt":"List the files in the current directory","agent":"opencode"}`
   Expected: Receive `session.init` event. Then receive streaming events. Finally receive `result` event.

### VP7: Abort Works Across Adapters

Steps:
1. Connect WebSocket, send a long-running `ExecuteCommand` with `agent: "claude"`
2. Send: `{"type":"abort","session_id":"<session_id from session.init>"}`
   Expected: Session stops. No further events after abort. No `error` event (aborted sessions are silent).

### VP8: Resume Routes to Correct Adapter

Steps:
1. Connect WebSocket, send `ExecuteCommand` with `agent: "codex"`, note the `sdk_session_id` from `session.init`
2. Disconnect, reconnect WebSocket
3. Send: `{"type":"resume","project":"duraclaw","prompt":"continue","sdk_session_id":"<id>","agent":"codex"}`
   Expected: Receive `session.init` from CodexAdapter (not ClaudeAdapter). Session resumes the Codex thread.

### VP9: Abort Works for Non-Claude Adapter

Steps:
1. Connect WebSocket, send a long-running `ExecuteCommand` with `agent: "opencode"`
2. Note the `session_id` from `session.init`
3. Send: `{"type":"abort","session_id":"<session_id>"}`
   Expected: Session stops. OpenCode sidecar session is aborted via `client.session.abort()`.

### VP10: Package Rename Verification

Steps:
1. `ls packages/agent-gateway/package.json`
   Expected: File exists
2. `ls packages/cc-gateway/ 2>&1`
   Expected: `No such file or directory`
3. `cat packages/agent-gateway/package.json | jq .name`
   Expected: `"@duraclaw/agent-gateway"`
4. `pnpm typecheck`
   Expected: Exit code 0, no errors

### VP11: Integration Test Suite

Steps:
1. `cd packages/agent-gateway && pnpm test`
   Expected: All adapter integration tests pass (claude-adapter-execute, claude-adapter-resume, claude-adapter-abort, codex-adapter-execute, codex-adapter-resume, opencode-adapter-execute, opencode-adapter-abort)

## Implementation Hints

### Dependencies

```bash
# Phase 1 -- no new deps, just rename + refactor
cd packages/agent-gateway

# Phase 2
pnpm add @openai/codex-sdk

# Phase 3
pnpm add @opencode-ai/sdk
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@anthropic-ai/claude-agent-sdk` | `{ query, getSessionInfo }` | ClaudeAdapter execution and session info |
| `@openai/codex-sdk` | `Codex` (default export) | CodexAdapter -- instantiate SDK, `startThread`, `runStreamed` |
| `@opencode-ai/sdk` | `{ createOpencodeClient }` | OpenCodeAdapter -- connect to sidecar, session CRUD, SSE events |

### Code Patterns

**Adapter registry in server.ts:**

```typescript
import { ClaudeAdapter } from './adapters/claude.js'
import { CodexAdapter } from './adapters/codex.js'
import { OpenCodeAdapter } from './adapters/opencode.js'

const adapters = new Map<string, AgentAdapter>([
  ['claude', new ClaudeAdapter()],
  ['codex', new CodexAdapter()],
  ['opencode', new OpenCodeAdapter()],
])

// In the execute/resume handler:
const agentName = cmd.agent ?? 'claude'
const adapter = adapters.get(agentName)
if (!adapter) {
  const available = [...adapters.keys()].join(', ')
  ws.send(JSON.stringify({
    type: 'error',
    session_id: null,
    error: `Unknown agent: "${agentName}". Available: ${available}`,
  }))
  return
}
adapter.execute(ws, cmd, ctx)
```

**ClaudeAdapter (simplified full-auto):**

```typescript
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  async execute(ws, cmd, ctx) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const options = {
      abortController: ctx.abortController,
      cwd: projectPath,
      env: buildCleanEnv(),
      permissionMode: 'bypassPermissions',
      includePartialMessages: true,
    }
    // ... existing message loop, normalized to GatewayEvents
  }

  getCapabilities() {
    return { canResume: true, canStreamInput: true, canApproveTools: false, canRewind: false }
  }
}
```

**CodexAdapter (in-process SDK wrapping CLI):**

```typescript
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex'

  async execute(ws, cmd, ctx) {
    const Codex = (await import('@openai/codex-sdk')).default
    const codex = new Codex({ env: buildCleanEnv() })
    const thread = codex.startThread({ workingDirectory: projectPath })

    send(ws, { type: 'session.init', session_id: ctx.sessionId, ... })

    for await (const event of thread.runStreamed(cmd.prompt)) {
      if (ctx.abortController.signal.aborted) break

      switch (event.type) {
        case 'item.updated':
          // Normalize to partial_assistant
          break
        case 'item.completed':
          // Normalize to assistant or tool_result
          break
        case 'turn.completed':
          // Normalize to result
          break
      }
    }
  }

  getCapabilities() {
    return { canResume: true, canStreamInput: false, canApproveTools: false, canRewind: false }
  }
}
```

**OpenCodeAdapter (HTTP SDK + SSE bridge):**

```typescript
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode'
  private baseUrl: string

  constructor() {
    this.baseUrl = process.env.OPENCODE_URL ?? 'http://localhost:4096'
  }

  async execute(ws, cmd, ctx) {
    const { createOpencodeClient } = await import('@opencode-ai/sdk')
    const client = createOpencodeClient({ baseUrl: this.baseUrl })

    const session = await client.session.create({ body: {} })
    send(ws, { type: 'session.init', session_id: ctx.sessionId, sdk_session_id: session.id, ... })

    // Subscribe to SSE events
    const events = await client.event.subscribe()
    const promptPromise = client.session.prompt({
      path: { id: session.id },
      body: { parts: [{ type: 'text', text: typeof cmd.prompt === 'string' ? cmd.prompt : '' }] },
    })

    for await (const event of events.stream) {
      if (ctx.abortController.signal.aborted) {
        await client.session.abort({ path: { id: session.id } })
        break
      }
      // Normalize SSE event to GatewayEvent and send over WebSocket
    }
  }

  async abort(ctx) {
    // client.session.abort() via stored reference
  }

  getCapabilities() {
    return { canResume: true, canStreamInput: false, canApproveTools: false, canRewind: false }
  }
}
```

### Gotchas

- **Dynamic imports for ESM SDKs:** Both `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are ESM-only packages. Use `await import()` at call sites (current pattern in `sessions.ts`), not top-level imports. This also enables lazy loading -- adapters only load their SDK when first used.
- **Codex SDK spawns a child process:** `@openai/codex-sdk` internally spawns the `codex` CLI as a subprocess. The `codex` binary must be installed and on `PATH`. Environment variables (`OPENAI_API_KEY`, `PATH`, `HOME`) must be passed through. Abort requires destroying the thread, which kills the subprocess.
- **OpenCode SSE-to-WebSocket bridge:** `client.event.subscribe()` returns an SSE stream. The adapter must consume this stream and re-emit events as WebSocket JSON messages. Initially, subscribe per-session inside `execute()`. If the SSE subscription is global (all sessions), the adapter must filter events by session ID. Shared subscription across sessions is an optimization for later — per-session is simpler and correct for the initial implementation.
- **OpenCode sidecar lifecycle:** The `opencode serve` process must be running before the gateway starts. The adapter should check `GET /health` (or equivalent) on construction and log a warning if unreachable. It should not crash the gateway -- just return errors when sessions are requested.
- **Adapter-specific session state:** OpenCodeAdapter needs to store the SDK client and OpenCode session ID per-session for abort. Use a `Map<string, { client, sessionId }>` keyed by gateway session ID, stored as a private field on the adapter instance. Clean up on session completion or abort.
- **Codex thread resume:** Codex SDK uses `codex.resumeThread(threadId)` to resume. The gateway must store the Codex thread ID (returned from `startThread`) as the `sdk_session_id` in the `session.init` event so the orchestrator can pass it back in `ResumeCommand.sdk_session_id`.
- **Permission removal in ClaudeAdapter:** When switching to `permissionMode: 'bypassPermissions'`, remove the entire `canUseTool` callback. However, retain the `AskUserQuestion` interception if possible -- check whether `bypassPermissions` mode still fires hooks for `AskUserQuestion`. If not, accept that questions are auto-answered in full-auto mode.
- **`stream-input` command routing:** Only ClaudeAdapter supports `canStreamInput: true`. The server should check `adapter.getCapabilities().canStreamInput` before forwarding `stream-input` commands, and return an error for adapters that do not support it.
- **Package rename atomicity:** Rename `packages/cc-gateway` to `packages/agent-gateway` in a single commit. Update `pnpm-workspace.yaml`, `turbo.json`, the systemd service file (`duraclaw-cc-gateway.service` to `duraclaw-agent-gateway.service`), the systemd install script, and all `CLAUDE.md` references.

### Reference Docs

- [Claude Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview) -- query() API, hooks, message types
- [Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) -- startThread, runStreamed, event types
- [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive) -- full-auto, JSONL events
- [OpenCode GitHub](https://github.com/opencode-ai/opencode) -- CLI + serve mode + SDK
- [Duraclaw Roadmap Phase 5.4](../specs/roadmap-v2-full-vision.md) -- AgentExecutor interface design
