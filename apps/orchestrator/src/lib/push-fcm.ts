import { importPKCS8, SignJWT } from 'jose'
import type { PushPayload } from './push'

interface FcmServiceAccount {
  project_id: string
  client_email: string
  private_key: string // PEM
  token_uri: string
}

interface CachedToken {
  token: string
  expiresAt: number
}

let cached: CachedToken | null = null

/**
 * Get a Google OAuth2 access token for FCM. Cached for 50 minutes
 * (Google issues 1h tokens). Single in-flight request — re-uses the
 * cached token across all FCM sends in a fan-out batch.
 */
async function getAccessToken(sa: FcmServiceAccount): Promise<string> {
  const now = Date.now()
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const pk = await importPKCS8(sa.private_key, 'RS256')
  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(sa.token_uri)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(pk)

  const resp = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!resp.ok) throw new Error(`FCM token exchange failed: ${resp.status}`)
  const data = (await resp.json()) as { access_token: string; expires_in: number }
  cached = {
    token: data.access_token,
    expiresAt: now + 50 * 60 * 1000, // hard-cap 50 min
  }
  return data.access_token
}

export async function sendFcmNotification(
  token: string,
  payload: PushPayload,
  serviceAccountJson: string,
): Promise<{ ok: boolean; status?: number; gone?: boolean }> {
  try {
    const sa = JSON.parse(serviceAccountJson) as FcmServiceAccount
    const accessToken = await getAccessToken(sa)
    const resp = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: {
              url: payload.url,
              tag: payload.tag,
              sessionId: payload.sessionId,
              ...(payload.actionToken ? { actionToken: payload.actionToken } : {}),
            },
            android: { priority: 'HIGH', notification: { tag: payload.tag } },
          },
        }),
      },
    )
    if (resp.status === 404 || resp.status === 410) {
      return { ok: false, status: resp.status, gone: true }
    }
    return { ok: resp.ok, status: resp.status }
  } catch (err) {
    console.error('[fcm] send failed:', err)
    return { ok: false }
  }
}

/** Test-only: clear the cached token so unit tests start clean. */
export function _resetTokenCacheForTests() {
  cached = null
}
