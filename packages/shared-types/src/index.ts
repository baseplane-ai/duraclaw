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
  | SynthRateLimitCommand

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
  /** GH#86: enable Haiku-based session titler in the runner. Default false. */
  titler_enabled?: boolean
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

/**
 * GH#92 — dev-only synthetic rate_limit_event trigger. Routed from the
 * DO's `POST /api/__dev__/synth-ratelimit/:sessionId` endpoint through
 * the existing dial-back WS. The runner's handler is gated on
 * `DURACLAW_DEBUG_ENDPOINTS === '1'` and synthesizes an SDK-shape
 * rate_limit_event into its own message loop, so all B3 gates fire
 * and produce real .exit / .meta / caam side effects.
 *
 * The `rate_limit_info` payload mirrors the Claude SDK's
 * `rate_limit_event.rate_limit_info` shape (loosely typed by the SDK).
 * When omitted, the runner synthesizes a canned default with a
 * 45-minute `resetsAt` so VP1's derived-minutes math has a nonround
 * number to verify against.
 */
export interface SynthRateLimitCommand {
  type: 'synth-rate-limit'
  session_id: string
  rate_limit_info?: Record<string, unknown>
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
  /** GH#86: enable Haiku-based session titler in the runner. Default false. */
  titler_enabled?: boolean
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
  | ChainAdvanceEvent
  | ChainStalledEvent
  | GapSentinelEvent
  | TitleUpdateEvent
  | HeartbeatEvent

/**
 * Runner heartbeat — emitted every 15s by session-runner to prove liveness.
 * The DO uses this to bump `lastGatewayActivity`; the watchdog alarm detects
 * a stale session when heartbeats stop arriving. Not forwarded to clients.
 */
export interface HeartbeatEvent {
  type: 'heartbeat'
  session_id: string
  seq: number
}

/**
 * GH#75 B4: BufferedChannel gap sentinel relayed from the session-runner.
 * Emitted when the runner's ring buffer overflowed while the WS was down,
 * so some number of events were dropped between `from_seq` and `to_seq`.
 * The DO forwards this as a `{type:'gap'}` frame to every connected
 * client, which treats it as a synthetic gap trigger and fires
 * `requestSnapshot`.
 */
export interface GapSentinelEvent {
  type: 'gap'
  dropped_count?: number
  from_seq?: number
  to_seq?: number
}

/**
 * GH#86: Haiku-generated session title update.
 *
 * Emitted by the session-runner's `SessionTitler` after a successful
 * Haiku call (initial title or pivot-gated retitle). The DO applies it
 * iff `title_source !== 'user'` (never-clobber invariant), persists to
 * `session_meta` + D1 `agent_sessions`, and broadcasts via
 * `broadcastSessionRow`.
 */
export interface TitleUpdateEvent {
  type: 'title_update'
  session_id: string
  title: string
  confidence: number
  did_pivot: boolean
  /** `num_turns` snapshot at the moment the title was generated. */
  turn_stamp: number
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

// ── Chain auto-advance events (DO-synthesised for chain UX P3) ──────
//
// Emitted by SessionDO when a chain-linked session terminates and the
// DO's `maybeAutoAdvanceChain()` pathway runs `tryAutoAdvance()`.
// Travel over the browser WS alongside real runner events; the client
// handler in `use-coding-agent.ts` invalidates `chainsCollection` and
// surfaces a toast / stall reason for `ChainStatusItem`.

export interface ChainAdvanceEvent {
  type: 'chain_advance'
  newSessionId: string
  nextMode: string
  issueNumber: number
}

export interface ChainStalledEvent {
  type: 'chain_stalled'
  reason: string
  issueNumber: number
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

/**
 * GH#92: runner → DO rate-limit relay. `rate_limit_info` is the raw
 * SDK passthrough; the new optional top-level fields are added by the
 * runner's caam-rotation branch so the DO doesn't have to re-parse the
 * loosely-typed SDK blob.
 *
 * - `exit_reason` distinguishes the three rotation outcomes. Absent
 *   on dev boxes without caam (B7 degraded-mode relay).
 * - `rotation` is non-null only on `rate_limited` success.
 * - `earliest_clear_ts` is populated only on `rate_limited_no_profile`
 *   (DO uses it to schedule a delayed resume alarm — see B6).
 * - `resets_at` mirrors `rate_limit_info.resetsAt` lifted to a typed
 *   top-level field; null when the SDK payload didn't carry it.
 */
export interface RateLimitEvent {
  type: 'rate_limit'
  session_id: string
  rate_limit_info: Record<string, unknown>
  exit_reason?: 'rate_limited' | 'rate_limited_no_rotate' | 'rate_limited_no_profile'
  rotation?: { from: string; to: string } | null
  earliest_clear_ts?: number
  resets_at?: number | null
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
  /** Spec #68 — public projects (and their sessions) are visible to all authed users. */
  visibility?: 'public' | 'private'
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
  /**
   * True when `.kata/sessions/<sessionId>/run-end.json` exists — kata's Stop
   * hook writes it whenever `can-exit` succeeds (no-op modes or all stop
   * conditions met). This is the authoritative "rung finished" signal that
   * Duraclaw's chain auto-advance gates on. GH#73.
   */
  runEnded?: boolean
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

/**
 * GH#92 B4/B6: caam rotation adds two new transient/persistent states.
 *  - 'rotating'        : transient — caam profile rotation in progress,
 *                        runner is about to be respawned on a fresh profile.
 *  - 'waiting_profile' : persistent — every caam profile is in cooldown;
 *                        runner will resume after the earliest-clear ts.
 */
export type SessionStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_gate'
  | 'rotating'
  | 'waiting_profile'
  | 'error'

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

/**
 * Per-question structured answer from the AskUserQuestion structured-questions UI.
 * `label` is the chosen option label (or empty if only a note was provided).
 * `note` is the free-text addendum.
 */
export interface StructuredAnswer {
  label: string
  note?: string
}

export interface GateResponse {
  /** Permission gate response. */
  approved?: boolean
  /**
   * Legacy flat answer. Still used for:
   *  - permission gates with a text reason (none today, but shape preserved).
   *  - single-question (legacy) ask_user payloads with no `questions` array.
   *  - back-compat with rows persisted before structured `answers` landed.
   */
  answer?: string
  /**
   * Structured per-question answers from ask_user. Parallel to the
   * `input.questions[]` array — `answers[i]` is the answer to `questions[i]`.
   * When present, the server persists `part.output = { answers }` (object)
   * so `ResolvedAskUser` can render paired Q/A, and serializes to a joined
   * flat string for the gateway `answer` command (the SDK runner still
   * expects a single string).
   */
  answers?: StructuredAnswer[]
  /**
   * ask_user only: the user chose to send a new message instead of
   * answering. Server sends a placeholder answer to the runner to unblock
   * the SDK tool callback, and persists the part as `output-denied` with
   * `output = 'User declined to answer'` so `ResolvedAskUser` collapses the
   * question block to a "User declined to answer" summary in place of the
   * usual Q/A pairs. Ignored for permission_request gates.
   */
  declined?: boolean
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
  messageSeq?: number
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
  visibility?: 'public' | 'private'
}

// ── Admin: caam status (GH#92 P5) ───────────────────────────────────
//
// Shape returned by `GET /admin/caam/status` on the agent-gateway, and
// proxied verbatim by the worker's admin route. The admin React
// component imports this same type so wire / proxy / render all agree.
//
// `caam_configured: false` is the degraded mode (binary missing or not
// executable) — every other field empties out and `warnings` carries
// the human-readable reason. Endpoint never 500s; per-subcommand failures
// surface as additional `warnings[]` entries with partial data.

export interface CaamProfileStatus {
  name: string
  active: boolean
  /** Tool / system bucket — always 'claude' on Duraclaw today. */
  system: string
  health: { status: string; error_count: number }
  /** Cooldown clear time in ms-epoch; absent when profile is not cooling. */
  cooldown_until?: number
}

export interface CaamLastRotation {
  from: string
  to: string
  at_ms: number
  session_id: string
}

export interface CaamStatus {
  active_profile: string | null
  profiles: CaamProfileStatus[]
  warnings: string[]
  last_rotation?: CaamLastRotation | null
  caam_configured: boolean
  fetched_at_ms: number
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
 * GH#92 B4/B5/B6: optional per-message metadata bag. Currently carries the
 * caam rotation breadcrumb stamped onto system-role messages by the DO; new
 * keys can be added here without growing the top-level `SessionMessage`
 * surface.
 */
export interface SessionMessageMetadata {
  /**
   * GH#92 B4/B5/B6: caam rotation breadcrumb — present on system-role
   * messages inserted by the DO when a rate-limit rotation happens.
   *   - kind 'rotated'  : successful rotation from → to
   *   - kind 'skipped'  : rotation suppressed (peer runner live or
   *                       DURACLAW_CLAUDE_ROTATION=off)
   *   - kind 'waiting'  : every profile cooling; resume scheduled at
   *                       earliest_clear_ts + 30s slop
   * Client-side `useDerivedStatus` keys off this metadata (never body
   * text) to surface the 'rotating' / 'waiting_profile' status.
   * DO history → SDK resume-prompt serializer also filters on
   * `metadata?.caam !== undefined` so these breadcrumbs are not
   * replayed as user/assistant turns.
   */
  caam?: {
    kind: 'rotated' | 'skipped' | 'waiting'
    from?: string
    to?: string
    at: number
    earliest_clear_ts?: number
  }
}

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
  /**
   * GH#92 B4–B6: optional metadata bag. See `SessionMessageMetadata`.
   * Currently used by the DO to stamp caam rotation breadcrumbs on
   * system-role messages.
   */
  metadata?: SessionMessageMetadata
  createdAt?: string | number | Date
  /**
   * Wall-clock of the last in-place mutation of this row (ISO 8601). Stamped
   * by SessionDO on every append (= createdAt) and update (= now()) and
   * mirrored into the `assistant_messages.modified_at` column. Drives the
   * client's `subscribe:messages` tail cursor so a warm reconnect only
   * replays rows whose `modified_at` strictly exceeds the cached tail —
   * unifying insert and update semantics on a single monotonic key. Optional
   * on the wire for back-compat with older server bundles.
   */
  modifiedAt?: string
  /**
   * Optional canonical turn id (`usr-N`). Populated by SessionDO on user
   * turns; absent on assistant and tool rows. Introduced in P3 (B6); safe to
   * declare now as an optional field so P1 MessagesFrame types compile.
   */
  canonical_turn_id?: string
  /**
   * Per-row copy of the broadcasting DO's `messageSeq` envelope counter at
   * the time this row was emitted. Stamped by `SessionDO.broadcastMessages`
   * on every outbound op. Used by `useDerivedStatus` to detect whether the
   * messages collection is ahead of the D1-mirrored `agent_sessions.message_seq`
   * tiebreaker — if any locally-held message has `seq > session.messageSeq`,
   * the hook derives status from messages; otherwise it falls through to the
   * D1 row. Optional on the wire for back-compat with older server bundles
   * and cold-start REST replay rows that pre-date the stamping (they fall
   * through the tiebreaker harmlessly).
   */
  seq?: number
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
   * When true, `ops` represents the complete current state of the
   * collection (all rows as insert ops). The client diffs against its
   * local state: upserts everything in the frame, deletes any local key
   * NOT present in the frame. This makes deletes implicit — if a row is
   * missing from the snapshot, it's gone. No lost-delete risk.
   */
  snapshot?: boolean
  /**
   * Per-stream monotonic seq stamped by the DO in `broadcastMessages` /
   * `broadcastBranchInfo` for non-targeted frames. Advances monotonically
   * on every non-targeted send; echoed (unchanged) on targeted sends so
   * non-recipients stay aligned with the shared stream.
   *
   * GH#75: clients MUST track `lastSeq` per session and request a
   * snapshot on non-targeted gap (`messageSeq > lastSeq + 1`). Stale
   * non-targeted frames (`messageSeq <= lastSeq`) MUST be dropped.
   * Targeted frames (see `targeted`) bypass the gap-check entirely and
   * install `lastSeq = max(lastSeq, messageSeq)` after applying.
   *
   * Legacy user-scoped callers (UserSettingsDO fanout) do not populate
   * this field — those collections have no gap-detection path.
   */
  messageSeq?: number
  /**
   * GH#75: set by the DO on every frame emitted to a single
   * `targetClientId` (cursor-replay in `replayMessagesFromCursor` and
   * full-history replies from the `requestSnapshot` @callable). Clients
   * MUST bypass `lastSeq` gap-gating on targeted frames and install
   * `lastSeq = max(lastSeq, messageSeq)` after applying. Orthogonal to
   * `snapshot` — targeted frames do NOT carry implicit-delete semantics
   * (cursor-replay is chunked by LIMIT 500 and the full-history snapshot
   * reply is cold-start fresh where the client already has no state).
   *
   * Older servers never emit this field, older clients never read it —
   * OTA / version-skew safe.
   */
  targeted?: boolean
}
