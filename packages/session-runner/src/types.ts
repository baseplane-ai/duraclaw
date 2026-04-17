import type {
  ContentBlock,
  GetContextUsageCommand,
  InterruptCommand,
  SetModelCommand,
  SetPermissionModeCommand,
} from '@duraclaw/shared-types'

/**
 * Per-session context owned by the session-runner process.
 *
 * Shape mirrors the gateway's old `GatewaySessionContext` but drops fields
 * that only made sense when the adapter lived inside the gateway.
 * `nextSeq` + `meta` are populated by part B of P1.2.
 */
export interface RunnerSessionContext {
  sessionId: string
  abortController: AbortController
  pendingAnswer: {
    resolve: (answers: Record<string, string>) => void
    reject: (err: Error) => void
  } | null
  pendingPermission: {
    resolve: (allowed: boolean) => void
    reject: (err: Error) => void
  } | null
  messageQueue: {
    push: (msg: { role: 'user'; content: string | ContentBlock[] }) => void
    waitForNext: () => Promise<{
      type: 'user'
      message: { role: 'user'; content: string | ContentBlock[] }
      parent_tool_use_id: string | null
    } | null>
    done: () => void
  } | null
  /** SDK Query object — available after session.init, null before */
  query: import('@anthropic-ai/claude-agent-sdk').Query | null
  /** Queue for commands received before Query is available */
  commandQueue: Array<
    InterruptCommand | SetModelCommand | SetPermissionModeCommand | GetContextUsageCommand
  >
  /** Monotonic sequence stamped on every outbound event. Part B populates this. */
  nextSeq: number
  /** In-memory snapshot of live session state; the meta-file dumper reads this. */
  meta: {
    sdk_session_id: string | null
    last_activity_ts: number
    last_event_seq: number
    cost: { input_tokens: number; output_tokens: number; usd: number }
    model: string | null
    turn_count: number
    state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
  }
}
