---
initiative: refactor-pluggable-agent-gateway
type: project
issue_type: feature
status: approved
priority: high
github_issue: 16
created: 2026-04-11
updated: 2026-04-11
phases:
  - id: p1
    name: "AgentAdapter Interface + ClaudeAdapter Extraction"
    tasks:
      - "Define AgentAdapter interface with execute(), resume(), abort(), getCapabilities()"
      - "Extract current sessions.ts logic into ClaudeAdapter"
      - "Add adapter registry and routing in server.ts"
      - "Add agent field to ExecuteCommand in shared-types"
    test_cases:
      - id: "p1-interface"
        description: "AgentAdapter interface compiles with all required methods"
        type: "unit"
      - id: "p1-claude-adapter"
        description: "ClaudeAdapter execute/resume/abort work identically to current sessions.ts"
        type: "integration"
      - id: "p1-routing"
        description: "ExecuteCommand with agent='claude' routes to ClaudeAdapter"
        type: "integration"
  - id: p2
    name: "CodexAdapter (in-process SDK)"
    tasks:
      - "Install @openai/codex-sdk dependency"
      - "Implement CodexAdapter using startThread + runStreamed"
      - "Normalize Codex JSONL events to VpsEvent format"
      - "Wire CodexAdapter into adapter registry"
    test_cases:
      - id: "p2-codex-execute"
        description: "CodexAdapter.execute() starts a Codex thread and streams normalized events"
        type: "integration"
      - id: "p2-codex-abort"
        description: "CodexAdapter.abort() terminates the running Codex thread"
        type: "integration"
      - id: "p2-event-normalization"
        description: "Codex turn.completed events map to VpsEvent result format"
        type: "unit"
  - id: p3
    name: "OpenCodeAdapter (HTTP SDK client)"
    tasks:
      - "Install @opencode-ai/sdk dependency"
      - "Implement OpenCodeAdapter as HTTP SDK client to opencode serve sidecar"
      - "Normalize OpenCode events to VpsEvent format"
      - "Wire OpenCodeAdapter into adapter registry"
    test_cases:
      - id: "p3-opencode-execute"
        description: "OpenCodeAdapter.execute() connects to opencode serve and streams normalized events"
        type: "integration"
      - id: "p3-opencode-abort"
        description: "OpenCodeAdapter.abort() stops the running OpenCode session"
        type: "integration"
      - id: "p3-event-normalization"
        description: "OpenCode events map to VpsEvent format"
        type: "unit"
  - id: p4
    name: "Capabilities Endpoint + Package Rename"
    tasks:
      - "Implement getCapabilities() for each adapter (detect installed agents)"
      - "Add GET /capabilities HTTP endpoint aggregating all adapter capabilities"
      - "Rename package from cc-gateway to agent-gateway"
      - "Update systemd service, imports, and CLAUDE.md references"
    test_cases:
      - id: "p4-capabilities"
        description: "GET /capabilities returns list of available agents with their supported features"
        type: "integration"
      - id: "p4-unavailable-agent"
        description: "Requesting unavailable agent returns clear error before session starts"
        type: "integration"
      - id: "p4-package-rename"
        description: "Package builds and runs under new agent-gateway name"
        type: "smoke"
---

# Pluggable Agent Gateway

> GitHub Issue: [#16](https://github.com/codevibesmatter/duraclaw/issues/16)

## Overview

The cc-gateway package is tightly coupled to the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), making it impossible to route sessions to alternative coding agents. Users need agent choice -- Claude for complex multi-file tasks, Codex for quick edits with OpenAI models, and OpenCode for model flexibility across 200+ providers -- without changing the orchestrator protocol. This spec introduces an `AgentAdapter` interface, extracts the existing Claude logic into `ClaudeAdapter`, adds `CodexAdapter` (in-process via `@openai/codex-sdk`) and `OpenCodeAdapter` (HTTP SDK client via `@opencode-ai/sdk`), and renames the package from `cc-gateway` to `agent-gateway`.

