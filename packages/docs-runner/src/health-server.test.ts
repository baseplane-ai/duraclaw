import { afterEach, describe, expect, it } from 'vitest'
import { HealthServer, type HealthSnapshot } from './health-server.js'

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
