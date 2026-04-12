const encoder = new TextEncoder()

function base64urlEncode(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(str: string): Uint8Array {
  const padding = '='.repeat((4 - (str.length % 4)) % 4)
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

export async function generateActionToken(
  sid: string,
  gid: string,
  secret: string,
): Promise<string> {
  const payload = JSON.stringify({ sid, gid, exp: Math.floor(Date.now() / 1000) + 300 })
  const payloadB64 = base64urlEncode(encoder.encode(payload))

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64))
  const sigB64 = base64urlEncode(signature)

  return `${payloadB64}.${sigB64}`
}

export async function validateActionToken(
  token: string,
  secret: string,
): Promise<{ ok: true; sid: string; gid: string } | { ok: false; error: string }> {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) {
      return { ok: false, error: 'Invalid token' }
    }

    const [payloadB64, sigB64] = parts

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(sigB64),
      encoder.encode(payloadB64),
    )

    if (!valid) {
      return { ok: false, error: 'Invalid token' }
    }

    const payloadStr = new TextDecoder().decode(base64urlDecode(payloadB64))
    const { sid, gid, exp } = JSON.parse(payloadStr) as { sid: string; gid: string; exp: number }

    if (exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'Token expired' }
    }

    return { ok: true, sid, gid }
  } catch {
    return { ok: false, error: 'Invalid token' }
  }
}