## Feature Behaviors

### B1: AgentAdapter Interface Definition

**Core:**
- **ID:** agent-adapter-interface
- **Trigger:** Implementation begins; all adapters need a shared contract
- **Expected:** A TypeScript interface `AgentAdapter` is defined in `packages/cc-gateway/src/adapters/types.ts` with four methods: `execute(ws, cmd, ctx)` to run a new session, `resume(ws, cmd, ctx)` to resume an existing session, `abort(ctx)` to cancel a running session, and `getCapabilities()` to report what the adapter supports (agent name, supported commands, availability). The interface normalizes all agent output to `GatewayEvent` messages sent over the WebSocket.
- **Verify:** `AgentAdapter` interface compiles; a no-op mock adapter implementing it passes type checking
- **Source:** New file `packages/cc-gateway/src/adapters/types.ts`

**UI Layer:** N/A -- backend only

**API Layer:**

```typescript
// packages/cc-gateway/src/adapters/types.ts
import type { ServerWebSocket } from 'bun'
import type {
  ExecuteCommand,
  GatewayEvent,
  ResumeCommand,
} from '@duraclaw/shared-types'
import type { GatewaySessionContext, WsData } from '../types.js'

export interface AdapterCapabilities {
  agent: string
  available: boolean
  supportedCommands: string[]
  models?: string[]
  description: string
}

export interface AgentAdapter {
  readonly name: string
  execute(ws: ServerWebSocket<WsData>, cmd: ExecuteCommand, ctx: GatewaySessionContext): Promise<void>
  resume(ws: ServerWebSocket<WsData>, cmd: ResumeCommand, ctx: GatewaySessionContext): Promise<void>
  abort(ctx: GatewaySessionContext): void
  getCapabilities(): Promise<AdapterCapabilities>
}
```

**Data Layer:** No schema changes. The interface is gateway-local, not in shared-types.

---

### B2: ClaudeAdapter Extraction from sessions.ts

**Core:**
- **ID:** claude-adapter-extraction
- **Trigger:** `AgentAdapter` interface is defined (B1 complete)
- **Expected:** The existing `executeSession()` function in `packages/cc-gateway/src/sessions.ts` is extracted into a `ClaudeAdapter` class implementing `AgentAdapter`. The class wraps the `@anthropic-ai/claude-agent-sdk` `query()` call, SDK hooks (PreToolUse, PostToolUse), message queue, event streaming, and result handling. The `resume()` method uses the existing `options.resume = cmd.sdk_session_id` path. The `abort()` method calls `ctx.abortController.abort()`. The `getCapabilities()` method dynamically checks whether the Claude SDK is importable. After extraction, `sessions.ts` becomes a thin re-export or is removed, and `server.ts` routes through the adapter registry instead of calling `executeSession()` directly.
- **Verify:** Execute a Claude session via WebSocket; receive identical `session.init`, `assistant`, `tool_result`, and `result` events as before the refactor
- **Source:** `packages/cc-gateway/src/sessions.ts:83-446` (the entire `executeSession` function)

**UI Layer:** N/A -- backend only

**API Layer:** No protocol changes. The orchestrator sends the same `ExecuteCommand` and receives the same `GatewayEvent` stream. Internally, `server.ts` delegates to `ClaudeAdapter.execute()` instead of calling `executeSession()` directly.

**Data Layer:** No schema changes.

---

### B3: Adapter Registry and Routing

