import { drizzle } from 'drizzle-orm/d1'
import type { Connection } from 'partyserver'
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'
import * as schema from '~/db/schema'
import { checkArcAccess } from '~/lib/arc-acl'
import type { Env } from '~/lib/types'
import {
  type ArcCollabDOContext,
  addChatImpl,
  type ChatCursor,
  deleteChatImpl,
  editChatImpl,
  listChatForArc,
} from './arc-collab-do/rpc-chat'
import { listReactionsForArc, toggleReactionImpl } from './arc-collab-do/rpc-reactions'

/**
 * Per-arc collaborative DO. One instance per arc ID. (GH#152 P1.3 B11.)
 *
 * Hybrid storage substrate:
 *   - Extends `YServer` (y-partyserver) so the DO speaks the Yjs sync +
 *     awareness wire protocol on its WS surface — same shape as
 *     `SessionCollabDOv2`. Y.Doc snapshot persisted as a single BLOB in
 *     the `y_state` table; `onSave` is debounced so rapid edits coalesce
 *     into one write, with a hard cap to bound staleness.
 *   - Owns custom SQLite tables for per-arc team chat (`chat_messages`
 *     at v8). Future DO migrations may add reactions and other
 *     arc-scoped collab surfaces; the Y.Doc layer is reserved for the
 *     P1.6 awareness work.
 *
 * No HTTP routes here yet — WU-C adds chat insert/list/edit/delete
 * impls and the broadcast fanout. The DO base class still handles WS
 * upgrades for the y-partyserver protocol; that's free.
 */
export class ArcCollabDO extends YServer {
  static options = { hibernate: true }

  // onSave debounce: wait 2s after last edit, max 10s, 5s timeout.
  static callbackOptions = {
    debounceWait: 2000,
    debounceMaxWait: 10000,
    timeout: 5000,
  }

