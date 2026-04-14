---
initiative: session-message-format
type: project
issue_type: feature
status: draft
priority: high
github_issue: 36
created: 2026-04-14
updated: 2026-04-14
phases:
  - id: p1
    name: "Session adoption as persistence layer"
    tasks:
      - "Add agents@0.11.0 (pinned exact) + peer deps (ai, zod) to orchestrator"
      - "Create gateway-event-to-parts mapper in SessionAgent (all event types)"
      - "Replace events table with Session.appendMessage/updateMessage"
      - "Update getMessages() RPC to return SessionMessage[]"
      - "Update reconnect replay to use Session.getHistory()"
      - "Add migration v4 to rename old tables to _deprecated_* (keep migration files 1-3 in chain); add migration v5 to drop _deprecated tables after P1 validation"
      - "Remove ChatMessage type, update imports"
    test_cases:
      - id: "session-persist-assistant"
        description: "Gateway assistant event is persisted as SessionMessage with TextUIPart"
        type: "integration"
      - id: "session-persist-tool"
        description: "Gateway tool_result event updates the ToolInvocationUIPart state to output-available"
        type: "integration"
      - id: "session-persist-thinking"
        description: "Gateway assistant event with thinking blocks creates ReasoningUIPart"
        type: "integration"
      - id: "session-reconnect-replay"
        description: "Client reconnect receives SessionMessage[] from Session.getHistory()"
        type: "integration"
      - id: "session-streaming-update"
        description: "partial_assistant events update in-flight message parts with state:streaming"
        type: "integration"
      - id: "mapper-unit-text"
        description: "gatewayEventToParts maps assistant text block to {type:'text', state:'done'}"
        type: "unit"
      - id: "mapper-unit-tool"
        description: "gatewayEventToParts maps tool_use block to {type:'tool-{name}', state:'input-available'}"
        type: "unit"
      - id: "mapper-unit-thinking"
        description: "gatewayEventToParts maps thinking block to {type:'reasoning', state:'done'}"
        type: "unit"
      - id: "mapper-unit-tool-result"
        description: "applyToolResult updates matching part by toolCallId to output-available or output-error"
        type: "unit"
      - id: "mapper-unit-user"
        description: "User message creates SessionMessage with role:'user' and text part"
        type: "unit"
      - id: "mapper-unit-file-changed"
        description: "file_changed event adds data-file-changed part with path and action"
        type: "unit"
      - id: "wire-format-broadcast"
        description: "broadcastGatewayEvent sends {type:'message', message: SessionMessage} not {type:'gateway_event'}"
        type: "unit"
      - id: "mapper-error-fallback"
        description: "When appendMessage throws, client receives {type:'raw_event'} fallback broadcast"
        type: "unit"
      - id: "session-coldstart-config"
        description: "On DO wake, turnCounter loads from assistant_config and produces correct message IDs"
        type: "unit"
      - id: "session-coldstart-seed"
        description: "On first use (no config), turnCounter seeds from getPathLength()+1 to avoid ID collisions"
        type: "unit"
  - id: p2
    name: "ChatThread parts rendering + streaming"
    tasks:
      - "Update ChatThread to render message.parts instead of JSON parsing"
      - "Map TextUIPart to MessageResponse with isAnimating"
      - "Map ToolInvocationUIPart to Tool/ToolHeader/ToolContent"
      - "Map ReasoningUIPart to Reasoning/ReasoningTrigger/ReasoningContent"
      - "Replace StreamingText with ai-elements built-in streaming"
      - "Update OPFS cache schema to store SessionMessage parts"
      - "Update useCodingAgent to work with SessionMessage[]"
    test_cases:
      - id: "render-text-part"
        description: "TextUIPart renders via MessageResponse component"
        type: "smoke"
      - id: "render-tool-part"
        description: "ToolInvocationUIPart renders Tool with correct state badge"
        type: "smoke"
      - id: "render-reasoning-part"
        description: "ReasoningUIPart renders collapsible Reasoning block"
        type: "smoke"
      - id: "streaming-text"
        description: "In-flight text renders with isAnimating, no custom cursor div"
        type: "smoke"
      - id: "render-gate-approval"
        description: "tool-ask_user part with state:approval-requested renders GateResolver, transitions to Tool after approval"
        type: "smoke"
      - id: "wire-format-message"
        description: "WebSocket frame for real-time assistant response has type:'message' with parts array, not type:'gateway_event'"
        type: "integration"
      - id: "opfs-cache-roundtrip"
        description: "SessionMessage cached to OPFS and restored on session reopen"
        type: "integration"
  - id: p3a
    name: "Message branching"
    tasks:
      - "Add MessageBranch with version navigation to ChatThread"
      - "Wire branching to Session.getBranches() + appendMessage(msg, parentId)"
      - "Add getBranches() and resubmitMessage() RPCs, extend getMessages() with optional leafId"
      - "Update useCodingAgent to track active branch leaf client-side"
    test_cases:
      - id: "branch-navigate"
        description: "User can navigate between message branches via MessageBranch arrows"
        type: "smoke"
      - id: "branch-create"
        description: "Editing a user message creates a new branch from that point"
        type: "integration"
      - id: "branch-reconnect"
        description: "After reconnect, getMessages() returns latest branch; client can switch to other branches via getMessages(leafId)"
        type: "integration"
      - id: "branch-resubmit-streaming"
        description: "Resubmit while streaming aborts current stream before creating branch"
        type: "integration"
  - id: p3b
    name: "Suggestions + compound PromptInput"
    tasks:
      - "Add Suggestions component for empty state with static starter prompts"
      - "Upgrade MessageInput to compound PromptInput with Body/Tools/Attachments/Footer"
      - "Add ConversationDownload to export conversation"
    test_cases:
      - id: "suggestions-empty"
        description: "Empty session shows Suggestions component with starter prompts"
        type: "smoke"
      - id: "compound-prompt"
        description: "PromptInput renders with attachment button and action menu"
        type: "smoke"
      - id: "conversation-download"
        description: "Download button exports current branch as formatted Markdown file"
        type: "smoke"
