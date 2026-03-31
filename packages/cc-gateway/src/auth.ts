import { timingSafeEqual } from 'node:crypto'

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify auth token from a Bun Request.
 * Checks Authorization header (Bearer) and query param `token`.
 * If no CC_GATEWAY_API_TOKEN is configured, all requests pass through.
 */
export function verifyToken(req: Request): boolean {
  const token = process.env.CC_GATEWAY_API_TOKEN
  if (!token) return true // no token configured = open

  // Check Authorization header
  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) {
    return timingSafeCompare(auth.slice(7), token)
  }

  // Check query param for WS upgrade
  const url = new URL(req.url)
  const qToken = url.searchParams.get('token')
  if (qToken) {
    return timingSafeCompare(qToken, token)
  }

  return false
}
