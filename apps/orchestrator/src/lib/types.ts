// Re-export Session types for convenience

// Re-export shared types
export type {
  BrowserCommand,
  ContentBlock,
  DiscoveredSession,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  PrInfo,
  ProjectInfo,
  ResumeCommand,
  SessionState,
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
  BOOTSTRAP_TOKEN?: string
  /** Watchdog stale threshold in ms. Default 90_000 when unset. */
  STALE_THRESHOLD_MS?: string
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
  messageCount: number | null
  kataMode: string | null
  kataIssue: number | null
  kataPhase: string | null
}

export interface UserTabRow {
  id: string
  userId: string
  sessionId: string | null
  position: number
  createdAt: string
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
