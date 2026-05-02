import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk'

// ── Gateway Commands (Orchestrator → Gateway) ─────────────────────────

/**
 * GH#107: Adapter-name discriminator on the wire. Narrows `agent` on
 * `ExecuteCommand` / `ResumeCommand` so consumers (DO, gateway, runner,
 * tests) share a single source of truth for valid runner adapters.
 *
 * Other persisted/external `agent` strings (`SessionSummary.agent`,
 * `DiscoveredSession.agent`, `SessionSource.agent`, `SpawnConfig.agent`)
 * stay as `string` for now — those read from D1 / external SDKs and
 * narrowing them is a follow-up.
 */
export type AgentName = 'claude' | 'codex' | 'gemini'

/**
 * Claude Agent SDK permission mode. Must stay in sync with the SDK's
 * `PermissionMode` union (sdk.d.ts) — extending here without SDK
 * support means the runner's fallback path swallows the value silently.
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type GatewayCommand =
  | ExecuteCommand
  | ResumeCommand
  | StreamInputCommand
  | InterruptCommand
  | StopCommand
  | PingCommand
  | PermissionResponseCommand
  | AnswerCommand
  | TranscriptRpcResponseCommand

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
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * SDK permission mode. Injected by the DO from `user_preferences.permission_mode`
   * at spawn time. Runner falls back to `'default'` when omitted.
   */
  permission_mode?: PermissionMode
  /** Baseplane organization ID (gateway-level metadata, not passed to Claude SDK) */
  org_id?: string
  /** Baseplane user ID (gateway-level metadata, not passed to Claude SDK) */
  user_id?: string
  /** Which agent to use. Defaults to 'claude' if omitted. */
  agent?: AgentName
  /**
   * GH#107: Codex model catalog injected by the DO from D1 at spawn
   * time. The CodexAdapter uses it for `availableProviders` and the
   * per-turn context-window math; ignored by other adapters.
   */
  codex_models?: ReadonlyArray<{ name: string; context_window: number }>
  /** GH#110: Gemini model catalog injected by the DO from D1 at spawn time. */
  gemini_models?: ReadonlyArray<{ name: string; context_window: number }>
  /** GH#86: enable Haiku-based session titler in the runner. Default false. */
  titler_enabled?: boolean
  /**
   * GH#115: absolute path on the VPS to the reserved clone (e.g.
   * `/data/projects/duraclaw-dev2`). When present, the runner uses
   * this verbatim as the working directory; when absent (callers that
   * predate worktree reservation), the runner falls back to its
   * default project-path resolution (gateway-side `/projects/<name>`).
   */
  worktree_path?: string
  /** GH#119: enable DO-side SessionStore mirror for account failover. Default false. */
  session_store_enabled?: boolean
  /**
   * GH#119: HOME directory for the runner identity. The gateway sets
   * `HOME=<runner_home>` in the spawn env so the runner picks up the
   * identity-scoped Claude auth at `~/.claude/.credentials.json`.
   * Optional — when omitted, the gateway uses its own HOME (current
   * behavior, preserved when no identities are configured).
   */
  runner_home?: string
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

export interface StopCommand {
  type: 'stop'
  session_id: string
}

