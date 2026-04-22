// ── Gateway Commands (Orchestrator → Gateway) ─────────────────────────

export type GatewayCommand =
  | ExecuteCommand
  | ResumeCommand
  | StreamInputCommand
  | PermissionResponseCommand
  | AbortCommand
  | StopCommand
  | AnswerCommand
  | RewindCommand
  | InterruptCommand
  | GetContextUsageCommand
  | SetModelCommand
  | SetPermissionModeCommand
  | StopTaskCommand
  | PingCommand

export interface ExecuteCommand {
  type: 'execute'
  project: string
  prompt: string | ContentBlock[]
  model?: string
  system_prompt?: string
  allowed_tools?: string[]
  max_turns?: number
  max_budget_usd?: number
  thinking?:
    | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }
    | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Baseplane organization ID (gateway-level metadata, not passed to Claude SDK) */
  org_id?: string
  /** Baseplane user ID (gateway-level metadata, not passed to Claude SDK) */
  user_id?: string
  /** Which agent to use. Defaults to 'claude' if omitted. */
  agent?: string
}

// Content block types matching Anthropic API format
export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ImageContentBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
}

export type ContentBlock = TextContentBlock | ImageContentBlock

export interface StreamInputCommand {
  type: 'stream-input'
  session_id: string
  message: { role: 'user'; content: string | ContentBlock[] }
  /** Optional client-proposed message id for server-accepts-client-ID echo reconciliation (GH#14 B6). */
  client_message_id?: string
}

export interface PermissionResponseCommand {
  type: 'permission-response'
  session_id: string
  tool_call_id: string
  allowed: boolean
}

export interface AbortCommand {
  type: 'abort'
  session_id: string
}

export interface StopCommand {
  type: 'stop'
  session_id: string
}

export interface RewindCommand {
  type: 'rewind'
  session_id: string
  message_id: string
  /** If true, preview what would change without modifying files */
  dry_run?: boolean
}

export interface InterruptCommand {
  type: 'interrupt'
  session_id: string
}

export interface GetContextUsageCommand {
  type: 'get-context-usage'
  session_id: string
}

export interface SetModelCommand {
  type: 'set-model'
  session_id: string
  model?: string
}

export interface SetPermissionModeCommand {
  type: 'set-permission-mode'
  session_id: string
  mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
}

export interface StopTaskCommand {
  type: 'stop-task'
  session_id: string
  task_id: string
}

export interface PingCommand {
  type: 'ping'
}

export interface AnswerCommand {
  type: 'answer'
  session_id: string
  tool_call_id: string
  answers: Record<string, string>
}

// Resume command (session recovery with follow-up prompt)
export interface ResumeCommand {
  type: 'resume'
  project: string
  prompt: string | ContentBlock[]
  sdk_session_id: string
  /** Which agent to use for resume. Defaults to 'claude' if omitted. */
  agent?: string
}

// ── Gateway Events (Gateway → Orchestrator) ────────────────────────────

export type GatewayEvent =
  | SessionInitEvent
  | PartialAssistantEvent
  | AssistantEvent
  | ToolResultEvent
  | AskUserEvent
  | PermissionRequestEvent
  | FileChangedEvent
  | ResultEvent
  | ErrorEvent
  | KataStateEvent
  | StoppedEvent
  | ContextUsageEvent
  | RewindResultEvent
  | RateLimitEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | ModeTransitionEvent
  | ModeTransitionTimeoutEvent
  | ModeTransitionPreambleDegradedEvent
  | ModeTransitionFlushTimeoutEvent

// ── Mode transition events (DO-synthesised for chain UX) ────────────
//
// Emitted by SessionDO when a chain-linked session receives a `kata_state`
// event whose `currentMode` differs from the previous mode and
// `continueSdk` is not set. These travel over the browser WS channel
// alongside real runner events so the chain timeline UI can render them.

export interface ModeTransitionEvent {
  type: 'mode_transition'
  session_id: string
  from: string | null
  to: string
  issueNumber: number
  at: string
}

export interface ModeTransitionTimeoutEvent {
  type: 'mode_transition_timeout'
  session_id: string
  issueNumber: number
  at: string
  note: string
}

