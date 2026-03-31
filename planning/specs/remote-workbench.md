---
initiative: remote-workbench
type: project
issue_type: feature
status: draft
priority: high
github_issue: null
created: 2026-03-31
updated: 2026-03-31
phases:
  - id: p1
    name: "Foundation -- Protocol & Gateway Refactor"
    tasks:
      - "Define shared protocol types in new packages/shared-types/ (GatewayCommand, GatewayEvent, UIStreamChunk, FileChangeEvent)"
      - "Refactor cc-gateway executeSession to use streaming input mode (AsyncIterable<SDKUserMessage> prompt via messageGenerator)"
      - "Enable includePartialMessages: true on query() options for token-level streaming"
      - "Expand canUseTool callback to handle both AskUserQuestion and permission prompts (tool approval relay)"
      - "Add PostToolUse hooks on Edit/Write tools to emit file-changed events over WS"
      - "Add HTTP endpoint: GET /worktrees/:name/files -- directory tree listing with depth limit"
      - "Add HTTP endpoint: GET /worktrees/:name/files/*path -- raw file contents (read-only)"
      - "Add HTTP endpoint: GET /worktrees/:name/git-status -- per-file git status (modified, staged, untracked)"
      - "Update VpsCommand/VpsEvent types to new GatewayCommand/GatewayEvent protocol"
      - "Add stream-input command type: sends user message into running session via streamInput()"
      - "Add permission-response command type: resolves canUseTool promise for permission prompts"
      - "Write integration tests for WS protocol round-trips (execute, stream, abort, answer, permission)"
      - "Add worktree name validation: reject names not in discovered worktree list (prevents path traversal via worktree name)"
      - "Write integration tests for file API endpoints"
    test_cases:
      - id: "p1-ws-execute"
        description: "WS execute command starts session, receives session.init + streaming assistant events"
        type: "integration"
      - id: "p1-ws-stream-input"
        description: "stream-input command delivers user message into running session via AsyncIterable"
        type: "integration"
      - id: "p1-ws-permission"
        description: "canUseTool intercepts permission prompt, sends to WS, resolves on permission-response"
        type: "integration"
      - id: "p1-ws-ask-user"
        description: "AskUserQuestion intercepted via canUseTool, relayed over WS, resolved on answer command"
        type: "integration"
      - id: "p1-partial-messages"
        description: "includePartialMessages produces SDKPartialAssistantMessage events with incremental content"
        type: "integration"
      - id: "p1-file-changed"
        description: "PostToolUse hook on Edit/Write emits file-changed event over WS"
        type: "integration"
      - id: "p1-file-tree"
        description: "GET /worktrees/:name/files returns directory tree JSON with type, name, path fields"
        type: "integration"
      - id: "p1-file-contents"
        description: "GET /worktrees/:name/files/*path returns raw file contents with correct content-type"
        type: "integration"
      - id: "p1-git-status"
        description: "GET /worktrees/:name/git-status returns per-file status array"
        type: "integration"
  - id: p2
    name: "Durable Objects -- State Machine & Protocol Translation"
    tasks:
      - "Rename SessionAgent to SessionDO, update state machine (idle, running, waiting_input, waiting_permission, completed, failed, aborted)"
      - "Implement AI SDK stream protocol translation: SDKMessage/SDKPartialAssistantMessage to UIMessageChunk format (text-delta, tool-input-start/delta/available, tool-output-available, start, finish)"
      - "Implement bidirectional WS relay: browser WS <-> SessionDO <-> gateway WS"
      - "Handle stream-input relay: browser sends message -> DO forwards to gateway -> gateway yields to AsyncIterable"
      - "Handle AskUserQuestion relay: gateway event -> DO -> browser tool-invocation with approval-requested -> user response -> DO -> gateway"
      - "Handle permission prompt relay: gateway permission event -> DO -> browser Confirmation component -> user approve/deny -> DO -> gateway"
      - "Handle file-changed event relay: gateway file-changed -> DO -> browser file-changed push"
      - "Rename SessionRegistry to WorktreeRegistry DO, update worktree lock management"
      - "Add session history query methods to WorktreeRegistry (list by worktree, list by status, list recent)"
      - "Implement DO eviction recovery: persist gateway WS reconnection state, resume streaming on wake"
      - "Store full message history in DO SQLite for session replay on browser reconnect"
      - "Migrate SessionDO messages table: add role column"
      - "Write DO state machine tests with miniflare"
      - "Write protocol translation unit tests (SDK message -> UI stream chunk mapping)"
    test_cases:
      - id: "p2-state-machine"
        description: "SessionDO transitions through idle -> running -> waiting_input -> running -> completed"
        type: "integration"
      - id: "p2-stream-translation"
        description: "SDKPartialAssistantMessage with text content translates to text-start, text-delta, text-end chunks"
        type: "unit"
      - id: "p2-tool-translation"
        description: "SDK tool_use message translates to tool-input-start, tool-input-delta, tool-input-available, tool-output-available chunks"
        type: "unit"
      - id: "p2-browser-relay"
        description: "Message sent from browser WS arrives at gateway WS via DO relay"
        type: "integration"
      - id: "p2-ask-user-relay"
        description: "AskUserQuestion flows gateway -> DO -> browser -> user answer -> DO -> gateway"
        type: "integration"
      - id: "p2-permission-relay"
        description: "Permission prompt flows gateway -> DO -> browser Confirmation -> user response -> DO -> gateway"
        type: "integration"
      - id: "p2-file-changed-relay"
        description: "File-changed event from gateway reaches browser via DO push"
        type: "integration"
      - id: "p2-eviction-recovery"
        description: "After DO eviction, SessionDO reconnects to gateway and resumes streaming"
        type: "integration"
      - id: "p2-session-replay"
        description: "Browser reconnecting to SessionDO receives full message history from SQLite"
        type: "integration"
      - id: "p2-worktree-registry"
        description: "WorktreeRegistry locks/unlocks worktrees and lists sessions by status"
        type: "integration"
  - id: p3
    name: "Frontend -- Dashboard & Chat UI"
    tasks:
      - "Install AI SDK v6 (@ai-sdk/react) and shadcn/ui + shadcn AI components"
      - "Implement WebSocketChatTransport class for useChat (connects to SessionDO WS endpoint)"
      - "Build dashboard layout: sidebar with worktree list + session list, main content area"
      - "Build worktree grid: cards showing name, branch, lock status, active session, git dirty state"
      - "Build session list: active sessions with status badge, worktree, duration, model"
      - "Build session history view: past sessions table with worktree, duration, status, cost, created_at"
      - "Build New Session dialog: worktree picker (only unlocked), prompt textarea, model selector, launch button"
      - "Build session chat view using shadcn AI components: Message, Conversation, Reasoning, Code Block"
      - "Build tool call rendering: Tool component showing tool name, streaming input, output"
      - "Build interactive prompt input: shadcn Prompt Input component wired to useChat.sendMessage"
      - "Build AskUserQuestion UI: render questions with input fields, submit answers"
      - "Build permission Confirmation UI: show tool name + input, approve/deny buttons using addToolApprovalResponse"
      - "Build file browser panel: tree view (collapsible directories), file viewer (syntax highlighted), git status indicators per file"
      - "Wire file-changed events to highlight modified files in tree and show notification badge"
      - "Add session abort button wired to DO abort RPC"
      - "Add session cost/metadata display: model, duration, cost, num_turns in session header"
    test_cases:
      - id: "p3-ws-transport"
        description: "WebSocketChatTransport connects to SessionDO, sends messages, receives streamed responses"
        type: "integration"
      - id: "p3-worktree-grid"
        description: "Dashboard renders worktree cards with correct lock status and branch info"
        type: "smoke"
      - id: "p3-new-session"
        description: "New Session dialog creates session, locks worktree, navigates to chat view"
        type: "smoke"
      - id: "p3-chat-streaming"
        description: "Chat view renders streaming text deltas and tool call progress in real-time"
        type: "smoke"
      - id: "p3-permission-ui"
        description: "Permission prompt renders Confirmation component, approve/deny sends response"
        type: "smoke"
      - id: "p3-file-browser"
        description: "File browser loads tree, clicking file shows contents, git status icons display correctly"
        type: "smoke"
  - id: p4
    name: "Integration & Polish"
    tasks:
      - "End-to-end test: start session from browser -> stream output -> send message -> answer question -> browse files"
      - "Implement gateway disconnect handling: SessionDO detects close, attempts reconnect, marks failed after retries"
      - "Implement DO eviction recovery: on wake, check if session was running, reconnect to gateway"
      - "Implement session cleanup: on completed/failed, release worktree lock in WorktreeRegistry"
      - "Add UI error states: gateway unreachable, session failed, WS disconnected with reconnect banner"
      - "Throttle UI updates: batch text-delta events (16ms debounce), lazy-load file tree nodes"
      - "Add loading skeletons for worktree grid, session list, file browser"
      - "Performance: efficient file tree loading (on-demand expansion, not full tree upfront)"
      - "Add session cost/duration live counter during running sessions"
    test_cases:
      - id: "p4-e2e-full"
        description: "Full round-trip: create session, stream output, send interactive message, answer question, browse changed files"
        type: "smoke"
      - id: "p4-disconnect-recovery"
        description: "Gateway WS drops, SessionDO reconnects and resumes streaming without data loss"
        type: "integration"
      - id: "p4-cleanup"
        description: "Completed session releases worktree lock and updates WorktreeRegistry index"
        type: "integration"
      - id: "p4-error-states"
        description: "UI shows appropriate error banners for gateway disconnect and session failure"
        type: "smoke"
