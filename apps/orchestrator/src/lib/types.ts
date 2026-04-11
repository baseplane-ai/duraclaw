// Re-export shared types
export type {
  BrowserCommand,
  ContentBlock,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  ProjectInfo,
  ResumeCommand,
  SessionState,
  SessionStatus,
  SessionSummary,
  SpawnConfig,
  StoredMessage,
  UIStreamChunk,
} from '@duraclaw/shared-types'

// ── CF-specific types ──────────────────────────────────────────────

export interface Env {
  SESSION_AGENT: DurableObjectNamespace
  SESSION_REGISTRY: DurableObjectNamespace
  ASSETS: Fetcher
  CC_GATEWAY_URL?: string
  CC_GATEWAY_SECRET?: string
  AUTH_DB: D1Database
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
}
