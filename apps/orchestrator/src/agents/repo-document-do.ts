/**
 * RepoDocumentDO — per-repo-file collaborative Y.Doc with soft-delete tombstones.
 *
 * One instance per repo file (idFromName(`${projectId}:${relPath}`)). Extends
 * y-partyserver's YServer so it speaks the Yjs sync + awareness protocol over
 * WS, with onLoad/onSave persisting the encoded Y.Doc snapshot as a single
 * BLOB row in SQLite. Two write paths share the document:
 *
 *  - browser peers connect with the user's session cookie (B3 cookie path);
 *  - the docs-runner connects with a `?role=docs-runner&token=...` bearer
 *    matched against `DOCS_RUNNER_SECRET` (B3 bearer path).
 *
 * Soft-delete (B10): the runner can POST `/tombstone` with a grace period;
 * the DO records `tombstoneAt` in storage, schedules a DO alarm, and
 * broadcasts a `tombstone-pending` frame so connected peers can render the
 * file with strikethrough. New connects during the grace window are
 * refused with WS close code 4412 (`document_deleted`). The runner can
 * `/cancel-tombstone` before the alarm fires; once it does fire, `alarm()`
 * hard-deletes the y_state row and force-closes any remaining peers.
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Connection, ConnectionContext } from 'partyserver'
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'
import { getRequestSession } from '~/api/auth-session'
import { projectMetadata } from '~/db/schema'
import type { Env } from '~/lib/types'

export class RepoDocumentDO extends YServer {
  static options = { hibernate: true }

  // onSave debounce: wait 2s after last edit, max 10s, 5s timeout. Mirrors
  // SessionCollabDOv2 — same trade-off between coalescing rapid edits and
  // bounding how stale the on-disk snapshot can get.
  static callbackOptions = {
    debounceWait: 2000,
    debounceMaxWait: 10000,
    timeout: 5000,
  }

  /**
   * B12 lazy-spawn debounce timer. Browser connects schedule a 2-second
   * grace window so a flurry of tab opens collapses to a single
   * `POST /docs-runners/start` instead of N. Stored on `this` only —
   * with `hibernate: true`, in-memory timers are evicted along with the
   * DO; that's fine because the timer's only role is debounce, not
   * durable scheduling. A new connect after rehydration just re-arms it.
   * Held as a plain timer handle (not a promise) to keep the DO
   * hibernation-safe.
   */
  private lazySpawnTimer: ReturnType<typeof setTimeout> | null = null

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
    // DDL in onLoad (not onStart) — the table must exist before the first
    // read regardless of y-partyserver's internal lifecycle ordering.
    // CREATE TABLE IF NOT EXISTS is idempotent and cheap on subsequent calls.
    this.ensureTable()
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
   * Dual-auth gate (B3). The same DO accepts both browser peers (cookie)
   * and the docs-runner (bearer). We branch on the `role` query param so
   * the bearer path never has to round-trip through Better Auth, and the
   * cookie path never sees the runner secret.
   *
   * Tombstone gate (B10): if `tombstoneAt` is set, every new connect is
   * refused with 4412 regardless of role — the alarm path closes existing
   * peers, but a peer racing the alarm could still slip in here.
   */
  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url)
    const env = this.env as Env

    const tombstoneAt = (await this.ctx.storage.get<number>('tombstoneAt')) ?? null
    if (tombstoneAt !== null) {
      connection.close(4412, 'document_deleted')
      return
    }

    const role = url.searchParams.get('role')
    if (role === 'docs-runner') {
      const token = url.searchParams.get('token') ?? ''
      const expected = env.DOCS_RUNNER_SECRET ?? ''
      if (!expected || !timingSafeEqual(token, expected)) {
        connection.close(4401, 'invalid_token')
        return
      }
      connection.setState({ kind: 'docs-runner' })
      return
    }

    // Browser path — cookie-authed via Better Auth.
    const session = await getRequestSession(env, ctx.request)
    if (!session) {
      connection.close(4401, 'invalid_token')
      return
    }
    connection.setState({ kind: 'browser', userId: session.userId })

    // B12: lazy-spawn the docs-runner on first browser connect. The 2s
    // debounce + once-per-DO timer guard collapses simultaneous tab
    // opens into one POST.
    await this.scheduleLazySpawn(url)
  }

  /**
   * B12: schedule a 2-second debounce after a browser connect, then
   * (if no docs-runner is already attached) POST the gateway's
   * `/docs-runners/start`. Read `projectId` from the connect URL or
   * fall back to a previously persisted value; persist when the URL
   * supplies a fresher one. Skips silently if neither source has it.
   *
   * The timer body is wrapped in `ctx.waitUntil` so the worker keeps
   * the DO alive long enough for the 2s wait + downstream fetch — a
   * hibernating DO would otherwise drop the timer.
   */
  private async scheduleLazySpawn(url: URL): Promise<void> {
    if (this.lazySpawnTimer !== null) return

    const fromUrl = url.searchParams.get('projectId')
    const stored = (await this.ctx.storage.get<string>('projectId')) ?? null
    const projectId = fromUrl ?? stored
    if (!projectId) {
      console.warn('[repo-document-do] lazy-spawn skipped: no projectId on URL or in storage')
      return
    }
    if (fromUrl && fromUrl !== stored) {
      await this.ctx.storage.put('projectId', fromUrl)
    }

    const settled = new Promise<void>((resolve) => {
      this.lazySpawnTimer = setTimeout(async () => {
        this.lazySpawnTimer = null
        try {
          await this.runLazySpawn(projectId)
        } catch (err) {
          console.error('[repo-document-do] lazy-spawn failed', err)
        } finally {
          resolve()
        }
      }, 2000)
    })

    this.ctx.waitUntil(settled)
  }

  /**
   * Inner body of the B12 lazy-spawn: runs after the 2s debounce.
   * Returns silently if a docs-runner is already attached, the project
   * is unconfigured (broadcasts `setup-required`), the rate-limit
   * window hasn't elapsed, or the gateway acks. On gateway 400
   * `docs_worktree_invalid` clears the stored path so the next connect
   * surfaces the setup gate instead of looping. On a fetch throw
   * broadcasts `spawn-failed`.
   */
  private async runLazySpawn(projectId: string): Promise<void> {
    const env = this.env as Env

    for (const conn of this.getConnections()) {
      const state = (conn as { state?: { kind?: string } }).state
      if (state?.kind === 'docs-runner') return
    }

    const db = drizzle(env.AUTH_DB)
    const rows = await db
      .select()
      .from(projectMetadata)
      .where(eq(projectMetadata.projectId, projectId))
      .limit(1)
    const row = rows[0]
    if (!row?.docsWorktreePath) {
      this.broadcast(JSON.stringify({ kind: 'setup-required', projectId }))
      return
    }

    const lastSpawnAttempt = (await this.ctx.storage.get<number>('lastSpawnAttempt')) ?? 0
    const now = Date.now()
    if (now - lastSpawnAttempt < 30_000) return
    await this.ctx.storage.put('lastSpawnAttempt', now)

    let res: Response
    try {
      res = await fetch(`${env.CC_GATEWAY_URL}/docs-runners/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CC_GATEWAY_SECRET}`,
        },
        body: JSON.stringify({
          projectId,
          docsWorktreePath: row.docsWorktreePath,
          bearer: env.DOCS_RUNNER_SECRET,
        }),
      })
    } catch {
      this.broadcast(JSON.stringify({ kind: 'spawn-failed', reason: 'gateway_unreachable' }))
      return
    }

    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (body.error === 'docs_worktree_invalid') {
        await db
          .update(projectMetadata)
          .set({ docsWorktreePath: null, updatedAt: new Date().toISOString() })
          .where(eq(projectMetadata.projectId, projectId))
        this.broadcast(JSON.stringify({ kind: 'setup-required', projectId }))
      }
    }
  }

  /**
   * HTTP control plane (B10). Runner-only: `/tombstone`,
   * `/cancel-tombstone`, `/tombstone-status`. Bearer-authed against
   * DOCS_RUNNER_SECRET — mirrors the WS bearer path so the runner has
   * one credential, not two.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const env = this.env as Env

    const auth = request.headers.get('Authorization') ?? ''
    const expected = env.DOCS_RUNNER_SECRET ?? ''
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!expected || !timingSafeEqual(provided, expected)) {
      return new Response('unauthorized', { status: 401 })
    }

    if (request.method === 'POST' && url.pathname.endsWith('/tombstone')) {
      const body = (await request.json().catch(() => ({}))) as {
        relPath?: string
        graceDays?: number
      }
      const graceDays = body.graceDays ?? 7
      const tombstoneAt = Date.now() + graceDays * 86_400_000
      await this.ctx.storage.put('tombstoneAt', tombstoneAt)
      if (body.relPath) await this.ctx.storage.put('relPath', body.relPath)
      await this.ctx.storage.setAlarm(tombstoneAt)
      // Broadcast tombstone-pending so connected peers can render strikethrough
      // immediately, without waiting for the alarm or a re-fetch.
      this.broadcast(JSON.stringify({ kind: 'tombstone-pending', tombstoneAt }))
      return Response.json({ tombstoneAt })
    }

    if (request.method === 'POST' && url.pathname.endsWith('/cancel-tombstone')) {
      const tombstoneAt = (await this.ctx.storage.get<number>('tombstoneAt')) ?? null
      if (tombstoneAt === null) return new Response('not found', { status: 404 })
      await this.ctx.storage.delete('tombstoneAt')
      await this.ctx.storage.deleteAlarm()
      this.broadcast(JSON.stringify({ kind: 'tombstone-cancelled' }))
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname.endsWith('/tombstone-status')) {
      const tombstoneAt = (await this.ctx.storage.get<number>('tombstoneAt')) ?? null
      return Response.json({ tombstoneAt })
    }

    return new Response('not found', { status: 404 })
  }

  /**
   * Alarm fire = end of grace window. Hard-delete the y_state row and
   * force-close every remaining peer with 4412. We deliberately keep
   * `tombstoneAt` set so any post-alarm reconnect is also refused
   * by `onConnect` rather than silently re-creating an empty document.
   */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM y_state WHERE id = 'snapshot'")
    for (const conn of this.getConnections()) {
      try {
        conn.close(4412, 'document_deleted')
      } catch {
        // Connection may already be closing; ignore.
      }
    }
  }

  /**
   * Flush pending Y.Doc state to SQLite when the last client disconnects.
   * Same rationale as SessionCollabDOv2: with `hibernate: true`, a DO
   * with zero active sockets is hibernation-eligible and the pending
   * onSave debounce timer can be evicted before it fires.
   */
  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean) {
    try {
      await super.onClose(connection, code, reason, wasClean)
    } finally {
      const active = Array.from(this.getConnections()).length
      if (active === 0) {
        // B12: no peers left — cancel any pending lazy-spawn debounce so
        // we don't fire a POST after the last browser walked away.
        if (this.lazySpawnTimer !== null) {
          clearTimeout(this.lazySpawnTimer)
          this.lazySpawnTimer = null
        }
        try {
          await this.onSave()
        } catch (err) {
          console.error('[repo-document-do] flush on last close failed:', err)
        }
      }
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}
