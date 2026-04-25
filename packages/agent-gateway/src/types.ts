// Re-export protocol types from shared package. The gateway is now a thin
// spawn/list/status control plane — it no longer imports the Agent SDK or
// owns SessionContext / message-queue shapes; those live in session-runner.
export type {
  ExecuteCommand,
  GatewayCommand,
  PrInfo,
  ProjectInfo,
  ResumeCommand,
} from '@duraclaw/shared-types'

/** Data attached to each WebSocket connection via server.upgrade(). */
export interface WsData {
  project: string | null
}

/**
 * On-disk schema for <sessionsDir>/<id>.pid — written by session-runner on
 * startup, read by the gateway's status + list endpoints to detect liveness.
 */
export interface PidFile {
  pid: number
  sessionId: string
  started_at: number
}

/**
 * On-disk schema for <sessionsDir>/<id>.meta.json — snapshotted by
 * session-runner every ~10s while the SDK is running.
 */
export interface MetaFile {
  sdk_session_id: string | null
  last_activity_ts: number | null
  last_event_seq: number
  cost: { input_tokens: number; output_tokens: number; usd: number }
  model: string | null
  turn_count: number
  state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
}

/**
 * On-disk schema for <sessionsDir>/<id>.exit — written exactly once on
 * terminal state by session-runner (or the reaper on crash detection).
 */
export interface ExitFile {
  state: 'completed' | 'failed' | 'aborted' | 'crashed'
  exit_code: number | null
  duration_ms: number
  error?: string
}

/** B5 response body shape — shared by status + list endpoints. */
export interface SessionStateSnapshot {
  session_id: string
  state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
  sdk_session_id: string | null
  last_activity_ts: number | null
  last_event_seq: number
  cost: { input_tokens: number; output_tokens: number; usd: number }
  model: string | null
  turn_count: number
}
