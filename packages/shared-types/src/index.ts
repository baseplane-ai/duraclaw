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
  | SessionStateChangedEvent
  | RateLimitEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | HeartbeatEvent
  | ModeTransitionEvent
  | ModeTransitionTimeoutEvent
  | ModeTransitionPreambleDegradedEvent
  | ModeTransitionFlushTimeoutEvent

export interface HeartbeatEvent {
  type: 'heartbeat'
  session_id: string
}

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

export interface SessionStateChangedEvent {
  type: 'session_state_changed'
  session_id: string
  state: 'idle' | 'running' | 'requires_action'
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

// ── Session State ────────────────────────────────────────────────────

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_gate'

export interface SessionState {
  status: SessionStatus
  session_id: string | null
  project: string
  project_path: string
  model: string | null
  prompt: string
  userId: string | null
  started_at: string | null
  completed_at: string | null
  num_turns: number
  total_cost_usd: number | null
  duration_ms: number | null
  gate: {
    id: string
    type: 'permission_request' | 'ask_user'
    detail: unknown
  } | null
  created_at: string
  updated_at: string
  result: string | null
  error: string | null
  summary: string | null
  sdk_session_id: string | null
  /**
   * Per-session UUID minted by the DO on each triggerGatewayDial and sent to
   * the gateway as the WS dial-back bearer (?token=<uuid>). Validated timing-
   * safely on gateway-role onConnect. Rotated on new dial, cleared on terminal
   * state. Lives in the DO's setState JSON blob — no SQLite migration.
   */
  active_callback_token?: string
  /**
   * Last `currentMode` observed on a `kata_state` event. Used by the chain
   * UX mode-transition detector: when a new kata_state arrives with a
   * different `currentMode` the DO kicks the runner and respawns in the new
   * mode. Stored in the DO's setState JSON blob — no SQLite migration.
   */
  lastKataMode?: string
  /** @deprecated Use gate instead */
  pending_question?: {
    tool_call_id: string
    questions: unknown[]
  } | null
  /** @deprecated Use gate instead */
  pending_permission?: {
    tool_call_id: string
    tool_name: string
    input: Record<string, unknown>
  } | null
}

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
  messageCount?: number | null
  sdkSessionId?: string | null
  kataMode?: string | null
  kataIssue?: number | null
  kataPhase?: string | null
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

export interface DeltaPayload {
  kind: 'delta'
  upsert?: SessionMessage[]
  /**
   * Reserved. No current DO call site populates `remove`; the field exists
   * so the client-side handler can be correct-by-construction when a future
   * feature (e.g. "delete attachment") adds a producer.
   */
  remove?: string[]
  /**
   * P2 B2: DO piggybacks affected parents' sibling lists onto the same delta
   * frame that carries the user-turn upsert (after sendMessage / forkWithHistory
   * mutations that add a sibling). Snapshot payloads already carry
   * `BranchInfoRow[]` — this brings deltas to parity.
   *
   * `remove` is reserved for future producers (message deletion reducing
   * siblings). No current DO call site populates it — the field exists so the
   * client handler is correct-by-construction.
   */
  branchInfo?: {
    upsert?: BranchInfoRow[]
    remove?: string[]
  }
}

export interface BranchInfoRow {
  parentMsgId: string
  sessionId: string
  siblings: string[]
  activeId: string
  updatedAt: string
}

export interface SnapshotPayload {
  kind: 'snapshot'
  version: number // equals SessionDO's current messageSeq at broadcast time
  messages: SessionMessage[]
  reason: 'reconnect' | 'rewind' | 'resubmit' | 'branch-navigate'
  branchInfo?: BranchInfoRow[]
}

export type MessagesPayload = DeltaPayload | SnapshotPayload

export interface MessagesFrame {
  type: 'messages'
  sessionId: string
  seq: number // per-session monotonic, assigned by SessionDO at broadcast
  payload: MessagesPayload
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
