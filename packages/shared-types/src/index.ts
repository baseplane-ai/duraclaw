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

export interface HeartbeatEvent {
  type: 'heartbeat'
  session_id: string
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
  created_at: string
  updated_at: string
  last_activity?: string | null
  duration_ms?: number | null
  total_cost_usd?: number | null
  num_turns?: number | null
  prompt?: string
  summary?: string
  title?: string | null
  tag?: string | null
  archived?: boolean
  origin?: string | null
  agent?: string | null
  message_count?: number | null
  sdk_session_id?: string | null
  kata_mode?: string | null
  kata_issue?: number | null
  kata_phase?: string | null
}

// ── Stored Message (for SQLite persistence) ─────────────────────────

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant' | 'tool'
  type: string
  data: string
  created_at: string
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