---

# Remote Workbench

> GitHub Issue: TBD (no remote configured yet)

## Overview

Duraclaw becomes a remote workbench for managing Claude Code Agent SDK sessions across VPS worktrees. Users can start new sessions from the browser, monitor them in real-time with token-level streaming, send messages and answer questions interactively, and browse project files -- all without SSH access to the VPS. The feature covers five capabilities: folder management, session tracking, CLI chat mirror with token-level streaming, interactive chat with permission handling, and a project file browser with real-time change notifications.

### State Transitions

| From State | Event | To State |
|---|---|---|
| idle | create session | running |
| running | assistant finishes | running (waiting for next user input via AsyncIterable) |
| running | canUseTool(AskUserQuestion) fires | waiting_input |
| running | canUseTool(other tool) fires | waiting_permission |
| waiting_input | user submits answer | running |
| waiting_permission | user approves | running |
| waiting_permission | user denies | running |
| running | result message received | completed |
| running | error occurs | failed |
| running/waiting_input/waiting_permission | user aborts | aborted |
| running/waiting_input/waiting_permission | gateway WS drops | failed (after reconnect retries exhausted) |

## Feature Behaviors

### B1: List Worktrees with Status

**Core:**
- **ID:** list-worktrees
- **Trigger:** User opens the dashboard
- **Expected:** Dashboard displays a grid of worktree cards, each showing name, git branch, lock status (free/locked + by which session), and dirty state
- **Verify:** Open dashboard, confirm all discovered worktrees appear with correct branch names and lock indicators
- **Source:** `packages/cc-gateway/src/worktrees.ts:31` (discoverWorktrees), `apps/orchestrator/src/agents/session-registry.ts:71` (getWorktreeLocks)

#### UI Layer

