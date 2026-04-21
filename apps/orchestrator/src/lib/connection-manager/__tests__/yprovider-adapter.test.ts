/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createYProviderAdapter } from '../adapters/yprovider-adapter'

type ObservableHandler = (...args: unknown[]) => void

function makeMockYProvider() {
  const handlers = new Map<string, Set<ObservableHandler>>()
  const awarenessHandlers = new Map<string, Set<ObservableHandler>>()
  const provider = {
    wsconnected: false,
    wsconnecting: false,
    on: vi.fn((event: string, handler: ObservableHandler) => {
      let set = handlers.get(event)
      if (!set) {
        set = new Set()
        handlers.set(event, set)
      }
      set.add(handler)
    }),
    off: vi.fn((event: string, handler: ObservableHandler) => {
      handlers.get(event)?.delete(handler)
    }),
    disconnect: vi.fn(),
    connect: vi.fn(),
    awareness: {
      on: vi.fn((event: string, handler: ObservableHandler) => {
        let set = awarenessHandlers.get(event)
        if (!set) {
          set = new Set()
          awarenessHandlers.set(event, set)
        }
        set.add(handler)
      }),
      off: vi.fn((event: string, handler: ObservableHandler) => {
        awarenessHandlers.get(event)?.delete(handler)
      }),
    },
  }
  const fire = (event: string, ...args: unknown[]) => {
    for (const h of handlers.get(event) ?? []) h(...args)
  }
  const fireAwareness = (event: string, ...args: unknown[]) => {
    for (const h of awarenessHandlers.get(event) ?? []) h(...args)
  }
  return { provider, fire, fireAwareness }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createYProviderAdapter', () => {
  it('readyState reflects wsconnected / wsconnecting', () => {
    const { provider } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'collab:s1')
    provider.wsconnected = false
    provider.wsconnecting = false
    expect(adapter.readyState).toBe(WebSocket.CLOSED)
    provider.wsconnecting = true
    expect(adapter.readyState).toBe(WebSocket.CONNECTING)
    provider.wsconnecting = false
    provider.wsconnected = true
    expect(adapter.readyState).toBe(WebSocket.OPEN)
  })

  it('id + kind are set', () => {
    const { provider } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'collab:s1')
    expect(adapter.id).toBe('collab:s1')
    expect(adapter.kind).toBe('yprovider')
  })

  it('.reconnect() calls provider.disconnect() then provider.connect() in that order', () => {
    const { provider } = makeMockYProvider()
    const callOrder: string[] = []
    provider.disconnect.mockImplementation(() => {
      callOrder.push('disconnect')
    })
    provider.connect.mockImplementation(() => {
      callOrder.push('connect')
    })
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    adapter.reconnect()
    expect(callOrder).toEqual(['disconnect', 'connect'])
  })

  it('.close() calls provider.disconnect()', () => {
    const { provider } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    adapter.close()
    expect(provider.disconnect).toHaveBeenCalledTimes(1)
    expect(provider.connect).not.toHaveBeenCalled()
  })

  it('addEventListener("open") fires on status=connected, not on other statuses', () => {
    const { provider, fire } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const fn = vi.fn()
    adapter.addEventListener('open', fn)
    fire('status', { status: 'connecting' })
    expect(fn).not.toHaveBeenCalled()
    fire('status', { status: 'disconnected' })
    expect(fn).not.toHaveBeenCalled()
    fire('status', { status: 'connected' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('addEventListener("close") fires on status=disconnected', () => {
    const { provider, fire } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const fn = vi.fn()
    adapter.addEventListener('close', fn)
    fire('status', { status: 'connected' })
    expect(fn).not.toHaveBeenCalled()
    fire('status', { status: 'disconnected' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('addEventListener("error") is a no-op and symmetric removeEventListener', () => {
    const { provider } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const fn = vi.fn()
    // Should not throw and should not install anything on provider.
    const priorOn = provider.on.mock.calls.length
    adapter.addEventListener('error', fn)
    expect(provider.on.mock.calls.length).toBe(priorOn)
    adapter.removeEventListener('error', fn)
  })

  it('addEventListener("message") hooks sync events', () => {
    const { provider, fire } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const fn = vi.fn()
    adapter.addEventListener('message', fn)
    fire('sync', true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('removeEventListener unhooks translated subscription', () => {
    const { provider, fire } = makeMockYProvider()
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const fn = vi.fn()
    adapter.addEventListener('open', fn)
    adapter.removeEventListener('open', fn)
    fire('status', { status: 'connected' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('bumps lastSeenTs on sync', () => {
    const { provider, fire } = makeMockYProvider()
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const start = adapter.lastSeenTs
    vi.setSystemTime(new Date('2026-04-21T00:00:05Z'))
    fire('sync', true)
    expect(adapter.lastSeenTs).toBeGreaterThan(start)
  })

  it('bumps lastSeenTs on awareness update', () => {
    const { provider, fireAwareness } = makeMockYProvider()
    vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    const adapter = createYProviderAdapter(provider as any, 'id')
    const start = adapter.lastSeenTs
    vi.setSystemTime(new Date('2026-04-21T00:00:10Z'))
    fireAwareness('update', { added: [1], updated: [], removed: [] })
    expect(adapter.lastSeenTs).toBeGreaterThan(start)
  })
})
