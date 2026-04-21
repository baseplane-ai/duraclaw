// Re-export Session types for convenience

// Re-export shared types
export type {
  BrowserCommand,
  ContentBlock,
  ContextUsage,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  PrInfo,
  ProjectInfo,
  ResumeCommand,
  SessionStatus,
  SessionSummary,
  SpawnConfig,
  StoredMessage,
  UIStreamChunk,
  UserPreferences,
} from '@duraclaw/shared-types'
export type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'

// ── Chat message type (shared across features + db) ───────────────

export interface ChatMessage {
  id: number | string
  role: 'user' | 'assistant' | 'tool' | 'qa_pair'
  type: string
  content: string
  event_uuid?: string | null
  created_at?: string
}

// ── CF-specific types ──────────────────────────────────────────────

export interface Env {
  SESSION_AGENT: DurableObjectNamespace
  USER_SETTINGS: DurableObjectNamespace
  SESSION_COLLAB: DurableObjectNamespace
  /** Set to '1' via wrangler secret to short-circuit all non-/login traffic to a 503 maintenance page (#7 cutover). */
  MAINTENANCE_MODE?: string
  ASSETS: Fetcher
  CC_GATEWAY_URL?: string
  CC_GATEWAY_SECRET?: string
  WORKER_PUBLIC_URL?: string
  AUTH_DB: D1Database
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  /** Firebase service account JSON (set via `wrangler secret`). When
   *  present, SessionDO push fan-out also dispatches to FCM tokens for
   *  the Capacitor Android shell (GH#26 P1 B5). When unset, FCM dispatch
   *  is silently skipped — opt-in deployment. */
  FCM_SERVICE_ACCOUNT_JSON?: string
  BOOTSTRAP_TOKEN?: string
  /** Watchdog stale threshold in ms. Default 90_000 when unset. */
  STALE_THRESHOLD_MS?: string
  /** GitHub webhook HMAC secret (set via `wrangler secret`). Required for the
   *  `/api/webhooks/github` handler (GH#16 Feature 3E / U3); missing secret
   *  causes the handler to 503 rather than accidentally ack unauthenticated
   *  traffic. */
  GITHUB_WEBHOOK_SECRET?: string
  /** Fully-qualified GitHub repository (e.g. "baseplane-ai/duraclaw") used to
   *  filter incoming webhook payloads — events for other repos are ack'd-but-
   *  ignored. */
  GITHUB_REPO?: string
  /** Optional GitHub API token (classic PAT or fine-grained) used to
   *  authenticate issue/PR list calls from `/api/chains` — raises the rate
   *  limit from 60/hr unauthenticated to 5000/hr. Read-only scope is
   *  sufficient since we only list public issues + PRs. */
  GITHUB_API_TOKEN?: string
  /** Bearer token guarding `UserSettingsDO POST /broadcast` (GH#32 phase p2a).
   *  API handlers that push synced-collection delta frames to a user's
   *  browsers must authenticate with this secret. Required for broadcast
   *  calls; missing secret means the DO rejects every broadcast with 401. */
  SYNC_BROADCAST_SECRET?: string
}

// ── D1 row response shapes (issue #7 p2) ───────────────────────────

/**
 * Response envelope for /api/sessions* — a row from the D1 agent_sessions
 * table mapped through Drizzle, so keys are camelCase. The schema's
 * `archived` column is stored as integer 0/1 but Drizzle returns it as a
 * boolean via `{ mode: 'boolean' }` in the schema definition.
 */
export interface AgentSessionRow {
  id: string
  userId: string
  project: string
  status: string
  model: string | null
  sdkSessionId: string | null
  createdAt: string
  updatedAt: string
  lastActivity: string | null
  numTurns: number | null
  prompt: string | null
  summary: string | null
  title: string | null
  tag: string | null
  origin: string | null
  agent: string | null
  archived: boolean
  durationMs: number | null
  totalCostUsd: number | null
  error: string | null
  errorCode: string | null
  kataStateJson: string | null
  contextUsageJson: string | null
  worktreeInfoJson: string | null
  kataMode: string | null
  kataIssue: number | null
  kataPhase: string | null
}

/**
 * Tab semantics that used to live on the Yjs `TabEntry` value. Persisted as
 * a stringified JSON blob on `user_tabs.meta` so adding a field is a pure
 * client-side change. Absent/empty meta is equivalent to `{kind: 'session'}`.
 */
export interface TabMeta {
  /** Absent → 'session' (legacy rows). */
  kind?: 'chain' | 'session'
  /** One-tab-per-project cluster key for session tabs. */
  project?: string
  /** Required when kind === 'chain' — one-chain-per-issue cluster key. */
  issueNumber?: number
  /** For chain tabs: which mode-session inside the chain is currently live. */
  activeSessionId?: string
}

export interface UserTabRow {
  id: string
  userId: string
  sessionId: string | null
  position: number
  createdAt: string
  /** Stringified `TabMeta` — null for legacy rows. */
  meta?: string | null
}

/**
 * Chain-level worktree checkout reservation (GH#16 Feature 3E). One row per
 * currently-checked-out worktree — owner holds the worktree for the lifetime
 * of the chain driving `issueNumber`. Serves as the TypeScript API contract
 * for `/api/worktrees/*` endpoints (U2) and the force-release webhook (U3).
 */
export interface WorktreeReservation {
  issueNumber: number
  worktree: string
  ownerId: string
  heldSince: string // ISO
  lastActivityAt: string // ISO
  modeAtCheckout: string
  stale: boolean
}

/**
 * Chain summary — one entry per kata-linked GitHub issue (GH#16 Feature 3D).
 * Response shape of `GET /api/chains`. Merges D1 session/reservation state
 * with GitHub issue metadata (cached 5min module-level). `column` is derived
 * by `deriveColumn()` from the latest qualifying session's kataMode plus the
 * issue's open/closed state.
 */
export interface ChainSummary {
  issueNumber: number
  issueTitle: string
  issueType: 'enhancement' | 'bug' | 'other' | string
  issueState: 'open' | 'closed'
  column: 'backlog' | 'research' | 'planning' | 'implementation' | 'verify' | 'done'
  sessions: Array<{
    id: string
    kataMode: string | null
    status: string
    lastActivity: string | null
    createdAt: string
    project: string
  }>
  worktreeReservation: {
    worktree: string
    heldSince: string
    lastActivityAt: string
    ownerId: string
    stale: boolean
  } | null
  prNumber?: number
  lastActivity: string
}

/** Response envelope for `GET /api/chains/:issue/spec-status`. */
export interface SpecStatusResponse {
  exists: boolean
  status?: string | null
  path?: string | null
}

/** Response envelope for `GET /api/chains/:issue/vp-status`. */
export interface VpStatusResponse {
  exists: boolean
  passed?: boolean | null
  path?: string | null
}

export interface UserPreferencesRow {
  userId: string
  permissionMode: string | null
  model: string | null
  maxBudget: number | null
  thinkingMode: string | null
  effort: string | null
  hiddenProjects: string | null
  updatedAt: string
}