Worktree grid component renders cards using shadcn Card. Each card shows: worktree name (bold), branch name (badge), lock indicator (green dot = free, red dot + session link = locked), dirty state icon (yellow dot if uncommitted changes). Cards are sorted alphabetically. A loading skeleton displays while data is fetched.

#### API Layer

1. `GET /api/worktrees` -- orchestrator route that calls WorktreeRegistry DO `getWorktreeLocks()` and merges with cc-gateway `GET /worktrees` response. Returns `{ worktrees: Array<{ name, path, branch, locked_by_session, dirty }> }`. Status 200 on success, 502 if gateway unreachable.
2. cc-gateway `GET /worktrees` -- already exists, returns `WorktreeInfo[]`. Needs enhancement to include `dirty` (has uncommitted changes) boolean.

#### Data Layer

WorktreeRegistry DO state `worktree_locks: Record<string, string>` (worktree name to session ID). No schema migration needed -- uses existing in-memory state.

---

### B2: Lock and Unlock Worktrees

**Core:**
- **ID:** worktree-locking
- **Trigger:** Session is created (acquires lock) or completes/fails/aborts (releases lock)
- **Expected:** Only one session can run per worktree. Lock is acquired atomically on session start and released on terminal state.
- **Verify:** Attempt to create two sessions on the same worktree; second attempt is rejected with "worktree locked" error
- **Source:** `apps/orchestrator/src/agents/session-registry.ts:56` (acquireWorktree)

#### UI Layer

Locked worktree cards in the grid show a lock icon and the active session link. The "New Session" dialog disables locked worktrees in the picker dropdown with "(in use)" label. If a lock acquisition fails (race condition), a toast error appears: "Worktree is already in use by another session."

#### API Layer

WorktreeRegistry DO RPC methods (already exist, to be renamed):
- `acquireWorktree(worktree: string, sessionId: string): Promise<boolean>` -- returns false if already locked
- `releaseWorktree(worktree: string): Promise<void>` -- idempotent release
- `getWorktreeLocks(): Promise<Record<string, string>>` -- current lock map

Lock is acquired in the "New Session" flow before the execute command is sent to the gateway. Lock is released by SessionDO when it transitions to a terminal state (completed, failed, aborted) via RPC call to WorktreeRegistry.

#### Data Layer

In-memory state in WorktreeRegistry DO (persisted via Agents SDK `setState`). Stale lock cleanup runs every 5 minutes via `scheduleEvery(300, ...)` (already implemented in `cleanupStaleLocks`).

---

### B3: Create New Session

**Core:**
- **ID:** create-session
- **Trigger:** User clicks "New Session" button, fills in worktree + prompt + model, clicks "Launch"
- **Expected:** A new SessionDO is created, worktree is locked, gateway receives execute command via streaming input, session appears in active sessions list, chat view opens with streaming output
- **Verify:** Create a session, confirm worktree locks, gateway receives command, streaming output appears in chat
- **Source:** `apps/orchestrator/src/agents/session-agent.ts:145` (create method)

#### UI Layer

1. "New Session" button in dashboard header opens a dialog (shadcn Dialog).
2. Dialog contains: worktree picker (Select, only unlocked worktrees), prompt textarea (Textarea), model selector (Select: claude-sonnet-4-6, claude-opus-4, etc.), optional system prompt (collapsible Textarea).
3. "Launch" button is disabled until worktree and prompt are filled.
4. On submit: loading spinner, then redirect to `/session/:id` chat view.
5. Error toast if worktree lock fails or gateway is unreachable.

#### API Layer

Orchestrator server function (TanStack Start server function or API route):
- `POST /api/sessions` -- body: `{ worktree, prompt, model?, system_prompt? }`
- Flow: generate session ID -> acquire worktree lock via WorktreeRegistry -> create SessionDO -> call `session.create()` RPC -> register session in WorktreeRegistry -> return `{ session_id }`
- Errors: 409 if worktree locked, 502 if gateway unreachable, 400 if missing fields

#### Data Layer

SessionDO state initialized with: id, worktree, worktree_path, status="running", model, prompt, created_at, updated_at. WorktreeRegistry sessions table gets new row. SessionDO SQLite messages table created on start.

---

### B4: Token-Level Streaming (CLI Chat Mirror)

**Core:**
- **ID:** token-streaming
- **Trigger:** Session is running; gateway streams SDK partial messages
- **Expected:** Browser renders assistant text character-by-character as it arrives. Tool call inputs stream incrementally. Tool results appear when complete.
- **Verify:** Start a session with a code generation prompt, observe text appearing progressively (not in chunks), tool calls showing input as it is typed
- **Source:** `packages/cc-gateway/src/sessions.ts:110` (message iteration loop)

#### UI Layer

Chat view uses `useChat` hook with `WebSocketChatTransport`. Renders:
- **Text blocks:** shadcn AI Message component, text appears progressively via text-delta events
- **Reasoning blocks:** shadcn Reasoning component (collapsible), streamed same as text
- **Tool calls:** shadcn Tool component showing tool name header, input streaming in a code block, then output when available
- **Code blocks:** shadcn Code Block component with syntax highlighting for code in text and tool outputs

Messages auto-scroll to bottom. A "scroll to bottom" button appears if user scrolls up.

All UIMessageChunk events are broadcast to ALL connected browser WebSocket clients on the SessionDO. Multiple browser tabs viewing the same session see identical real-time output.

#### API Layer

**Gateway to DO (GatewayEvent, over WS):**
- `partial_assistant`: SDKPartialAssistantMessage with incremental content blocks (text deltas, tool input deltas)
- `assistant`: Complete assistant message (final version after partial streaming)
- `tool_result`: Tool execution result with output content

