import type { GatewayEvent } from './types'

export function parseEvent(data: string | ArrayBuffer): GatewayEvent {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
  return JSON.parse(raw) as GatewayEvent
}

/**
 * Gateway session-status response body per B5 (subset the DO needs).
 */
export interface SessionStatusBody {
  ok: true
  state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
  sdk_session_id: string | null
  last_activity_ts: number | null
  last_event_seq: number
  cost: { input_tokens: number; output_tokens: number; usd: number }
  model: string | null
  turn_count: number
}

/**
 * Discriminated result of a gateway status probe.
 * - `state`       — 200 with a parseable body.
 * - `not_found`   — 404 (orphan / never spawned).
 * - `unreachable` — timeout / network error / non-2xx,non-404 response.
 *
 * The DO uses this to decide whether to run `recoverFromDroppedConnection`.
 */
export type SessionStatusResult =
  | { kind: 'state'; body: SessionStatusBody }
  | { kind: 'not_found' }
  | { kind: 'unreachable'; reason: string }

/**
 * Fetch GET /sessions/:id/status from the gateway with a bounded timeout.
 *
 * `gatewayUrl` accepts either an http(s):// or ws(s):// URL (CC_GATEWAY_URL
 * is historically stored as ws://) and is normalised to http(s).
 *
 * Error classification:
 *   - AbortError from the AbortSignal.timeout → `unreachable:timeout`
 *   - Thrown network error → `unreachable:network:<message>`
 *   - HTTP 404 → `not_found`
 *   - HTTP non-2xx other than 404 → `unreachable:http_<status>`
 *   - HTTP 2xx that fails JSON parse → `unreachable:parse_error`
 *
 * @remarks
 * Fetches the session's live state from the agent-gateway.
 *
 * @param gatewayUrl — Expected format: `ws://HOST[:PORT]` or
 *   `wss://HOST[:PORT]`, with NO trailing path segment. The helper
 *   strips a trailing slash but does not handle mounted prefixes
 *   (e.g. `wss://gw.example.com/v1/` is unsupported).
 */
export async function getSessionStatus(
  gatewayUrl: string,
  bearer: string | undefined,
  sessionId: string,
  timeoutMs = 5000,
): Promise<SessionStatusResult> {
  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = `${httpBase.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}/status`
  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  let resp: Response
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err: unknown) {
    const name = (err as { name?: string } | undefined)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { kind: 'unreachable', reason: 'timeout' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'unreachable', reason: `network:${msg}` }
  }

  if (resp.status === 404) return { kind: 'not_found' }
  if (!resp.ok) return { kind: 'unreachable', reason: `http_${resp.status}` }

  try {
    const body = (await resp.json()) as SessionStatusBody
    return { kind: 'state', body }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'unreachable', reason: `parse_error:${msg}` }
  }
}

/**
 * Entry returned by GET /sessions (B5b) — one row per live .pid file the
 * gateway observes in SESSIONS_DIR.
 */
export interface SessionListEntry {
  session_id: string
  state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
  sdk_session_id: string | null
  last_activity_ts: number | null
  last_event_seq: number
  cost: { input_tokens: number; output_tokens: number; usd: number }
  model: string | null
  turn_count: number
}

/**
 * List sessions currently observed by the gateway. Used by the DO to detect
 * orphaned runners (live runner that isn't WS-connected to us) before we
 * spawn a replacement that would collide inside session-runner's
 * hasLiveResume guard.
 */
export async function listSessions(
  gatewayUrl: string,
  bearer: string | undefined,
  timeoutMs = 5000,
): Promise<SessionListEntry[]> {
  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = `${httpBase.replace(/\/+$/, '')}/sessions`
  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return []
    const body = (await resp.json()) as { ok?: boolean; sessions?: SessionListEntry[] }
    return body.sessions ?? []
  } catch {
    return []
  }
}

/**
 * Result of a gateway force-kill call.
 *  - `signalled` — SIGTERM was delivered; the runner should exit within
 *    ~2s via its own watchdog or sigkill_grace_ms later via the
 *    gateway's escalation timer.
 *  - `already_terminal` — `.exit` file was present; nothing to kill,
 *    treat as a successful no-op.
 *  - `not_found` — no `.pid` or `.exit` on disk. Runner likely already
 *    gone and the DO should fall through to its usual recovery path.
 *  - `unreachable` — gateway timeout / network error / non-2xx. Caller
 *    may want to surface a "force stop failed" error to the user, but
 *    the DO has already transitioned to `idle` so nothing else is
 *    blocked.
 */
export type SessionKillResult =
  | { kind: 'signalled'; pid: number; sigkill_grace_ms: number }
  | { kind: 'already_terminal'; state: string }
  | { kind: 'not_found' }
  | { kind: 'unreachable'; reason: string }

/**
 * POST /sessions/:id/kill on the gateway with a bounded timeout. Mirrors
 * the URL normalisation + error classification of `getSessionStatus`.
 *
 * Unlike the in-band `abort` command (which rides the dial-back WS), this
 * survives a dead WS — the gateway signals the runner process by PID
 * straight from its on-disk `.pid` file.
 */
export async function killSession(
  gatewayUrl: string,
  bearer: string | undefined,
  sessionId: string,
  timeoutMs = 5000,
): Promise<SessionKillResult> {
  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = `${httpBase.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}/kill`
  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err: unknown) {
    const name = (err as { name?: string } | undefined)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { kind: 'unreachable', reason: 'timeout' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'unreachable', reason: `network:${msg}` }
  }

  if (resp.status === 404) return { kind: 'not_found' }
  if (!resp.ok) return { kind: 'unreachable', reason: `http_${resp.status}` }

  try {
    const body = (await resp.json()) as {
      ok?: boolean
      signalled?: string
      pid?: number
      sigkill_grace_ms?: number
      already_terminal?: boolean
      state?: string
    }
    if (body.already_terminal) {
      return { kind: 'already_terminal', state: body.state ?? 'unknown' }
    }
    if (body.signalled && typeof body.pid === 'number') {
      return {
        kind: 'signalled',
        pid: body.pid,
        sigkill_grace_ms: body.sigkill_grace_ms ?? 5_000,
      }
    }
    return { kind: 'unreachable', reason: 'parse_error:unexpected_body' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'unreachable', reason: `parse_error:${msg}` }
  }
}