---

# Session-Based Message Format

## Overview

Our ChatThread manually JSON-parses stringified content blocks from raw gateway events, creating a brittle pipeline that prevents us from using ai-elements components natively. This feature replaces the raw events persistence with Cloudflare's `Session` class (from `agents@0.11.0`), adopts typed `SessionMessage` with `parts` arrays throughout the stack, and unlocks rich ai-elements patterns like message branching, built-in streaming, and compound prompt inputs.

## Feature Behaviors

### B1: Gateway Event to SessionMessage Mapping

**Core:**
- **ID:** event-to-session-message
- **Trigger:** SessionAgent DO receives any gateway event
- **Expected:** Each event is mapped to `SessionMessage` parts and persisted via `Session.appendMessage()` or `Session.updateMessage()`. The full mapping table:

| Gateway Event | Part `type` field | Part `state` | Persistence action |
|---------------|-------------------|--------------|-------------------|
| `sendMessage` RPC (user message) | `"text"` | `"done"` | `appendMessage()` with `role: "user"`, ID `usr-{turn_counter}`. The user message becomes the `parentId` for the subsequent assistant message, forming the conversation tree. |
| `partial_assistant` (first for turn) | `"text"` | `"streaming"` | `appendMessage()` with DO-generated ID `msg-{turn_counter}`, `parentId` set to the preceding user message ID |
| `partial_assistant` (subsequent) | `"text"` | `"streaming"` | `updateMessage()` on same `msg-{turn_counter}` ID |
| `assistant` text block | `"text"` | `"done"` | `updateMessage()` — finalizes the in-flight message, replaces streaming parts with final parts |
| `assistant` thinking block | `"reasoning"` | `"done"` | Part of same `updateMessage()` on assistant message |
| `assistant` tool_use block | `"tool-{toolName}"` (e.g. `"tool-read_file"`) | `"input-available"` | Part of same `updateMessage()` on assistant message |
| `tool_result` (success) | Updates existing `"tool-{toolName}"` part by `toolCallId` | `"output-available"` | `updateMessage()` — sets `output` and `state` on matching part |
| `tool_result` (error) | Updates existing `"tool-{toolName}"` part by `toolCallId` | `"output-error"` | `updateMessage()` — sets `errorText` and `state` on matching part |
| `ask_user` | `"tool-ask_user"` | `"approval-requested"` | `updateMessage()` — adds part `{type: "tool-ask_user", toolCallId: gateId, toolName: "ask_user", input: {question: string}, state: "approval-requested"}` to current assistant message |
| `permission_request` | `"tool-permission"` | `"approval-requested"` | `updateMessage()` — adds part `{type: "tool-permission", toolCallId: gateId, toolName: "permission", input: {tool_name: string, tool_call_id: string}, state: "approval-requested"}` to current assistant message |
| `file_changed` | `"data-file-changed"` | N/A | `updateMessage()` — adds data part `{type: "data-file-changed", path: string, action: "created"\|"modified"\|"deleted"}` to current assistant message. Persisted so reconnect replays include file-change context. |
| `result` | N/A | N/A | Not stored as a message part — updates session state only (status, cost, duration) |
| `stopped` | N/A | N/A | Not stored — updates session status to `"idle"` |
| `error` | N/A | N/A | Not stored as a message part — updates session status to `"failed"` with error detail |
| `session.init` | N/A | N/A | Not stored — updates session model/sdk_session_id |
| `kata_state` | N/A | N/A | Not stored as message — persisted in Session config via `assistant_config` table |

