import { describe, expect, it } from 'vitest'
import { wrapFetch } from '../src/fetch.js'
import { type FetchLike, OPENCLAW_SESSION_HEADER, SESSION_HEADER } from '../src/types.js'

describe('wrapFetch', () => {
  it('injects x-session-id when sessionId is provided', async () => {
    let captured: Headers | undefined
    const stub: FetchLike = async (_input, init) => {
      captured = new Headers(init?.headers)
      return new Response('ok')
    }

    const fetch = wrapFetch({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-xyz',
      fetch: stub,
    })
    await fetch('http://127.0.0.1:8403/ping')

    expect(captured!.get(SESSION_HEADER)).toBe('sess-xyz')
  })

  it('injects x-openclaw-session-key when provided', async () => {
    let captured: Headers | undefined
    const stub: FetchLike = async (_input, init) => {
      captured = new Headers(init?.headers)
      return new Response('ok')
    }

    const fetch = wrapFetch({
      routerUrl: 'http://127.0.0.1:8403',
      openclawSessionKey: 'ocw-1',
      fetch: stub,
    })
    await fetch('http://127.0.0.1:8403/ping')

    expect(captured!.get(OPENCLAW_SESSION_HEADER)).toBe('ocw-1')
  })

  it('leaves caller-provided headers intact', async () => {
    let captured: Headers | undefined
    const stub: FetchLike = async (_input, init) => {
      captured = new Headers(init?.headers)
      return new Response('ok')
    }

    const fetch = wrapFetch({
      routerUrl: 'http://127.0.0.1:8403',
      sessionId: 'sess-default',
      fetch: stub,
    })
    await fetch('http://127.0.0.1:8403/ping', {
      headers: { [SESSION_HEADER]: 'sess-override', 'x-foo': 'bar' },
    })

    expect(captured!.get(SESSION_HEADER)).toBe('sess-override')
    expect(captured!.get('x-foo')).toBe('bar')
  })

  it('applies custom `headers` option on every call', async () => {
    let captured: Headers | undefined
    const stub: FetchLike = async (_input, init) => {
      captured = new Headers(init?.headers)
      return new Response('ok')
    }

    const fetch = wrapFetch({
      routerUrl: 'http://127.0.0.1:8403',
      headers: { 'x-tenant': 'duraclaw' },
      fetch: stub,
    })
    await fetch('http://127.0.0.1:8403/ping')

    expect(captured!.get('x-tenant')).toBe('duraclaw')
  })

  it('throws a helpful error when no fetch is available', () => {
    const originalFetch = (globalThis as { fetch?: unknown }).fetch
    try {
      ;(globalThis as { fetch?: unknown }).fetch = undefined
      expect(() => wrapFetch({ routerUrl: 'http://127.0.0.1:8403' })).toThrow(/no global `fetch`/)
    } finally {
      ;(globalThis as { fetch?: unknown }).fetch = originalFetch
    }
  })
})