**Core:**
- **ID:** adapter-registry-routing
- **Trigger:** Orchestrator sends an `execute` or `resume` command with an `agent` field
- **Expected:** A registry module (`packages/cc-gateway/src/adapters/registry.ts`) maintains a `Map<string, AgentAdapter>` populated at startup. When `server.ts` receives an `execute` or `resume` command, it reads `cmd.agent` (defaulting to `'claude'` if omitted for backward compatibility), looks up the adapter in the registry, and delegates to `adapter.execute()` or `adapter.resume()`. If the requested agent is not registered or not available, the gateway sends an `error` event with a descriptive message listing available agents. The `abort` and `stop` commands look up the adapter from the session context and call `adapter.abort()`.
- **Verify:** Send `execute` with `agent='claude'` -- routes to ClaudeAdapter. Send `execute` with `agent='unknown'` -- receive error event listing available agents.
- **Source:** `packages/cc-gateway/src/server.ts:253-281` (the `execute`/`resume` switch case)

**UI Layer:** N/A -- backend only

**API Layer:**

The `switch` block in `server.ts` for `execute`/`resume` changes from:
```typescript
executeSession(ws, cmd, ctx)
```
to:
```typescript
const adapter = registry.get(cmd.agent ?? 'claude')
if (!adapter) { send error listing available agents; return }
adapter.execute(ws, cmd, ctx)
```

The `GatewaySessionContext` gains an `adapter` field so that `abort`/`stop` can delegate to the correct adapter.

**Data Layer:** Add `adapterName: string | null` to `GatewaySessionContext` in `packages/cc-gateway/src/types.ts`. Store the adapter name (not the adapter object) to avoid a circular import between `types.ts` and `adapters/types.ts`. The server looks up the adapter from the registry by name when needed (e.g., for abort/stop delegation).

---

### B4: ExecuteCommand Agent Field

**Core:**
- **ID:** execute-command-agent-field
- **Trigger:** Orchestrator wants to select which coding agent runs a session
- **Expected:** The `ExecuteCommand` interface in `packages/shared-types/src/index.ts` gains an optional `agent` field of type `string`. When omitted, the gateway defaults to `'claude'` for backward compatibility. Known values: `'claude'`, `'codex'`, `'opencode'`. The `ResumeCommand` also gains an optional `agent` field (needed because different adapters have different resume mechanisms).
- **Verify:** TypeScript compiles with `{ type: 'execute', project: 'test', prompt: 'hello', agent: 'codex' }`; omitting `agent` still compiles
- **Source:** `packages/shared-types/src/index.ts:18-36` (`ExecuteCommand` interface), `packages/shared-types/src/index.ts:121-127` (`ResumeCommand` interface)

**UI Layer:** N/A -- backend only

**API Layer:**

```typescript
export interface ExecuteCommand {
  // ...existing fields...
  /** Which agent to use. Defaults to 'claude' if omitted. */
  agent?: string
}

export interface ResumeCommand {
  // ...existing fields...
  /** Which agent to use for resume. Defaults to 'claude' if omitted. */
  agent?: string
}
```

**Data Layer:** Type-only change in `packages/shared-types/src/index.ts`. No database or runtime schema changes.

---

### B5: CodexAdapter (In-Process SDK)

**Core:**
- **ID:** codex-adapter
- **Trigger:** Orchestrator sends `execute` with `agent='codex'`
- **Expected:** `CodexAdapter` implements `AgentAdapter` using `@openai/codex-sdk`. On `execute()`, it instantiates `new Codex({ env })`, calls `codex.startThread({ workingDirectory })`, then iterates `thread.runStreamed(prompt)` to receive JSONL events. Events are normalized to `GatewayEvent` format: `thread.started` maps to `session.init`, `item.updated` maps to `partial_assistant`, `item.completed` maps to `assistant` or `tool_result` depending on item type, `turn.completed` maps to `result`. The `abort()` method destroys the thread. The `resume()` method calls `codex.resumeThread(threadId)`. The `getCapabilities()` method checks whether `@openai/codex-sdk` is importable and whether `OPENAI_API_KEY` is set.
- **Verify:** Send `execute` with `agent='codex'` and a simple prompt; receive `session.init` followed by `assistant` and `result` events
- **Source:** New file `packages/cc-gateway/src/adapters/codex.ts`
- **SDK Risk:** The `@openai/codex-sdk` API surface (`startThread`, `runStreamed`, `resumeThread`, event type names) is based on v0.116.0 research. Pin the dependency version at implementation time and verify the actual API before coding the event normalization table. If the SDK API differs, update the normalization mapping accordingly.