**Turn counter and message IDs:** The DO maintains a `turnCounter` integer and `currentTurnMessageId` string, both stored in Session config (`assistant_config` table) so they survive DO hibernation/restart. `turnCounter` increments on each `sendMessage` RPC call. User messages get ID `usr-{turnCounter}`, assistant messages get ID `msg-{turnCounter}`.

**Cold-start recovery:** On DO wake from hibernation, `turnCounter` MUST be loaded from `assistant_config`. If the config read returns null (first use or data loss), seed `turnCounter` from `Session.getPathLength() + 1` to guarantee IDs don't collide with existing messages. The config value always takes precedence when present.

**Streaming semantics:** On first `partial_assistant` of a turn, generate `msg-{turnCounter}`, call `appendMessage()`, and set `currentTurnMessageId`. Subsequent `partial_assistant` events call `updateMessage()` on `currentTurnMessageId`. The final `assistant` event calls `updateMessage()` to replace streaming parts with final parts and clears `currentTurnMessageId`.

**Gate resolution lifecycle:** When `resolveGate()` RPC is called with approval, the matching `"tool-ask_user"` or `"tool-permission"` part is updated via `updateMessage()`:
  - Approved: `state` → `"output-available"`, `output` set to response content
  - Denied: `state` → `"output-denied"`

**Error handling:** If `Session.appendMessage()` or `updateMessage()` throws (SQLite full, schema error), log the error and broadcast the raw event to connected clients as a fallback `{ type: "raw_event", event }` so the UI doesn't silently lose data. On reconnect, if `Session.getHistory()` fails, fall back to an empty message list and log the error.

**Orphaned streaming parts:** On session `result`/`stopped`/`error` events, if `currentTurnMessageId` is set (streaming was in progress), call `updateMessage()` to finalize all `state: "streaming"` parts to `state: "done"` before clearing the turn ID. This prevents orphaned streaming states across reconnects.