**DO to Browser (UIMessageChunk, over WS, AI SDK stream protocol):**
- `{"type":"start","messageId":"msg_xxx"}` -- new assistant turn
- `{"type":"text-start","id":"text_xxx"}` -- begin text block
- `{"type":"text-delta","id":"text_xxx","delta":"Hello"}` -- incremental text
- `{"type":"text-end","id":"text_xxx"}` -- end text block
- `{"type":"tool-input-start","toolCallId":"tc_xxx","toolName":"Bash"}` -- begin tool call
- `{"type":"tool-input-delta","toolCallId":"tc_xxx","inputTextDelta":"ls -la"}` -- tool input streaming
- `{"type":"tool-input-available","toolCallId":"tc_xxx","toolName":"Bash","input":{...}}` -- complete tool input
- `{"type":"tool-output-available","toolCallId":"tc_xxx","output":{...}}` -- tool result
- `{"type":"finish"}` -- end of assistant turn

SessionDO translates between these two formats in real-time.

#### Data Layer

SessionDO SQLite `messages` table stores each complete message (not partials) for replay. Schema: `id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, type TEXT, data TEXT, created_at TEXT`. NOTE: The existing schema at `session-agent.ts` does not have the `role` column -- a migration is required (see Phase 2 task).

---

### B5: Send Interactive Messages

**Core:**
- **ID:** interactive-chat
- **Trigger:** User types a message in the prompt input and presses Enter/Send while a session is running
- **Expected:** Message is delivered to the running SDK session via the streaming input AsyncIterable. The SDK processes it as a follow-up user turn. Response streams back.
- **Verify:** While a session is running, type a follow-up instruction, see it appear in chat, and receive a streamed response
- **Source:** New functionality -- cc-gateway `messageGenerator` AsyncIterable, SessionDO relay

#### UI Layer

shadcn Prompt Input component at bottom of chat view. Enabled when session status is "running" (disabled in idle, completed, failed, aborted, waiting_input, waiting_permission states -- except waiting_input also allows sending). Send button and Ctrl+Enter submit. User message appears immediately in chat (optimistic rendering via useChat). Typing indicator shows while waiting for response.

#### API Layer

**Browser to DO (over WS):**
- `{"type":"user-message","content":"your follow-up instruction here"}`

**DO to Gateway (over WS, GatewayCommand):**
- `{"type":"stream-input","session_id":"xxx","message":{"role":"user","content":"..."}}`

Gateway receives this, yields it from the `messageGenerator` AsyncIterable, which feeds into the SDK `query()` prompt stream. The SDK processes it as the next user turn.

Verified: The Claude Agent SDK `query()` function accepts `AsyncIterable<SDKUserMessage>` as the prompt parameter (see streaming input docs). This is the recommended mode for interactive sessions.

#### Data Layer

User messages stored in SessionDO SQLite messages table with `role="user"`. No additional schema needed.

---

### B6: Answer AskUserQuestion Prompts

**Core:**
- **ID:** ask-user-answer
- **Trigger:** SDK encounters an AskUserQuestion tool call; gateway intercepts via `canUseTool` and relays to browser
- **Expected:** Browser displays the question(s) with input fields. User types answers and submits. Answers flow back to gateway, resolving the `canUseTool` promise. Session continues.
- **Verify:** Start a session whose prompt triggers AskUserQuestion, see question appear in browser, submit answer, confirm session continues with that answer
- **Source:** `packages/cc-gateway/src/sessions.ts:63` (canUseTool for AskUserQuestion)

#### UI Layer

When a tool-invocation with `toolName: "AskUserQuestion"` and state `approval-requested` arrives, the chat renders a custom AskUserQuestion component:
- Displays each question as a labeled input field
- "Submit Answers" button sends answers back via `addToolApprovalResponse`
- After submission, the component shows the answered state (read-only with submitted answers)
- Timeout warning banner appears after 4 minutes (gateway has 5-minute timeout)

SessionDO state transitions to `waiting_input` while question is pending, back to `running` when answered.

#### API Layer

**Gateway to DO (GatewayEvent):**
- `{"type":"ask_user","session_id":"xxx","tool_call_id":"tc_xxx","questions":[{"id":"q1","text":"What is the target?"}]}`

**DO to Browser (UIMessageChunk):**
- Tool invocation with `toolName: "AskUserQuestion"`, state: `approval-requested`, input containing questions array

**Browser to DO (over WS):**
- `{"type":"tool-approval","toolCallId":"tc_xxx","approved":true,"answers":{"q1":"The target is..."}}`

**DO to Gateway (GatewayCommand):**
- `{"type":"answer","session_id":"xxx","tool_call_id":"tc_xxx","answers":{"q1":"The target is..."}}`

#### Data Layer

SessionDO state field `pending_question` stores the question data while waiting. Cleared when answer is submitted. The question and answer are stored in the messages table as a tool call + result pair.

---

### B7: Handle Permission Prompts

**Core:**
- **ID:** permission-prompt
- **Trigger:** SDK `canUseTool` callback fires for a tool that requires permission (not AskUserQuestion)
- **Expected:** Browser displays a Confirmation dialog showing the tool name, input summary, and approve/deny buttons. User decision flows back to gateway.
- **Verify:** Start a session that triggers a Bash command requiring permission, see Confirmation dialog, approve it, confirm tool executes
- **Source:** `packages/cc-gateway/src/sessions.ts:63` (canUseTool callback -- to be expanded)

#### UI Layer

shadcn AI Confirmation component renders when a tool-invocation arrives with state `approval-requested` and `toolName` is not AskUserQuestion:
- Shows tool name in header (e.g., "Bash")
- Shows tool input in a code block (e.g., the bash command)
- "Allow" button (green) and "Deny" button (red)
- Optional "Always allow this tool" checkbox (stores preference in SessionDO state for this session)

SessionDO state transitions to `waiting_permission` while prompt is pending.