**UI Layer:** N/A -- backend only

**API Layer:**

Event normalization mapping:

| Codex SDK Event | GatewayEvent |
|---|---|
| `thread.started` | `session.init` (session_id, model, tools) |
| `item.updated` (text) | `partial_assistant` (text delta) |
| `item.updated` (tool_use) | `partial_assistant` (tool_use delta) |
| `item.completed` (message) | `assistant` (content blocks) |
| `item.completed` (tool result) | `tool_result` (content) |
| `turn.completed` | `result` (duration_ms, is_error=false) |
| `turn.failed` | `result` (is_error=true) or `error` |
| `error` | `error` |

The `resume()` path uses Codex session IDs stored in `~/.codex/sessions`. The `sdk_session_id` in `session.init` is set to the Codex thread ID.

**Data Layer:** No schema changes. Add `@openai/codex-sdk` to `packages/cc-gateway/package.json` dependencies.

---

### B6: OpenCodeAdapter (HTTP SDK Client)

**Core:**
- **ID:** opencode-adapter
- **Trigger:** Orchestrator sends `execute` with `agent='opencode'`
- **Expected:** `OpenCodeAdapter` implements `AgentAdapter` using `@opencode-ai/sdk` as an HTTP client connecting to an `opencode serve` sidecar process. On `execute()`, it creates a session via the SDK client, sends the prompt, and subscribes to the SSE event stream. Events are normalized to `GatewayEvent` format. The `abort()` method cancels the session via the SDK. The `resume()` method reconnects to an existing OpenCode session. The `getCapabilities()` method checks whether the OpenCode sidecar is reachable at the configured URL (env var `OPENCODE_URL`, default `http://127.0.0.1:3000`). OpenCode supports 200+ models across providers; the `model` field from `ExecuteCommand` is passed through.
- **Verify:** Start `opencode serve`, send `execute` with `agent='opencode'`; receive `session.init` followed by `assistant` and `result` events
- **Source:** New file `packages/cc-gateway/src/adapters/opencode.ts`
- **SDK Risk:** The `@opencode-ai/sdk` API surface and `opencode serve` SSE event types are based on current research. Pin the dependency version at implementation time and verify the actual SDK client methods and event schema. The event normalization table below uses generic descriptions; replace with exact event type names from the SDK at implementation time.

**UI Layer:** N/A -- backend only

**API Layer:**

Event normalization mapping:

| OpenCode Event | GatewayEvent |
|---|---|
| Session created | `session.init` (session_id, model, tools=[]) |
| Assistant text chunk | `partial_assistant` (text delta) |
| Assistant message complete | `assistant` (content blocks) |
| Tool call result | `tool_result` (content) |
| Session complete | `result` (duration_ms, is_error=false) |
| Error | `error` |

The OpenCode sidecar must be running as a separate process (`opencode serve`). The adapter does not manage the sidecar lifecycle -- it connects to it as a client. The `OPENCODE_URL` environment variable configures the sidecar address.

**Data Layer:** No schema changes. Add `@opencode-ai/sdk` to `packages/cc-gateway/package.json` dependencies. Add `OPENCODE_URL` to systemd `EnvironmentFile` documentation.

---

### B7: Capabilities Endpoint

