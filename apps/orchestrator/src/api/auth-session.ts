import { createAuth } from '~/lib/auth'
import type { Env } from '~/lib/types'

export interface RequestSession {
  userId: string
  /** GH#152 P1: surfaced from Better Auth so WS-upgrade handlers can
   *  attach the email alongside the userId for the DO `onConnect`
   *  handshake (B2). May be `null` for legacy rows missing the field. */
  userEmail: string | null
  role: string
  session: unknown
  user: unknown
}

export async function getRequestSession(
  env: Env,
  request: Request,
): Promise<RequestSession | null> {
  const auth = createAuth(env) as any
  const result = await auth.api.getSession({
    headers: request.headers,
  })

  const userId = result?.user?.id ?? result?.session?.userId ?? null
  if (!userId) {
    return null
  }

  return {
    userId,
    userEmail: result?.user?.email ?? null,
    role: result?.user?.role ?? 'user',
    session: result.session ?? null,
    user: result.user ?? null,
  }
}
