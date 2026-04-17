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
