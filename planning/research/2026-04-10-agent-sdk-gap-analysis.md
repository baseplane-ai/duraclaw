---
date: 2026-04-10
topic: Claude Agent SDK v0.2.98 — cc-gateway gap analysis
status: complete
github_issue: null
---

# Research: Claude Agent SDK Gap Analysis

## Context

Compare the full API surface of `@anthropic-ai/claude-agent-sdk@0.2.98` against what
cc-gateway currently uses, to identify missing features worth wiring through to the
orchestrator.

## SDK Version

- **Installed:** `0.2.98` (Claude Code `2.1.98`)
- **Entry points:** `.` (main), `/browser`, `/bridge`, `/assistant`, `/sdk-tools`

## Current cc-gateway Usage

The gateway uses these SDK capabilities today (`sessions.ts`):

| Category | What's used |
|---|---|
| **Core** | `query()` with `AsyncIterable<SDKUserMessage>` streaming prompt |
| **Session recovery** | `resume` option, `getSessionInfo()` for post-session summary |
| **Options** | `abortController`, `cwd`, `env`, `permissionMode`, `includePartialMessages`, `settingSources`, `model`, `systemPrompt`, `allowedTools`, `maxTurns`, `maxBudgetUsd`, `canUseTool` |
| **Messages handled** | `system/init`, `assistant` (partial + full), `tool_use_summary`, `result` |
| **Tool interception** | `canUseTool` callback for permission gating, special-case `AskUserQuestion` |
| **Protocol commands** | `execute`, `resume`, `stream-input`, `permission-response`, `abort`, `stop`, `answer` |
| **Protocol events** | `session.init`, `assistant`, `tool_result`, `user_question`, `result`, `error`, `kata_state`, `permission_request`, `stopped` |

## Gap Analysis

### Tier 1: High Value — Should Wire Through

| Feature | SDK API | Gap | Why it matters |
|---|---|---|---|
| **Context usage** | `query.getContextUsage()` | Not exposed | Orchestrator UI needs to show context window fill %, warn when near limit |
| **Model switching** | `query.setModel()` | Not wired | Allow orchestrator to downgrade model mid-session (cost control) |
| **Permission mode switching** | `query.setPermissionMode()` | Not wired | Let user toggle between modes from UI without restarting |
| **Interrupt** | `query.interrupt()` | Have `abort` but not `interrupt` | Interrupt is softer than abort — stops current turn but keeps session alive |
| **File checkpointing + rewind** | `enableFileCheckpointing` + `query.rewindFiles()` | `rewind` command exists in protocol but returns "not implemented" | Critical for undo/rollback in orchestrator UI |
| **Thinking/effort config** | `thinking`, `effort` options | Not exposed | Control reasoning depth per session or mid-session |
| **Session state events** | `system/session_state_changed` | Not forwarded | Orchestrator needs idle/running/requires_action state for UI indicators |
| **Rate limit events** | `rate_limit_event` | Not forwarded | Show rate limit status in UI, pause/retry logic |

### Tier 2: Medium Value — Nice to Have

| Feature | SDK API | Gap | Why it matters |
|---|---|---|---|
| **MCP servers** | `mcpServers`, `createSdkMcpServer()`, `onElicitation` | Not wired | Let orchestrator inject custom tools into sessions |
| **Custom agents/subagents** | `agents` option, `AgentDefinition` | Not used | Define specialized agents from orchestrator config |
| **Structured output** | `outputFormat` (JSON schema) | Not used | Force structured responses for automated pipelines |
| **Session management** | `listSessions`, `getSessionMessages`, `forkSession`, `renameSession`, `tagSession` | Partially covered (`listSdkSessions` is custom) | Replace custom listing with SDK's richer API; add fork/rename/tag to UI |
| **Subagent introspection** | `listSubagents`, `getSubagentMessages` | Not used | Show subagent tree in orchestrator UI |
| **Task events** | `task_started`, `task_progress`, `task_notification` | Not forwarded | Show background task progress in UI |
| **Hooks** | 27 hook events via `hooks` option | Not used (ad-hoc postToolUse only) | More structured tool lifecycle control |
| **Apply settings mid-session** | `query.applyFlagSettings()` | Not wired | Hot-reload settings without restart |
| **MCP server management** | `reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()` | Not wired | Dynamic tool management from UI |

### Tier 3: Low Priority / Not Applicable

