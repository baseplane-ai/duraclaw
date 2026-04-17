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
  SESSION_REGISTRY: DurableObjectNamespace
  USER_SETTINGS: DurableObjectNamespace
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
