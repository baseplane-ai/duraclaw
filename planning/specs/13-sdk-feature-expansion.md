---
initiative: feat-sdk-feature-expansion
type: project
issue_type: feature
status: approved
priority: high
github_issue: 13
created: 2026-04-10
updated: 2026-04-10
phases:
  - id: p1
    name: "Foundation Refactor"
    tasks:
      - "Store SDK Query object in SessionContext"
      - "Add command queue to SessionContext for pre-session commands"
      - "Migrate canUseTool/postToolUse to SDK hooks API"
      - "Add thinking and effort fields to ExecuteCommand"
      - "Add enableFileCheckpointing: true as default option"
    test_cases:
      - id: "p1-query-stored"
        description: "After session starts, SessionContext.query is non-null and exposes interrupt/setModel/etc."
        type: "integration"
      - id: "p1-command-queue"
        description: "Commands sent before session init are queued and applied when Query becomes available"
        type: "integration"
      - id: "p1-hooks-pretooluse"
        description: "PreToolUse hook fires for tool calls and permission gating works via hook callback"
        type: "integration"
      - id: "p1-hooks-posttooluse"
        description: "PostToolUse hook fires after tool execution and emits file_changed events"
        type: "integration"
      - id: "p1-thinking-effort"
        description: "ExecuteCommand with thinking and effort fields passes them through to SDK options"
        type: "unit"
      - id: "p1-checkpointing"
        description: "enableFileCheckpointing defaults to true in SDK options"
        type: "unit"
  - id: p2
    name: "New Gateway Commands"
    tasks:
      - "Add interrupt command and handler"
      - "Add get-context-usage command and ContextUsageEvent"
      - "Add set-model command and handler"
      - "Add set-permission-mode command and handler"
      - "Replace rewind stub with query.rewindFiles() implementation"
      - "Add stop-task command and handler"
    test_cases:
      - id: "p2-interrupt"
        description: "Sending interrupt command calls query.interrupt() and session remains alive"
        type: "integration"
      - id: "p2-context-usage"
        description: "get-context-usage returns SDKControlGetContextUsageResponse data"
        type: "integration"
      - id: "p2-set-model"
        description: "set-model command calls query.setModel() with provided model string"
        type: "integration"
      - id: "p2-set-permission-mode"
        description: "set-permission-mode command calls query.setPermissionMode() with valid PermissionMode"
        type: "integration"
      - id: "p2-rewind"
        description: "rewind command calls query.rewindFiles() and returns RewindFilesResult"
        type: "integration"
      - id: "p2-stop-task"
        description: "stop-task command calls query.stopTask() with task_id"
        type: "integration"
      - id: "p2-queue-before-ready"
        description: "Commands sent before Query is available are queued and error if session never starts"
        type: "integration"
  - id: p3
    name: "Event Forwarding"
    tasks:
      - "Forward session_state_changed events as SessionStateChangedEvent"
      - "Forward rate_limit_event as RateLimitEvent"
      - "Forward task_started as TaskStartedEvent"
      - "Forward task_progress as TaskProgressEvent"
      - "Forward task_notification as TaskNotificationEvent"
    test_cases:
      - id: "p3-session-state"
        description: "session_state_changed SDK message is forwarded as GatewayEvent with correct state"
        type: "integration"
      - id: "p3-rate-limit"
        description: "rate_limit_event SDK message is forwarded with rate_limit_info payload"
        type: "integration"
      - id: "p3-task-started"
        description: "task_started SDK message is forwarded with task_id and description"
        type: "integration"
      - id: "p3-task-progress"
        description: "task_progress SDK message is forwarded with usage and description"
        type: "integration"
      - id: "p3-task-notification"
        description: "task_notification SDK message is forwarded with status and summary"
        type: "integration"
  - id: p4
    name: "Session Management HTTP Endpoints"
    tasks:
      - "Add POST /projects/:name/sessions/:id/fork endpoint"
      - "Add PATCH /projects/:name/sessions/:id endpoint for rename and tag"
      - "Add shared-types interfaces for fork/rename/tag responses"
    test_cases:
      - id: "p4-fork"
        description: "POST fork endpoint calls forkSession() and returns new session ID"
        type: "integration"
      - id: "p4-rename"
        description: "PATCH with title field calls renameSession() and returns 200"
        type: "integration"
      - id: "p4-tag"
        description: "PATCH with tag field calls tagSession() and returns 200"
        type: "integration"
      - id: "p4-not-found"
        description: "Fork/rename/tag on non-existent project returns 404"
        type: "integration"
---

# SDK Feature Expansion