export interface InterruptCommand {
  type: 'interrupt'
  session_id: string
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

/**
 * GH#119 P1.1: DO -> RUNNER reply for `transcript-rpc` requests.
 *
 * The runner-side TranscriptRpc multiplexer correlates this response
 * with its original request via `rpc_id`. Method-specific result is
 * carried on `result` (or `null` when `error` is set); `error` is a
 * human-readable message on failure (`null` on success).
 */
export interface TranscriptRpcResponseCommand {
  type: 'transcript-rpc-response'
  session_id: string
  rpc_id: string
  /** Method-specific result. null when error is set. */
  result: unknown
  /** null on success; human-readable error message on failure. */
  error: string | null
}

// Resume command (session recovery with follow-up prompt)
export interface ResumeCommand {
  type: 'resume'
  project: string
  prompt: string | ContentBlock[]
  runner_session_id: string
  /**
   * SDK permission mode. Injected by the DO from `user_preferences.permission_mode`
   * at resume time so user-preference changes apply on the next spawn/resume.
   */
  permission_mode?: PermissionMode
  /** Which agent to use for resume. Defaults to 'claude' if omitted. */
  agent?: AgentName
  /**
   * GH#107: Codex model catalog injected by the DO from D1 at spawn
   * time. The CodexAdapter uses it for `availableProviders` and the
   * per-turn context-window math; ignored by other adapters.
   */
  codex_models?: ReadonlyArray<{ name: string; context_window: number }>
  /** GH#110: Gemini model catalog injected by the DO from D1 at spawn time. */
  gemini_models?: ReadonlyArray<{ name: string; context_window: number }>
  /** GH#86: enable Haiku-based session titler in the runner. Default false. */
  titler_enabled?: boolean
  /**
   * GH#115: absolute path on the VPS to the reserved clone (e.g.
   * `/data/projects/duraclaw-dev2`). When present, the runner uses
   * this verbatim as the working directory; when absent (callers that
   * predate worktree reservation), the runner falls back to its
   * default project-path resolution (gateway-side `/projects/<name>`).
   */
  worktree_path?: string
  /** GH#119: enable DO-side SessionStore mirror for account failover. Default false. */
  session_store_enabled?: boolean
  /**
   * GH#119: HOME directory for the runner identity. The gateway sets
   * `HOME=<runner_home>` in the spawn env so the runner picks up the
   * identity-scoped Claude auth at `~/.claude/.credentials.json`.
   * Optional — when omitted, the gateway uses its own HOME (current
   * behavior, preserved when no identities are configured).
   */
  runner_home?: string
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
  | RateLimitEvent
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationEvent
  | ChainAdvanceEvent
  | ChainStalledEvent
  | GapSentinelEvent
  | TitleUpdateEvent
  | TitleErrorEvent
  | SessionStateChangedEvent
  | CompactBoundaryEvent
  | ApiRetryEvent
  | TranscriptRpcRequestEvent
  | FailoverEvent

/**
 * GH#119 P1.1: RUNNER -> DO request over the dial-back WS.
 *
 * Carries an opaque `rpc_id` the DO echoes back on the response so the
 * runner-side multiplexer can correlate concurrent calls. `method`
 * selects the SessionStore op; `params` is the method-specific shape
 * (validated server-side by the dispatcher).
 */
export interface TranscriptRpcRequestEvent {
  type: 'transcript-rpc'
  session_id: string
  rpc_id: string
  method: 'appendTranscript' | 'loadTranscript' | 'listTranscriptSubkeys' | 'deleteTranscript'
  params: Record<string, unknown>
}

/**
 * GH#119 P1.1: mirror of the Claude Agent SDK `SessionStore` key shape.
 * Replicated here so the wire contract is decoupled from the SDK's
 * `@alpha` types.
 */
export interface TranscriptSessionKey {
  projectKey: string
  sessionId: string
  /** Optional subpath (subagent transcripts). Empty string when omitted. */
  subpath?: string
}

/**
 * GH#119 P1.1: mirror of the SDK's `SessionStoreEntry` — opaque,
 * type-discriminated JSONL line. We don't constrain the shape beyond
 * `type` so the SDK can evolve its entry vocabulary without forcing a
 * shared-types bump.
 */
export interface TranscriptEntry {
  type: string
  uuid?: string
  timestamp?: string
  [k: string]: unknown
}

/**
 * GH#102 / spec 102-sdk-peelback B1: SDK-native liveness signal.
 *
 * Translated by the runner from `SDKSessionStateChangedMessage` (3-value
 * SDK enum) plus `SDKStatusMessage{status:'compacting'}` and
 * `SDKAPIRetryMessage` (synthesised). Wire enum is wider than the SDK's
 * `idle | running | requires_action` because the runner additionally
 * exposes `compacting` and `api_retry` as transient liveness states
 * derived from sibling SDK frames. Used by the DO to drive both
 * `lastAnyEventTs` (residual watchdog) and `SessionMeta.status` /
 * `SessionMeta.transient_state` mapping.
 */
export interface SessionStateChangedEvent {
  type: 'session_state_changed'
  session_id: string
  /**
   * Stamped by the runner's BufferedChannel `send()` helper — callers never
   * pass it explicitly. Always present on the wire.
   */
  seq?: number
  state: 'idle' | 'running' | 'requires_action' | 'compacting' | 'api_retry'
  ts: number
}

/**
 * GH#102 / spec 102-sdk-peelback B11: SDK-native auto-compact boundary.
 *
 * Translated by the runner from `SDKCompactBoundaryMessage`. Persisted by
 * the DO as a system-flavored `SessionMessage` (transcript-visible) and
 * also broadcast as a dedicated gateway event for any UI consumer.
 */
export interface CompactBoundaryEvent {
  type: 'compact_boundary'
  session_id: string
  seq?: number
  trigger: 'manual' | 'auto'
  pre_tokens: number
  preserved_segment?: {
    head_uuid: string
    anchor_uuid: string
    tail_uuid: string
  }
  ts: number
}

/**
 * GH#102 / spec 102-sdk-peelback B12: dedicated `api_retry` event.
 *
 * Translated by the runner from `SDKAPIRetryMessage`. NOT persisted by
 * the DO — retries are transient diagnostic state, not transcript
 * content. Broadcast to the client which renders the `ApiRetryBanner`.
 *
 * `error` is the SDK `SDKAssistantMessageError` enum (7 values at
 * @anthropic-ai/claude-agent-sdk@0.2.98), with `'unknown'` as a
 * forward-compat fallback in case the SDK widens the enum.
 */
export interface ApiRetryEvent {
  type: 'api_retry'
  session_id: string
  seq?: number
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: SDKAssistantMessageError | 'unknown'
  ts: number
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

/**
 * Diagnostic event emitted by the runner when a titler call fails
 * (Agent SDK throw, JSON parse failure, missing OAuth, etc.). The DO
 * routes it to the per-DO `event_log` SQLite table via `logEvent` so
 * titler failures are queryable from the orchestrator without needing
 * to read the runner's stdout file on the VPS.
 *
 * Fire-and-forget — the runner does NOT pause on this. Title generation
 * is best-effort; the session continues untitled if all titler calls fail.
 */
export interface TitleErrorEvent {
  type: 'title_error'
  session_id: string
  /** Which titler call failed — initial title or pivot retitle. */
  phase: 'initial' | 'pivot'
  /** Short error message (e.g. "JSON parse failed", "no assistant text"). */
  error: string
  /** Optional longer detail (e.g. raw exception message). */
  detail?: string
}

// ── Arc auto-advance events (DO-synthesised) ───────────────────────
//
// Emitted by SessionDO when an arc-linked session terminates and the
// DO's auto-advance gate decides to mint a successor (or to stall).
// Travel over the browser WS alongside real runner events; the client
// handler in `use-coding-agent.ts` invalidates `arcsCollection` and
// surfaces a toast / stall reason for `ArcStatusItem`. Wire type names
// preserve the legacy `chain_*` discriminants so existing handlers
// keep matching.

export interface ChainAdvanceEvent {
  type: 'chain_advance'
  newSessionId: string
  nextMode: string
  /**
   * Optional GH issue number — present only when the arc is linked to a
   * `github` externalRef. Arcs without an externalRef (implicit / debug /
   * freeform / non-kata) emit the event without this field; the client
   * (`use-coding-agent.ts`) reads `issueNumber` defensively.
   */
  issueNumber?: number
}

export interface ChainStalledEvent {
  type: 'chain_stalled'
  reason: string
  /**
   * Optional GH issue number — see `ChainAdvanceEvent.issueNumber`. The
   * gate-skip path in the SessionDO emits the event whenever the
   * auto-advance decision returns `skipped`; for non-issue-linked arcs
   * the field is omitted and the client falls back to a generic toast.
   */
  issueNumber?: number
}

export interface StoppedEvent {
  type: 'stopped'
  session_id: string
  runner_session_id: string | null
}

export interface RateLimitEvent {
  type: 'rate_limit'
  session_id: string
  rate_limit_info: {
    /**
     * GH#119: ISO timestamp when the rate limit resets. Used by the
     * failover handler to set `cooldown_until` on the rate-limited
     * identity. When absent, the handler uses a +30min fallback.
     */
    resets_at?: string
    [k: string]: unknown
  }
}

/**
 * GH#119 P3: emitted when the DO swaps the runner identity due to
 * rate-limit or auth-error. Broadcast to clients so the StatusBar can
 * show "Switching accounts...". The actual session resume happens via
 * the normal `triggerGatewayDial({type:'resume',...})` flow; this
 * event is observability-only.
 */
export interface FailoverEvent {
  type: 'failover'
  session_id: string
  from_identity: string
  to_identity: string
  reason: 'rate_limit' | 'auth_error'
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

/**
 * AdapterCapabilities — declared by the runner on session.init so the DO
 * (and downstream UI) know which features the underlying SDK supports.
 *
 * Optional for backward compatibility with older runners that predate
 * this field; consumers MUST tolerate `undefined` and fall back to the
 * Claude Agent SDK behavior.
 */
export interface AdapterCapabilities {
  supportsRewind: boolean
  supportsThinkingDeltas: boolean
  supportsPermissionGate: boolean
  supportsSubagents: boolean
  supportsPermissionMode: boolean
  supportsSetModel: boolean
  supportsContextUsage: boolean
  supportsInterrupt: boolean
  supportsCleanAbort: boolean
  emitsUsdCost: boolean
  availableProviders: ReadonlyArray<{ provider: string; models: string[] }>
}

/**
 * Transport-layer message part — mirrors the DO-internal SessionMessagePart
 * from `agents/experimental/memory/session`. Decoupled from the SDK type so
 * shared-types doesn't import the Agents SDK. The DO maps WireMessagePart →
 * SessionMessagePart on arrival (identity today; indirection allows divergence).
 */
export type WireMessagePart =
  | { type: 'text'; text: string; state: 'streaming' | 'done' }
  | { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
  | {
      type: string // 'tool-{name}' e.g. 'tool-Bash', 'tool-Read'
      toolCallId: string
      toolName: string
      input?: unknown
      output?: unknown
      state: string // 'input-available', 'output-available', 'output-error', etc.
    }

export interface SessionInitEvent {
  type: 'session.init'
  session_id: string
  runner_session_id: string | null
  project: string
  model: string | null
  tools: string[]
  /** Optional — populated by capability-aware runners. */
  capabilities?: AdapterCapabilities
}

export interface PartialAssistantEvent {
  type: 'partial_assistant'
  session_id: string
  content: PartialContentBlock[]
  parts?: WireMessagePart[]
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
  parts?: WireMessagePart[]
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
  /**
   * GH#102 / spec 102-sdk-peelback B8: optional attachment with the latest
   * context-usage snapshot from the SDK at turn-complete. Replaces the
   * standalone (now-deleted) `ContextUsageEvent`. Best-effort — runner
   * omits this if the SDK call throws or returns malformed data.
   */
  context_usage?: WireContextUsage
  /**
   * GH#119 P3: optional SDK error discriminator stamped by the runner
   * when `is_error === true`. The DO routes `'rate_limit'` and
   * `'authentication_failed'` through the failover handler; other
   * values fall through to the normal terminal-error path. Forward-
   * compatible — runners that don't stamp this still produce a normal
   * is_error result that the existing pipeline handles.
   */
  error?: string | null
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
  /** GH#122 — per-project ACL owner from project_metadata.ownerId; NULL until claimed. */
  ownerId?: string | null
  /** GH#122 — sha256(originUrl).slice(0,16); NULL when repo_origin is null or pre-backfill. */
  projectId?: string | null
  /**
   * GH#84: optional admin-set override for the 2-char tab abbreviation.
   * Constrained server-side to `[A-Z0-9]{1,2}`; null/undefined falls back
   * to the regex derivation in `lib/project-display.ts` (`deriveProjectAbbrev`).
   * D1-stored on the `projects` row; the gateway side does not write this
   * field — admins patch via `PATCH /api/projects/:name/customization`.
   */
  abbrev?: string | null
  /**
   * GH#84: optional admin-set override for the tab fill color, as an index
   * into `PROJECT_COLOR_SLOTS` (10 slots today). Out-of-range / null falls
   * back to the FNV-1a hash derivation in `lib/project-display.ts`
   * (`deriveProjectColorSlot`). D1-stored on the `projects` row; the
   * gateway side does not write this field.
   */
  color_slot?: number | null
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
  runner_session_id: string
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
// `sessionLiveStateCollection.contextUsage`. UI-side camelCase used by
// consumers and by the P3 REST cache in SessionDO's
// `session_meta.context_usage_json` column. The wire-side sibling is
// `WireContextUsage` (snake_case), carried on `ResultEvent.context_usage`.

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
  isAutoCompactEnabled?: boolean
  autoCompactThreshold?: number
}

/**
 * Wire-side context-usage attachment carried on `ResultEvent.context_usage`.
 * Snake_case to match the rest of the wire types. The UI-side camelCase
 * `ContextUsage` (above) is the sibling — transform is applied at the
 * SessionDO ingest boundary (`handleGatewayEvent('result')`).
 *
 * GH#102 / spec 102-sdk-peelback B8: replaces the standalone
 * `ContextUsageEvent` (deleted) with an attachment on the `result` event
 * so each turn-complete carries fresh token counts in one frame.
 */
export interface WireContextUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  max_tokens: number
  percentage: number
  model: string
  auto_compact_at?: number
}

// ── Session State ────────────────────────────────────────────────────

export type SessionStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'waiting_gate'
  // GH#119 P3: no identity available; alarm-loop polling
  | 'waiting_identity'
  // GH#119 P3: transient — selecting next identity + resuming
  | 'failover'
  | 'error'

// SessionState deleted (#31 P5 / B10). Status / gate / result are now derived
// client-side from `messagesCollection`; context usage and kata state go over
// REST; all other ex-SessionState fields moved into the DO's typed
// `session_meta` SQLite table (see `SessionMeta` in session-do.ts).
// `SessionStatus` is retained — still used by status-derivation hooks and the
// D1-mirrored SessionSummary row.

export interface SpawnConfig {
  project: string
  /**
   * Initial message — plain text or structured content blocks (text + images).
   * Optional: when omitted at session-creation time, the DO is initialised in
   * `idle` with no runner spawned; the runner is dialled lazily on the first
   * `sendMessage` (fresh-execute fallback). See SessionDO.initialize.
   */
  prompt?: string | ContentBlock[]
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
  runnerSessionId?: string | null
  capabilitiesJson?: string | null
  kataMode?: string | null
  kataIssue?: number | null
  kataPhase?: string | null
  // Spec #37 P1a-1: per-session live state mirrored from DO.
  error?: string | null
  errorCode?: string | null
  kataStateJson?: string | null
  contextUsageJson?: string | null
  visibility?: 'public' | 'private'
  /**
   * GH#119: which runner identity owns this session. Populated by the DO at
   * spawn time (P2) via syncIdentityNameToD1; surfaces in the session sidebar
   * so operators can see which identity (e.g. 'work1' vs 'personal') is
   * active. The wire shape uses camelCase because broadcastSessionRow
   * `SELECT * FROM agent_sessions` via Drizzle, which returns TS field names
   * (the column itself is `identity_name`).
   */
  identityName?: string | null
  /**
   * GH#116: parent arc id for this session. Always set on rows produced
   * after migration 0032 (createSession auto-creates an implicit arc when
   * no explicit arcId is supplied). Optional in the wire type for
   * back-compat with cold-start paths and pre-migration test fixtures —
   * the per-message "Branch from here" UI guards on its presence before
   * enabling the affordance.
   */
  arcId?: string | null
  /**
   * GH#116: free-form mode label (kata writes 'research' / 'planning' /
   * 'implementation' / 'verify' / 'debug' / 'task' / 'freeform'; other
   * agents may write their own strings). Mirrors `agent_sessions.mode`.
   * The branch UI passes this through verbatim so the new arc's first
   * session inherits the parent's mode by default.
   */
  mode?: string | null
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
  /**
   * GH#68 B14 — author attribution for shared sessions. Stamped by SessionDO
   * on user-role turns from the authenticated `userId` of the POSTer; absent
   * on assistant/tool/system rows and on legacy user rows that pre-date this
   * field. Rides the JSON `content` column (no schema migration required —
   * `Session.appendMessage` serialises the whole message; replay round-trips
   * via `JSON.parse(row.content) as WireSessionMessage`).
   */
  senderId?: string
  /**
   * GH#68 B14 — frozen-at-write display name for the sender, looked up
   * server-side from `users.name` so the client never needs a per-user
   * lookup endpoint to render initials. Frozen-at-write means later renames
   * do not propagate; acceptable for an attribution badge.
   */
  senderName?: string
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
  permissionMode: string
  model: string
  codexModel: string
  maxBudget: number | null
  thinkingMode: string
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
  /**
   * DO-authoritative session status, stamped on every `messages:*` frame.
   * Replaces the client-side `useDerivedStatus` fold — the DO is the
   * single source of truth. Clients read this directly; no derivation,
   * no D1 tiebreaker. Cold-start (before first WS frame) falls back to
   * the D1 `agent_sessions.status` column.
   *
   * Only populated on session-scoped collections (`messages:*`,
   * `branchInfo:*`). User-scoped collections (UserSettingsDO fanout)
   * never carry this field.
   */
  sessionStatus?: SessionStatus
}

// ── Shared workspace helpers ──────────────────────────────────────────

// GH#27 B2: SHA-256-based projectId / entityId derivation usable from
// the browser, the Worker, and the Bun runner.
export * from './entity-id.js'