export interface ModeTransitionPreambleDegradedEvent {
  type: 'mode_transition_preamble_degraded'
  session_id: string
  issueNumber: number
  at: string
  reason: string
}

export interface ModeTransitionFlushTimeoutEvent {
  type: 'mode_transition_flush_timeout'
  session_id: string
  issueNumber: number
  at: string
}

export interface StoppedEvent {
  type: 'stopped'
  session_id: string
  sdk_session_id: string | null
}

export interface ContextUsageEvent {
  type: 'context_usage'
  session_id: string
  /** Full SDK response from query.getContextUsage() */
  usage: Record<string, unknown>
}

export interface RewindResultEvent {
  type: 'rewind_result'
  session_id: string
  can_rewind: boolean
  error?: string
  files_changed?: string[]
  insertions?: number
  deletions?: number
}

export interface RateLimitEvent {
  type: 'rate_limit'
  session_id: string
  rate_limit_info: Record<string, unknown>
}

export interface TaskStartedEvent {
  type: 'task_started'
  session_id: string
  task_id: string
  description: string
  task_type?: string
  prompt?: string
}

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

export interface SessionInitEvent {
  type: 'session.init'
  session_id: string
  sdk_session_id: string | null
  project: string
  model: string | null
  tools: string[]
}

export interface PartialAssistantEvent {
  type: 'partial_assistant'
  session_id: string
  content: PartialContentBlock[]
}

export interface PartialContentBlock {
  type: 'text' | 'thinking' | 'tool_use'
  id: string
  /** For text and thinking blocks: the incremental text / reasoning delta */
  delta?: string
  /** For tool_use blocks: the tool name (sent on first delta) */
  tool_name?: string
  /** For tool_use blocks: the incremental input delta */
  input_delta?: string
}

export interface AssistantEvent {
  type: 'assistant'
  session_id: string
  uuid: string
  content: unknown[]
}

export interface ToolResultEvent {
  type: 'tool_result'
  session_id: string
  uuid: string
  content: unknown[]
}

export interface AskUserEvent {
  type: 'ask_user'
  session_id: string
  tool_call_id: string
  questions: unknown[]
}

export interface PermissionRequestEvent {
  type: 'permission_request'
  session_id: string
  tool_call_id: string
  tool_name: string
  input: Record<string, unknown>
}

export interface FileChangedEvent {
  type: 'file_changed'
  session_id: string
  path: string
  tool: string
  timestamp: string
}

export interface ResultEvent {
  type: 'result'
  session_id: string
  subtype: string
  duration_ms: number
  total_cost_usd: number | null
  result: string | null
  num_turns: number | null
  is_error: boolean
  sdk_summary: string | null
}

export interface ErrorEvent {
  type: 'error'
  session_id: string | null
  error: string
}

// ── UI Stream Chunks (SessionDO → Browser, AI SDK stream protocol) ──

export type UIStreamChunk =
  | { type: 'start'; messageId: string }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | {
      type: 'tool-input-available'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'finish' }
  | { type: 'turn-complete' }
  | { type: 'history'; messages: StoredMessage[] }
  | { type: 'file-changed'; path: string; tool: string; timestamp: string }

// ── Browser → SessionDO Messages ────────────────────────────────────

export type BrowserCommand =
  | { type: 'user-message'; content: string }
  | {
      type: 'tool-approval'
      toolCallId: string
      approved: boolean
      answers?: Record<string, string>
    }

// ── Project ──────────────────────────────────────────────────────────

export interface PrInfo {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  checks: { pass: number; fail: number; pending: number; total: number } | null
}

export interface ProjectInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
  active_session: string | null
  repo_origin: string | null
  ahead: number
  behind: number
  pr: PrInfo | null
}

// ── SDK Session Info (on-disk session metadata) ─────────────────────

export interface SdkSessionInfo {
  session_id: string
  user: string
  branch: string
  project_dir: string
  workflow_id: string
  started_at: string
  last_activity: string
  summary: string
  tag: string | null
}

// ── Session Discovery ───────────────────────────────────────────────

