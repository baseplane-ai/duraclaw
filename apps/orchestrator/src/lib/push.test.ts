import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type PushPayload, sendPushNotification } from './push'

// Mock @pushforge/builder
vi.mock('@pushforge/builder', () => ({
  buildPushHTTPRequest: vi.fn(),
}))

// Import the mocked module
import { buildPushHTTPRequest } from '@pushforge/builder'

const mockBuildPush = vi.mocked(buildPushHTTPRequest)

// Test fixtures

// Generate a fake 65-byte uncompressed P-256 public key (0x04 || 32 bytes x || 32 bytes y)
// encoded as base64url
const fakePublicKeyBytes = new Uint8Array(65)
fakePublicKeyBytes[0] = 0x04
for (let i = 1; i < 65; i++) fakePublicKeyBytes[i] = i

function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const FAKE_VAPID = {
  publicKey: toBase64url(fakePublicKeyBytes),
  privateKey: 'fakePrivateKeyD_base64url',
  subject: 'mailto:push@example.com',
}

const FAKE_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  p256dh: 'fakep256dh',
  auth: 'fakeauth',
}

const FAKE_PAYLOAD: PushPayload = {
  title: 'Test Project',
  body: 'Session completed',
  url: '/sessions/sess-1',
  tag: 'session-sess-1',
  sessionId: 'sess-1',
}

describe('sendPushNotification', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Re-mock after restoreAllMocks
    mockBuildPush.mockReset()
    globalThis.fetch = vi.fn()
  })

  it('returns ok:true on successful push (201)', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 201 }))

    const result = await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    expect(result).toEqual({ ok: true, status: 201 })
    expect(mockBuildPush).toHaveBeenCalledOnce()

    // Verify the JWK was constructed correctly from VAPID keys
    const callArgs = mockBuildPush.mock.calls[0][0]
    const jwk = callArgs.privateJWK as JsonWebKey
    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
    expect(jwk.d).toBe(FAKE_VAPID.privateKey)
    // x and y should be base64url-encoded 32-byte slices of the public key
    expect(typeof jwk.x).toBe('string')
    expect(typeof jwk.y).toBe('string')
  })

  it('passes subscription keys and payload to buildPushHTTPRequest', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: {},
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 201 }))

    await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    const callArgs = mockBuildPush.mock.calls[0][0]
    expect(callArgs.subscription).toEqual({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      keys: { p256dh: FAKE_SUBSCRIPTION.p256dh, auth: FAKE_SUBSCRIPTION.auth },
    })
    expect(callArgs.message.adminContact).toBe(FAKE_VAPID.subject)
    expect(callArgs.message.options).toEqual({
      ttl: 86400,
      urgency: 'high',
      topic: FAKE_PAYLOAD.tag,
    })
    // Payload should be JSON-serializable copy
    expect(callArgs.message.payload).toEqual(JSON.parse(JSON.stringify(FAKE_PAYLOAD)))
  })

  it('returns gone:true on 410 response', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: {},
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 410 }))

    const result = await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    expect(result).toEqual({ ok: false, status: 410, gone: true })
  })

  it('returns ok:false with status on non-ok response', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: {},
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 429 }))

    const result = await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    expect(result).toEqual({ ok: false, status: 429 })
  })

  it('returns ok:false when buildPushHTTPRequest throws', async () => {
    mockBuildPush.mockRejectedValue(new Error('crypto failure'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    expect(result).toEqual({ ok: false })
    expect(consoleSpy).toHaveBeenCalledWith(
      '[push] Failed to send notification:',
      expect.any(Error),
    )
  })

  it('returns ok:false when fetch throws', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: {},
    })
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network error'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    expect(result).toEqual({ ok: false })
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('correctly converts VAPID keys to JWK with x/y from public key bytes', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: {},
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 201 }))

    await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    const jwk = mockBuildPush.mock.calls[0][0].privateJWK as JsonWebKey

    // Decode x and y back and verify they match the right slices of the public key
    function fromBase64url(str: string): Uint8Array {
      const padding = '='.repeat((4 - (str.length % 4)) % 4)
      const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/')
      const binary = atob(base64)
      return Uint8Array.from(binary, (c) => c.charCodeAt(0))
    }

    const xBytes = fromBase64url(jwk.x!)
    const yBytes = fromBase64url(jwk.y!)

    // x should be bytes 1..33, y should be bytes 33..65 of the original public key
    expect(xBytes.length).toBe(32)
    expect(yBytes.length).toBe(32)
    expect(Array.from(xBytes)).toEqual(Array.from(fakePublicKeyBytes.slice(1, 33)))
    expect(Array.from(yBytes)).toEqual(Array.from(fakePublicKeyBytes.slice(33, 65)))
  })

  it('sends fetch POST to the endpoint from buildPushHTTPRequest', async () => {
    const fakeBody = new ArrayBuffer(16)
    const fakeHeaders = { Authorization: 'vapid t=jwt, k=key', 'Content-Encoding': 'aes128gcm' }
    mockBuildPush.mockResolvedValue({
      endpoint: 'https://push.example.com/send/xyz',
      body: fakeBody,
      headers: fakeHeaders,
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 201 }))

    await sendPushNotification(FAKE_SUBSCRIPTION, FAKE_PAYLOAD, FAKE_VAPID)

    expect(globalThis.fetch).toHaveBeenCalledWith('https://push.example.com/send/xyz', {
      method: 'POST',
      headers: fakeHeaders,
      body: fakeBody,
    })
  })

  it('handles payload with actions array', async () => {
    mockBuildPush.mockResolvedValue({
      endpoint: FAKE_SUBSCRIPTION.endpoint,
      body: new ArrayBuffer(0),
      headers: {},
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 201 }))

    const payloadWithActions: PushPayload = {
      ...FAKE_PAYLOAD,
      actions: [
        { action: 'approve', title: 'Allow' },
        { action: 'deny', title: 'Deny' },
      ],
    }

    const result = await sendPushNotification(FAKE_SUBSCRIPTION, payloadWithActions, FAKE_VAPID)

    expect(result.ok).toBe(true)
    const sentPayload = mockBuildPush.mock.calls[0][0].message.payload as Record<string, unknown>
    expect(sentPayload.actions).toEqual([
      { action: 'approve', title: 'Allow' },
      { action: 'deny', title: 'Deny' },
    ])
  })
})
