import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushPayload } from './push'
import { _resetTokenCacheForTests, sendFcmNotification } from './push-fcm'

vi.mock('jose', () => {
  function FakeSignJWT(this: unknown) {
    const chain = {
      setProtectedHeader: () => chain,
      setIssuer: () => chain,
      setSubject: () => chain,
      setAudience: () => chain,
      setIssuedAt: () => chain,
      setExpirationTime: () => chain,
      sign: () => Promise.resolve('signed.jwt.token'),
    }
    return chain
  }
  return {
    importPKCS8: vi.fn().mockResolvedValue({ type: 'fake-key' }),
    SignJWT: FakeSignJWT,
  }
})

const FAKE_SA = JSON.stringify({
  project_id: 'duraclaw-test',
  client_email: 'fcm@test.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQ==\n-----END PRIVATE KEY-----',
  token_uri: 'https://oauth2.googleapis.com/token',
})

const FAKE_PAYLOAD: PushPayload = {
  title: 'Test',
  body: 'Body',
  url: '/sessions/x',
  tag: 'session-x',
  sessionId: 'x',
}

describe('sendFcmNotification', () => {
  beforeEach(() => {
    _resetTokenCacheForTests()
    globalThis.fetch = vi.fn()
  })

  it('exchanges JWT for access token then POSTs to FCM', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'oauth-tok-1', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'projects/x/messages/y' }), { status: 200 }),
      )

    const result = await sendFcmNotification('fcm-token-abc', FAKE_PAYLOAD, FAKE_SA)

    expect(result).toEqual({ ok: true, status: 200 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    // Token exchange
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
    // FCM send
    expect(vi.mocked(globalThis.fetch).mock.calls[1][0]).toBe(
      'https://fcm.googleapis.com/v1/projects/duraclaw-test/messages:send',
    )
    const sendInit = vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit
    expect((sendInit.headers as Record<string, string>).Authorization).toBe('Bearer oauth-tok-1')
    const sendBody = JSON.parse(sendInit.body as string)
    expect(sendBody.message.token).toBe('fcm-token-abc')
    expect(sendBody.message.notification).toEqual({ title: 'Test', body: 'Body' })
    expect(sendBody.message.data.url).toBe('/sessions/x')
    expect(sendBody.message.android.priority).toBe('HIGH')
  })

  it('reuses cached access token across calls', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'oauth-tok-2', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    await sendFcmNotification('tok-a', FAKE_PAYLOAD, FAKE_SA)
    await sendFcmNotification('tok-b', FAKE_PAYLOAD, FAKE_SA)

    // Token endpoint hit only once; FCM endpoint hit twice
    const tokenCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter((c) => c[0] === 'https://oauth2.googleapis.com/token')
    expect(tokenCalls).toHaveLength(1)
  })

  it('returns gone:true on 404', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    const result = await sendFcmNotification('token', FAKE_PAYLOAD, FAKE_SA)
    expect(result).toEqual({ ok: false, status: 404, gone: true })
  })

  it('returns gone:true on 410', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 410 }))

    const result = await sendFcmNotification('token', FAKE_PAYLOAD, FAKE_SA)
    expect(result).toEqual({ ok: false, status: 410, gone: true })
  })

  it('returns ok:false on 5xx', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))

    const result = await sendFcmNotification('token', FAKE_PAYLOAD, FAKE_SA)
    expect(result).toEqual({ ok: false, status: 503 })
  })

  it('returns ok:false when service account JSON is malformed', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await sendFcmNotification('token', FAKE_PAYLOAD, '{not json')
    expect(result).toEqual({ ok: false })
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('returns ok:false when token exchange fails', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 401 }))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await sendFcmNotification('token', FAKE_PAYLOAD, FAKE_SA)
    expect(result).toEqual({ ok: false })
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('includes actionToken in data when present', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    await sendFcmNotification('token', { ...FAKE_PAYLOAD, actionToken: 'act-123' }, FAKE_SA)
    const sendInit = vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit
    const sendBody = JSON.parse(sendInit.body as string)
    expect(sendBody.message.data.actionToken).toBe('act-123')
  })
})
