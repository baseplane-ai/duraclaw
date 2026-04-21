/**
 * UserSettingsDO — per-user live-state fanout.
 *
 * One DO instance per user (idFromName(userId)). Holds a Set<WebSocket> of
 * active browser connections and broadcasts delta frames received via
 * POST /broadcast to all of them. Uses the WebSocket Hibernation API so
 * the DO can be evicted and reloaded without losing socket references.
 *
 * Data authoritative-ness:
 * - User settings (tabs, preferences) live in D1 under AUTH_DB.
 * - Active user presence (0→1 / N→0 transitions) is mirrored into
 *   `user_presence` D1 table via reference-counting on the sockets set.
 * - The DO itself holds NO persistent state — `y_state` is dropped on
 *   first post-deploy load.
 */

import { DurableObject } from 'cloudflare:workers'
import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { getRequestSession } from '~/api/auth-session'
import * as schema from '~/db/schema'
import type { Env } from '~/lib/types'

const MAX_BROADCAST_BODY = 256 * 1024 // 256 KiB
const USER_ID_ATTACHMENT_KEY = 'userId'

export class UserSettingsDO extends DurableObject<Env> {
  private sockets = new Set<WebSocket>()
  private userId: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // WebSocket hibernation: rehydrate in-memory socket set from the
    // platform's authoritative store on every DO init.
    for (const ws of this.ctx.getWebSockets()) {
      this.sockets.add(ws)
      const attached = ws.deserializeAttachment() as { [USER_ID_ATTACHMENT_KEY]?: string } | null
      if (attached?.[USER_ID_ATTACHMENT_KEY]) this.userId = attached[USER_ID_ATTACHMENT_KEY]
    }

    // One-time cleanup: drop the dead y_state table from the prior Y.Doc era.
    this.ctx.storage.sql.exec('DROP TABLE IF EXISTS y_state')
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/broadcast') {
      return this.handleBroadcast(request)
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request)
    }

    return new Response('not found', { status: 404 })
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Auth: the caller must present a valid session cookie. The DO ID is
    // keyed by userId (via idFromName), so we also verify the requesting
    // user matches the DO's room.
    const session = await getRequestSession(this.env, request)
    if (!session?.userId) return new Response('unauthorized', { status: 401 })

    const url = new URL(request.url)
    const roomUserId = url.searchParams.get('userId') ?? session.userId
    if (session.userId !== roomUserId) return new Response('forbidden', { status: 403 })

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    // Reference-count: this is the 0→1 transition for this user's
    // presence if the sockets set was empty BEFORE accepting.
    const wasEmpty = this.sockets.size === 0

    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ [USER_ID_ATTACHMENT_KEY]: session.userId })
    this.sockets.add(server)
    this.userId = session.userId

    if (wasEmpty) {
      try {
        const db = drizzle(this.env.AUTH_DB, { schema })
        await db
          .insert(schema.userPresence)
          .values({ userId: session.userId, firstConnectedAt: new Date().toISOString() })
          .onConflictDoNothing()
      } catch (err) {
        console.error('[user-settings-do] user_presence INSERT failed', err)
      }
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })

    const auth = request.headers.get('Authorization')
    const expected = `Bearer ${this.env.SYNC_BROADCAST_SECRET ?? ''}`
    if (!auth || auth !== expected) return new Response('unauthorized', { status: 401 })

    const contentLength = Number(request.headers.get('Content-Length') ?? 0)
    if (contentLength > MAX_BROADCAST_BODY)
      return new Response('payload too large', { status: 413 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('invalid json', { status: 400 })
    }

    if (!isSyncedCollectionFrame(body)) return new Response('invalid frame shape', { status: 400 })

    const payload = JSON.stringify(body)
    if (payload.length > MAX_BROADCAST_BODY)
      return new Response('payload too large', { status: 413 })

    for (const ws of [...this.sockets]) {
      try {
        ws.send(payload)
      } catch (err) {
        console.warn('[user-settings-do] socket send failed, removing', err)
        this.sockets.delete(ws)
      }
    }

    return new Response(null, { status: 204 })
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    try {
      console.log(
        `[user-settings-do] WS closed: code=${code} reason=${reason} wasClean=${wasClean} userId=${this.userId ?? '?'}`,
      )
      this.sockets.delete(ws)
      await this.maybeClearPresence()
    } catch (err) {
      this.logError('webSocketClose', err, { code, reason })
      throw err
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    try {
      this.logError('webSocketError.received', error, { userId: this.userId ?? '?' })
      this.sockets.delete(ws)
      await this.maybeClearPresence()
    } catch (err) {
      this.logError('webSocketError', err)
      throw err
    }
  }

  private logError(site: string, err: unknown, extra?: Record<string, unknown>): void {
    const prefix = `[user-settings-do] ERROR@${site}`
    const extraStr = extra
      ? ' ' +
        Object.entries(extra)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : ''
    if (err instanceof Error) {
      console.error(`${prefix}${extraStr} ${err.name}: ${err.message}`, err.stack ?? err)
    } else {
      console.error(`${prefix}${extraStr}`, err)
    }
  }

  private async maybeClearPresence() {
    if (this.sockets.size !== 0) return
    if (!this.userId) return
    try {
      const db = drizzle(this.env.AUTH_DB, { schema })
      await db.delete(schema.userPresence).where(eq(schema.userPresence.userId, this.userId))
    } catch (err) {
      console.error('[user-settings-do] user_presence DELETE failed', err)
    }
  }
}

function isSyncedCollectionFrame(body: unknown): body is SyncedCollectionFrame {
  if (typeof body !== 'object' || body === null) return false
  const b = body as { type?: unknown; collection?: unknown; ops?: unknown }
  if (b.type !== 'synced-collection-delta') return false
  if (typeof b.collection !== 'string') return false
  if (!Array.isArray(b.ops)) return false
  for (const op of b.ops) {
    if (typeof op !== 'object' || op === null) return false
    const o = op as { type?: unknown; value?: unknown; key?: unknown }
    if (o.type === 'insert' || o.type === 'update') {
      if (typeof o.value !== 'object' || o.value === null) return false
    } else if (o.type === 'delete') {
      if (typeof o.key !== 'string') return false
    } else return false
  }
  return true
}
