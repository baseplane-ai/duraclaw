import type { Connection } from 'partyserver'
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'

/**
 * Per-session collaborative draft DO. One instance per session ID.
 *
 * Extends y-partyserver's YServer base class — handles WS sync protocol,
 * awareness, and onLoad/onSave lifecycle hooks. We persist the Y.Doc state
 * as a single BLOB snapshot in SQLite; onSave is debounced so rapid edits
 * coalesce into one write, with a hard cap to bound staleness.
 */
export class SessionCollabDOv2 extends YServer {
  static options = { hibernate: true }

  // onSave debounce: wait 2s after last edit, max 10s, 5s timeout.
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
    // DDL in onLoad (not onStart) — guarantees the table exists before the
    // first read regardless of y-partyserver's internal lifecycle ordering.
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
   * Flush pending Y.Doc state to SQLite when the last client disconnects.
   *
   * y-partyserver schedules `onSave` via `setTimeout`-debounce on each Y.Doc
   * update. With `hibernate: true`, a DO with zero active WebSockets is
   * eligible for hibernation, which evicts the in-memory Y.Doc *and* the
   * pending debounce timer — losing any unsaved typing. Override
   * `onClose` so the last departing connection flushes synchronously
   * before the DO can hibernate. The base debounced save is kept; this
   * is purely additive for the "zero connections after close" case.
   */
  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean) {
    try {
      await super.onClose(connection, code, reason, wasClean)
    } finally {
      // `getConnections()` filters by `readyState === OPEN`. By the time
      // `onClose` fires, the closing socket is in CLOSING/CLOSED, so it's
      // naturally excluded — the count reflects the post-close active set.
      const active = Array.from(this.getConnections()).length
      if (active === 0) {
        try {
          await this.onSave()
        } catch (err) {
          console.error('[session-collab-do] flush on last close failed:', err)
        }
      }
    }
  }
}