NOTE: `permissionMode: 'default'` is required on the SDK `query()` options for permission prompts to fire. The `canUseTool` callback is only invoked when `permissionMode` is `'default'`.

#### API Layer

**Gateway to DO (GatewayEvent):**
- `{"type":"permission_request","session_id":"xxx","tool_call_id":"tc_xxx","tool_name":"Bash","input":{"command":"rm -rf /tmp/test"}}`

**DO to Browser (UIMessageChunk):**
- Tool invocation with `toolName`, state: `approval-requested`, input object

**Browser to DO (over WS):**
- `{"type":"tool-approval","toolCallId":"tc_xxx","approved":true}` or `{"type":"tool-approval","toolCallId":"tc_xxx","approved":false}`

**DO to Gateway (GatewayCommand):**
- `{"type":"permission-response","session_id":"xxx","tool_call_id":"tc_xxx","allowed":true}`

Gateway resolves the `canUseTool` promise with `{ behavior: "allow" }` or `{ behavior: "deny", message: "User denied permission" }`.

#### Data Layer

SessionDO state field `pending_permission: { tool_call_id, tool_name, input } | null`. Cleared on user response. Permission decisions are logged in the messages table.

---

### B8: Track Session Metadata and History

**Core:**
- **ID:** session-tracking
- **Trigger:** Sessions are created, run, and complete over time
- **Expected:** Dashboard shows active sessions with live status, and a history view shows past sessions with metadata (worktree, duration, cost, status, model, num_turns)
- **Verify:** Run several sessions to completion, check history view shows all with correct metadata
- **Source:** `apps/orchestrator/src/agents/session-registry.ts:77` (registerSession), `apps/orchestrator/src/agents/session-agent.ts:242` (getSessionState)

#### UI Layer

1. **Active sessions panel:** List of running sessions with: status badge (running = blue pulse, waiting = yellow), worktree name, model badge, live duration counter, prompt preview (first 80 chars).
2. **Session history view:** Table with columns: worktree, status (badge), model, duration, cost (USD), turns, created_at. Sortable by any column. Filterable by status and worktree.
3. Clicking any session navigates to `/session/:id` chat view (with replay from SQLite history for completed sessions).

#### API Layer

- `GET /api/sessions` -- returns `{ sessions: SessionSummary[] }` from WorktreeRegistry `listSessions()`
- `GET /api/sessions/active` -- returns `{ sessions: SessionSummary[] }` from WorktreeRegistry `listActiveSessions()`
- `GET /api/sessions/:id` -- returns `{ session: SessionState }` from SessionDO `getSessionState()` RPC
- `GET /api/sessions/:id/messages` -- returns `{ messages: Message[] }` from SessionDO SQLite for replay

#### Data Layer

WorktreeRegistry `sessions` SQLite table (already exists): `id, worktree, status, model, created_at, updated_at`. Needs additional columns: `duration_ms INTEGER, total_cost_usd REAL, num_turns INTEGER, prompt TEXT`. SessionDO updates WorktreeRegistry on terminal state with final metadata.

---

### B9: Browse Project Files

**Core:**
- **ID:** file-browser
- **Trigger:** User opens the file browser panel for a worktree (from session view or worktree card)
- **Expected:** Tree view of the worktree's file system renders. Clicking a file shows its contents. Git status indicators show per file. Directory nodes expand on click (lazy loaded).
- **Verify:** Open file browser for a worktree, expand directories, click a file to view contents, confirm git status icons match `git status` output
- **Source:** `packages/cc-gateway/src/worktrees.ts` (resolveWorktree -- base for new file endpoints)

#### UI Layer

File browser is a resizable side panel in the session view (shadcn ResizablePanel):
- **Tree view:** Collapsible directory tree. Files show icons by extension. Directories show folder icon. Git status: green dot (new/untracked), yellow dot (modified), no dot (clean).
- **File viewer:** Read-only code viewer with syntax highlighting (via shadcn Code Block or a lightweight highlighter). Shows file path breadcrumb at top.
- **Lazy loading:** Only root-level entries loaded initially. Subdirectories fetched on expand.
- **Search:** File name filter input at top of tree.

#### API Layer

cc-gateway HTTP endpoints (new):
- `GET /worktrees/:name/files?depth=1&path=/` -- returns `{ entries: Array<{ name, path, type: "file"|"dir", size? }> }`. Auth required. Depth parameter limits recursion (default 1). Path parameter specifies subdirectory.
- `GET /worktrees/:name/files/*path` -- returns raw file contents. Content-Type set by extension. Max file size 1MB (returns 413 if larger). Auth required.
- `GET /worktrees/:name/git-status` -- returns `{ files: Array<{ path, status: "modified"|"staged"|"untracked"|"clean" }> }`. Auth required. Runs `git status --porcelain` and parses output.

All endpoints validate that `:name` is a valid discovered worktree and `*path` does not escape the worktree root (no `..` traversal). NOTE: cc-gateway's `GET /worktrees/:name/*` endpoints MUST validate `name` against the discovered worktree list (not just path resolution). This prevents path traversal via crafted worktree names.

#### Data Layer

No persistent data. All file data served directly from the VPS filesystem via cc-gateway.

---

### B10: Real-Time File Change Notifications

**Core:**
- **ID:** file-change-sync
- **Trigger:** Running session modifies a file via Edit or Write tool
- **Expected:** Browser file browser highlights the changed file immediately. A notification badge appears on the file browser tab.
- **Verify:** While session is running and file browser is open, observe that files modified by tool calls get highlighted within 1 second of the tool completing
- **Source:** New functionality -- PostToolUse hooks in cc-gateway

#### UI Layer

