import { describe, expect, it } from 'vitest'
import { buildRouterOptions } from './router-options.js'

describe('buildRouterOptions', () => {
  it('returns an empty patch when UNCOMMON_ROUTE_URL is unset', () => {
    expect(buildRouterOptions({ sessionId: 's1', env: {} })).toEqual({})
  })

  it('returns an empty patch when UNCOMMON_ROUTE_URL is blank', () => {
    expect(buildRouterOptions({ sessionId: 's1', env: { UNCOMMON_ROUTE_URL: '   ' } })).toEqual({})
  })

  it('returns baseURL + fetch when UNCOMMON_ROUTE_URL is set', () => {
    const patch = buildRouterOptions({
      sessionId: 'sess-abc',
      env: { UNCOMMON_ROUTE_URL: 'http://127.0.0.1:8403' },
    })
    expect(patch.baseURL).toBe('http://127.0.0.1:8403')
    expect(typeof patch.fetch).toBe('function')
  })

  it('normalises trailing slashes on the baseURL', () => {
    const patch = buildRouterOptions({
      sessionId: 'sess-abc',
      env: { UNCOMMON_ROUTE_URL: 'http://127.0.0.1:8403/' },
    })
    expect(patch.baseURL).toBe('http://127.0.0.1:8403')
  })

  it('injects x-session-id onto requests made through the returned fetch', async () => {
    let captured: Headers | undefined
    const stubGlobalFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = new Headers(init?.headers ?? {})
      return new Response('ok')
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubGlobalFetch
    try {
      const patch = buildRouterOptions({
        sessionId: 'sess-xyz',
        env: { UNCOMMON_ROUTE_URL: 'http://127.0.0.1:8403' },
      })
      await patch.fetch!('http://127.0.0.1:8403/v1/messages', { method: 'POST' })
      expect(captured?.get('x-session-id')).toBe('sess-xyz')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to empty patch on malformed UNCOMMON_ROUTE_URL', () => {
    const warns: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    }
    try {
      const patch = buildRouterOptions({
        sessionId: 's1',
        env: { UNCOMMON_ROUTE_URL: 'not a url' },
      })
      expect(patch).toEqual({})
      expect(warns.some((w) => w.includes('UNCOMMON_ROUTE_URL invalid'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })
})