| Feature | SDK API | Why skip (for now) |
|---|---|---|
| **Bridge API** (`/bridge`) | `attachBridgeSession`, `createCodeSession` | For claude.ai remote control — different architecture than ours |
| **Assistant API** (`/assistant`) | `runAssistantWorker` | Managed worker pattern — we have our own lifecycle |
| **Browser API** (`/browser`) | Browser-compatible query | We run server-side |
| **Plugins** | `plugins` option | No plugin system yet |
| **Prompt suggestions** | `promptSuggestions` | UI feature — can add later |
| **Agent progress summaries** | `agentProgressSummaries` | AI-generated summaries — nice but not critical |
| **Sandbox settings** | `sandbox` option | VPS already sandboxed via worktree isolation |
| **Custom process spawner** | `spawnClaudeCodeProcess` | For container/VM — not our model |
| **Betas** | `betas` option (e.g. 1M context) | Can add when needed |
| **V2 Session API** | `unstable_v2_createSession` | Alpha — monitor but don't adopt yet |

## Query Methods Not Wired

The `Query` object (returned by `query()`) exposes these methods that cc-gateway doesn't use:

```
interrupt()              — soft stop (vs. hard abort)
setPermissionMode(mode)  — change permissions mid-session
setModel(model?)         — switch model mid-session
applyFlagSettings(s)     — merge settings mid-session
getContextUsage()        — context window breakdown
rewindFiles(messageId)   — checkpoint rollback
seedReadState(path, m)   — seed file read cache
reconnectMcpServer(n)    — reconnect MCP server
toggleMcpServer(n, b)    — enable/disable MCP server
setMcpServers(servers)   — replace dynamic MCP servers
streamInput(stream)      — stream additional input (we have messageQueue instead)
stopTask(taskId)         — stop background task
close()                  — terminate process
```

## SDKMessage Types Not Forwarded

These SDK message types are emitted but not forwarded through the gateway protocol:

| Message Type | Description |
|---|---|
| `system/status` | Compacting status |
| `system/compact_boundary` | Compaction metadata |
| `system/api_retry` | API retry info (attempt, delay, error) |
| `system/session_state_changed` | idle / running / requires_action |
| `system/task_notification` | Background task completion |
| `system/task_started` | Task launch info |
| `system/task_progress` | Task progress + usage |
| `system/hook_*` | Hook lifecycle events |
| `system/elicitation_complete` | MCP elicitation done |
| `auth_status` | Authentication state |
| `rate_limit_event` | Rate limit info |
| `prompt_suggestion` | Predicted next prompt |
| `tool_progress` | Tool execution progress |

## Recommendations

### Immediate (next sprint)

1. **Wire `interrupt()`** — Add `interrupt` command to protocol as a soft-stop alternative to `abort`. Map to `query.interrupt()`.
2. **Forward `session_state_changed`** — Add to `GatewayEvent` union. Orchestrator UI needs this for status indicators.
3. **Forward `rate_limit_event`** — Critical for production visibility.
4. **Expose `getContextUsage()`** — Add `context-usage` command or periodic polling. UI should show context fill %.

### Short-term (next 2 sprints)

5. **Implement `rewindFiles()`** — Complete the `rewind` command that's already stubbed in the protocol.
6. **Wire `effort`/`thinking` options** — Add to `ExecuteCommand` so orchestrator can control reasoning depth.
7. **Wire `setModel()` and `setPermissionMode()`** — Add mid-session control commands.
8. **Forward `task_*` events** — Show subagent/background task progress in UI.

### Medium-term

9. **MCP server injection** — Allow orchestrator to pass `mcpServers` config in execute command.
10. **Replace custom session listing** — Use SDK's `listSessions()` + `getSessionMessages()` instead of custom `listSdkSessions()`.
11. **Add `forkSession()`** — Enable session branching from UI.

## Open Questions

- Should we adopt the V2 Session API (`unstable_v2_createSession`) when it stabilizes? It has a simpler `send()`/`stream()` pattern vs our current `query()` + `AsyncIterable` approach.
- How much of the hooks system should we expose? Could replace our custom `canUseTool` + `postToolUse` with the real hooks API.
- Should structured output (`outputFormat`) be a session-level config from the orchestrator?

## Next Steps

Create implementation issues for Tier 1 items. The protocol types in `shared-types` need
new command/event variants for each feature wired through.
