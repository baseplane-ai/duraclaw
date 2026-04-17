import fs from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleListSessions,
  handleStartSession,
  handleStatus,
  isValidGatewayCommand,
  type SpawnFn,
} from './handlers.js'
import type { LivenessCheck } from './session-state.js'

// ────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ────────────────────────────────────────────────────────────────────

let tmpDir: string
let originalBearer: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'duraclaw-gw-test-'))
  originalBearer = process.env.CC_GATEWAY_API_TOKEN
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  if (originalBearer === undefined) {
    delete process.env.CC_GATEWAY_API_TOKEN
  } else {
    process.env.CC_GATEWAY_API_TOKEN = originalBearer
  }
  vi.restoreAllMocks()
})

function mkSpawnSpy(): { fn: SpawnFn; calls: { bin: string; args: string[]; opts: unknown }[] } {
  const calls: { bin: string; args: string[]; opts: unknown }[] = []
  const fn: SpawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts })
    return {
      unref: () => {},
      pid: 99999,
    }
  }
  return { fn, calls }
}

/** Minimal valid /sessions/start body. */
function validStartBody(overrides: Record<string, unknown> = {}) {
  return {
    callback_url: 'ws://example.com/cb',
    callback_token: 'test-token-123',
    cmd: { type: 'execute', project: 'duraclaw', prompt: 'hello' },
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────
// POST /sessions/start (B4)
// ────────────────────────────────────────────────────────────────────

describe('POST /sessions/start', () => {
  it('accepts a valid body, writes cmd file, spawns detached session-runner', async () => {
    const spy = mkSpawnSpy()
    const unrefSpy = vi.fn()
    const spawnFn: SpawnFn = (bin, args, opts) => {
      spy.fn(bin, args, opts)
      return { unref: unrefSpy, pid: 12345 }
    }

    const resp = await handleStartSession(validStartBody(), {
      sessionsDir: tmpDir,
      binResolver: async () => '/fake/bin/session-runner',
      spawnFn,
      idGenerator: () => 'SESSION-ABC',
    })

    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { ok: boolean; session_id: string }
    expect(body).toEqual({ ok: true, session_id: 'SESSION-ABC' })

    // Cmd file persisted
    const cmdContent = await fs.readFile(nodePath.join(tmpDir, 'SESSION-ABC.cmd'), 'utf8')
    expect(JSON.parse(cmdContent)).toEqual({
      type: 'execute',
      project: 'duraclaw',
      prompt: 'hello',
    })

    // Spawn argv: [bin, sessionId, cmdFile, callbackUrl, callbackToken, pidFile, exitFile, metaFile]
    expect(spy.calls).toHaveLength(1)
    const call = spy.calls[0]
    expect(call.bin).toBe('/fake/bin/session-runner')
    expect(call.args).toEqual([
      '/fake/bin/session-runner',
      'SESSION-ABC',
      nodePath.join(tmpDir, 'SESSION-ABC.cmd'),
      'ws://example.com/cb',
      'test-token-123',
      nodePath.join(tmpDir, 'SESSION-ABC.pid'),
      nodePath.join(tmpDir, 'SESSION-ABC.exit'),
      nodePath.join(tmpDir, 'SESSION-ABC.meta.json'),
    ])

    // Detached + stdio inherits log fd + unref called
    const opts = call.opts as {
      stdio: unknown[]
      detached: boolean
      env: Record<string, string>
    }
    expect(opts.detached).toBe(true)
    expect(opts.stdio[0]).toBe('ignore')
    expect(typeof opts.stdio[1]).toBe('number') // fd
    expect(opts.stdio[1]).toBe(opts.stdio[2])
    expect(opts.env.SESSIONS_DIR).toBe(tmpDir)
    expect(unrefSpy).toHaveBeenCalledTimes(1)
  })

  it('returns 200 within 100ms (fire-and-forget)', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const start = performance.now()
    const resp = await handleStartSession(validStartBody(), {
      sessionsDir: tmpDir,
      binResolver: async () => '/fake/bin/session-runner',
      spawnFn,
      idGenerator: () => 'FAST-ID',
    })
    const elapsed = performance.now() - start

    expect(resp.status).toBe(200)
    expect(elapsed).toBeLessThan(100)
  })

  it('400 "invalid callback_url" on missing url', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody({ callback_url: undefined }), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => '/x',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid callback_url' })
  })

  it('400 "invalid callback_url" on non-ws scheme', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody({ callback_url: 'not-a-url' }), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => '/x',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid callback_url' })
  })

  it('400 "invalid callback_url" on http:// scheme', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(
      validStartBody({ callback_url: 'http://example.com/cb' }),
      { sessionsDir: tmpDir, spawnFn, binResolver: async () => '/x' },
    )
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid callback_url' })
  })

  it('accepts wss:// url', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(
      validStartBody({ callback_url: 'wss://example.com/cb' }),
      {
        sessionsDir: tmpDir,
        spawnFn,
        binResolver: async () => '/x',
        idGenerator: () => 'WSS-ID',
      },
    )
    expect(resp.status).toBe(200)
  })

  it('400 "invalid callback_token" on missing token', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody({ callback_token: undefined }), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => '/x',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid callback_token' })
  })

  it('400 "invalid callback_token" on empty token', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody({ callback_token: '' }), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => '/x',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid callback_token' })
  })

  it('400 "invalid cmd" on missing cmd', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody({ cmd: undefined }), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => '/x',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid cmd' })
  })

  it('400 "invalid cmd" on cmd without type', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody({ cmd: { project: 'x' } }), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => '/x',
    })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid cmd' })
  })

  it('400 "invalid body" on non-object', async () => {
    const resp = await handleStartSession('not-an-object', { sessionsDir: tmpDir })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: 'invalid body' })
  })

  it('500 "session-runner bin not found" when resolver returns null', async () => {
    const { fn: spawnFn } = mkSpawnSpy()
    const resp = await handleStartSession(validStartBody(), {
      sessionsDir: tmpDir,
      spawnFn,
      binResolver: async () => null,
      idGenerator: () => 'NO-BIN',
    })
    expect(resp.status).toBe(500)
    expect(await resp.json()).toEqual({ ok: false, error: 'session-runner bin not found' })
  })

  it('isValidGatewayCommand rejects null / non-object / missing type', () => {
    expect(isValidGatewayCommand(null)).toBe(false)
    expect(isValidGatewayCommand(undefined)).toBe(false)
    expect(isValidGatewayCommand('string')).toBe(false)
    expect(isValidGatewayCommand({})).toBe(false)
    expect(isValidGatewayCommand({ type: '' })).toBe(false)
    expect(isValidGatewayCommand({ type: 123 })).toBe(false)
    expect(isValidGatewayCommand({ type: 'execute' })).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────
// GET /sessions (B5b)
// ────────────────────────────────────────────────────────────────────

describe('GET /sessions', () => {
  it('returns empty array when sessions dir missing', async () => {
    const missingDir = nodePath.join(tmpDir, 'does-not-exist')
    const resp = await handleListSessions(missingDir)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, sessions: [] })
  })

  it('returns empty array when sessions dir has no .pid files', async () => {
    const resp = await handleListSessions(tmpDir)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true, sessions: [] })
  })

  it('returns 3 entries for 3 pid files: live / exit / dead-pid', async () => {
    // Session A — live pid, no exit
    await fs.writeFile(
      nodePath.join(tmpDir, 'A.pid'),
      JSON.stringify({ pid: 100, sessionId: 'A', started_at: 1 }),
    )
    await fs.writeFile(
      nodePath.join(tmpDir, 'A.meta.json'),
      JSON.stringify({
        sdk_session_id: 'sdk-A',
        last_activity_ts: 111,
        last_event_seq: 5,
        cost: { input_tokens: 10, output_tokens: 20, usd: 0.001 },
        model: 'claude-sonnet-4',
        turn_count: 1,
        state: 'running',
      }),
    )

    // Session B — has exit file (completed)
    await fs.writeFile(
      nodePath.join(tmpDir, 'B.pid'),
      JSON.stringify({ pid: 200, sessionId: 'B', started_at: 2 }),
    )
    await fs.writeFile(
      nodePath.join(tmpDir, 'B.exit'),
      JSON.stringify({ state: 'completed', exit_code: 0, duration_ms: 500 }),
    )
    await fs.writeFile(
      nodePath.join(tmpDir, 'B.meta.json'),
      JSON.stringify({
        sdk_session_id: 'sdk-B',
        last_activity_ts: 222,
        last_event_seq: 42,
        cost: { input_tokens: 1000, output_tokens: 500, usd: 0.02 },
        model: 'claude-opus-4',
        turn_count: 3,
        state: 'completed',
      }),
    )

    // Session C — pid but process dead, no exit
    await fs.writeFile(
      nodePath.join(tmpDir, 'C.pid'),
      JSON.stringify({ pid: 300, sessionId: 'C', started_at: 3 }),
    )

    const isAlive: LivenessCheck = (pid) => pid === 100 // only A is live

    const resp = await handleListSessions(tmpDir, isAlive)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as {
      ok: boolean
      sessions: Array<{ session_id: string; state: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.sessions).toHaveLength(3)

    const byId = Object.fromEntries(body.sessions.map((s) => [s.session_id, s]))
    expect(byId.A.state).toBe('running')
    expect(byId.B.state).toBe('completed')
    expect(byId.C.state).toBe('crashed')
  })
})

