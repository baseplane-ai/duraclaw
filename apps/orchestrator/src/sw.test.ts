import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock workbox-precaching before importing sw
vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),
}))

// Capture addEventListener calls
const handlers: Record<string, Function> = {}
const mockShowNotification = vi.fn(() => Promise.resolve())
const mockOpenWindow = vi.fn(() => Promise.resolve(null))
const mockMatchAll = vi.fn(() => Promise.resolve([] as unknown[]))

// Mock BroadcastChannel in the SW context
const mockBcPostMessage = vi.fn()
const mockBcClose = vi.fn()
globalThis.BroadcastChannel = class {
  postMessage = mockBcPostMessage
  close = mockBcClose
} as unknown as typeof BroadcastChannel

// Set up ServiceWorkerGlobalScope mock
const swSelf = {
  __WB_MANIFEST: [],
  addEventListener: vi.fn((event: string, handler: Function) => {
    handlers[event] = handler
  }),
  registration: {
    showNotification: mockShowNotification,
  },
  clients: {
    openWindow: mockOpenWindow,
    matchAll: mockMatchAll,
  },
}

// Assign to globalThis so the SW module sees it as `self`
Object.assign(globalThis, { self: swSelf })

describe('service worker handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Re-import to capture fresh handlers
    vi.resetModules()
    Object.assign(globalThis, { self: swSelf })
    swSelf.addEventListener.mockClear()
    handlers.push = undefined as unknown as Function
    handlers.notificationclick = undefined as unknown as Function
    await import('./sw')
  })

  it('registers push and notificationclick handlers', () => {
    expect(handlers.push).toBeDefined()
    expect(handlers.notificationclick).toBeDefined()
  })

  it('calls precacheAndRoute on import', async () => {
    const { precacheAndRoute } = await import('workbox-precaching')
    expect(precacheAndRoute).toHaveBeenCalledWith([])
  })

  describe('push handler', () => {
    function makePushEvent(data: unknown) {
      const promises: Promise<unknown>[] = []
      return {
        data: data ? { json: () => data } : null,
        waitUntil: vi.fn((p: Promise<unknown>) => promises.push(p)),
        _promises: promises,
      }
    }

    it('shows notification with correct options when push data is present', () => {
      const pushData = {
        title: 'Session Ready',
        body: 'Your session is waiting',
        tag: 'session-123',
        url: '/session/123',
        sessionId: 'sess-abc',
        actionToken: 'tok-xyz',
        actions: [{ action: 'open', title: 'Open' }],
      }
      const event = makePushEvent(pushData)

      handlers.push(event)

      expect(event.waitUntil).toHaveBeenCalledTimes(1)
      expect(mockShowNotification).toHaveBeenCalledWith('Session Ready', {
        // URL is appended to the body as a debugging aid so the tap target
        // is visible on the notification shade itself.
        body: 'Your session is waiting\n/session/123',
        icon: '/icons/icon-192.png',
        tag: 'session-123',
        data: {
          url: '/session/123',
          sessionId: 'sess-abc',
          actionToken: 'tok-xyz',
        },
        actions: [{ action: 'open', title: 'Open' }],
      })
    })

    it('does not append a trailing newline when payload has no url', () => {
      const pushData = {
        title: 'T',
        body: 'Body',
        tag: 'tag',
        sessionId: 's',
        actionToken: 'a',
      }
      const event = makePushEvent(pushData)

      handlers.push(event)

      expect(mockShowNotification).toHaveBeenCalledWith(
        'T',
        expect.objectContaining({ body: 'Body' }),
      )
    })

    it('defaults actions to empty array when not provided', () => {
      const pushData = {
        title: 'Test',
        body: 'Body',
        tag: 'tag-1',
        url: '/',
        sessionId: 's1',
        actionToken: 'a1',
      }
      const event = makePushEvent(pushData)

      handlers.push(event)

      expect(mockShowNotification).toHaveBeenCalledWith(
        'Test',
        expect.objectContaining({ actions: [] }),
      )
    })

    it('does nothing when push data is null', () => {
      const event = makePushEvent(null)

      handlers.push(event)

      expect(event.waitUntil).not.toHaveBeenCalled()
      expect(mockShowNotification).not.toHaveBeenCalled()
    })
  })

  describe('notificationclick handler', () => {
    function makeClickEvent(notificationData: unknown, action?: string) {
      const promises: Promise<unknown>[] = []
      return {
        action,
        notification: {
          close: vi.fn(),
          data: notificationData,
        },
        waitUntil: vi.fn((p: Promise<unknown>) => promises.push(p)),
        _promises: promises,
      }
    }

    async function flushWaitUntil(event: { _promises: Promise<unknown>[] }) {
      await Promise.all(event._promises)
    }

    it('opens a new window via openWindow when no existing client is present (cold start)', async () => {
      mockMatchAll.mockResolvedValueOnce([])
      const event = makeClickEvent({ url: '/?session=456' })

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      expect(event.notification.close).toHaveBeenCalled()
      expect(event.waitUntil).toHaveBeenCalledTimes(1)
      expect(mockMatchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
      expect(mockOpenWindow).toHaveBeenCalledWith('/?session=456')
    })

    it('broadcasts on BroadcastChannel AND postMessages existing client (warm PWA)', async () => {
      const existing = {
        postMessage: vi.fn(),
        focus: vi.fn(() => Promise.resolve()),
      }
      mockMatchAll.mockResolvedValueOnce([existing])
      const event = makeClickEvent({ url: '/?session=456' })

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      // Primary: BroadcastChannel
      expect(mockBcPostMessage).toHaveBeenCalledWith({
        type: 'SW_NAVIGATE',
        url: '/?session=456',
      })
      expect(mockBcClose).toHaveBeenCalled()

      // Fallback: client.postMessage
      expect(existing.postMessage).toHaveBeenCalledWith({
        type: 'SW_NAVIGATE',
        url: '/?session=456',
      })
      expect(existing.focus).toHaveBeenCalled()
      expect(mockOpenWindow).not.toHaveBeenCalled()
    })

    it('does not call WindowClient.navigate (works around Android Chrome quirk)', async () => {
      const existing = {
        postMessage: vi.fn(),
        focus: vi.fn(() => Promise.resolve()),
        navigate: vi.fn(() => Promise.resolve(null)),
      }
      mockMatchAll.mockResolvedValueOnce([existing])
      const event = makeClickEvent({ url: '/?session=456' })

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      expect(existing.navigate).not.toHaveBeenCalled()
    })

    it('falls through to next client when focus() rejects on a stale client', async () => {
      const stale = {
        postMessage: vi.fn(),
        focus: vi.fn(() => Promise.reject(new Error('stale'))),
      }
      const live = {
        postMessage: vi.fn(),
        focus: vi.fn(() => Promise.resolve()),
      }
      mockMatchAll.mockResolvedValueOnce([stale, live])
      const event = makeClickEvent({ url: '/?session=456' })

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      expect(live.postMessage).toHaveBeenCalledWith({
        type: 'SW_NAVIGATE',
        url: '/?session=456',
      })
      expect(live.focus).toHaveBeenCalled()
      expect(mockOpenWindow).not.toHaveBeenCalled()
    })

    it('opens root url when notification data has no url', async () => {
      mockMatchAll.mockResolvedValueOnce([])
      const event = makeClickEvent({})

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      expect(mockOpenWindow).toHaveBeenCalledWith('/')
    })

    it('opens root url when notification data is null', async () => {
      mockMatchAll.mockResolvedValueOnce([])
      const event = makeClickEvent(null)

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      expect(mockOpenWindow).toHaveBeenCalledWith('/')
    })

    it('new-session action broadcasts "/" to existing client', async () => {
      const existing = {
        postMessage: vi.fn(),
        focus: vi.fn(() => Promise.resolve()),
      }
      mockMatchAll.mockResolvedValueOnce([existing])
      const event = makeClickEvent({ url: '/?session=ignored' }, 'new-session')

      handlers.notificationclick(event)
      await flushWaitUntil(event)

      expect(mockBcPostMessage).toHaveBeenCalledWith({ type: 'SW_NAVIGATE', url: '/' })
      expect(existing.focus).toHaveBeenCalled()
      expect(mockOpenWindow).not.toHaveBeenCalled()
    })
  })
})
