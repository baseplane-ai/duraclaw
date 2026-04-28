import { afterEach, describe, expect, it } from 'vitest'
import {
  type DeriveStatusInputs,
  deriveStatus,
  HealthServer,
  type HealthSnapshot,
} from './health-server.js'

const baseSnapshot: HealthSnapshot = {
  status: 'ok',
  version: '0.0.0-test',
  uptime_ms: 1234,
  files: 0,
  syncing: 0,
  disconnected: 0,
  tombstoned: 0,
  errors: 0,
  reconnects: 0,
  per_file: [],
  config_present: true,
  metrics: {
    syncs_ok: 0,
    syncs_err: 0,
    reconnects: 0,
    tombstones_started: 0,
    tombstones_cancelled: 0,
  },
}

let active: HealthServer | null = null

afterEach(async () => {
  if (active) {
    await active.stop()
    active = null
  }
})

// Pick a random ephemeral port (>= 30000) to avoid collisions with other
// vitest workers. Re-rolling on EADDRINUSE is overkill for these tests.
function ephemeralPort(): number {
  return 30000 + Math.floor(Math.random() * 30000)
}

describe('HealthServer', () => {
  it('serves GET /health with snapshot JSON and stops cleanly', async () => {
    const port = ephemeralPort()
    const server = new HealthServer({ port, snapshot: () => baseSnapshot })
    active = server
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('x-docs-runner-version')).toBe('0.0.0-test')
    const body = (await res.json()) as HealthSnapshot
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.0.0-test')
    expect(body.uptime_ms).toBe(1234)
    expect(body.config_present).toBe(true)

    await server.stop()
    active = null
  })

  it('surfaces config_present=false when supplied by the snapshot factory', async () => {
    const port = ephemeralPort()
    const server = new HealthServer({
      port,
      snapshot: () => ({ ...baseSnapshot, config_present: false }),
    })
    active = server
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await res.json()) as HealthSnapshot
    expect(body.config_present).toBe(false)
  })

  it('returns 404 for unknown paths', async () => {
    const port = ephemeralPort()
    const server = new HealthServer({ port, snapshot: () => baseSnapshot })
    active = server
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(res.status).toBe(404)
    await res.text() // drain body so the conn closes cleanly
  })

  it('exposes the 5 metrics counter keys in the snapshot body', async () => {
    const port = ephemeralPort()
    const server = new HealthServer({
      port,
      snapshot: () => ({
        ...baseSnapshot,
        metrics: {
          syncs_ok: 4,
          syncs_err: 1,
          reconnects: 2,
          tombstones_started: 3,
          tombstones_cancelled: 0,
        },
      }),
    })
    active = server
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await res.json()) as HealthSnapshot
    expect(body.metrics).toBeDefined()
    expect(Object.keys(body.metrics).sort()).toEqual([
      'reconnects',
      'syncs_err',
      'syncs_ok',
      'tombstones_cancelled',
      'tombstones_started',
    ])
    expect(body.metrics.syncs_ok).toBe(4)
    expect(body.metrics.tombstones_started).toBe(3)
  })

  it('reflects live snapshot changes between requests', async () => {
    const port = ephemeralPort()
    let counter = 0
    const server = new HealthServer({
      port,
      snapshot: () => ({ ...baseSnapshot, files: counter }),
    })
    active = server
    await server.start()

    counter = 1
    const a = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as HealthSnapshot
    expect(a.files).toBe(1)

    counter = 5
    const b = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as HealthSnapshot
    expect(b.files).toBe(5)
  })
})

describe('deriveStatus (B14 threshold tree)', () => {
  const baseInputs: DeriveStatusInputs = {
    watcherAlive: true,
    enumerationComplete: true,
    filesCount: 3,
    uptimeMs: 5_000,
    disconnected: 0,
    startupGraceMs: 30_000,
  }

  it('returns ok in the happy path', () => {
    expect(deriveStatus(baseInputs)).toBe('ok')
  })

  it('returns down when watcher is dead', () => {
    expect(deriveStatus({ ...baseInputs, watcherAlive: false })).toBe('down')
  })

  it('returns down when initial enumeration has not completed', () => {
    expect(deriveStatus({ ...baseInputs, enumerationComplete: false })).toBe('down')
  })

  it('returns down when files=0 and uptime exceeds the grace window', () => {
    expect(
      deriveStatus({
        ...baseInputs,
        filesCount: 0,
        uptimeMs: 30_001,
        startupGraceMs: 30_000,
      }),
    ).toBe('down')
  })

  it('stays ok when files=0 but still within the grace window', () => {
    expect(
      deriveStatus({
        ...baseInputs,
        filesCount: 0,
        uptimeMs: 5_000,
        startupGraceMs: 30_000,
      }),
    ).toBe('ok')
  })

  it('returns degraded when at least one non-tombstoned file is disconnected', () => {
    expect(deriveStatus({ ...baseInputs, disconnected: 1 })).toBe('degraded')
  })

  it('prefers down over degraded when both conditions hold', () => {
    expect(
      deriveStatus({
        ...baseInputs,
        watcherAlive: false,
        disconnected: 2,
      }),
    ).toBe('down')
  })

  it('is tombstone-neutral — ok when disconnected=0 even if tombstoned files exist', () => {
    // Tombstoned files are excluded from `disconnected` by the caller, so
    // here we only need to assert that disconnected=0 yields ok regardless
    // of any other implied tombstone count.
    expect(
      deriveStatus({
        ...baseInputs,
        filesCount: 5, // tracked files, ignoring tombstoned ones
        disconnected: 0,
      }),
    ).toBe('ok')
  })
})