**Core:**
- **ID:** capabilities-endpoint
- **Trigger:** HTTP `GET /capabilities` request to the gateway
- **Expected:** The gateway calls `getCapabilities()` on every registered adapter and returns a JSON array of `AdapterCapabilities` objects. Each object includes the agent name, whether it is available (SDK importable, API key set, sidecar reachable), supported commands, and a human-readable description. The orchestrator uses this to determine which agents to offer in the UI. The endpoint requires auth (same as other non-health endpoints).
- **Verify:** `curl -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:9877/capabilities` returns JSON array with at least `claude` entry
- **Source:** `packages/cc-gateway/src/server.ts:46-62` (HTTP route handler section, add new route)

**UI Layer:** N/A -- backend only

**API Layer:**

```
GET /capabilities
Authorization: Bearer <token>

Response 200:
{
  "agents": [
    {
      "agent": "claude",
      "available": true,
      "supportedCommands": ["execute", "resume", "abort", "stop", "interrupt", "set-model", "rewind"],
      "description": "Claude Code via Agent SDK"
    },
    {
      "agent": "codex",
      "available": true,
      "supportedCommands": ["execute", "resume", "abort"],
      "description": "OpenAI Codex via codex-sdk"
    },
    {
      "agent": "opencode",
      "available": false,
      "supportedCommands": ["execute", "abort"],
      "models": ["claude-sonnet-4-20250514", "gpt-4o", "..."],
      "description": "OpenCode multi-provider agent (sidecar not reachable)"
    }
  ]
}
```

**Data Layer:** No schema changes.

---

### B8: Package Rename (cc-gateway to agent-gateway)

**Core:**
- **ID:** package-rename
- **Trigger:** All adapters are implemented and tested
- **Expected:** The package is renamed from `@duraclaw/cc-gateway` to `@duraclaw/agent-gateway`. This involves: renaming the directory from `packages/cc-gateway` to `packages/agent-gateway`, updating `package.json` name field, updating the systemd service file from `duraclaw-cc-gateway.service` to `duraclaw-agent-gateway.service` (including `Description`, `ExecStart` path, `ReadWritePaths`), updating `install.sh`, updating all workspace references in the root `pnpm-workspace.yaml` and `turbo.json`, updating `CLAUDE.md` documentation, and updating log prefixes from `[cc-gateway]` to `[agent-gateway]` throughout the source.
- **Verify:** `pnpm build` succeeds; `bun run packages/agent-gateway/src/server.ts` starts; `sudo systemctl start duraclaw-agent-gateway` runs
- **Source:** `packages/cc-gateway/package.json:2` (name field), `packages/cc-gateway/systemd/duraclaw-cc-gateway.service` (service definition), `packages/cc-gateway/systemd/install.sh`, `CLAUDE.md`

**UI Layer:** N/A -- backend only

**API Layer:** No protocol changes. The gateway serves the same HTTP and WebSocket endpoints on the same port.

**Data Layer:** No schema changes. The systemd `EnvironmentFile` path remains `/data/projects/duraclaw/.env`. New env vars: `OPENAI_API_KEY` (for Codex), `OPENCODE_URL` (for OpenCode sidecar, default `http://127.0.0.1:3000`).

---

## Non-Goals

- **No Cursor, Aider, Cline, or Goose adapters.** Only Claude, Codex, and OpenCode are in scope. Other agents can be added later using the same `AgentAdapter` interface.
- **No UI changes.** The orchestrator frontend is not modified. Agent selection will be added in a future spec.
- **No permission callbacks for Codex or OpenCode.** Both run in full-auto mode (`--full-auto` / equivalent). Only ClaudeAdapter retains the PreToolUse permission gating hooks.
- **No orchestrator-side changes beyond the `agent` field.** The orchestrator passes `agent` in `ExecuteCommand` and handles the same `GatewayEvent` stream regardless of which adapter produced it.
- **No sidecar lifecycle management.** The OpenCode sidecar (`opencode serve`) must be started and managed separately (e.g., via a second systemd unit). The adapter only connects to it as a client.

## Test Plan

### Unit Tests

