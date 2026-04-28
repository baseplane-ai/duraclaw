import type { ContentBlock } from '@duraclaw/shared-types'
import type { PushPullQueue } from './push-pull-queue.js'
import type { SessionTitler } from './titler.js'
import type { WsTranscriptRpc } from './transcript-rpc.js'

/** SDK user message shape used as the lifetime queue payload. */
export interface SDKUserMsg {
  type: 'user'
  message: { role: 'user'; content: string | ContentBlock[] }
  parent_tool_use_id: string | null
}

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
  /** Lifetime queue of user messages feeding the single Query() prompt.
   * Constructed by ClaudeRunner; null before runSession starts and after
   * the session ends. stream-input commands push onto this. */
  userQueue: PushPullQueue<SDKUserMsg> | null
  /** SDK Query object — available after session.init, null before */
  query: import('@anthropic-ai/claude-agent-sdk').Query | null
  /** GH#86: Haiku session titler. Set by ClaudeRunner.runSession() when
   * `cmd.titler_enabled` is true. Read by handleIncomingCommand for pivot
   * retitle on `stream-input`. */
  titler: SessionTitler | null
  /** Monotonic sequence stamped on every outbound event. Part B populates this. */
  nextSeq: number
  /** In-memory snapshot of live session state; the meta-file dumper reads this. */
  meta: {
    runner_session_id: string | null
    last_activity_ts: number
    last_event_seq: number
    cost: { input_tokens: number; output_tokens: number; usd: number }
    model: string | null
    turn_count: number
    state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
    pending_gate?: {
      type: 'ask_user' | 'permission_request'
      tool_call_id: string
      parked_at_ts: number
    } | null
  }
  /** Flush the meta snapshot to disk immediately. Assigned by main() after
   * constructing the flushMeta closure; optional so claude-runner.ts can call
   * it without a hard dependency on the closure. */
  flushMeta?: () => Promise<void>
  /**
   * GH#119: TranscriptRpc multiplexer over the dial-back WS. Constructed
   * in main() before the channel is dialed and exposed on ctx so the
   * incoming-command dispatcher can deliver `transcript-rpc-response`
   * frames into `handleResponse()` and `claude-runner` can build the
   * `DuraclavSessionStore` adapter when the feature flag is on. Optional
   * — pre-119 wiring won't populate it.
   */
  transcriptRpc?: WsTranscriptRpc
}
