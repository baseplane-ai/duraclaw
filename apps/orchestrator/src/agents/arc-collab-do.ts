import type { Connection } from 'partyserver'
import { YServer } from 'y-partyserver'
import * as Y from 'yjs'

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
}
