import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killSession, parseEvent } from './vps-client'

describe('parseEvent', () => {
  it('parses a JSON string into a GatewayEvent', () => {
    const event = parseEvent('{"type":"session.init","session_id":"s1","model":"claude"}')
    expect(event).toEqual({ type: 'session.init', session_id: 's1', model: 'claude' })
  })

  it('parses an ArrayBuffer into a GatewayEvent', () => {
    const json = '{"type":"result","session_id":"s1","status":"completed"}'
    const buf = new TextEncoder().encode(json).buffer
    const event = parseEvent(buf)
    expect(event).toEqual({ type: 'result', session_id: 's1', status: 'completed' })
  })

  it('throws on invalid JSON', () => {
    expect(() => parseEvent('not-json')).toThrow()
  })

  it('does not export connectToExecutor or sendCommand (dead code removed)', async () => {
    const mod = await import('./vps-client')
    expect(mod).not.toHaveProperty('connectToExecutor')
    expect(mod).not.toHaveProperty('sendCommand')
  })

  it('exports parseEvent, getSessionStatus, listSessions, killSession (no dead legacy helpers)', async () => {
    const mod = await import('./vps-client')
    const exportedKeys = Object.keys(mod).sort()
    // Intentional allow-list — guards against accidental re-introduction of
    // the old connectToExecutor/sendCommand helpers (see spec #1 P1.5).
    expect(exportedKeys).toEqual(['getSessionStatus', 'killSession', 'listSessions', 'parseEvent'])
  })
})

describe('killSession', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('normalises ws:// → http:// and POSTs to /sessions/:id/kill with bearer', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      return new Response(
        JSON.stringify({ ok: true, signalled: 'SIGTERM', pid: 42, sigkill_grace_ms: 5000 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('ws://127.0.0.1:9877', 'secret-abc', 'SID-1')
    expect(result).toEqual({ kind: 'signalled', pid: 42, sigkill_grace_ms: 5000 })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9877/sessions/SID-1/kill')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-abc')
  })

  it('normalises wss:// → https://', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, signalled: 'SIGTERM', pid: 1, sigkill_grace_ms: 5000 }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    await killSession('wss://gw.example.com', undefined, 'SID-2')
    expect(fetchSpy.mock.calls[0][0]).toBe('https://gw.example.com/sessions/SID-2/kill')
  })

  it('returns already_terminal when body carries that flag', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, already_terminal: true, state: 'completed' }), {
          status: 200,
        }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('http://gw', undefined, 'SID')
    expect(result).toEqual({ kind: 'already_terminal', state: 'completed' })
  })

  it('returns not_found on 404', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('http://gw', undefined, 'SID')
    expect(result).toEqual({ kind: 'not_found' })
  })

  it('returns unreachable:http_<status> on non-2xx non-404', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 503 }))
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('http://gw', undefined, 'SID')
    expect(result).toEqual({ kind: 'unreachable', reason: 'http_503' })
  })

  it('returns unreachable:timeout when the fetch aborts', async () => {
    const fetchSpy = vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'TimeoutError'
      throw err
    })
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('http://gw', undefined, 'SID')
    expect(result).toEqual({ kind: 'unreachable', reason: 'timeout' })
  })

  it('returns unreachable:network:<msg> on other errors', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('http://gw', undefined, 'SID')
    expect(result).toEqual({ kind: 'unreachable', reason: 'network:ECONNREFUSED' })
  })

  it('returns unreachable:parse_error when body is unexpected shape', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, weird: 'payload' }), { status: 200 }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    const result = await killSession('http://gw', undefined, 'SID')
    expect(result.kind).toBe('unreachable')
    if (result.kind === 'unreachable') {
      expect(result.reason).toMatch(/parse_error/)
    }
  })

  it('url-encodes the session id', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, signalled: 'SIGTERM', pid: 1, sigkill_grace_ms: 5000 }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch

    await killSession('http://gw', undefined, 'weird/id with spaces')
    expect(fetchSpy.mock.calls[0][0]).toBe('http://gw/sessions/weird%2Fid%20with%20spaces/kill')
  })
})