**Non-persistence side effects preserved:** The existing `handleGatewayEvent()` performs side effects beyond persistence for several event types: push notifications (`ask_user`, `permission_request`, `result`), registry sync (`result`, `kata_state`), WS teardown (`stopped`), action token generation (`permission_request`), and session status updates (all). Only the storage path changes — from `persistEvent()` to Session methods. All other side effects in the switch statement MUST be preserved as-is.

- **Verify:** Send a gateway event sequence through SessionAgent; query `Session.getHistory()` and confirm parts have correct types and states.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:handleGatewayEvent`

#### UI Layer
N/A — this behavior is DO-internal.

#### API Layer
`getMessages()` RPC returns `SessionMessage[]` instead of `ChatMessage[]`. Each message has `{id, role, parts, createdAt}`.

#### Data Layer
Session creates `assistant_messages` table (tree-structured with `parent_id`), `assistant_compactions`, `assistant_fts` (FTS5), and `assistant_config`. Old `events`, `messages`, and `kv` tables are renamed to `_deprecated_*` in migration v4 (migration files 1-3 are kept in the chain — never remove deployed migrations). After P1 is validated in production, migration v5 drops the `_deprecated_*` tables.

---

### B2: Client Receives SessionMessage Wire Format

**Core:**
- **ID:** session-message-wire-format
- **Trigger:** Client connects via WebSocket or calls `getMessages()` RPC
- **Expected:** All messages are `SessionMessage` objects with typed `parts`. The `gateway_event` wrapper is replaced — the DO broadcasts `{ type: "message", message: SessionMessage }` for new/updated messages and `{ type: "messages", messages: SessionMessage[] }` for bulk replay.
- **Verify:** Connect a WebSocket client, trigger an assistant response, confirm the received JSON has `parts` array with typed entries instead of raw gateway event JSON.

#### UI Layer
`useCodingAgent` hook processes `SessionMessage` directly — no `safeParseJson()`, no block filtering. During P1→P2 transition, `useCodingAgent.onMessage()` MUST handle both `type: "gateway_event"` (old format) and `type: "message"` (new format) to support non-atomic deploys. The old handler can be removed after P2 ships.

#### API Layer
WebSocket messages change from `{ type: "gateway_event", event }` to `{ type: "message", message: SessionMessage }`.

**Deploy strategy:** Since the DO and client deploy independently (CF Worker vs static assets), the client must handle both wire formats during the transition. P2 adds `type: "message"` handling; the old `type: "gateway_event"` handler is kept as a fallback until P2 is confirmed deployed. This avoids requiring atomic deploys.

#### Data Layer
N/A.

---

### B3: ChatThread Renders Parts Directly

**Core:**
- **ID:** chat-thread-parts-rendering
- **Trigger:** ChatThread receives `SessionMessage[]` from useCodingAgent
- **Expected:** Each message's `parts` array is mapped to ai-elements components without JSON parsing:
  - `type: "text"` → `MessageResponse` (with `isAnimating` when `state === "streaming"`)
  - `type: "tool-*"` → `Tool` + `ToolHeader` + `ToolContent` + `ToolInput` + `ToolOutput`
  - `type: "reasoning"` → `Reasoning` + `ReasoningTrigger` + `ReasoningContent`
  - `type: "tool-ask_user"` or `"tool-permission"` with `state: "approval-requested"` → `GateResolver` component (existing interactive approve/deny UI, not the generic `Tool` component). After resolution: renders as `Tool` with `state: "output-available"` or `"output-denied"`.
  - `type: "data-file-changed"` → File change indicator (icon + filename, same as current `file_changed` rendering)
  - Unknown `type` → Silently skip (forward-compatible with future part types)
- **Verify:** Open a session with tool calls and thinking — confirm all render correctly without console errors.
- **Source:** `apps/orchestrator/src/features/agent-orch/ChatThread.tsx`

#### UI Layer
- `safeParseJson()` function removed
- Block filtering (`blocks.filter(b => b.type === 'text')`) replaced with `parts.filter(p => p.type === 'text')`
- `StreamingText` component deleted; replaced with `MessageResponse` + `isAnimating` prop

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B4: OPFS Cache Stores SessionMessage

**Core:**
- **ID:** opfs-cache-session-message
- **Trigger:** New message arrives via WebSocket
- **Expected:** `CachedMessage` type is updated to extend `SessionMessage` (with `sessionId`). The OPFS SQLite collection stores the full `parts` array as JSON. Schema version bumps to 2 with migration that drops old format rows.
- **Verify:** Open a session, close it, reopen — messages load instantly from cache with correct parts rendering.
- **Source:** `apps/orchestrator/src/db/messages-collection.ts`

#### UI Layer
No visible change — cache is transparent.

#### API Layer
N/A.

#### Data Layer
OPFS SQLite schema version 2. Old v1 rows dropped (clean break).

---

### B5: Message Branching

**Core:**
- **ID:** message-branching
- **Trigger:** User edits a previous user message and resubmits
- **Expected:** A new branch is created from the edited message's parent using `Session.appendMessage(msg, parentId)`. The `MessageBranch` ai-elements component renders navigation arrows showing `n/m` branch position. Clicking arrows calls `Session.getBranches(messageId)` to load sibling branches.

**Resubmission flow:**
1. Client calls `resubmitMessage(originalMessageId, newContent)` RPC
2. DO finds the parent of `originalMessageId` (the message before the user message being edited)
3. DO appends a new user message as a sibling branch: `Session.appendMessage({id: 'usr-{turnCounter}', role: 'user', parts: [{type: 'text', text: newContent}]}, parentId)`
4. DO derives the conversation history from root to the new user message via `Session.getHistory(newMessageId)` and sends it to the gateway as a new `execute` command
6. Gateway responds with the normal event stream; assistant messages are appended as children of the new user message

**Branch state tracking:**
- `activeLeafId` is stored client-side in `useCodingAgent` state
- After P3a, `getMessages()` becomes a convenience wrapper: `getMessages(leafId?)` calls `Session.getHistory(leafId ?? Session.getLatestLeaf())`. The separate `getHistory(leafId)` RPC is not needed — `getMessages` gains an optional `leafId` parameter.
- When user navigates branches via `MessageBranch` arrows, client updates its local `activeLeafId` and calls `getHistory(leafId)` to fetch that branch's conversation path
- Each tab independently tracks its active branch — no cross-tab interference

**Resubmit while streaming:** If `resubmitMessage()` is called while `currentTurnMessageId` is set (streaming in progress), the DO MUST first abort the current gateway execution (call `abort()` on the gateway WebSocket), finalize the in-flight message's streaming parts to `state: "done"` (same as orphaned streaming cleanup in B1), and only then proceed with the resubmission flow. This prevents race conditions between the old stream and the new branch.

**Multi-tab branch behavior:** `activeLeafId` is per-client, stored client-side in `useCodingAgent` state (not server-side). Each tab independently tracks which branch it's viewing. The server returns the full tree via `getBranches()` and the client navigates locally. This avoids the problem of one tab's branch navigation disrupting another tab's work. On initial connect/reconnect, the client defaults to the latest leaf via `Session.getLatestLeaf()`.

- **Verify:** Send a message, get a response, edit the original message, get a new response. Confirm branch arrows appear and navigation works. Refresh the page — confirm the latest branch is displayed.

#### UI Layer
`MessageBranch` component added to user messages that have siblings. Shows left/right arrows + "2/3" counter.

#### API Layer
New/modified RPC methods on SessionAgent:
- `getMessages(leafId?: string)` → `SessionMessage[]` — existing RPC gains optional `leafId` param. Without it, returns `Session.getHistory(latestLeaf)`. With it, returns the specified branch's path.
- `getBranches(messageId: string)` → `SessionMessage[]` — sibling messages at that tree node (children of the same parent)
- `resubmitMessage(messageId: string, content: string)` → `{leafId: string}` — creates new branch, triggers gateway execution, returns new leaf ID

#### Data Layer
Uses Session's tree-structured `assistant_messages.parent_id`. Branch tracking is client-side.

---

### B6: Suggestions for Empty State

**Core:**
- **ID:** suggestions-empty-state
- **Trigger:** User opens a new session with no messages
- **Expected:** `ConversationEmptyState` renders with `Suggestions` component showing 3-4 starter prompts relevant to the connected worktree. Clicking a suggestion fills and submits the prompt.
- **Verify:** Open a new session, confirm suggestions appear, click one, confirm it submits.

#### UI Layer
`Suggestions` component with hardcoded starter prompts (e.g., "Explain this codebase", "Run the test suite", "What changed recently?").

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B7: Compound PromptInput

**Core:**
- **ID:** compound-prompt-input
- **Trigger:** User interacts with the message input area
- **Expected:** `MessageInput` already uses `PromptInput`, `PromptInputTextarea`, `PromptInputFooter`, and `PromptInputSubmit`. Extend it with: `PromptInputBody` wrapper, `PromptInputTools` (attachment button), and `PromptInputAttachments` (preview/remove uploaded images replacing custom image chips). No `PromptInputHeader` — model selection happens at session spawn time.
- **Verify:** Open a session, confirm attachment button works, paste an image, confirm preview chip, submit with text + image.
- **Source:** `apps/orchestrator/src/features/agent-orch/MessageInput.tsx`

#### UI Layer
Full compound PromptInput replaces minimal textarea + submit. Image paste UX uses `Attachments` compound instead of custom chips.

#### API Layer
Image upload path is unchanged — the existing `sendMessage(content: ContentBlock[])` RPC already supports `ImageContentBlock` with base64 data inline in the WebSocket frame. The compound `PromptInputAttachments` component handles client-side preview/remove; the submission format remains the same `ContentBlock[]` array. No new upload infrastructure needed.

#### Data Layer
N/A.

---

### B8: Conversation Download

**Core:**
- **ID:** conversation-download
- **Trigger:** User clicks the download button in the conversation header
- **Expected:** The `ConversationDownload` component from `@duraclaw/ai-elements` (synced from upstream ai-elements v1.9 — already in codebase) is added to the conversation header area. Clicking it exports the current branch's message history as a Markdown file. Each message is formatted with role headers (`## User` / `## Assistant`), text parts as markdown, tool invocations as fenced code blocks with tool name, and reasoning blocks as collapsed `<details>` sections. The file is named `session-{sessionId}-{date}.md`.
- **Verify:** Open a session with messages, click download, confirm a `.md` file downloads with correctly formatted conversation.