| Scenario | File | Verifies |
|---|---|---|
| AgentAdapter interface type checking | `packages/cc-gateway/src/adapters/types.test.ts` | Interface compiles, mock adapter satisfies contract |
| Adapter registry get/set/list | `packages/cc-gateway/src/adapters/registry.test.ts` | Registry returns correct adapter by name, lists all, returns undefined for unknown |
| Codex event normalization | `packages/cc-gateway/src/adapters/codex.test.ts` | Each Codex JSONL event type maps to correct GatewayEvent |
| OpenCode event normalization | `packages/cc-gateway/src/adapters/opencode.test.ts` | Each OpenCode event type maps to correct GatewayEvent |
| ExecuteCommand agent field defaults | `packages/shared-types/src/index.test.ts` | Omitting `agent` compiles; explicit `agent='codex'` compiles |

### Integration Tests

| Scenario | File | Verifies |
|---|---|---|
| ClaudeAdapter execute E2E | `packages/cc-gateway/src/adapters/claude.integration.test.ts` | Full session lifecycle: session.init, assistant, result events match pre-refactor behavior |
| ClaudeAdapter resume E2E | `packages/cc-gateway/src/adapters/claude.integration.test.ts` | Resume with sdk_session_id produces session.init with restored context |
| CodexAdapter execute E2E | `packages/cc-gateway/src/adapters/codex.integration.test.ts` | Session with `agent='codex'` streams normalized events and completes |
| CodexAdapter abort | `packages/cc-gateway/src/adapters/codex.integration.test.ts` | Abort during execution terminates cleanly |
| OpenCodeAdapter execute E2E | `packages/cc-gateway/src/adapters/opencode.integration.test.ts` | Session with `agent='opencode'` streams normalized events via sidecar |
| Routing unknown agent | `packages/cc-gateway/src/server.test.ts` | `agent='unknown'` returns error event listing available agents |
| Capabilities endpoint | `packages/cc-gateway/src/server.test.ts` | `GET /capabilities` returns all registered adapters with correct availability |
| Codex resume E2E | `packages/cc-gateway/src/adapters/codex.integration.test.ts` | Resume with Codex thread ID reconnects and streams events |
| Unsupported command to non-Claude | `packages/cc-gateway/src/server.test.ts` | Sending `interrupt` to a Codex session returns error with "unsupported command" message |
| Package rename build | smoke test | `pnpm build` succeeds after rename |

## Implementation Phases

**P1: AgentAdapter Interface + ClaudeAdapter Extraction** -- Define the `AgentAdapter` interface (B1), extract existing `sessions.ts` logic into `ClaudeAdapter` (B2), wire up the adapter registry and routing in `server.ts` (B3), and add the `agent` field to `ExecuteCommand`/`ResumeCommand` in shared-types (B4). After P1, the gateway behaves identically to before but routes through the adapter layer.

**P2: CodexAdapter (in-process SDK)** -- Install `@openai/codex-sdk`, implement `CodexAdapter` with `startThread` + `runStreamed` (B5), normalize Codex JSONL events to `GatewayEvent` format, and register in the adapter registry. Requires `OPENAI_API_KEY` environment variable.

**P3: OpenCodeAdapter (HTTP SDK client)** -- Install `@opencode-ai/sdk`, implement `OpenCodeAdapter` as an HTTP client to the `opencode serve` sidecar (B6), normalize OpenCode events to `GatewayEvent` format, and register in the adapter registry. Requires the OpenCode sidecar running separately.

**P4: Capabilities Endpoint + Package Rename** -- Implement `GET /capabilities` endpoint aggregating all adapter availability (B7), rename package from `cc-gateway` to `agent-gateway` (B8), update systemd service, imports, and documentation.

## Test Infrastructure

Existing test setup uses `vitest` (v4.1.2) with `vitest run` as the test command. Existing test files:
- `packages/cc-gateway/src/commands.test.ts` -- unit tests for query command handling
- `packages/cc-gateway/src/files.test.ts` -- unit tests for file API handlers
- `packages/cc-gateway/src/kata.test.ts` -- unit tests for kata state discovery

