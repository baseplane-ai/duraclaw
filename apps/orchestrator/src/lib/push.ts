import { buildPushHTTPRequest } from '@pushforge/builder'

export interface PushPayload {
  title: string
  body: string
  url: string
  tag: string
  sessionId: string
  actionToken?: string
  actions?: Array<{ action: string; title: string }>
}

interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

interface PushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

function base64urlDecode(str: string): Uint8Array {
  const padding = '='.repeat((4 - (str.length % 4)) % 4)
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function vapidKeysToJwk(publicKeyB64: string, privateKeyB64: string): JsonWebKey {
  const pubBytes = base64urlDecode(publicKeyB64)
  const x = base64urlEncode(pubBytes.slice(1, 33))
  const y = base64urlEncode(pubBytes.slice(33, 65))
  return { kty: 'EC', crv: 'P-256', x, y, d: privateKeyB64 }
}

export async function sendPushNotification(
  subscription: PushSubscription,
  payload: PushPayload,
  vapid: VapidConfig,
): Promise<{ ok: boolean; status?: number; gone?: boolean }> {
  try {
    const jwk = vapidKeysToJwk(vapid.publicKey, vapid.privateKey)
    const request = await buildPushHTTPRequest({
      privateJWK: jwk,
      subscription: {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      message: {
        payload: JSON.parse(JSON.stringify(payload)),
        adminContact: vapid.subject,
        options: { ttl: 86400, urgency: 'high', topic: payload.tag },
      },
    })

    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })

    if (response.status === 410) {
      return { ok: false, status: 410, gone: true }
    }

    return { ok: response.ok, status: response.status }
  } catch (err) {
    console.error('[push] Failed to send notification:', err)
    return { ok: false }
  }
}