#### UI Layer
`ConversationDownload` component placed in conversation header alongside session title.

#### API Layer
N/A — export runs client-side from the already-loaded `SessionMessage[]`.

#### Data Layer
N/A.

---

## Non-Goals

- **Replacing the VPS gateway** — we keep the Claude Agent SDK executing on VPS with raw event streaming. Session transformation happens at the DO layer only.
- **Adopting Think class** — we keep our own SessionAgent DO with custom WebSocket protocol. Only the `Session` persistence class is adopted.
- **Virtual filesystem (Workspace)** — Think's Workspace is for sandboxed execution. We use real worktrees.
- **Context blocks / compaction** — Session supports these but we defer adoption to a future spec. The plumbing will be there.
- **FTS5 search UI** — Session creates the FTS5 index automatically but we don't build search UI in this spec.
- **Message pagination** — `getMessages()` returns full history without pagination. Acceptable for current session lengths; add pagination if production sessions exceed ~200 messages.

## Open Questions

- [x] Scope: All 3 phases in one spec — decided
- [x] Dependency strategy: npm `agents@0.11.0` — decided
- [x] Migration: Replace events table entirely — decided
- [x] Breaking change: Clean break acceptable — decided
- [x] Client cache: Keep OPFS, adapt to SessionMessage — decided
- [x] Streaming: Replace StreamingText with ai-elements built-in — decided
- [x] Suggestions: Static starter prompts for now — decided (dynamic can be a future enhancement)
- [x] Model selector: Omit `PromptInputHeader` entirely — decided (no model selection in v1, the model is set at session spawn time)