Build command: `tsup` (configured in package.json). Runtime: `bun run src/server.ts`. TypeScript checking: `tsc --noEmit`.

New adapter tests follow the same pattern: colocated `*.test.ts` for unit tests, `*.integration.test.ts` for tests requiring real SDK calls. Integration tests are gated by environment variable checks (skip if `OPENAI_API_KEY` or OpenCode sidecar not available).

## Verification Plan

All verification steps assume the gateway is running on `127.0.0.1:9877` with auth token set in `CC_GATEWAY_API_TOKEN`.

### VP1: Claude Adapter E2E

Connect via WebSocket and execute a Claude session:

```bash
# Install wscat if needed: npm i -g wscat
wscat -c "ws://127.0.0.1:9877?project=duraclaw" \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN"

# Send execute command (agent defaults to claude):
{"type":"execute","project":"duraclaw","prompt":"What files are in the root directory? Just list them briefly."}
```

**Expected events in order:**
1. `session.init` with `session_id`, `model` containing "claude", `tools` array
2. One or more `partial_assistant` with text deltas
3. `assistant` with complete content
4. `result` with `subtype: "success"`, `duration_ms > 0`, `is_error: false`

### VP2: Codex Adapter E2E

```bash
wscat -c "ws://127.0.0.1:9877?project=duraclaw" \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN"

# Send execute command with agent=codex:
{"type":"execute","project":"duraclaw","prompt":"List the files in the current directory.","agent":"codex"}
```

**Expected events in order:**
1. `session.init` with `session_id`, `model` containing a Codex model identifier
2. One or more `partial_assistant` or `assistant` events
3. `result` with `is_error: false`

**Prerequisite:** `OPENAI_API_KEY` must be set in the gateway environment. The `codex` CLI must be installed and on `PATH` (the SDK spawns it as a child process).

### VP3: OpenCode Adapter E2E

```bash
# Ensure opencode sidecar is running:
opencode serve &

wscat -c "ws://127.0.0.1:9877?project=duraclaw" \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN"

# Send execute command with agent=opencode:
{"type":"execute","project":"duraclaw","prompt":"List the files in the current directory.","agent":"opencode"}
```

**Expected events in order:**
1. `session.init` with `session_id`
2. One or more `partial_assistant` or `assistant` events
3. `result` with `is_error: false`

**Prerequisite:** `opencode serve` sidecar must be running on `OPENCODE_URL` (default `http://127.0.0.1:3000`).

### VP4: Capabilities Endpoint

```bash
curl -s -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
  http://127.0.0.1:9877/capabilities | jq .
```

**Expected response:**
```json
{
  "agents": [
    {
      "agent": "claude",
      "available": true,
      "supportedCommands": ["execute", "resume", "abort", "stop", "interrupt", "set-model", "rewind"],
      "description": "Claude Code via Agent SDK"
    },
    {
      "agent": "codex",
      "available": true,
      "supportedCommands": ["execute", "resume", "abort"],
      "description": "OpenAI Codex via codex-sdk"
    },
    {
      "agent": "opencode",
      "available": true,
      "supportedCommands": ["execute", "abort"],
      "description": "OpenCode multi-provider agent"
    }
  ]
}
```

The `available` field for each agent depends on runtime conditions (SDK importable, API key set, sidecar reachable). At minimum, `claude` must be `available: true`.

### VP5: Unknown Agent Error

```bash
wscat -c "ws://127.0.0.1:9877?project=duraclaw" \
  -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN"

# Request non-existent agent:
{"type":"execute","project":"duraclaw","prompt":"hello","agent":"unknown"}
```

**Expected response:**
```json
{
  "type": "error",
  "session_id": null,
  "error": "Agent \"unknown\" is not available. Available agents: claude, codex, opencode"
}
```

