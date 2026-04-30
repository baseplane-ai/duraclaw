import type { Connection } from 'agents'
import type { Session } from 'agents/experimental/memory/session'
import type { Env } from '~/lib/types'
import type { SessionDO, SessionMeta } from './index'

/**
 * SessionDOContext — live-reference bag passed to every extracted module
 * function (spec #101 B3).
 *
 * Constructed once in `onStart()` after migrations + Session init. Holds
 * **live references** — `state` points to `this.state` (the Agent's
 * reactive state object), `session` points to the single Session instance,
 * `sql` / `env` / `ctx` are immutable DO properties. Never reconstructed
 * after `onStart()`. Modules must NOT cache `ctx.state.fieldName` across
 * await boundaries — always re-read from `ctx.state`.
 */
export interface SessionDOContext {
  /** The owning DO instance. Type-only import to avoid runtime cycles. */
  do: SessionDO
  /** Reactive state proxy from the Agent base class. */
  state: SessionMeta
  /** Lazily-initialised Session (agents/experimental/memory). */
  session: Session
  /** DO SQLite handle (this.ctx.storage.sql). */
  sql: SqlStorage
  /** DO env bindings. */
  env: Env
  /** Raw DurableObjectState. */
  ctx: DurableObjectState
  /** Send a WS frame to every non-gateway browser connection. */
  broadcast: (data: string) => void
  /** All connections currently attached to the DO (gateway + clients). */
  getConnections: () => Connection[]
  /** Persist a structured log event + mirror to console. */
  logEvent: (
    level: 'info' | 'warn' | 'error',
    tag: string,
    message: string,
    attrs?: Record<string, unknown>,
  ) => void
}

/**
 * Hibernation-safe alarm interval (ms) for periodic messageSeq D1 flush
 * and recovery-grace deadline expiration. Alarms survive DO hibernation,
 * unlike setInterval which stops when the DO is evicted from memory.
 */
export const ALARM_INTERVAL_MS = 30_000

/** GH#57: grace period before running recovery when the gateway reports the
 * runner is still alive. Gives DialBackClient time to reconnect after a
 * transient CF WS flap. If the runner re-dials within this window (detected
 * in onConnectInner), the timer is cancelled and the session resumes. */
export const RECOVERY_GRACE_MS = 15_000

/**
 * Extended awaiting-response grace for the "silent network drop" case —
 * `conn.send()` returned success on the gateway WS but the data never
 * actually reached the runner (TCP half-close, CF WS proxy buffer drop,
 * packet loss). The runner connection ID is still recorded as healthy, so
 * `RECOVERY_GRACE_MS` (which only fires when connectionId is null) won't
 * catch it. After this window — long enough to absorb a slow first-token
 * SDK turn — the watchdog expires the awaiting part with a notice prompting
 * the user to retry, while keeping the session running (the runner is
 * fine; only this one stream-input was dropped).
 *
 * Production evidence: session sess-230935d5-... usr-41 (00:37), usr-52
 * (01:17), usr-54 (01:25) all stuck in awaiting_response with the runner
 * still attached and processing other turns normally. No connection-drop
 * log entry around any of them — confirms the WS layer never reported the
 * drop.
 */
export const AWAITING_LIVE_CONN_GRACE_MS = 90_000

/**
 * Runaway-turn guard threshold. When the SDK emits this many consecutive
 * `assistant` events whose content is "effectively empty" (no tool_use and
 * only whitespace / ZWS text), the DO interrupts the runner and flips the
 * session to idle with a visible system-error message. See prod incident
 * 2026-04-24, session `sess-ffca0374-...`, where the model emitted 500+
 * single-U+200B assistant turns before a human interrupted it.
 */
export const RUNAWAY_EMPTY_TURN_THRESHOLD = 10

/**
 * Repeat-detector threshold for the "stuck-content" runaway flavor —
 * model emits N consecutive non-empty turns with identical fingerprints
 * (whitespace / case / Unicode-modulo). Tighter than the empty-turn
 * threshold because identical-content loops are a stronger, rarer signal:
 * 5 in a row is virtually never legitimate. Tool-use turns are excluded
 * from fingerprinting (varying tool args = legitimate progress).
 */
export const REPEATED_TURN_THRESHOLD = 5

/**
 * Parse a canonical user-turn ordinal from a message id or canonical_turn_id.
 * Returns `N` if the id matches `/^usr-(\d+)$/`, otherwise `undefined`.
 * Used by DO cold-start turnCounter recovery (GH#14 P3) and the client
 * sort-key derivation.
 */
export function parseTurnOrdinal(id?: string): number | undefined {
  if (!id) return undefined
  const m = /^usr-(\d+)$/.exec(id)
  return m ? Number.parseInt(m[1], 10) : undefined
}

export const DEFAULT_META: SessionMeta = {
  status: 'idle',
  session_id: null,
  project: '',
  project_path: '',
  model: null,
  prompt: '',
  userId: null,
  started_at: null,
  completed_at: null,
  num_turns: 0,
  total_cost_usd: null,
  duration_ms: null,
  created_at: '',
  updated_at: '',
  result: null,
  error: null,
  summary: null,
  runner_session_id: null,
  capabilities: null,
  active_callback_token: undefined,
  title: null,
  title_confidence: null,
  title_set_at_turn: null,
  title_source: null,
  agent: null,
  worktreeId: null,
  waiting_identity_retries: 0,
}

// Map `SessionMeta` keys to their `session_meta` column names. Keys not in
// this map are treated as non-persistent (e.g. `result`, `updated_at` —
// `updated_at` is written explicitly below; `result` is legacy).
export const META_COLUMN_MAP: Partial<Record<keyof SessionMeta, string>> = {
  status: 'status',
  session_id: 'session_id',
  project: 'project',
  project_path: 'project_path',
  model: 'model',
  prompt: 'prompt',
  userId: 'user_id',
  started_at: 'started_at',
  completed_at: 'completed_at',
  num_turns: 'num_turns',
  total_cost_usd: 'total_cost_usd',
  duration_ms: 'duration_ms',
  created_at: 'created_at',
  error: 'error',
  summary: 'summary',
  runner_session_id: 'runner_session_id',
  capabilities: 'capabilities_json',
  active_callback_token: 'active_callback_token',
  lastKataMode: 'last_kata_mode',
  lastRunEnded: 'last_run_ended',
  title: 'title',
  title_confidence: 'title_confidence',
  title_set_at_turn: 'title_set_at_turn',
  title_source: 'title_source',
  agent: 'agent',
  worktreeId: 'worktree_id',
  waiting_identity_retries: 'waiting_identity_retries',
}
