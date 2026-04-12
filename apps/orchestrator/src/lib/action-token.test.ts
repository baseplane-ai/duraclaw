import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateActionToken, validateActionToken } from './action-token'

const TEST_SECRET = 'test-hmac-secret-key'

describe('generateActionToken', () => {
  it('returns a string with two dot-separated parts', async () => {
    const token = await generateActionToken('sess-1', 'gate-1', TEST_SECRET)
    const parts = token.split('.')
    expect(parts).toHaveLength(2)
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1].length).toBeGreaterThan(0)
  })

  it('encodes sid, gid, and exp in the payload', async () => {
    const token = await generateActionToken('sess-1', 'gate-1', TEST_SECRET)
    const [payloadB64] = token.split('.')

    // Decode the payload
    const padding = '='.repeat((4 - (payloadB64.length % 4)) % 4)
    const base64 = (payloadB64 + padding).replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64)
    const payload = JSON.parse(json)

    expect(payload.sid).toBe('sess-1')
    expect(payload.gid).toBe('gate-1')
    expect(typeof payload.exp).toBe('number')
    // exp should be ~5 minutes from now
    const now = Math.floor(Date.now() / 1000)
    expect(payload.exp).toBeGreaterThan(now + 290)
    expect(payload.exp).toBeLessThanOrEqual(now + 310)
  })

  it('produces different tokens for different inputs', async () => {
    const token1 = await generateActionToken('sess-1', 'gate-1', TEST_SECRET)
    const token2 = await generateActionToken('sess-2', 'gate-1', TEST_SECRET)
    expect(token1).not.toBe(token2)
  })

  it('produces different tokens for different secrets', async () => {
    const token1 = await generateActionToken('sess-1', 'gate-1', 'secret-a')
    const token2 = await generateActionToken('sess-1', 'gate-1', 'secret-b')
    // Payloads may differ due to timing, but signatures definitely differ
    const sig1 = token1.split('.')[1]
    const sig2 = token2.split('.')[1]
    expect(sig1).not.toBe(sig2)
  })
})

describe('validateActionToken', () => {
  it('validates a freshly generated token', async () => {
    const token = await generateActionToken('sess-1', 'gate-1', TEST_SECRET)
    const result = await validateActionToken(token, TEST_SECRET)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sid).toBe('sess-1')
      expect(result.gid).toBe('gate-1')
    }
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await generateActionToken('sess-1', 'gate-1', 'secret-a')
    const result = await validateActionToken(token, 'secret-b')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('rejects a token with tampered payload', async () => {
    const token = await generateActionToken('sess-1', 'gate-1', TEST_SECRET)
    const [, sig] = token.split('.')

    // Create a different payload
    const tamperedPayload = JSON.stringify({ sid: 'sess-hacked', gid: 'gate-1', exp: 9999999999 })
    const encoder = new TextEncoder()
    const bytes = encoder.encode(tamperedPayload)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    const tamperedB64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    const tamperedToken = `${tamperedB64}.${sig}`
    const result = await validateActionToken(tamperedToken, TEST_SECRET)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('rejects an expired token', async () => {
    // Mock Date.now to generate a token that is already expired
    const realDateNow = Date.now
    // Generate token with exp in the past
    vi.spyOn(Date, 'now').mockReturnValue((Math.floor(realDateNow() / 1000) - 600) * 1000)
    const token = await generateActionToken('sess-1', 'gate-1', TEST_SECRET)
    vi.restoreAllMocks()

    const result = await validateActionToken(token, TEST_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Token expired')
    }
  })

  it('rejects a malformed token with no dot separator', async () => {
    const result = await validateActionToken('no-dot-here', TEST_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('rejects a token with too many parts', async () => {
    const result = await validateActionToken('a.b.c', TEST_SECRET)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Invalid token')
    }
  })

  it('rejects an empty token', async () => {
    const result = await validateActionToken('', TEST_SECRET)
    expect(result.ok).toBe(false)
  })
})
