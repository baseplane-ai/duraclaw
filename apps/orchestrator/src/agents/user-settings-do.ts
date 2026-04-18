// UserSettingsDO — PartyServer fanout for cache-invalidation broadcasts.
//
// Issue #7 p3: this DO no longer holds tabs / drafts / preferences. All
// authoritative state moved to D1 in p2. The DO's only job now is to
// receive `POST /notify` calls from the Worker (after a D1 commit) and
// fan the JSON payload out to every browser socket open for this user.
//
// Auth: the room name (URL path userId) MUST equal the cookie's userId.
// onConnect closes 4401 unauthenticated / 4403 forbidden otherwise.
// No this.storage / this.state / this.ctx.storage.sql access — the class
// is stateless and we ship a wrangler `delete_sqlite` migration in p3 to
// free the per-DO SQLite from the prior Agent-based implementation.

import { type Connection, type ConnectionContext, Server } from 'partyserver'
import { getRequestSession } from '~/api/auth-session'
import type { Env } from '~/lib/types'

// Back-compat type re-export — the legacy `useUserSettings` hook
// (`src/hooks/use-user-settings.tsx`) still references this type. The hook
// is being deleted in #7 p4; until then this empty shape keeps typecheck
// green without re-introducing any state into the DO.
export interface UserSettingsState {
  tabs: Array<{ id: string; project: string; sessionId: string; title: string; draft?: string }>
  activeTabId: string | null
  drafts: Record<string, string>
}

export class UserSettingsDO extends Server<Env> {
  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const session = await getRequestSession(this.env, ctx.request)
    if (!session) {
      conn.close(4401, 'unauthenticated')
      return
    }
    // The room name is the URL path userId (set by partyserver from
    // /parties/user-settings/:userId). Reject if it doesn't match the
    // authenticated session's userId so a logged-in user can't snoop on
    // someone else's invalidation stream by guessing a userId.
    const roomUserId = this.name
    if (roomUserId && roomUserId !== session.userId) {
      conn.close(4403, 'forbidden')
      return
    }
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/notify' && req.method === 'POST') {
      const body = await req.text()
      for (const conn of this.getConnections()) {
        try {
          conn.send(body)
        } catch {
          // Dropped sockets — partyserver will reap on next webSocketClose.
        }
      }
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }

  async onClose(_conn: Connection) {
    // partyserver removes from getConnections() automatically.
  }
}