- Changed files in the tree view get a blue highlight animation (fades after 3 seconds).
- File browser tab/icon shows a badge with count of changed files since last viewed.
- If the changed file is currently open in the viewer, a "File changed -- reload?" banner appears at the top.
- Clicking "reload" re-fetches the file contents.

#### API Layer

**Gateway to DO (GatewayEvent):**
- `{"type":"file_changed","session_id":"xxx","path":"/data/projects/worktree-dev1/src/index.ts","tool":"Edit","timestamp":"2026-03-31T10:00:00Z"}`

**DO to Browser (over WS, custom event -- not part of AI SDK stream protocol):**
- `{"type":"file-changed","path":"src/index.ts","tool":"Edit","timestamp":"..."}`

Path is relative to worktree root in the browser event.

The PostToolUse hook in cc-gateway fires after Edit and Write tool completions. It extracts the file path from the tool input and sends the file_changed event over the session WS.

#### Data Layer

No persistent storage for file change events. They are ephemeral push notifications.

---

### B11: Abort Running Session

**Core:**
- **ID:** abort-session
- **Trigger:** User clicks the "Abort" button in the session chat view
- **Expected:** Session stops immediately. Gateway aborts the SDK query. Worktree lock is released. Session status transitions to "aborted".
- **Verify:** Start a long-running session, click Abort, confirm session stops, worktree shows as free in dashboard
- **Source:** `apps/orchestrator/src/agents/session-agent.ts:206` (abort method)

#### UI Layer

Red "Abort" button in session header, visible only when session status is "running", "waiting_input", or "waiting_permission". Confirmation dialog: "Are you sure you want to abort this session?" with Cancel and Abort buttons. After abort, status badge changes to "aborted" (red), prompt input is disabled, and a banner shows "Session was aborted."

#### API Layer

- `POST /api/sessions/:id/abort` -- calls SessionDO `abort()` RPC
- The abort RPC must accept abort from `running`, `waiting_input`, and `waiting_permission` states (existing code only allows `running` -- needs expansion)
- SessionDO sends abort command to gateway, closes gateway WS, transitions to "aborted"
- SessionDO calls WorktreeRegistry `releaseWorktree()` and `updateSessionStatus()`
- Gateway `AbortController.abort()` cancels the SDK query

#### Data Layer

SessionDO state: `status: "aborted"`, `updated_at` set. WorktreeRegistry: worktree lock removed, sessions table status updated.

---

### B12: Session Replay on Reconnect

**Core:**
- **ID:** session-replay
- **Trigger:** User navigates to a session page (either active or completed) or browser reconnects after disconnect
- **Expected:** Full message history loads from SessionDO SQLite and renders in the chat view. If session is still running, live streaming resumes after history replay.
- **Verify:** Open a running session in a new browser tab, confirm full conversation history appears, then new streaming messages continue to appear
- **Source:** `apps/orchestrator/src/agents/session-agent.ts:92` (onConnect, messages table)

#### UI Layer

On session page load:
1. Loading skeleton shows while history is fetched.
2. Full conversation history renders (all messages, tool calls, tool results).
3. If session is running, a "Live" indicator appears and new streaming messages append in real-time.
4. If session is completed/failed/aborted, the final status banner shows.
5. Scroll position starts at bottom.

#### API Layer

- Browser connects to SessionDO via WebSocket at `/api/sessions/:id/ws`
- On WS open, SessionDO sends full message history as a batch: `{"type":"history","messages":[...]}`
- Then switches to live streaming mode, forwarding new events as they arrive from gateway
- If session is in a terminal state, only history is sent, then WS can remain open for file-changed events or close

#### Data Layer

SessionDO SQLite `messages` table stores every complete message. On WS connect, `SELECT * FROM messages ORDER BY id ASC` retrieves full history.

---

## Non-Goals

Explicitly out of scope for this feature:
- Task queuing or scheduling -- no queue of sessions waiting for free worktrees
- Prompt curation or context injection -- no managed prompt templates or CLAUDE.md injection
- End-of-session eval loops -- no automatic verification or retry on failure
- Session chaining -- no plan-then-implement-then-verify pipelines
- Cross-session coordination -- no dependency tracking between sessions
- File editing from browser -- file browser is strictly read-only
- Mobile support -- desktop-first, no responsive design optimization
- Multi-user concurrent access -- single-user dashboard (auth protects access, no role-based permissions)

## Open Questions

- [x] Protocol format between gateway and DO: using GatewayCommand/GatewayEvent (typed JSON over WS), translated to AI SDK UIMessageChunk in SessionDO
- [x] File browser scope: worktree root only, no navigation outside (no `~/.claude/`)
- [ ] Maximum file size for file viewer -- currently specified as 1MB, may need adjustment based on real usage
- [ ] Session history retention policy -- how long to keep completed session data in DO SQLite before cleanup
- [x] Model list -- hardcoded in frontend. Starting with: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5.

## Implementation Phases

See YAML frontmatter `phases:` above. Each phase should be 1-4 hours of focused work.

## Verification Strategy

### Test Infrastructure

- **cc-gateway tests:** vitest with Bun runtime. Test config at `packages/cc-gateway/vitest.config.ts` (to be created in P1). WS protocol tests use Bun's built-in WebSocket client against a test server instance.
- **DO tests:** vitest with miniflare (Cloudflare Workers test environment). Test config at `apps/orchestrator/vitest.config.ts` (may need `@cloudflare/vitest-pool-workers` plugin). Tests instantiate DOs directly via miniflare bindings.
- **Protocol translation tests:** Pure unit tests (vitest), no runtime dependencies. Test the SDK message to UI stream chunk mapping functions in isolation.
- **Frontend tests:** Smoke tests via manual verification against running system. Component rendering tests optional (vitest + jsdom if added).

### Build Verification