> GitHub Issue: [#13](https://github.com/codevibesmatter/duraclaw/issues/13)

## Overview

cc-gateway uses approximately 30% of the Claude Agent SDK surface area. Critical features like interrupt, context usage tracking, model switching, file rewind, and rich event forwarding are missing, which limits the orchestrator UI to basic session execution. This spec wires the remaining high-value SDK capabilities through the gateway protocol so the orchestrator can offer mid-session control, context visibility, and task monitoring.

## Feature Behaviors

### B1: Store SDK Query Object in SessionContext

**Core:**
- **ID:** store-query-object
- **Trigger:** `executeSession()` calls `query()` and receives a `Query` iterator
- **Expected:** The returned `Query` object is stored as `ctx.query` on the `SessionContext`, making `interrupt()`, `setModel()`, `setPermissionMode()`, `getContextUsage()`, `rewindFiles()`, and `stopTask()` callable from WS command handlers
- **Verify:** After session init, `sessions.get(ws)?.query` is non-null and has method `interrupt`
- **Source:** `packages/cc-gateway/src/sessions.ts:260` (where `query()` is called and result is consumed in for-await without storing)

#### UI Layer

N/A -- backend only

#### API Layer

No new protocol messages. Internal refactor only: the `Query` instance (line 260 of `sessions.ts`) is assigned to `ctx.query` before the for-await loop begins.

#### Data Layer

Add `query` field to a gateway-local `GatewaySessionContext` type in `packages/cc-gateway/src/sessions.ts` (NOT in `packages/shared-types/src/index.ts`, because shared-types is consumed by the orchestrator on CF Workers which cannot depend on the Agent SDK):

```typescript
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { SessionContext } from '@duraclaw/shared-types'

/** Gateway-local extension of SessionContext with SDK-specific fields */
interface GatewaySessionContext extends SessionContext {
  /** SDK Query object — available after session.init, null before */
  query: Query | null
}
```

---

### B2: Command Queue for Pre-Session Commands

**Core:**
- **ID:** command-queue
- **Trigger:** A WS command (`set-model`, `interrupt`, etc.) arrives before the SDK `Query` object is available (session still initializing)
- **Expected:** The command is enqueued in `ctx.commandQueue`. When `ctx.query` becomes available (after `system/init`), all queued commands are drained and applied in order. If the session fails before `Query` is available, queued commands are rejected with an error event.
- **Verify:** Send `set-model` immediately after `execute`; verify no error and model change takes effect after init
- **Source:** `packages/cc-gateway/src/server.ts:203` (switch statement for WS commands)

#### UI Layer

N/A -- backend only

#### API Layer

No new protocol messages. The `switch` block in `server.ts` for new command types checks `ctx.query`: if null, pushes to `ctx.commandQueue`; if non-null, executes immediately.

#### Data Layer

Add `commandQueue` field to the gateway-local `GatewaySessionContext` (not shared-types, for the same reason as B1). Only control commands that operate on the Query object are queueable -- execution lifecycle commands like `execute`, `resume`, `abort`, and `stop-task` are not:

```typescript
/** Only commands that operate on a Query object can be queued before session init */
type QueueableCommand = InterruptCommand | SetModelCommand | SetPermissionModeCommand | GetContextUsageCommand

interface GatewaySessionContext extends SessionContext {
  // ...existing fields from B1...
  /** Queue for commands received before Query is available */
  commandQueue: QueueableCommand[]
}
```

Commands like `execute`, `resume`, `abort`, and `stop-task` must NOT be queued. They should return an error event immediately if sent at an invalid time.

---

### B3: Migrate to SDK Hooks API

**Core:**
- **ID:** hooks-migration
- **Trigger:** `executeSession()` builds SDK `options` for the `query()` call
- **Expected:** The ad-hoc `canUseTool` and `postToolUse` callbacks (lines 134-245 of `sessions.ts`) are replaced with the SDK `hooks` option using `PreToolUse` and `PostToolUse` hook events. `PreToolUse` handles both AskUserQuestion relay and permission gating. `PostToolUse` handles file-changed event emission. The `canUseTool` option is removed.
- **Verify:** Tool permission prompts still work; `file_changed` events still emitted for Edit/Write; no `canUseTool` or `postToolUse` keys in options
- **Source:** `packages/cc-gateway/src/sessions.ts:134-245` (canUseTool callback), `packages/cc-gateway/src/sessions.ts:228-245` (postToolUse callback)

#### UI Layer

N/A -- backend only

#### API Layer

No protocol changes. Internal refactor of how tool interception is wired.

The `HookCallback` return type is `Promise<HookJSONOutput>` where `HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput`. For synchronous permission gating, return a `SyncHookJSONOutput`:

```typescript
options.hooks = {
  PreToolUse: [{
    hooks: [async (input: HookInput, toolUseId: string | undefined, { signal }: { signal: AbortSignal }): Promise<HookJSONOutput> => {
      const hookInput = input as PreToolUseHookInput
      // permission gating + AskUserQuestion relay
      // SyncHookJSONOutput with PreToolUseHookSpecificOutput:
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow', // HookPermissionDecision: 'allow' | 'deny' | 'ask' | 'defer'
        } satisfies PreToolUseHookSpecificOutput,
      }
    }]
  }],
  PostToolUse: [{
    hooks: [async (input: HookInput, toolUseId: string | undefined, { signal }): Promise<HookJSONOutput> => {
      // file-changed emission
      return { continue: true }
    }]
  }]
}
```

#### Data Layer

No schema changes.

---

### B4: Thinking and Effort Options

**Core:**
- **ID:** thinking-effort-options
- **Trigger:** Orchestrator sends an `execute` command with `thinking` and/or `effort` fields
- **Expected:** The `thinking` config (type `ThinkingConfig`: `{ type: 'adaptive' }`, `{ type: 'enabled', budgetTokens: N }`, or `{ type: 'disabled' }`) and `effort` level (`'low' | 'medium' | 'high' | 'max'`) are passed through to the SDK `Options` object
- **Verify:** Send execute with `{ "thinking": { "type": "adaptive" }, "effort": "high" }`; verify SDK receives these values
- **Source:** `packages/cc-gateway/src/sessions.ts:122-131` (where execute options are mapped)

#### UI Layer

N/A -- backend only

#### API Layer

Extended `ExecuteCommand`:
```typescript
export interface ExecuteCommand {
  // ...existing fields...
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
           | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }
           | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'max'
}
```

#### Data Layer

Add `thinking` and `effort` fields to `ExecuteCommand` in `packages/shared-types/src/index.ts`.

---

### B5: Enable File Checkpointing by Default

**Core:**
- **ID:** enable-file-checkpointing
- **Trigger:** `executeSession()` builds the SDK options
- **Expected:** `enableFileCheckpointing: true` is always included in the options passed to `query()`, enabling `rewindFiles()` to work
- **Verify:** After session init, calling `query.rewindFiles()` does not return "checkpointing not enabled" error
- **Source:** `packages/cc-gateway/src/sessions.ts:113-120` (options object construction)

#### UI Layer

N/A -- backend only

#### API Layer

No protocol changes. One-line addition to SDK options.

#### Data Layer

No schema changes.

---

### B6: Interrupt Command

**Core:**
- **ID:** interrupt-command
- **Trigger:** Orchestrator sends `{ "type": "interrupt", "session_id": "..." }` over WebSocket
- **Expected:** Calls `ctx.query.interrupt()` which soft-stops the current turn but keeps the session alive (unlike `abort` which kills it). The session can receive new messages after interrupt.
- **Verify:** Send interrupt during a long tool execution; session remains open and can process follow-up messages
- **Source:** `packages/cc-gateway/src/server.ts:275-299` (near existing abort/stop handlers)

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayCommand`:
```typescript
export interface InterruptCommand {
  type: 'interrupt'
  session_id: string
}
```

WS handler: look up `ctx.query`, call `await ctx.query.interrupt()`. If `ctx.query` is null, queue command.

#### Data Layer

Add `InterruptCommand` to `GatewayCommand` union in `packages/shared-types/src/index.ts`.

---

### B7: Get Context Usage Command

**Core:**
- **ID:** get-context-usage
- **Trigger:** Orchestrator sends `{ "type": "get-context-usage", "session_id": "..." }` over WebSocket
- **Expected:** Calls `ctx.query.getContextUsage()` and sends back a `context_usage` event with token breakdown by category, total tokens, max tokens, percentage used, and model name
- **Verify:** Send `get-context-usage` during an active session; receive `context_usage` event with `totalTokens > 0`
- **Source:** New handler in `packages/cc-gateway/src/server.ts` switch block

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayCommand`:
```typescript
export interface GetContextUsageCommand {
  type: 'get-context-usage'
  session_id: string
}
```

New `GatewayEvent` -- passes through the full `SDKControlGetContextUsageResponse` to avoid lossy simplification. The orchestrator can pick the fields it needs:
```typescript
export interface ContextUsageEvent {
  type: 'context_usage'
  session_id: string
  /** Full SDK response from query.getContextUsage() */
  usage: SDKControlGetContextUsageResponse
  // SDKControlGetContextUsageResponse includes:
  //   categories, totalTokens, maxTokens, rawMaxTokens, percentage,
  //   gridRows, model, memoryFiles, mcpTools, deferredBuiltinTools,
  //   systemTools, systemPromptSections, agents, slashCommands, skills,
  //   autoCompactThreshold, isAutoCompactEnabled, messageBreakdown, apiUsage
}
```

#### Data Layer

Add `GetContextUsageCommand` and `ContextUsageEvent` to shared-types.

---

### B8: Set Model Command

**Core:**
- **ID:** set-model-command
- **Trigger:** Orchestrator sends `{ "type": "set-model", "session_id": "...", "model": "claude-sonnet-4-6" }` over WebSocket
- **Expected:** Calls `ctx.query.setModel(model)` to switch the model for subsequent turns. If model is omitted/null, resets to default.
- **Verify:** Send `set-model` with `"claude-haiku-4-6"`; next assistant message uses the new model
- **Source:** New handler in `packages/cc-gateway/src/server.ts` switch block

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayCommand`:
```typescript
export interface SetModelCommand {
  type: 'set-model'
  session_id: string
  model?: string
}
```

No response event -- the next `session_state_changed` or `assistant` message will reflect the new model.

#### Data Layer

Add `SetModelCommand` to `GatewayCommand` union in `packages/shared-types/src/index.ts`.

---

### B9: Set Permission Mode Command

**Core:**
- **ID:** set-permission-mode-command
- **Trigger:** Orchestrator sends `{ "type": "set-permission-mode", "session_id": "...", "mode": "acceptEdits" }` over WebSocket
- **Expected:** Calls `ctx.query.setPermissionMode(mode)` to change permission handling mid-session. Valid modes: `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- **Verify:** Send `set-permission-mode` with `"acceptEdits"`; subsequent Edit tool calls no longer trigger permission_request events
- **Source:** New handler in `packages/cc-gateway/src/server.ts` switch block

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayCommand`:
```typescript
export interface SetPermissionModeCommand {
  type: 'set-permission-mode'
  session_id: string
  mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
}
```

#### Data Layer

Add `SetPermissionModeCommand` to `GatewayCommand` union in `packages/shared-types/src/index.ts`.

---

### B10: Rewind Command (Complete Implementation)

**Core:**
- **ID:** rewind-command
- **Trigger:** Orchestrator sends `{ "type": "rewind", "session_id": "...", "message_id": "..." }` over WebSocket
- **Expected:** Calls `ctx.query.rewindFiles(message_id, { dryRun })` to restore file state to a given user message checkpoint (or preview changes if `dry_run` is true). Returns a `rewind_result` event with `canRewind`, `filesChanged`, `insertions`, `deletions`, and optional `error`. Replaces the current stub that returns "not implemented".
- **Verify:** Execute session that edits a file, then send rewind to the pre-edit message; file contents restored. Send rewind with `dry_run: true`; file contents unchanged but `rewind_result` still reports changes.
- **Source:** `packages/cc-gateway/src/server.ts:302-321` (existing rewind stub)

#### UI Layer

N/A -- backend only

#### API Layer

Existing `RewindCommand` already defined at `packages/shared-types/src/index.ts:69-73`. Add an optional `dry_run` field:

```typescript
export interface RewindCommand {
  type: 'rewind'
  session_id: string
  message_id: string
  /** If true, preview what would change without modifying files (SDK: dryRun option) */
  dry_run?: boolean
}
```

New `GatewayEvent`:
```typescript
export interface RewindResultEvent {
  type: 'rewind_result'
  session_id: string
  can_rewind: boolean
  error?: string
  files_changed?: string[]
  insertions?: number
  deletions?: number
}
```

#### Data Layer

Add `RewindResultEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts`.

---

### B11: Stop Task Command

**Core:**
- **ID:** stop-task-command
- **Trigger:** Orchestrator sends `{ "type": "stop-task", "session_id": "...", "task_id": "..." }` over WebSocket
- **Expected:** Calls `ctx.query.stopTask(task_id)` to stop a running background task. A `task_notification` event with `status: 'stopped'` will be emitted by the SDK. **Note:** `stop-task` requires an active session with a Query object. If `ctx.query` is null (session not yet initialized or already ended), return an error event immediately rather than queueing -- unlike control commands (set-model, interrupt, etc.), stop-task is meaningless without a running Query.
- **Verify:** Start a session with a background task, send stop-task; receive task_notification with status stopped. Also verify: send stop-task before session init; receive an error event (not queued).
- **Source:** New handler in `packages/cc-gateway/src/server.ts` switch block

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayCommand`:
```typescript
export interface StopTaskCommand {
  type: 'stop-task'
  session_id: string
  task_id: string
}
```

#### Data Layer

Add `StopTaskCommand` to `GatewayCommand` union in `packages/shared-types/src/index.ts`.

---

### B12: Forward Session State Changed Events

**Core:**
- **ID:** forward-session-state-changed
- **Trigger:** SDK emits `SDKSessionStateChangedMessage` (`type: 'system', subtype: 'session_state_changed'`)
- **Expected:** Gateway forwards as a `session_state_changed` event with `state: 'idle' | 'running' | 'requires_action'`
- **Verify:** During session execution, receive `session_state_changed` events with transitioning states
- **Source:** `packages/cc-gateway/src/sessions.ts:266-349` (for-await message handling loop)

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayEvent`:
```typescript
export interface SessionStateChangedEvent {
  type: 'session_state_changed'
  session_id: string
  state: 'idle' | 'running' | 'requires_action'
}
```

Added as a new `else if` branch in the for-await loop checking `message.type === 'system' && message.subtype === 'session_state_changed'`.

#### Data Layer

Add `SessionStateChangedEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts`.

---

### B13: Forward Rate Limit Events

**Core:**
- **ID:** forward-rate-limit
- **Trigger:** SDK emits `SDKRateLimitEvent` (`type: 'rate_limit_event'`)
- **Expected:** Gateway forwards as a `rate_limit` event with the full `rate_limit_info` payload including `status`, `resetsAt`, `utilization`, and overage info
- **Verify:** Trigger rate limiting (high-volume requests); receive `rate_limit` events with `status: 'allowed_warning'`
- **Source:** `packages/cc-gateway/src/sessions.ts:266-349` (for-await message handling loop)

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayEvent`:
```typescript
export interface RateLimitEvent {
  type: 'rate_limit'
  session_id: string
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected'
    resetsAt?: number
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage'
    utilization?: number
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected'
    overageResetsAt?: number
    overageDisabledReason?: 'overage_not_provisioned' | 'org_level_disabled' | 'org_level_disabled_until' | 'out_of_credits' | 'seat_tier_level_disabled' | 'member_level_disabled' | 'seat_tier_zero_credit_limit' | 'group_zero_credit_limit' | 'member_zero_credit_limit' | 'org_service_level_disabled' | 'org_service_zero_credit_limit' | 'no_limits_configured' | 'unknown'
    isUsingOverage?: boolean
    surpassedThreshold?: number
  }
}
```

#### Data Layer

Add `RateLimitEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts`.

---

### B14: Forward Task Started Events

**Core:**
- **ID:** forward-task-started
- **Trigger:** SDK emits `SDKTaskStartedMessage` (`type: 'system', subtype: 'task_started'`)
- **Expected:** Gateway forwards as a `task_started` event with `task_id`, `description`, optional `task_type` and `prompt`
- **Verify:** Execute a session that spawns a subagent task; receive `task_started` event
- **Source:** `packages/cc-gateway/src/sessions.ts:266-349` (for-await message handling loop)

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayEvent`:
```typescript
export interface TaskStartedEvent {
  type: 'task_started'
  session_id: string
  task_id: string
  description: string
  task_type?: string
  prompt?: string
}
```

#### Data Layer

Add `TaskStartedEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts`.

---

### B15: Forward Task Progress Events

**Core:**
- **ID:** forward-task-progress
- **Trigger:** SDK emits `SDKTaskProgressMessage` (`type: 'system', subtype: 'task_progress'`)
- **Expected:** Gateway forwards as a `task_progress` event with `task_id`, `description`, `usage`, and optional `summary`
- **Verify:** During background task execution, receive periodic `task_progress` events with increasing `usage.total_tokens`
- **Source:** `packages/cc-gateway/src/sessions.ts:266-349` (for-await message handling loop)

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayEvent`:
```typescript
export interface TaskProgressEvent {
  type: 'task_progress'
  session_id: string
  task_id: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
}
```

#### Data Layer

Add `TaskProgressEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts`.

---

### B16: Forward Task Notification Events

**Core:**
- **ID:** forward-task-notification
- **Trigger:** SDK emits `SDKTaskNotificationMessage` (`type: 'system', subtype: 'task_notification'`)
- **Expected:** Gateway forwards as a `task_notification` event with `task_id`, `status` (`'completed' | 'failed' | 'stopped'`), `summary`, and `usage`
- **Verify:** After background task completes, receive `task_notification` with `status: 'completed'`
- **Source:** `packages/cc-gateway/src/sessions.ts:266-349` (for-await message handling loop)

#### UI Layer

N/A -- backend only

#### API Layer

New `GatewayEvent`:
```typescript
export interface TaskNotificationEvent {
  type: 'task_notification'
  session_id: string
  task_id: string
  status: 'completed' | 'failed' | 'stopped'
  summary: string
  output_file: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}
```

#### Data Layer

Add `TaskNotificationEvent` to `GatewayEvent` union in `packages/shared-types/src/index.ts`.

---

### B17: Fork Session HTTP Endpoint

**Core:**
- **ID:** fork-session-endpoint
- **Trigger:** HTTP `POST /projects/:name/sessions/:id/fork` with optional JSON body `{ "up_to_message_id": "...", "title": "..." }`
- **Expected:** Calls SDK `forkSession(id, { dir: projectPath, upToMessageId, title })` and returns `{ session_id: "new-uuid" }` with status 200. Returns 404 if project not found.
- **Verify:** Fork an existing session; verify new session ID is returned and is resumable
- **Source:** `packages/cc-gateway/src/server.ts:107-133` (near existing session endpoints)

#### UI Layer

N/A -- backend only

#### API Layer

```
POST /projects/:name/sessions/:id/fork
Authorization: Bearer <token>
Content-Type: application/json

{ "up_to_message_id": "optional-uuid", "title": "optional title" }

200: { "session_id": "new-session-uuid" }
404: { "error": "Project \"foo\" not found" }
500: { "error": "Fork failed: ..." }
```

#### Data Layer

No shared-types changes needed. Response is ad-hoc JSON.

---

### B18: Rename and Tag Session HTTP Endpoint

**Core:**
- **ID:** rename-tag-session-endpoint
- **Trigger:** HTTP `PATCH /projects/:name/sessions/:id` with JSON body `{ "title": "...", "tag": "..." }`
- **Expected:** If `title` is present, calls `renameSession(id, title, { dir: projectPath })`. If `tag` is present, calls `tagSession(id, tag, { dir: projectPath })`. Both can be provided. Returns 200 on success, 404 if project not found.
- **Verify:** Rename a session; call `GET /projects/:name/sessions` and verify the new title appears
- **Source:** `packages/cc-gateway/src/server.ts:107-133` (near existing session endpoints)

#### UI Layer

N/A -- backend only

#### API Layer

```
PATCH /projects/:name/sessions/:id
Authorization: Bearer <token>
Content-Type: application/json

{ "title": "new title", "tag": "v1.0" }

200: { "ok": true }
404: { "error": "Project \"foo\" not found" }
500: { "error": "Rename failed: ..." }
```

`tag` accepts `null` to remove an existing tag (SDK: `tagSession(id, null)`).

#### Data Layer

No shared-types changes needed. Response is ad-hoc JSON.

---

## Non-Goals

Explicitly out of scope for this feature:
- MCP server injection via `mcpServers` option (separate spec when needed)
- Structured output via `outputFormat` (pipeline feature, not interactive)
- Custom agents / `AgentDefinition` passed from orchestrator (separate spec)
- V2 Session API adoption (`unstable_v2_createSession` is alpha)
- Bridge API or Assistant API integration (different architecture)
- Protocol versioning between gateway and orchestrator (deployed together)
- Subagent introspection (`listSubagents`, `getSubagentMessages`)

## Open Questions

- [x] Should we use hooks or canUseTool for permission gating? **Decision: migrate to hooks API**
- [x] Should commands before session init error or queue? **Decision: queue-and-apply**
- [x] Should enableFileCheckpointing be configurable per-session? **Decision: always on by default, can override via execute command later if needed**

## Implementation Phases

See YAML frontmatter `phases:` above. Each phase should be 1-4 hours of focused work.

## Verification Strategy

### Test Infrastructure

bun:test with mocks for the SDK `query()` function and `Query` interface. Test config exists at `packages/cc-gateway/src/*.test.ts` (see `files.test.ts`, `kata.test.ts`). New test files: `sessions.test.ts` for unit tests on type guards and option building, `server-commands.test.ts` for integration tests on WS command routing with a mock SDK.

### Build Verification

Run `pnpm typecheck` from monorepo root. The `packages/cc-gateway/tsconfig.json` excludes `*.test.ts` from tsc (see memory: feedback_bun_test_tsconfig). Run `bun test` from `packages/cc-gateway/` for test execution.

## Verification Plan

Concrete, executable steps to verify the feature works against the REAL running system.
NOT unit tests -- these are commands a fresh agent can run to confirm end-to-end behavior.

### VP1: Interrupt a Running Session

Steps:
1. Open a WebSocket connection and start a session:
   ```bash
   wscat -c 'ws://127.0.0.1:9877?project=duraclaw' -H 'Authorization: Bearer <token>'
   ```
   Send: `{"type":"execute","project":"duraclaw","prompt":"Read every file in the src directory and summarize each one in detail"}`
   Expected: Receive `session.init` event with `sdk_session_id`

2. While the session is processing, send interrupt:
   ```bash
   {"type":"interrupt","session_id":"<session_id_from_init>"}
   ```
   Expected: Session stops current turn. No `error` event. Session remains alive (no `result` event with error subtype). Can send follow-up messages.

### VP2: Get Context Usage

Steps:
1. Start a session via WebSocket (same as VP1 step 1).
   Wait for at least one `assistant` event (session has context).

2. Send context usage request:
   ```bash
   {"type":"get-context-usage","session_id":"<session_id>"}
   ```
   Expected: Receive `context_usage` event with `totalTokens > 0`, `maxTokens > 0`, `percentage > 0`, non-empty `categories` array, and `model` string.

### VP3: Set Model Mid-Session

Steps:
1. Start a session with default model. Wait for `session.init`.

2. Send model change:
   ```bash
   {"type":"set-model","session_id":"<session_id>","model":"claude-haiku-4-6"}
   ```
   Expected: No error event. Subsequent turns use the new model (visible in next `session.init` or context usage response).

### VP4: Rewind Files

Steps:
1. Start a session:
   ```bash
   {"type":"execute","project":"duraclaw","prompt":"Create a file called /tmp/duraclaw-rewind-test.txt with content 'hello'"}
   ```
   Expected: `file_changed` event for `/tmp/duraclaw-rewind-test.txt`. Note the `assistant` message UUID.

2. Send another message to modify the file:
   ```bash
   {"type":"stream-input","session_id":"<id>","message":{"role":"user","content":"Now change the file to say 'world'"}}
   ```
   Expected: Another `file_changed` event.

3. Send rewind to the first user message:
   ```bash
   {"type":"rewind","session_id":"<id>","message_id":"<first_assistant_uuid>"}
   ```
   Expected: `rewind_result` event with `can_rewind: true`, `files_changed` including the test file.

4. Verify file contents:
   ```bash
   cat /tmp/duraclaw-rewind-test.txt
   ```
   Expected: Content is `hello` (reverted).

### VP5: Session State Changed Events

Steps:
1. Start a session and observe WebSocket messages.
   Expected: Receive `session_state_changed` events with `state: 'running'` during tool execution and `state: 'idle'` between turns.

### VP6: Fork Session via HTTP

Steps:
1. List existing sessions:
   ```bash
   curl -s -H 'Authorization: Bearer <token>' http://127.0.0.1:9877/projects/duraclaw/sessions | jq '.sessions[0].session_id'
   ```
   Expected: A session ID string.

2. Fork the session:
   ```bash
   curl -s -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
     -d '{"title":"fork test"}' \
     http://127.0.0.1:9877/projects/duraclaw/sessions/<session_id>/fork | jq .
   ```
   Expected: `{ "session_id": "<new-uuid>" }` with status 200.

3. Verify the fork appears in session list:
   ```bash
   curl -s -H 'Authorization: Bearer <token>' http://127.0.0.1:9877/projects/duraclaw/sessions | jq '.sessions[] | select(.session_id == "<new-uuid>")'
   ```
   Expected: Session entry with title "fork test".

### VP7: Rename and Tag Session via HTTP

Steps:
1. Get a session ID (same as VP6 step 1).

2. Rename and tag:
   ```bash
   curl -s -X PATCH -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
     -d '{"title":"renamed session","tag":"v1"}' \
     http://127.0.0.1:9877/projects/duraclaw/sessions/<session_id> | jq .
   ```
   Expected: `{ "ok": true }` with status 200.

3. Verify in session list:
   ```bash
   curl -s -H 'Authorization: Bearer <token>' http://127.0.0.1:9877/projects/duraclaw/sessions | jq '.sessions[] | select(.session_id == "<session_id>")'
   ```
   Expected: Session shows updated `summary` (title) and `tag` field.

### VP8: Tool Permission Flow via Hooks API

Steps:
1. Open a WebSocket connection and start a session with default permission mode:
   ```bash
   wscat -c 'ws://127.0.0.1:9877?project=duraclaw' -H 'Authorization: Bearer <token>'
   ```
   Send: `{"type":"execute","project":"duraclaw","prompt":"Edit the file /tmp/duraclaw-hooks-test.txt and add a line"}`
   Expected: Receive a `permission_request` event (proving the PreToolUse hook fired for the Edit tool).

2. Send a permission response allowing the tool:
   ```bash
   {"type":"permission-response","session_id":"<session_id>","tool_use_id":"<tool_use_id>","decision":"allow"}
   ```
   Expected: The tool executes. Receive a `file_changed` event (proving PostToolUse hook fired). No `canUseTool` key in SDK options (legacy callback removed).

3. Verify no `canUseTool` or `postToolUse` keys remain in the options passed to `query()` by inspecting server logs or by confirming the hook-based flow works end-to-end.

### VP9: Thinking, Effort, and File Checkpointing Options

Steps:
1. Open a WebSocket connection and start a session with thinking and effort:
   ```bash
   wscat -c 'ws://127.0.0.1:9877?project=duraclaw' -H 'Authorization: Bearer <token>'
   ```
   Send: `{"type":"execute","project":"duraclaw","prompt":"What is 2+2?","thinking":{"type":"adaptive"},"effort":"high"}`
   Expected: Receive `session.init` event. Session completes without errors. The thinking and effort values are accepted by the SDK (no "invalid option" errors).

2. Verify file checkpointing is enabled by sending a rewind after a file edit:
   Send: `{"type":"execute","project":"duraclaw","prompt":"Create /tmp/duraclaw-checkpoint-test.txt with 'original'"}`
   Wait for completion. Then send rewind with `dry_run: true`:
   ```bash
   {"type":"rewind","session_id":"<session_id>","message_id":"<message_id>","dry_run":true}
   ```
   Expected: `rewind_result` with `can_rewind: true` (not "checkpointing not enabled" error), confirming `enableFileCheckpointing: true` is set.

## Implementation Hints

### Dependencies

No new package dependencies. All features use the existing `@anthropic-ai/claude-agent-sdk@0.2.98`.

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@anthropic-ai/claude-agent-sdk` | `query` | Core query function (already imported) |
| `@anthropic-ai/claude-agent-sdk` | `Query` | Type for stored query object on SessionContext |
| `@anthropic-ai/claude-agent-sdk` | `forkSession` | Fork session in Phase 4 HTTP endpoint |
| `@anthropic-ai/claude-agent-sdk` | `renameSession` | Rename session in Phase 4 HTTP endpoint |
| `@anthropic-ai/claude-agent-sdk` | `tagSession` | Tag session in Phase 4 HTTP endpoint |
| `@anthropic-ai/claude-agent-sdk` | `Options` | Type for SDK query options (thinking, effort, hooks, enableFileCheckpointing) |
| `@anthropic-ai/claude-agent-sdk` | `HookEvent` | Type union: `'PreToolUse' \| 'PostToolUse' \| ...` (27 events) |
| `@anthropic-ai/claude-agent-sdk` | `HookCallbackMatcher` | Type: `{ matcher?: string; hooks: HookCallback[]; timeout?: number }` |
| `@anthropic-ai/claude-agent-sdk` | `HookCallback` | Type: `(input: HookInput, toolUseID: string \| undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>` |
| `@anthropic-ai/claude-agent-sdk` | `HookJSONOutput` | Type: `AsyncHookJSONOutput \| SyncHookJSONOutput` -- return type of HookCallback |
| `@anthropic-ai/claude-agent-sdk` | `SyncHookJSONOutput` | Type: `{ continue?: boolean; suppressOutput?: boolean; decision?: 'approve' \| 'block'; hookSpecificOutput?: PreToolUseHookSpecificOutput \| ... }` |
| `@anthropic-ai/claude-agent-sdk` | `PreToolUseHookInput` | Type: `BaseHookInput & { hook_event_name: 'PreToolUse'; tool_name: string; tool_input: unknown; tool_use_id: string }` |
| `@anthropic-ai/claude-agent-sdk` | `PreToolUseHookSpecificOutput` | Type: `{ hookEventName: 'PreToolUse'; permissionDecision?: HookPermissionDecision; updatedInput?: Record<string, unknown>; additionalContext?: string }` |
| `@anthropic-ai/claude-agent-sdk` | `HookPermissionDecision` | Type: `'allow' \| 'deny' \| 'ask' \| 'defer'` |
| `@anthropic-ai/claude-agent-sdk` | `ThinkingConfig` | Type: `ThinkingAdaptive \| ThinkingEnabled \| ThinkingDisabled` |
| `@anthropic-ai/claude-agent-sdk` | `EffortLevel` | Type: `'low' \| 'medium' \| 'high' \| 'max'` |
| `@anthropic-ai/claude-agent-sdk` | `PermissionMode` | Type: `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` |
| `@anthropic-ai/claude-agent-sdk` | `SDKControlGetContextUsageResponse` | Return type of `query.getContextUsage()` |
| `@anthropic-ai/claude-agent-sdk` | `RewindFilesResult` | Return type of `query.rewindFiles()`: `{ canRewind, error?, filesChanged?, insertions?, deletions? }` |
| `@anthropic-ai/claude-agent-sdk` | `ForkSessionOptions` | Type: `SessionMutationOptions & { upToMessageId?, title? }` |
| `@anthropic-ai/claude-agent-sdk` | `ForkSessionResult` | Type: `{ sessionId: string }` |
| `@anthropic-ai/claude-agent-sdk` | `SessionMutationOptions` | Type: `{ dir?: string }` |
| `@anthropic-ai/claude-agent-sdk` | `SDKSessionStateChangedMessage` | SDK message: `{ type: 'system', subtype: 'session_state_changed', state }` |
| `@anthropic-ai/claude-agent-sdk` | `SDKRateLimitEvent` | SDK message: `{ type: 'rate_limit_event', rate_limit_info }` |
| `@anthropic-ai/claude-agent-sdk` | `SDKTaskStartedMessage` | SDK message: `{ type: 'system', subtype: 'task_started', task_id, description }` |
| `@anthropic-ai/claude-agent-sdk` | `SDKTaskProgressMessage` | SDK message: `{ type: 'system', subtype: 'task_progress', task_id, usage }` |
| `@anthropic-ai/claude-agent-sdk` | `SDKTaskNotificationMessage` | SDK message: `{ type: 'system', subtype: 'task_notification', task_id, status, summary }` |

### Code Patterns

**Storing the Query object:**
```typescript
// sessions.ts — after calling query(), store on ctx
const iter = query({ prompt: messageGenerator(), options: options as any })
ctx.query = iter  // Query extends AsyncGenerator<SDKMessage, void>

for await (const message of iter) {
  // ...existing handling
}
```

**Hooks-based permission gating (replacing canUseTool):**
```typescript
import type { HookCallbackMatcher, HookCallback, HookJSONOutput, PreToolUseHookInput, PreToolUseHookSpecificOutput, HookPermissionDecision } from '@anthropic-ai/claude-agent-sdk'

const preToolUseHook: HookCallback = async (input, toolUseId, { signal }) => {
  const hookInput = input as PreToolUseHookInput
  if (hookInput.tool_name === 'AskUserQuestion') {
    // relay questions, wait for answer
    const output: PreToolUseHookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { /* modified input if needed */ },
    }
    return { continue: true, hookSpecificOutput: output }
  }
  // relay permission request, wait for response
  const decision: HookPermissionDecision = 'allow' // or 'deny', 'ask', 'defer'
  return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } satisfies PreToolUseHookSpecificOutput }
}