export interface DiscoveredSession {
  /** Unique session ID from the agent (SDK session_id, thread_id, etc.) */
  sdk_session_id: string
  /** Agent that created this session */
  agent: string
  /** Project directory path */
  project_dir: string
  /** Project name (derived from path) */
  project: string
  /** Git branch at time of session */
  branch: string
  /** Session start time (ISO) */
  started_at: string
  /** Last activity time (ISO) */
  last_activity: string
  /** Session summary or first prompt */
  summary: string
  /** User-assigned tag */
  tag: string | null
  /** Title (from SDK rename or agent-generated) */
  title: string | null
  /** Number of messages/turns if known */
  message_count: number | null
  /** User identity from the agent */
  user: string | null
}

export interface SessionSource {
  /** Agent name matching the execution adapter (e.g. 'claude', 'codex') */
  readonly agent: string
  /** Human-readable description */
  readonly description: string
  /** Whether this source can discover sessions (binary exists, dirs present, etc.) */
  available(): Promise<boolean>
  /** Discover sessions in a project directory, optionally filtered by timestamp */
  discoverSessions(
    projectPath: string,
    opts?: {
      since?: string
      limit?: number
    },
  ): Promise<DiscoveredSession[]>
}

// ── File API ─────────────────────────────────────────────────────────

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface GitFileStatus {
  path: string
  status: 'modified' | 'staged' | 'untracked' | 'clean'
}

// ── Kata Session State ──────────────────────────────────────────────

export interface KataSessionState {
  sessionId: string
  workflowId: string | null
  issueNumber: number | null
  sessionType: string | null
  currentMode: string | null
  currentPhase: string | null
  completedPhases: string[]
  template: string | null
  phases: string[]
  modeHistory: Array<{ mode: string; enteredAt: string }>
  modeState: Record<string, { status: string; enteredAt: string }>
  updatedAt: string
  beadsCreated: string[]
  editedFiles: string[]
  /**
   * If true, a kata_state event signalling a mode change instructs the DO to
   * KEEP the current SDK runner instead of performing a reset. Used by modes
   * that legitimately want to reuse the live context (rare — default is
   * reset-on-enter).
   */
  continueSdk?: boolean
}

export interface KataStateEvent {
  type: 'kata_state'
  session_id: string | null
  project: string
  kata_state: KataSessionState | null
}

// ── Context Usage (shared between DO + client) ─────────────────────
//
// Mirror of the canonical shape client-side code writes into
// `sessionLiveStateCollection.contextUsage`. The SDK's
// `query.getContextUsage()` returns a `Record<string, unknown>` on the wire
// (see ContextUsageEvent.usage); this interface is the parsed /
// strongly-typed projection used by UI consumers and by the new P3 REST
// cache in SessionDO's `session_meta.context_usage_json` column.

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
  isAutoCompactEnabled?: boolean
  autoCompactThreshold?: number
}

// ── Session State ────────────────────────────────────────────────────

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_gate'

// SessionState deleted (#31 P5 / B10). Status / gate / result are now derived
// client-side from `messagesCollection`; context usage and kata state go over
// REST; all other ex-SessionState fields moved into the DO's typed
// `session_meta` SQLite table (see `SessionMeta` in session-do.ts).
// `SessionStatus` is retained — still used by status-derivation hooks and the
// D1-mirrored SessionSummary row.

export interface SpawnConfig {
  project: string
  /** Initial message — plain text or structured content blocks (text + images). */
  prompt: string | ContentBlock[]
  model?: string
  /** Which agent adapter to use (e.g. 'claude', 'codex'). Defaults to 'claude'. */
  agent?: string
  system_prompt?: string
  allowed_tools?: string[]
  max_turns?: number
  max_budget_usd?: number
}

export interface GateResponse {
  approved?: boolean
  answer?: string
}

export interface SessionSummary {
  id: string
  userId: string | null
  project: string
  status: SessionStatus
  model: string | null
  createdAt: string
  updatedAt: string
  lastActivity?: string | null
  durationMs?: number | null
  totalCostUsd?: number | null
  numTurns?: number | null
  prompt?: string
  summary?: string
  title?: string | null
  tag?: string | null
  archived?: boolean
  origin?: string | null
  agent?: string | null
  sdkSessionId?: string | null
  kataMode?: string | null
  kataIssue?: number | null
  kataPhase?: string | null
  // Spec #37 P1a-1: per-session live state mirrored from DO.
  error?: string | null
  errorCode?: string | null
  kataStateJson?: string | null
  contextUsageJson?: string | null
  worktreeInfoJson?: string | null
  // GH#50: epoch-ms of the last GatewayEvent received by the SessionDO.
  // Read by client `deriveStatus()` predicate to override stuck `running`
  // rows with `idle` after >45s of silence.
  lastEventTs?: number | null
}

