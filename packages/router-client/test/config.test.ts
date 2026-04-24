import { describe, expect, it } from 'vitest'
import { routerConfig } from '../src/config.js'
import { type FetchLike, OPENCLAW_SESSION_HEADER, SESSION_HEADER } from '../src/types.js'

describe('routerConfig', () => {
  it('normalises trailing slashes from routerUrl', () => {
    const cfg = routerConfig({ routerUrl: 'http://127.0.0.1:8403/' })
    expect(cfg.baseURL).toBe('http://127.0.0.1:8403')
  })

  it('throws on empty routerUrl', () => {
    expect(() => routerConfig({ routerUrl: '' })).toThrow(/routerUrl/)
  })

  it('throws on malformed routerUrl', () => {
    expect(() => routerConfig({ routerUrl: 'not a url' })).toThrow(/routerUrl/)
  })

  it('propagates sessionId as x-session-id in defaultHeaders', () => {
    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-1',
    })
    expect(cfg.defaultHeaders[SESSION_HEADER]).toBe('sess-1')
    expect(cfg.defaultHeaders[OPENCLAW_SESSION_HEADER]).toBeUndefined()
  })

  it('propagates openclawSessionKey separately from sessionId', () => {
    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-1',
      openclawSessionKey: 'ocw-key',
    })
    expect(cfg.defaultHeaders[SESSION_HEADER]).toBe('sess-1')
    expect(cfg.defaultHeaders[OPENCLAW_SESSION_HEADER]).toBe('ocw-key')
  })

  it('merges user headers after defaults (user wins on collision)', () => {
    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-default',
      headers: { [SESSION_HEADER]: 'sess-override', 'x-custom': 'yep' },
    })
    expect(cfg.defaultHeaders[SESSION_HEADER]).toBe('sess-override')
    expect(cfg.defaultHeaders['x-custom']).toBe('yep')
  })

  it('returns a fetch that injects defaults on every call', async () => {
    const seen: RequestInit[] = []
    const stub: FetchLike = async (_input, init) => {
      seen.push(init ?? {})
      return new Response('ok', { status: 200 })
    }

    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-abc',
      fetch: stub,
    })

    await cfg.fetch('http://127.0.0.1:8403/v1/messages', { method: 'POST' })
    const init = seen[0]
    expect(init).toBeDefined()
    const headers = new Headers(init!.headers)
    expect(headers.get(SESSION_HEADER)).toBe('sess-abc')
  })

  it('does not clobber a per-request header the caller set', async () => {
    const seen: RequestInit[] = []
    const stub: FetchLike = async (_input, init) => {
      seen.push(init ?? {})
      return new Response('ok')
    }

    const cfg = routerConfig({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-default',
      fetch: stub,
    })

    await cfg.fetch('http://127.0.0.1:8403/v1/messages', {
      method: 'POST',
      headers: { [SESSION_HEADER]: 'sess-call-site' },
    })

    const headers = new Headers(seen[0]!.headers)
    expect(headers.get(SESSION_HEADER)).toBe('sess-call-site')
  })
})