Run `pnpm build` from the monorepo root (Turbo pipeline builds all packages in dependency order). Note: TanStack Start generates route types at build time, so `pnpm typecheck` alone may not catch route-related type errors -- always run the full build. For incremental checks during development, `pnpm typecheck` is sufficient for non-route changes.

## Verification Plan

Concrete, executable steps to verify the feature works against the REAL running system.

### VP1: Gateway File API

Steps:
1. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/worktrees`
   Expected: JSON array of worktree objects with name, path, branch, dirty fields
2. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/worktrees/baseplane-dev1/files?depth=1`
   Expected: JSON with entries array containing file/dir objects for the worktree root
3. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/worktrees/baseplane-dev1/files/package.json`
   Expected: Raw contents of package.json with Content-Type application/json
4. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/worktrees/baseplane-dev1/git-status`
   Expected: JSON with files array showing per-file git status
5. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9877/worktrees/baseplane-dev1/files/../../../etc/passwd`
   Expected: 400 error "Path traversal not allowed"

### VP2: Gateway WS Session Protocol

Steps:
1. Connect via WebSocket to `ws://127.0.0.1:9877/?worktree=baseplane-dev1` with auth header
   Expected: Connection established
2. Send `{"type":"execute","worktree":"baseplane-dev1","prompt":"Say hello","model":"claude-sonnet-4-6"}`
   Expected: Receive `session.init` event, then `partial_assistant` events with incremental text, then `assistant` event with complete message, then `result` event
3. Send `{"type":"stream-input","session_id":"xxx","message":{"role":"user","content":"Now say goodbye"}}`
   Expected: Receive new `partial_assistant` events for the follow-up response
4. Send `{"type":"abort","session_id":"xxx"}`
   Expected: Session stops, WS may close or send final error

Note: Use `websocat` or `wscat` for WebSocket testing: `wscat -c ws://localhost:9877/?token=xxx -H 'Authorization: Bearer xxx'`

### VP3: Dashboard Worktree Grid

Steps:
1. Open `https://<orchestrator-url>/` in browser (authenticated)
   Expected: Dashboard loads with worktree grid showing all discovered worktrees with branch names
2. Verify one worktree shows as "free" (green indicator)
   Expected: Lock status reflects actual state from WorktreeRegistry

### VP4: New Session Flow

Steps:
1. Click "New Session" button on dashboard
   Expected: Dialog opens with worktree picker, prompt input, model selector
2. Select an unlocked worktree, type "List the files in this project", select claude-sonnet-4-6, click Launch
   Expected: Dialog closes, redirects to `/session/:id`, chat view opens
3. Observe chat view
   Expected: Streaming text appears progressively, tool calls (Bash/Glob) render with inputs and outputs
4. Check dashboard in another tab
   Expected: Selected worktree shows as locked, session appears in active list

### VP5: Interactive Chat

Steps:
1. While session from VP4 is running, type "Now show me the README" in the prompt input and press Enter
   Expected: Message appears in chat, new streaming response begins
2. Wait for response to complete
   Expected: Full response with file contents rendered

### VP6: Permission and AskUserQuestion Flow

Steps:
1. Start a session with a prompt that triggers a permission-requiring tool (e.g., "Run `ls /tmp` using bash")
   Expected: Confirmation dialog appears showing the Bash command
2. Click "Allow"
   Expected: Tool executes, result appears in chat
3. Start a session whose prompt triggers AskUserQuestion
   Expected: Question fields appear in chat with input boxes
4. Fill in answers and click "Submit Answers"
   Expected: Session continues with provided answers

### VP7: File Browser

Steps:
1. Open file browser panel in a running session view
   Expected: Tree view loads with worktree root entries
2. Click a directory to expand it
   Expected: Directory children load and appear indented
3. Click a source file (e.g., `src/index.ts`)
   Expected: File contents display with syntax highlighting in the viewer panel
4. Wait for the session to edit a file
   Expected: Changed file gets highlighted in the tree, "File changed" badge appears

### VP8: Session Replay

Steps:
1. Open a completed session at `/session/:id`
   Expected: Full conversation history renders (all messages, tool calls, results)
2. Open a running session in a new browser tab
   Expected: History loads first, then live streaming continues from where history ends

### VP9: Session Abort

Steps:
1. Start a session with a long prompt (e.g., "Refactor the entire codebase to use...")
   Expected: Session starts streaming
2. Click the "Abort" button, confirm in dialog
   Expected: Streaming stops, status badge changes to "aborted", worktree shows as free in dashboard

## Implementation Hints

### Dependencies

```bash
# Frontend (apps/orchestrator)
pnpm add ai @ai-sdk/react

# shadcn AI components are copy-paste (not npm packages)
# Install via: npx shadcn@latest add "https://www.shadcn.io/r/ai/..."
# Components needed: message, conversation, prompt-input, tool, reasoning, confirmation, code-block

# cc-gateway already has @anthropic-ai/claude-agent-sdk
# No new npm dependencies needed for cc-gateway
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@ai-sdk/react` | `{ useChat }` | Chat state management + message rendering |
| `~/lib/ws-transport` | `{ WebSocketChatTransport }` | CUSTOM class we implement (not an AI SDK export) -- WS transport for useChat connecting to SessionDO |
| `ai` | `{ UIMessage, UIMessageChunk }` | Types for AI SDK stream protocol |
| `@anthropic-ai/claude-agent-sdk` | `{ query }` | SDK query with streaming input |
| `agents` | `{ Agent, Connection }` | DO base class (CF Agents SDK) |

### Code Patterns