// ── Stored Message (for SQLite persistence) ─────────────────────────

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant' | 'tool'
  type: string
  data: string
  created_at: string
}

// ── Messages Frame (SessionDO → Browser, unified {type:'messages'} channel) ──

/**
 * Wire-level shape of a session message. Mirrors the SDK's `SessionMessage`
 * (from `agents/experimental/memory/session`) as serialised over the
 * DO→browser WS channel. Additional fields may be present on the wire; this
 * interface only declares fields we read client-side and on the gateway.
 */
export interface SessionMessage {
  id: string
  sessionId?: string
  role: 'user' | 'assistant' | 'tool' | string
  parts: unknown[]
  createdAt?: string | number | Date
  /**
   * Optional canonical turn id (`usr-N`). Populated by SessionDO on user
   * turns; absent on assistant and tool rows. Introduced in P3 (B6); safe to
   * declare now as an optional field so P1 MessagesFrame types compile.
   */
  canonical_turn_id?: string
}

export interface BranchInfoRow {
  parentMsgId: string
  sessionId: string
  siblings: string[]
  activeId: string
  updatedAt: string
}

// ── User Preferences ────────────────────────────────────────────────

export interface UserPreferences {
  permission_mode: string
  model: string
  max_budget: number | null
  thinking_mode: string
  effort: string
}

// ── Session Context (agent-gateway internal) ─────────────────────────

export interface SessionContext {
  sessionId: string
  /** Baseplane organization ID (gateway-level tracking) */
  orgId: string | null
  /** Baseplane user ID (gateway-level tracking) */
  userId: string | null
  abortController: AbortController
  pendingAnswer: {
    resolve: (answers: Record<string, string>) => void
    reject: (err: Error) => void
  } | null
  pendingPermission: {
    resolve: (allowed: boolean) => void
    reject: (err: Error) => void
  } | null
  /** Queue for streaming user messages into a running session */
  messageQueue: {
    push: (msg: { role: 'user'; content: string | ContentBlock[] }) => void
    done: () => void
  } | null
}

// ============================================================================
// Synced-collection delta-frame wire protocol (GH#32)
// ============================================================================
//
// Shape pushed by UserSettingsDO over the user-stream WS to drive
// TanStack DB synced-layer writes (begin / write / commit) on the client.
// The discriminated union on `SyncedCollectionOp` guarantees that
// `insert` / `update` frames always carry `value` and `delete` frames
// always carry `key` — no optional fields, malformed frames reject at
// compile time. No `seq` — reconnect triggers a full-fetch resync via
// the factory's queryFn, and hot incremental delivery assumes the WS
// is authoritative while connected.
//
// `collection` is a free-form string used to route frames to consumer
// handlers. The project convention is `<scope>` for user-scoped
// collections (e.g. `'user_tabs'`, `'user_preferences'`, `'projects'`,
// `'chains'`, `'agent_sessions'`) and `'<scope>:<sessionId>'` for
// session-scoped collections (e.g. `'messages:<sessionId>'`,
// `'branchInfo:<sessionId>'`). The convention is enforced only by
// callers and subscribers; there is no runtime check.

export type SyncedCollectionOp<TRow = unknown> =
  | { type: 'insert'; value: TRow }
  | { type: 'update'; value: TRow }
  | { type: 'delete'; key: string }

export interface SyncedCollectionFrame<TRow = unknown> {
  type: 'synced-collection-delta'
  collection: string
  ops: Array<SyncedCollectionOp<TRow>>
  /**
   * Optional per-stream monotonic counter stamped by the server;
   * observability only, clients MUST NOT gate on it. Introduced by
   * `broadcastMessages` in SessionDO (GH#38 P1.2) so operators can
   * correlate frames across server logs without surfacing a reconcile
   * knob to the client. Legacy user-scoped callers do not populate it.
   */
  messageSeq?: number
}
