import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock workbox-precaching before importing sw
vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),
}))

// Capture addEventListener calls
const handlers: Record<string, Function> = {}
const mockShowNotification = vi.fn(() => Promise.resolve())
const mockOpenWindow = vi.fn(() => Promise.resolve(null))

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
        body: 'Your session is waiting',
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
    function makeClickEvent(notificationData: unknown) {
      const promises: Promise<unknown>[] = []
      return {
        notification: {
          close: vi.fn(),
          data: notificationData,
        },
        waitUntil: vi.fn((p: Promise<unknown>) => promises.push(p)),
        _promises: promises,
      }
    }

    it('closes notification and opens the url from notification data', () => {
      const event = makeClickEvent({ url: '/session/456' })

      handlers.notificationclick(event)

      expect(event.notification.close).toHaveBeenCalled()
      expect(event.waitUntil).toHaveBeenCalledTimes(1)
      expect(mockOpenWindow).toHaveBeenCalledWith('/session/456')
    })

    it('opens root url when notification data has no url', () => {
      const event = makeClickEvent({})

      handlers.notificationclick(event)

      expect(mockOpenWindow).toHaveBeenCalledWith('/')
    })

    it('opens root url when notification data is null', () => {
      const event = makeClickEvent(null)

      handlers.notificationclick(event)

      expect(mockOpenWindow).toHaveBeenCalledWith('/')
    })
  })
})