options.hooks = {
  PreToolUse: [{ hooks: [preToolUseHook] }],
  PostToolUse: [{ hooks: [postToolUseHook] }],
}
// Remove options.canUseTool and options.postToolUse
```

**Command queue drain:**
```typescript
// In sessions.ts, after Query is available and session.init received:
if (ctx.commandQueue.length > 0) {
  for (const queuedCmd of ctx.commandQueue) {
    await handleQueryCommand(ctx, queuedCmd, ws)
  }
  ctx.commandQueue = []
}
```

**Event forwarding in the for-await loop:**
```typescript
} else if (message.type === 'system' && (message as any).subtype === 'session_state_changed') {
  send(ws, {
    type: 'session_state_changed',
    session_id: sessionId,
    state: (message as any).state,
  })
} else if (message.type === 'rate_limit_event') {
  send(ws, {
    type: 'rate_limit',
    session_id: sessionId,
    rate_limit_info: (message as any).rate_limit_info,
  })
}
```

**HTTP endpoint for fork:**
```typescript
const forkMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/fork$/)
if (req.method === 'POST' && forkMatch) {
  const [, name, sessionId] = forkMatch
  const projectPath = await resolveProject(name)
  if (!projectPath) return json(404, { error: `Project "${name}" not found` })
  try {
    const body = await req.json().catch(() => ({}))
    const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
    const result = await forkSession(sessionId, {
      dir: projectPath,
      upToMessageId: body.up_to_message_id,
      title: body.title,
    })
    return json(200, { session_id: result.sessionId })
  } catch (err) {
    return json(500, { error: `Fork failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}
```

**HTTP endpoint for rename/tag (same try/catch pattern):**
```typescript
const patchMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/)
if (req.method === 'PATCH' && patchMatch) {
  const [, name, sessionId] = patchMatch
  const projectPath = await resolveProject(name)
  if (!projectPath) return json(404, { error: `Project "${name}" not found` })
  try {
    const body = await req.json()
    const { renameSession, tagSession } = await import('@anthropic-ai/claude-agent-sdk')
    if (body.title !== undefined) await renameSession(sessionId, body.title, { dir: projectPath })
    if (body.tag !== undefined) await tagSession(sessionId, body.tag, { dir: projectPath })
    return json(200, { ok: true })
  } catch (err) {
    return json(500, { error: `Update failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}
```

### Gotchas

- The `Query` object returned by `query()` extends `AsyncGenerator<SDKMessage, void>`. It is both the iterator (for-await) and the control interface (interrupt, setModel, etc.). Storing it does not interfere with the for-await loop -- they share the same object.
- `query.interrupt()` is async and may take a moment to take effect. The for-await loop continues until the current yield resolves. Do not assume immediate cessation.
- `query.rewindFiles()` requires `enableFileCheckpointing: true` in options. Without it, the method returns `{ canRewind: false, error: 'File checkpointing is not enabled' }`.
- The `hooks` option replaces `canUseTool` for permission decisions. If both are provided, the SDK uses `canUseTool` and ignores `PreToolUse` hooks for permission. We must remove `canUseTool` when switching to hooks.
- `forkSession`, `renameSession`, and `tagSession` are standalone functions (not Query methods). They operate on the session's JSONL file on disk and do not require an active session.
- SDK messages use `(message as any)` casts because the for-await yields `SDKMessage` which is a large union type. Type narrowing should check both `message.type` and `message.subtype` for system messages.
- The `PostToolUse` hook receives `PostToolUseHookInput` with `tool_name`, `tool_input`, `tool_response`, and `tool_use_id`. The current `postToolUse` callback has a slightly different signature `(toolName, input, output)` -- the hook version provides more data.

### Reference Docs

- [Claude Agent SDK README](https://github.com/anthropics/claude-agent-sdk-typescript) -- main SDK documentation
- [SDK Types (sdk.d.ts)](../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.98_@cfworker+json-schema@4.1.1_zod@4.3.6/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) -- full type definitions, 4551 lines
- [Research: SDK Gap Analysis](../research/2026-04-10-agent-sdk-gap-analysis.md) -- detailed gap analysis with tier classifications
