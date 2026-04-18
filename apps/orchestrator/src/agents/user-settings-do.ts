// UserSettingsDO — Yjs-backed per-user tab sync + invalidation fanout.
//
// Extends y-partyserver's YServer to hold a Y.Doc per user with:
//   - Y.Array<string> "openTabs"   — ordered session IDs
//   - Y.Map "workspace"            — { activeSessionId: string | null }
//
// Also keeps the POST /notify invalidation fanout for agent_sessions
// and user_preferences (those collections still live in D1).
//
// Auth: onConnect validates cookie userId === room name.
// Persistence: Y.Doc state snapshotted to DO SQLite (y_state table).

import type { Connection, ConnectionContext } from 'partyserver'
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'
import { getRequestSession } from '~/api/auth-session'
import type { Env } from '~/lib/types'

export class UserSettingsDO extends YServer {
  static options = { hibernate: true }

  static callbackOptions = {
    debounceWait: 2000,
    debounceMaxWait: 10000,
    timeout: 5000,
  }

  private ensureTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS y_state (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  async onLoad() {
    this.ensureTable()
    const rows = this.ctx.storage.sql
      .exec("SELECT data FROM y_state WHERE id = 'snapshot' LIMIT 1")
      .toArray()
    if (rows.length > 0) {
      const data = rows[0].data as ArrayBuffer | Uint8Array
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      Y.applyUpdate(this.document, bytes)
    }

    // One-time migration: seed from D1 user_tabs if Y.Doc is empty.
    const openTabs = this.document.getArray<string>('openTabs')
    if (openTabs.length === 0) {
      await this.seedFromD1()
    }
  }

  async onSave() {
    const update = Y.encodeStateAsUpdate(this.document)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO y_state (id, data, updated_at)
       VALUES ('snapshot', ?, ?)`,
      update,
      Date.now(),
    )
  }

  /**
   * One-time migration: read the user's D1 tabs and populate the Y.Doc.
   * Runs only when openTabs is empty (first connect after upgrade).
   */
  private async seedFromD1() {
    try {
      const env = this.env as unknown as Env
      const userId = this.name
      if (!userId || !env.AUTH_DB) return

      const result = await env.AUTH_DB.prepare(
        'SELECT session_id FROM user_tabs WHERE user_id = ? ORDER BY position ASC',
      )
        .bind(userId)
        .all()

      if (result.results && result.results.length > 0) {
        const openTabs = this.document.getArray<string>('openTabs')
        const workspace = this.document.getMap('workspace')
        this.document.transact(() => {
          for (const row of result.results) {
            const sessionId = row.session_id as string
            if (sessionId) openTabs.push([sessionId])
          }
          const firstSessionId = result.results[0]?.session_id as string | undefined
          if (firstSessionId) {
            workspace.set('activeSessionId', firstSessionId)
          }
        })
      }
    } catch (err) {
      // Migration is best-effort — empty tabs is better than a crash.
      console.warn('[UserSettingsDO] D1 tab seed failed:', err)
    }
  }

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const session = await getRequestSession(this.env as unknown as Env, ctx.request)
    if (!session) {
      conn.close(4401, 'unauthenticated')
      return
    }
    const roomUserId = this.name
    if (roomUserId && roomUserId !== session.userId) {
      conn.close(4403, 'forbidden')
      return
    }
    // Let YServer handle Yjs sync protocol setup.
    await super.onConnect(conn, ctx)
  }

  // Keep /notify for invalidation broadcasts (agent_sessions, user_preferences).
  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/notify' && req.method === 'POST') {
      const body = await req.text()
      for (const conn of this.getConnections()) {
        try {
          conn.send(body)
        } catch {
          // Dropped sockets — partyserver reaps on next webSocketClose.
        }
      }
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }
}