## Implementation Phases

See YAML frontmatter `phases:` above.

**Phase 1** (~4 hours): Session adoption. Add dependency, build the event-to-parts mapper for all event types, replace DO persistence, update wire format and RPCs. This is the foundational change.

**Phase 2** (~3 hours): ChatThread rendering. Update all UI components to consume `parts` directly, replace StreamingText, update OPFS cache. This is where the user-visible improvement lands.

**Phase 3a** (~4 hours): Message branching. Add RPCs (`getBranches`, `getHistory`, `resubmitMessage`), wire Session tree storage, render MessageBranch UI, implement resubmission-to-gateway flow, and handle reconnect with client-side branch tracking.

**Phase 3b** (~2 hours): Suggestions + compound PromptInput. Static starter prompts for empty state, upgrade MessageInput to ai-elements compound. Additive, low risk.

## Verification Strategy

### Test Infrastructure
Existing: `vitest.config.ts` in orchestrator with ~31 test files, including `use-coding-agent.test.ts` and `messages-collection.test.ts` which will need updating. Integration tests for Phase 1 behaviors run against miniflare (Durable Object SQLite). Smoke tests for Phase 2-3 use `chrome-devtools-axi` against local dev server.

### Build Verification
`cd apps/orchestrator && pnpm build` — Vite + wrangler build. Must pass typecheck (`pnpm typecheck`) since we're changing core types.