  private ensureTables() {
    // Y.Doc snapshot table — same shape as SessionCollabDOv2.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS y_state (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    // Per-arc team chat. `mentions` is a JSON-encoded string[] of
    // resolved user ids; null/empty until P1.5 wires the resolver.
    // `created_at` / `modified_at` are epoch ms (DO convention); the
    // D1 mirror (migration 0037) stores ISO 8601 to match D1 norms.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        arc_id TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        body TEXT NOT NULL,
        mentions TEXT,
        created_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER,
        deleted_by TEXT
      )
    `)

    // Timeline read index: latest-N-by-created.
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at)',
    )

    // Cursor-replay key for warm reconnects — mirrors the SessionDO
    // `assistant_messages.modified_at` cursor in messages-collection.ts.
    // Tail subscribers replay rows whose `modified_at` strictly exceeds
    // the cached tail; `id` is the tiebreaker for same-ms rows.
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_modified_at ON chat_messages(modified_at, id)',
    )

    // GH#152 P1.3 WU-C: idempotency table for chat write retries
    // (`addChatImpl` keyed on `clientChatId`, 60s TTL). Same shape /
    // semantics as the SessionDO `submit_ids` table.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS submit_ids (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `)

    // GH#152 P1.4 B12: per-arc reactions on comments + chat. Composite
    // PK enforces "one user one emoji per target" — toggling re-presses
    // the same key. No D1 mirror; the DO row is the source of truth
    // (reactions are high-frequency and ephemeral).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        target_kind TEXT NOT NULL CHECK(target_kind IN ('comment', 'chat')),
        target_id   TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        emoji       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (target_kind, target_id, user_id, emoji)
      )
    `)

    // Per-target rollup query — `SELECT … WHERE target_kind=? AND target_id=?`.
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_kind, target_id)',
    )
  }

  /** Build the live-reference context for the rpc-chat module. */
  private chatContext(): ArcCollabDOContext {
    return {
      do: { name: this.name },
      ctx: this.ctx,
      env: this.env as unknown as Env,
      sql: this.ctx.storage.sql,
    }
  }

  async onLoad() {
    // DDL in onLoad (not onStart) — guarantees the tables exist before
    // the first read regardless of y-partyserver's internal lifecycle
    // ordering. CREATE … IF NOT EXISTS is idempotent and cheap on
    // subsequent calls.
    this.ensureTables()
    const rows = this.ctx.storage.sql
      .exec("SELECT data FROM y_state WHERE id = 'snapshot' LIMIT 1")
      .toArray()
    if (rows.length > 0) {
      const data = rows[0].data as ArrayBuffer | Uint8Array
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      Y.applyUpdate(this.document, bytes)
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
   * Flush pending Y.Doc state to SQLite when the last client disconnects.
   *
   * Same rationale as `SessionCollabDOv2.onClose`: with `hibernate: true`,
   * a DO with zero active WebSockets is eligible for hibernation, which
   * evicts the in-memory Y.Doc *and* the pending debounce timer — losing
   * any unsaved edits. Flush synchronously on the last departing
   * connection before hibernation can occur. The base debounced save is
   * kept; this is purely additive for the "zero connections after close"
   * case.
   */
  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean) {
    try {
      await super.onClose(connection, code, reason, wasClean)
    } finally {
      // `getConnections()` filters by `readyState === OPEN`. By the time
      // `onClose` fires, the closing socket is in CLOSING/CLOSED, so
      // it's naturally excluded — the count reflects the post-close
      // active set.
      const active = Array.from(this.getConnections()).length
      if (active === 0) {
        try {
          await this.onSave()
        } catch (err) {
          console.error('[arc-collab-do] flush on last close failed:', err)
        }
      }
    }
  }

  /**
   * GH#152 P1.3 WU-C: HTTP routes for per-arc team chat.
   *
   * Mirrors `apps/orchestrator/src/agents/session-do/http-routes.ts`'s
   * `handleCommentsRoute` shape. Routes:
   *   - `POST   /chat`         → addChatImpl
   *   - `PATCH  /chat/:cid`    → editChatImpl
   *   - `DELETE /chat/:cid`    → deleteChatImpl
   *   - `GET    /chat?...`     → listChatForArc (sinceCursor as JSON in query)
   *
   * Auth: `x-user-id` + `x-user-role` headers stamped by the API forwarder.
   * Arc id is `this.name` (DO-name == arc-id by convention). 401 if no
   * userId, 403 if `checkArcAccess` rejects.
   *
   * Body limit: 64 KB on POST/PATCH (matches the comments route).
   *
   * Anything that doesn't match a chat route falls through to
   * `super.onRequest(request)` so y-partyserver still owns its WS
   * upgrades and any other framework routes.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/chat' || path.startsWith('/chat/')) {
      try {
        return await this.handleChatRoute(request, url)
      } catch (err) {
        console.error(`[ArcCollabDO:${this.ctx.id}] chat route unhandled:`, err)
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500)
      }
    }

    if (path === '/reactions' || path.startsWith('/reactions/')) {
      try {
        return await this.handleReactionsRoute(request, url)
      } catch (err) {
        console.error(`[ArcCollabDO:${this.ctx.id}] reactions route unhandled:`, err)
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500)
      }
    }

    return super.onRequest(request)
  }

  private async resolveAuth(
    request: Request,
  ): Promise<
    | { ok: true; userId: string; callerRole: 'owner' | 'member' | 'admin' | null }
    | { ok: false; status: number; error: string }
  > {
    const userId = request.headers.get('x-user-id')
    const role = request.headers.get('x-user-role') ?? 'user'
    if (!userId) return { ok: false, status: 401, error: 'unauthenticated' }

    const arcId = this.name
    const env = this.env as unknown as Env
    const db = drizzle(env.AUTH_DB, { schema })
    const verdict = await checkArcAccess(env, db, arcId, { userId, role })
    if (!verdict.allowed) return { ok: false, status: 403, error: 'forbidden' }
    // Admin override: surfaces as `callerRole='admin'` (not 'owner') so
    // deleteChatImpl can distinguish the moderation lane.
    const callerRole: 'owner' | 'member' | 'admin' | null =
      role === 'admin' ? 'admin' : verdict.role
    return { ok: true, userId, callerRole }
  }

  private async handleChatRoute(request: Request, url: URL): Promise<Response> {
    const ctx = this.chatContext()

    // POST /chat — create
    if (request.method === 'POST' && url.pathname === '/chat') {
      const cl = request.headers.get('content-length')
      if (cl !== null) {
        const bytes = Number(cl)
        if (Number.isFinite(bytes) && bytes > 64 * 1024) {
          return jsonResponse({ error: 'payload_too_large' }, 413)
        }
      }
      const auth = await this.resolveAuth(request)
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status)

      let raw: unknown
      try {
        raw = await request.json()
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400)
      }
      const body = raw as { body?: unknown; clientChatId?: unknown }
      if (typeof body.body !== 'string') {
        return jsonResponse({ error: 'body_required' }, 422)
      }
      if (typeof body.clientChatId !== 'string' || body.clientChatId.length === 0) {
        return jsonResponse({ error: 'clientChatId required' }, 422)
      }
      const result = await addChatImpl(ctx, {
        body: body.body,
        clientChatId: body.clientChatId,
        senderId: auth.userId,
      })
      if (!result.ok) return jsonResponse({ error: result.error }, result.status)
      return jsonResponse({ chat: result.chat }, result.status)
    }

    // PATCH /chat/:cid — edit
    if (request.method === 'PATCH' && url.pathname.startsWith('/chat/')) {
      const cl = request.headers.get('content-length')
      if (cl !== null) {
        const bytes = Number(cl)
        if (Number.isFinite(bytes) && bytes > 64 * 1024) {
          return jsonResponse({ error: 'payload_too_large' }, 413)
        }
      }
      const chatId = decodeURIComponent(url.pathname.slice('/chat/'.length))
      if (!chatId) return jsonResponse({ error: 'chatId required' }, 400)
      const auth = await this.resolveAuth(request)
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status)

      let raw: unknown
      try {
        raw = await request.json()
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400)
      }
      const body = raw as { body?: unknown }
      if (typeof body.body !== 'string') {
        return jsonResponse({ error: 'body_required' }, 422)
      }
      const result = await editChatImpl(ctx, {
        chatId,
        body: body.body,
        senderId: auth.userId,
      })
      if (!result.ok) return jsonResponse({ error: result.error }, result.status)
      return jsonResponse({ chat: result.chat }, result.status)
    }

    // DELETE /chat/:cid — soft delete
    if (request.method === 'DELETE' && url.pathname.startsWith('/chat/')) {
      const chatId = decodeURIComponent(url.pathname.slice('/chat/'.length))
      if (!chatId) return jsonResponse({ error: 'chatId required' }, 400)
      const auth = await this.resolveAuth(request)
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status)

      const result = await deleteChatImpl(ctx, {
        chatId,
        senderId: auth.userId,
        callerRole: auth.callerRole,
      })
      if (!result.ok) return jsonResponse({ error: result.error }, result.status)
      return jsonResponse({ chat: result.chat }, result.status)
    }

    // GET /chat?sinceCursor=<json> — cold-load / warm-reconnect
    if (request.method === 'GET' && url.pathname === '/chat') {
      const auth = await this.resolveAuth(request)
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status)

      const cursorRaw = url.searchParams.get('sinceCursor')
      let sinceCursor: ChatCursor | null = null
      if (cursorRaw) {
        try {
          const parsed = JSON.parse(cursorRaw) as unknown
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof (parsed as ChatCursor).modifiedAt === 'number' &&
            typeof (parsed as ChatCursor).id === 'string'
          ) {
            sinceCursor = {
              modifiedAt: (parsed as ChatCursor).modifiedAt,
              id: (parsed as ChatCursor).id,
            }
          } else {
            return jsonResponse({ error: 'invalid_cursor' }, 400)
          }
        } catch {
          return jsonResponse({ error: 'invalid_cursor' }, 400)
        }
      }

      const result = listChatForArc(ctx, { sinceCursor })
      return jsonResponse(result, 200)
    }

    return jsonResponse({ error: 'method_not_allowed' }, 405)
  }

  /**
   * GH#152 P1.4 B12: HTTP routes for per-arc reactions on comments + chat.
   *
   * Routes:
   *   - `POST /reactions/toggle`  → toggleReactionImpl
   *   - `GET  /reactions`         → listReactionsForArc
   *
   * Auth: same `resolveAuth` flow as chat. Body cap is 8 KB —
   * reactions payloads are tiny (`{targetKind, targetId, emoji}`).
   */
  private async handleReactionsRoute(request: Request, url: URL): Promise<Response> {
    const ctx = this.chatContext()

    // POST /reactions/toggle — add / remove a reaction (idempotent toggle).
    if (request.method === 'POST' && url.pathname === '/reactions/toggle') {
      const cl = request.headers.get('content-length')
      if (cl !== null) {
        const bytes = Number(cl)
        if (Number.isFinite(bytes) && bytes > 8 * 1024) {
          return jsonResponse({ error: 'payload_too_large' }, 413)
        }
      }
      const auth = await this.resolveAuth(request)
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status)

      let raw: unknown
      try {
        raw = await request.json()
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400)
      }
      const body = raw as { targetKind?: unknown; targetId?: unknown; emoji?: unknown }
      if (typeof body.targetKind !== 'string') {
        return jsonResponse({ error: 'invalid_target_kind' }, 422)
      }
      if (typeof body.targetId !== 'string') {
        return jsonResponse({ error: 'invalid_target_id' }, 422)
      }
      if (typeof body.emoji !== 'string') {
        return jsonResponse({ error: 'invalid_emoji' }, 422)
      }
      const result = await toggleReactionImpl(ctx, {
        targetKind: body.targetKind,
        targetId: body.targetId,
        emoji: body.emoji,
        userId: auth.userId,
      })
      if (!result.ok) return jsonResponse({ error: result.error }, result.status)
      return jsonResponse({ row: result.row, action: result.action }, result.status)
    }

    // GET /reactions — cold-load. Cursor is reserved for future use.
    if (request.method === 'GET' && url.pathname === '/reactions') {
      const auth = await this.resolveAuth(request)
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status)

      const result = listReactionsForArc(ctx, {})
      return jsonResponse(result, 200)
    }

    return jsonResponse({ error: 'method_not_allowed' }, 405)
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}
