import type { Env } from '~/lib/types'

/**
 * Fire-and-forget cache invalidation broadcast.
 *
 * IMPORTANT: this function NEVER throws and NEVER returns a rejected promise.
 * Mutation endpoints await it purely for ordering; a notify failure must
 * never cause the caller to return 5xx after a successful D1 commit.
 *
 * In p2 the UserSettingsDO is still the old Agents-SDK class that returns
 * 404 for /notify — the try/catch + non-2xx warn path silently swallows
 * those. p3 swaps the DO body to a partyserver implementation that
 * actually broadcasts the payload to every connected socket.
 */
export async function notifyInvalidation(
  env: Env,
  userId: string,
  collection: 'agent_sessions' | 'user_tabs' | 'user_preferences',
  keys?: string[],
): Promise<void> {
  try {
    const id = env.USER_SETTINGS.idFromName(userId)
    const payload = JSON.stringify({ type: 'invalidate', collection, keys })
    const res = await env.USER_SETTINGS.get(id).fetch('https://do/notify', {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      console.warn(`[notify] non-2xx status=${res.status} collection=${collection} user=${userId}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[notify] threw error="${message}" collection=${collection} user=${userId}`)
  }
}