## Verification Plan

### VP1: Session Persistence Round-Trip
Steps:
1. Start local dev server, open a session, send a prompt that triggers tool use + thinking
   Expected: No console errors, assistant response renders normally
2. `chrome-devtools-axi open http://localhost:43173` → login → open session
   Expected: Messages display with text, tool calls, and reasoning blocks
3. Refresh the page
   Expected: Messages reload from Session.getHistory() — same content, no duplicates
4. Close and reopen the session tab
   Expected: Messages load instantly from OPFS cache, then sync with DO

### VP2: Streaming Text
Steps:
1. Send a prompt that generates a long response
   Expected: Text streams in with `MessageResponse` animation — no custom cursor div visible in DOM
2. Inspect DOM for `.streaming-text` or `data-streaming` selectors
   Expected: None found — StreamingText component is fully removed

### VP3: Tool Call Rendering
Steps:
1. Send a prompt that triggers file reads and edits
   Expected: Each tool renders as collapsible `Tool` with status badge (running → completed)
2. Trigger a tool that errors
   Expected: Tool shows error state with red badge and error output

### VP4: Message Branching (Phase 3)
Steps:
1. Send a message, receive response
2. Click on the user message to edit it, change the text, resubmit
   Expected: Branch arrows appear showing "1/2", clicking right arrow shows original, left shows new branch

### VP5: Compound PromptInput (Phase 3)
Steps:
1. Open a session
   Expected: Input area shows attachment button in footer
2. Click attachment button or paste an image
   Expected: Image preview chip appears above textarea with remove button
3. Submit with text + image
   Expected: Message sends with ContentBlock[] including image

## Implementation Hints

### Dependencies
```bash
cd apps/orchestrator
pnpm add agents@0.11.0   # pinned exact — experimental API, avoid surprise breaks
pnpm add zod@^4.0.0      # ai@^6.0.142 already installed — no action needed
```

**API stability note:** The import path `agents/experimental/memory/session` is marked experimental. Pin the exact version (`0.11.0`, not `^0.11.0`) to avoid breaking changes on minor bumps. If the Session API moves out of experimental in a future agents release, update the import path at that time.

