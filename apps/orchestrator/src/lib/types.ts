// Re-export shared types
export type {
  SessionState,
  SessionStatus,
  SessionSummary,
  GatewayCommand,
  GatewayEvent,
  ResumeCommand,
  UIStreamChunk,
  BrowserCommand,
  StoredMessage,
  WorktreeInfo,
} from '@duraclaw/shared-types'

// ── CF-specific types ──────────────────────────────────────────────

export interface RegistryState {
  worktree_locks: Record<string, string> // worktree_name → session_id
}

export interface Env {
  SESSION_AGENT: DurableObjectNamespace
  SESSION_REGISTRY: DurableObjectNamespace
  CC_GATEWAY_URL?: string
  CC_GATEWAY_SECRET?: string
  AUTH_DB: D1Database
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
}
