import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authMiddleware } from './auth-middleware'
import { getRequestSession } from './auth-session'

vi.mock('./auth-session', () => ({
  getRequestSession: vi.fn(),
}))

describe('authMiddleware', () => {
  const mockedGetRequestSession = vi.mocked(getRequestSession)

  beforeEach(() => {
    mockedGetRequestSession.mockReset()
  })

  it('returns 401 when there is no authenticated session', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('/api/*', authMiddleware)
    app.get('/api/protected', (c) => c.json({ ok: true }))

    const response = await app.request('http://example.com/api/protected')

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('attaches userId for authenticated requests', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-123',
      session: { id: 'session-1' },
      user: { id: 'user-123' },
    })

    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('/api/*', authMiddleware)
    app.get('/api/protected', (c) => c.json({ userId: c.get('userId') }))

    const response = await app.request('http://example.com/api/protected')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ userId: 'user-123' })
  })

  it('bypasses auth for /api/gateway/projects/sync (Bearer-authed push)', async () => {
    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('/api/*', authMiddleware)
    app.post('/api/gateway/projects/sync', (c) => c.json({ ok: true }))

    const response = await app.request('http://example.com/api/gateway/projects/sync', {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(mockedGetRequestSession).not.toHaveBeenCalled()
  })

  it('still enforces session auth for browser-facing /api/gateway/projects', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('/api/*', authMiddleware)
    app.get('/api/gateway/projects', (c) => c.json({ ok: true }))

    const response = await app.request('http://example.com/api/gateway/projects')

    expect(response.status).toBe(401)
  })
})