### Key Imports
| Module | Import | Used For |
|--------|--------|----------|
| `agents/experimental/memory/session` | `{ Session }` | DO-side message persistence |
| `agents/experimental/memory/session` | `{ SessionMessage, SessionMessagePart }` | Type definitions |
| `@duraclaw/ai-elements` | `{ MessageResponse, Tool, ToolHeader, ToolContent, Reasoning, ... }` | Parts rendering |
| `@duraclaw/ai-elements` | `{ MessageBranch, Suggestions, Attachments }` | Phase 3 components |

### Code Patterns

**Session initialization in DO:**
```typescript
import { Session } from 'agents/experimental/memory/session'

class SessionAgent extends Agent<Env> {
  session!: Session

  async onStart() {
    this.session = Session.create(this)
  }
}
```

**Gateway event to parts mapping:**
```typescript
function gatewayEventToParts(event: GatewayEvent): SessionMessagePart[] {
  if (event.type === 'assistant') {
    return event.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text, state: 'done' }
      if (block.type === 'thinking') return { type: 'reasoning', text: block.thinking, state: 'done' }
      if (block.type === 'tool_use') return {
        type: `tool-${block.name}`,
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
        state: 'input-available'
      }
    }).filter(Boolean)
  }
  // ... other event types
}
```

**ChatThread parts rendering:**
```tsx
{message.parts.map((part, i) => {
  if (part.type === 'text')
    return <MessageResponse key={i} isAnimating={part.state === 'streaming'}>{part.text}</MessageResponse>
  if (part.type === 'reasoning')
    return <Reasoning key={i}><ReasoningTrigger /><ReasoningContent>{part.text}</ReasoningContent></Reasoning>
  if (part.type?.startsWith('tool-'))
    return <Tool key={i} state={part.state}><ToolHeader>{part.toolName}</ToolHeader>...</Tool>
})}
```

### Gotchas
- `Session.create(this)` requires `this` to be an Agent instance — it accesses `this.ctx.storage` for SQLite
- Session uses `assistant_messages` table — don't conflict with any existing table names (our old `messages` table will be dropped by migration v4)
- `SessionMessagePart.type` for tools is `"tool-{toolName}"` (e.g. `"tool-read_file"`), not `"tool_use"` — the tool name is embedded in the type string. Use `part.type.startsWith('tool-')` to match.
- The `agents` package has peer dep on `ai@^6.0.0` (Vercel AI SDK) — we need this even though we don't use Vercel's inference. It provides the `UIMessage`-compatible types.
- Session's `appendMessage` is idempotent by message ID — safe to retry on reconnect
- **Migration chain integrity**: Migration v4 renames old tables to `_deprecated_*` (safe rollback). Migration v5 (added after P1 validation) drops them. **Keep migration files 1-3 in the codebase** — CF applies migrations sequentially and requires the full chain.
- Existing tests in `use-coding-agent.test.ts` and `messages-collection.test.ts` reference `CachedMessage` (which extends `ChatMessage`) and the `gateway_event` wire format — update these in P2
- Concurrent tabs: Session's `appendMessage` is idempotent by ID, but two tabs calling `updateMessage()` on the same in-flight message could race. The DO serializes all WebSocket messages so this is safe within a single DO instance.
- **Verify Session API surface before P3a:** `Session.getLatestLeaf()` and `Session.getBranches(messageId)` are referenced in the P0 research from the `agents@0.11.0` source. Verify these methods exist at implementation time — if missing, P3a will need custom SQLite queries against `assistant_messages.parent_id` to walk the tree.

### Reference Docs
- [Cloudflare Agents Session](https://github.com/cloudflare/agents/tree/main/packages/agents/src/experimental/memory/session) — Session class source
- [Vercel AI Elements](https://elements.ai-sdk.dev/) — Component gallery and examples
- [AI SDK UIMessage](https://sdk.vercel.ai/docs/reference/ai-sdk-ui/use-chat#messages) — UIMessage type reference
