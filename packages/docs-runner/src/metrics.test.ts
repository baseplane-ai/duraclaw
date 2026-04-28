import { describe, expect, it } from 'vitest'
import { createMetrics } from './metrics.js'

describe('createMetrics', () => {
  it('returns all-zero counters', () => {
    expect(createMetrics()).toEqual({
      syncs_ok: 0,
      syncs_err: 0,
      reconnects: 0,
      tombstones_started: 0,
      tombstones_cancelled: 0,
    })
  })

  it('exposes mutable counters that can be incremented', () => {
    const m = createMetrics()
    m.syncs_ok++
    m.syncs_ok++
    m.syncs_err++
    m.reconnects += 3
    m.tombstones_started++
    expect(m.syncs_ok).toBe(2)
    expect(m.syncs_err).toBe(1)
    expect(m.reconnects).toBe(3)
    expect(m.tombstones_started).toBe(1)
    expect(m.tombstones_cancelled).toBe(0)
  })
})
