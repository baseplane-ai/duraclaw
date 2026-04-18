/**
 * Lag probe — measures the WS-arrival → DOM-paint delta for messages in the
 * collection-as-source debug route.
 *
 * Two marks per message id:
 *   ws.received.<id>      — set in the onMessage handler just after the
 *                           collection upsert is enqueued
 *   dom.painted.<id>      — set in a useLayoutEffect on the rendered row
 *                           the first time that row's content changes
 *
 * The difference is the round-trip we care about for §4 L1/L5 in the
 * session-tab-loading-trace research doc. We keep a rolling window of the
 * last N deltas and expose p50/p95 for a live readout.
 */

const WINDOW_SIZE = 500

interface Sample {
  id: string
  wsAtMs: number
  paintAtMs: number
  deltaMs: number
}

const samples: Sample[] = []
const pendingWs = new Map<string, number>()

/** Stamp the moment a message frame was received over the WS. */
export function markWsReceived(id: string): void {
  pendingWs.set(id, performance.now())
}

/**
 * Stamp the moment a message row first painted. Pair with the earlier
 * markWsReceived to compute the delta. No-op if no ws mark exists (e.g.
 * for cache-first rows that were never on the wire this session).
 */
export function markDomPainted(id: string): void {
  const wsAtMs = pendingWs.get(id)
  if (wsAtMs === undefined) return
  const paintAtMs = performance.now()
  pendingWs.delete(id)
  samples.push({ id, wsAtMs, paintAtMs, deltaMs: paintAtMs - wsAtMs })
  if (samples.length > WINDOW_SIZE) samples.shift()
}

export interface LagStats {
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export function getLagStats(): LagStats {
  if (samples.length === 0) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 }
  const sorted = samples.map((s) => s.deltaMs).sort((a, b) => a - b)
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    count: sorted.length,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    maxMs: sorted[sorted.length - 1],
  }
}

export function resetLagProbe(): void {
  samples.length = 0
  pendingWs.clear()
}
