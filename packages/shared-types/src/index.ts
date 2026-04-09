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

export interface ExecuteCommand {
  type: 'execute'
  project: string
  prompt: string
  model?: string
  system_prompt?: string
  allowed_tools?: string[]
  max_turns?: number
  max_budget_usd?: number
  /** Baseplane organization ID (gateway-level metadata, not passed to Claude SDK) */
  org_id?: string
  /** Baseplane user ID (gateway-level metadata, not passed to Claude SDK) */
  user_id?: string
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
}

export interface AnswerCommand {
  type: 'answer'
  session_id: string
  tool_call_id: string
  answers: Record<string, string>
}

// Legacy resume command (kept for session recovery)
export interface ResumeCommand {
  type: 'resume'
  project: string
  prompt: string
  sdk_session_id: string
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

export interface StoppedEvent {
  type: 'stopped'
  session_id: string
  sdk_session_id: string | null
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
  type: 'text' | 'tool_use'
  id: string
  /** For text blocks: the incremental text delta */
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

export interface ProjectInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
  active_session: string | null
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
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'stopped'

export interface SessionState {
  id: string
  userId: string | null
  project: string
  project_path: string
  status: SessionStatus
  model: string | null
  prompt: string
  created_at: string
  updated_at: string
  duration_ms: number | null
  total_cost_usd: number | null
  result: string | null
  error: string | null
  num_turns: number | null
  sdk_session_id: string | null
  summary: string | null
  pending_question: {
    tool_call_id: string
    questions: unknown[]
  } | null
  pending_permission: {
    tool_call_id: string
    tool_name: string
    input: Record<string, unknown>
  } | null
}

export interface SessionSummary {
  id: string
  userId: string | null
  project: string
  status: SessionStatus
  model: string | null
  created_at: string
  updated_at: string
  duration_ms?: number | null
  total_cost_usd?: number | null
  num_turns?: number | null
  prompt?: string
  summary?: string
}

// ── Stored Message (for SQLite persistence) ─────────────────────────

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant' | 'tool'
  type: string
  data: string
  created_at: string
}

// ── Session Context (cc-gateway internal) ───────────────────────────

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