**1. Streaming input mode in cc-gateway (AsyncIterable prompt):**
```typescript
// messageGenerator yields user messages as they arrive over WS
async function* messageGenerator(
  initialPrompt: string,
  inputQueue: AsyncIterableQueue<SDKUserMessage>
) {
  // Yield initial prompt
  yield { type: "user", message: { role: "user", content: initialPrompt } }
  // Yield subsequent messages as they arrive from browser via DO
  for await (const msg of inputQueue) {
    yield msg
  }
}

const iter = query({
  prompt: messageGenerator(cmd.prompt, queue),
  options: {
    permissionMode: 'default',
    includePartialMessages: true,
    canUseTool,
    ...rest,
  }
})
```

**2. Protocol translation in SessionDO (SDK event to UI stream chunk):**
```typescript
function translateToUIChunks(event: GatewayEvent): UIMessageChunk[] {
  switch (event.type) {
    case 'partial_assistant': {
      const chunks: UIMessageChunk[] = []
      for (const block of event.content) {
        if (block.type === 'text') {
          chunks.push({ type: 'text-delta', id: block.id, delta: block.delta })
        } else if (block.type === 'tool_use') {
          chunks.push({
            type: 'tool-input-delta',
            toolCallId: block.id,
            inputTextDelta: block.delta,
          })
        }
      }
      return chunks
    }
    // ... other event types
  }
}
```

**3. WebSocketChatTransport for useChat:**
```typescript
class WebSocketChatTransport {
  private ws: WebSocket | null = null

  constructor(private config: { sessionId: string; getWsUrl: () => string }) {}

  connect() {
    this.ws = new WebSocket(this.config.getWsUrl())
    this.ws.onmessage = (event) => {
      const chunk = JSON.parse(event.data)
      this.onChunk?.(chunk) // Callback registered by useChat
    }
  }

  send(message: { content: string }) {
    this.ws?.send(JSON.stringify({
      type: 'user-message',
      content: message.content,
    }))
  }

  onChunk?: (chunk: UIMessageChunk) => void
}
```

**4. PostToolUse hook for file change notifications:**
```typescript
const notifyFileChange = {
  matcher: /^(Edit|Write)$/,
  hook: async (toolName: string, input: Record<string, unknown>, output: unknown) => {
    const filePath = input.file_path as string
    ws.send(JSON.stringify({
      type: 'file_changed',
      session_id: sessionId,
      path: filePath,
      tool: toolName,
      timestamp: new Date().toISOString(),
    }))
  }
}
```

**5. canUseTool with permission relay:**
```typescript
options.canUseTool = async (toolName, input, toolOptions) => {
  if (toolName === 'AskUserQuestion') {
    // Existing flow -- relay questions, wait for answers
    send(ws, { type: 'ask_user', session_id, tool_call_id: toolOptions.id, questions: input.questions })
    const answers = await waitForAnswer(ctx, toolOptions.id)
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }

  // Permission prompt for other tools
  send(ws, { type: 'permission_request', session_id, tool_call_id: toolOptions.id, tool_name: toolName, input })
  const allowed = await waitForPermission(ctx, toolOptions.id)
  return allowed
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: 'User denied permission' }
}
```

### Gotchas

- **CF Workers WebSocket client limitations:** Cloudflare Workers can create outbound WebSocket connections (using `new WebSocket(url)`), but the connection is established during a request or DO alarm -- not in a persistent background thread. SessionDO must reconnect on every wake after eviction.
- **AI SDK stream protocol statefulness:** The `useChat` hook expects messages to arrive in order (start, deltas, finish). If the DO sends chunks out of order (e.g., after reconnect), the UI will break. Session replay must send a `history` batch first, then switch to live mode.
- **DO SQLite row limits:** Cloudflare DO SQLite has a 256MB storage limit per DO. Long sessions with many tool calls could approach this. Consider a message count limit (e.g., 10,000 messages) with oldest-first eviction for very long sessions.
- **Gateway WS per session:** Each SessionDO maintains one WS to the gateway for one session. If the gateway restarts, all active sessions lose their WS connection. SessionDO must detect this and attempt reconnect (with the `resume` command if the SDK supports it, or mark as failed).
- **Partial message deduplication:** `includePartialMessages: true` emits partial messages that are later superseded by the complete message. The DO must not store partials in SQLite -- only store the final complete message.
- **Message gap on reconnect:** Messages emitted between gateway WS drop and SessionDO reconnect may be lost. The session replay mechanism (B12) mitigates this by replaying full history from SQLite on reconnect, but real-time viewers may see a brief gap.
- **File path security:** The file API endpoints must validate that requested paths do not escape the worktree root. Use `path.resolve()` and verify the resolved path starts with the worktree path. Reject any path containing `..` segments.
- **permissionMode must change:** The existing cc-gateway uses `bypassPermissions` -- this MUST be changed to `'default'` for permission relaying to work. All tool permissions are handled via the `canUseTool` callback.
- **Biome formatting:** All new TypeScript files must follow Biome conventions: 2-space indent, no semicolons, single quotes, 100 char line width.

### Reference Docs

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- SDK API, query() options, message types
- [Claude Agent SDK Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) -- Session management, resume, streaming input
- [Claude Agent SDK User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) -- AskUserQuestion, canUseTool callback
- [Claude Agent SDK Streaming](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) -- includePartialMessages, SDKPartialAssistantMessage
- [AI SDK useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) -- useChat hook API, custom transports
- [AI SDK Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport) -- WebSocketChatTransport, custom transport interface
- [AI SDK Stream Protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) -- UIMessageChunk format, text-delta, tool events
- [AI SDK Tool Usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage) -- Tool invocations, approval flow, addToolApprovalResponse
- [shadcn AI Components](https://www.shadcn.io/ai) -- Message, Conversation, Prompt Input, Tool, Reasoning, Confirmation, Code Block
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) -- DO base class, setState, SQL, WebSocket connections
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) -- Storage limits, alarms, WebSocket hibernation
