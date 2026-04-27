/**
 * Process-lifetime metrics counters (P1.9).
 *
 * Plain monotonic counters — no rate-windowing, no decay. Exposed via
 * /health snapshot under `metrics: { syncs_ok, syncs_err, reconnects,
 * tombstones_started, tombstones_cancelled }`. The orchestrator surfaces
 * these to the tray for at-a-glance per-project health.
 */
export interface Metrics {
  syncs_ok: number
  syncs_err: number
  reconnects: number
  tombstones_started: number
  tombstones_cancelled: number
}

export function createMetrics(): Metrics {
  return {
    syncs_ok: 0,
    syncs_err: 0,
    reconnects: 0,
    tombstones_started: 0,
    tombstones_cancelled: 0,
  }
}
