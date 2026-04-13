import { createAuth } from '~/lib/auth'
import type { Env } from '~/lib/types'

export interface RequestSession {
  userId: string
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
    role: result?.user?.role ?? 'user',
    session: result.session ?? null,
    user: result.user ?? null,
  }
}