## Implementation Hints

### Key Imports

| Package | Version | Usage |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.91` | Already installed. `query()`, `getSessionInfo()`, `forkSession()`, `renameSession()`, `tagSession()` |
| `@openai/codex-sdk` | latest | New dependency. `new Codex()`, `codex.startThread()`, `thread.runStreamed()`, `codex.resumeThread()` |
| `@opencode-ai/sdk` | latest | New dependency. HTTP SDK client for `opencode serve` sidecar REST API |
| `@duraclaw/shared-types` | `workspace:*` | Already installed. `ExecuteCommand`, `ResumeCommand`, `GatewayEvent` types |

### Code Patterns

1. **Adapter interface** -- Each adapter is a class implementing `AgentAdapter`. The `execute()` method is async and streams `GatewayEvent` messages to the WebSocket as they arrive. It does not return events; it sends them directly via `ws.send()`.

2. **Event normalization** -- Each adapter has a private `normalizeEvent()` method that maps SDK-specific events to `GatewayEvent`. This keeps the mapping logic colocated with the SDK-specific code.

3. **Registry pattern** -- `AdapterRegistry` is a simple `Map<string, AgentAdapter>` with `register()`, `get()`, and `listCapabilities()` methods. It is instantiated once at server startup and passed to route handlers.

4. **Dynamic availability** -- `getCapabilities()` is async because it may need to attempt a dynamic import (`import('@openai/codex-sdk')`) or make an HTTP health check (`fetch(OPENCODE_URL + '/health')`). Results can be cached with a short TTL (30s) to avoid repeated checks.

5. **Backward compatibility** -- The `agent` field on `ExecuteCommand` defaults to `'claude'` when omitted. Existing orchestrator code that does not send `agent` continues to work without changes.

### Gotchas

1. **Codex SDK spawns CLI internally.** The `@openai/codex-sdk` TypeScript SDK spawns `codex` as a child process and communicates via JSONL over stdin/stdout. Ensure `codex` CLI is installed and on `PATH` in the systemd environment. The `PATH` in `duraclaw-cc-gateway.service` already includes `/home/ubuntu/.local/bin` and `/usr/local/bin`.

2. **OpenCode sidecar lifecycle.** The `opencode serve` process must be running independently. Consider a separate systemd unit (`duraclaw-opencode-sidecar.service`) managed outside this spec. The adapter only connects; it does not start or stop the sidecar.

3. **Package rename touches systemd.** Renaming from `cc-gateway` to `agent-gateway` requires updating the systemd service file name, `install.sh`, and running `systemctl daemon-reload`. The old service must be stopped and disabled before enabling the new one.

4. **Claude-specific commands.** Commands like `interrupt`, `set-model`, `set-permission-mode`, `rewind`, and `stop-task` are Claude SDK-specific (they operate on the `Query` object). Codex and OpenCode adapters do not support these commands. The server must check adapter capabilities before delegating query commands, and return a clear error if the active adapter does not support the command.

5. **GatewaySessionContext divergence.** The current `GatewaySessionContext` has Claude-specific fields (`query`, `commandQueue`, `pendingPermission`). After the refactor, only `ClaudeAdapter` needs these. The approach: keep `GatewaySessionContext` with only shared fields (`ws`, `abortController`, `adapterName`, `sessionId`). Create a `ClaudeSessionContext extends GatewaySessionContext` with the Claude-specific fields. The `ClaudeAdapter` casts to `ClaudeSessionContext` internally. Other adapters use the base `GatewaySessionContext` or their own extensions.

### Reference Documents

- Research: `planning/research/2026-04-10-pluggable-agent-gateway.md`
- Codex SDK docs: https://developers.openai.com/codex/sdk
- Codex SDK README: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- OpenCode GitHub: https://github.com/opencode-ai/opencode
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview
