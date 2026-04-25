import type {
  ContentBlock,
  GetContextUsageCommand,
  InterruptCommand,
  SetModelCommand,
  SetPermissionModeCommand,
} from '@duraclaw/shared-types'
import type { SessionTitler } from './titler.js'

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
  /** Set to true when a user `interrupt` command is issued. A subsequent
   * SDK throw is treated as an interrupt-induced abort (no error event,
   * meta.state='aborted') rather than a failure. */
  interrupted: boolean
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
  /** GH#86: Haiku session titler. Set by ClaudeRunner.runSession() when
   * `cmd.titler_enabled` is true. Read by handleIncomingCommand for pivot
   * retitle on `stream-input`. */
  titler: SessionTitler | null
  /** Monotonic sequence stamped on every outbound event. Part B populates this. */
  nextSeq: number
  /**
   * GH#92: rotation policy for this runner, resolved at startup from env
   * (`DURACLAW_CLAUDE_PROFILE` / `DURACLAW_CLAUDE_ROTATION`). `off` means
   * caam rotation is suppressed and a rate_limit_event aborts with
   * `rate_limited_no_rotate`; `auto` runs the normal B3 rotation gates.
   * A pinned profile (`DURACLAW_CLAUDE_PROFILE` set) forces `off` —
   * pinning is an explicit no-fallback choice per D8.
   */
  rotationMode?: 'auto' | 'off'
  /**
   * GH#92: path to the sessions-files directory (normally `/run/duraclaw/sessions`).
   * Read from `SESSIONS_DIR` env at startup. Exposed on ctx so the
   * rate-limit branch in claude-runner.ts can globs peer `*.meta.json`
   * without re-reading process.env.
   */
  sessionsDir?: string
  /**
   * GH#92: inline exit-file writer exposed on ctx so the rate-limit
   * branch in claude-runner.ts can write `.exit` BEFORE calling
   * `ctx.abortController.abort()`. Idempotent (link+EEXIST under the
   * hood); second caller no-ops. Populated by main.ts at startup.
   */
  writeExitFileInline?: (payload: Record<string, unknown>) => Promise<void>
  /** In-memory snapshot of live session state; the meta-file dumper reads this. */
  meta: {
    sdk_session_id: string | null
    last_activity_ts: number
    last_event_seq: number
    cost: { input_tokens: number; output_tokens: number; usd: number }
    model: string | null
    turn_count: number
    state:
      | 'running'
      | 'completed'
      | 'failed'
      | 'aborted'
      | 'crashed'
      | 'rate_limited'
      | 'rate_limited_no_profile'
      | 'rate_limited_no_rotate'
    /** GH#92: active caam Claude profile name, stamped at runner startup. */
    claude_profile?: string | null
    /** GH#92: rotation metadata, populated only when rate_limited fired and we rotated. */
    rotation?: { from: string; to: string } | null
    /** GH#92: earliest cooldown-clear timestamp, populated only on rate_limited_no_profile. */
    rate_limit_earliest_clear_ts?: number | null
  }
}
