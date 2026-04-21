/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPartySocketAdapter } from '../adapters/partysocket-adapter'

type Listener = (ev: Event | MessageEvent) => void

function makeMockPartySocket() {
  const listeners = new Map<string, Set<Listener>>()
  const ps = {
    readyState: 0,
    addEventListener: vi.fn((event: string, fn: Listener) => {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(fn)
    }),
    removeEventListener: vi.fn((event: string, fn: Listener) => {
      listeners.get(event)?.delete(fn)
    }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }
  const fire = (event: string, payload?: Event | MessageEvent) => {
    for (const fn of listeners.get(event) ?? []) {
      fn(payload ?? new Event(event))
    }
  }
  return { ps, fire }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createPartySocketAdapter', () => {
  it('readyState reflects underlying ps.readyState live', () => {
    const { ps } = makeMockPartySocket()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'user-stream')
    ps.readyState = 0
    expect(adapter.readyState).toBe(0)
    ps.readyState = 1
    expect(adapter.readyState).toBe(1)
    ps.readyState = 3
    expect(adapter.readyState).toBe(3)
  })

  it('exposes id and kind', () => {
    const { ps } = makeMockPartySocket()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'agent:foo')
    expect(adapter.id).toBe('agent:foo')
    expect(adapter.kind).toBe('partysocket')
  })

  it('.reconnect() forwards to ps.reconnect() with code+reason', () => {
    const { ps } = makeMockPartySocket()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'id')
    adapter.reconnect(4000, 'cm-foreground')
    expect(ps.reconnect).toHaveBeenCalledTimes(1)
    expect(ps.reconnect).toHaveBeenCalledWith(4000, 'cm-foreground')
  })

  it('.close() forwards to ps.close()', () => {
    const { ps } = makeMockPartySocket()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'id')
    adapter.close()
    expect(ps.close).toHaveBeenCalledTimes(1)
  })

  it('bumps lastSeenTs on message events', () => {
    const { ps, fire } = makeMockPartySocket()
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'id')
    const start = adapter.lastSeenTs
    vi.setSystemTime(new Date('2026-04-21T00:01:00Z'))
    fire('message', new MessageEvent('message', { data: 'hi' }))
    expect(adapter.lastSeenTs).toBeGreaterThan(start)
    expect(Math.abs(adapter.lastSeenTs - Date.now())).toBeLessThan(10)
  })

  it('bumps lastSeenTs on open events', () => {
    const { ps, fire } = makeMockPartySocket()
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'id')
    const start = adapter.lastSeenTs
    vi.setSystemTime(new Date('2026-04-21T00:00:05Z'))
    fire('open')
    expect(adapter.lastSeenTs).toBeGreaterThan(start)
    expect(Math.abs(adapter.lastSeenTs - Date.now())).toBeLessThan(10)
  })

  it('addEventListener / removeEventListener pass through to ps', () => {
    const { ps, fire } = makeMockPartySocket()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createPartySocketAdapter(ps as any, 'id')
    const fn = vi.fn()
    adapter.addEventListener('message', fn)
    fire('message', new MessageEvent('message', { data: 'payload' }))
    expect(fn).toHaveBeenCalledTimes(1)
    adapter.removeEventListener('message', fn)
    fire('message', new MessageEvent('message', { data: 'payload2' }))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