// ────────────────────────────────────────────────────────────────────
// GET /sessions/:id/status (B5)
// ────────────────────────────────────────────────────────────────────

describe('GET /sessions/:id/status', () => {
  it('404 when neither pid nor exit file exists', async () => {
    const resp = await handleStatus('missing', tmpDir)
    expect(resp.status).toBe(404)
    expect(await resp.json()).toEqual({ ok: false, error: 'session not found' })
  })

  it('200 state:"running" on live pid + meta', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'LIVE.pid'),
      JSON.stringify({ pid: 42, sessionId: 'LIVE', started_at: 1 }),
    )
    await fs.writeFile(
      nodePath.join(tmpDir, 'LIVE.meta.json'),
      JSON.stringify({
        sdk_session_id: 'sdk-xyz',
        last_activity_ts: 1700000000000,
        last_event_seq: 7,
        cost: { input_tokens: 100, output_tokens: 50, usd: 0.0015 },
        model: 'claude-sonnet-4',
        turn_count: 2,
        state: 'running',
      }),
    )

    const isAlive: LivenessCheck = (pid) => pid === 42
    const resp = await handleStatus('LIVE', tmpDir, isAlive)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({
      ok: true,
      session_id: 'LIVE',
      state: 'running',
      sdk_session_id: 'sdk-xyz',
      last_activity_ts: 1700000000000,
      last_event_seq: 7,
      cost: { input_tokens: 100, output_tokens: 50, usd: 0.0015 },
      model: 'claude-sonnet-4',
      turn_count: 2,
    })
  })

  it('200 state:"running" with default meta when meta file absent', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'NOMETA.pid'),
      JSON.stringify({ pid: 42, sessionId: 'NOMETA', started_at: 1 }),
    )

    const isAlive: LivenessCheck = (pid) => pid === 42
    const resp = await handleStatus('NOMETA', tmpDir, isAlive)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.state).toBe('running')
    expect(body.sdk_session_id).toBeNull()
    expect(body.last_activity_ts).toBeNull()
    expect(body.last_event_seq).toBe(0)
    expect(body.cost).toEqual({ input_tokens: 0, output_tokens: 0, usd: 0 })
  })

  it('200 state from exit file when present (completed)', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'DONE.exit'),
      JSON.stringify({ state: 'completed', exit_code: 0, duration_ms: 1234 }),
    )
    // No pid, no meta — only exit
    const resp = await handleStatus('DONE', tmpDir)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.state).toBe('completed')
  })

  it('200 state:"crashed" on dead pid without exit file', async () => {
    await fs.writeFile(
      nodePath.join(tmpDir, 'DEAD.pid'),
      JSON.stringify({ pid: 777, sessionId: 'DEAD', started_at: 1 }),
    )
    const isAlive: LivenessCheck = () => false
    const resp = await handleStatus('DEAD', tmpDir, isAlive)
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.state).toBe('crashed')
  })
})
