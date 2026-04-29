/**
 * hydration.ts — DO cold-start rehydrate body extracted from
 * `SessionDO.onStart()` (spec #101 Stage 6).
 *
 * Owns the post-`Session.create()` work: meta restore from `session_meta`,
 * GH#65 oversized-row retrofit, modified_at column ensure, persisted
 * turn-state load, max-ordinal recovery scan, and gateway-conn-id cache
 * populate. All side effects route through the supplied `SessionDOContext`.
 *
 * The facade `onStart()` call sequence after this stage looks like:
 *
 *   runMigrations(...)
 *   this.session = Session.create(this)
 *   this.moduleCtx = { ... }
 *   await runHydration(this.moduleCtx)
 *   gcEventLog(this.moduleCtx)
 *   scheduleWatchdog(this.moduleCtx)  (fires lazily — see runAlarm)
 */

import type { SessionMessagePart } from 'agents/experimental/memory/session'
import { MAX_PARTS_JSON_BYTES, offloadOversizedImages } from '~/lib/message-parts'
import { getGatewayConnectionIdFromSql } from './runner-link'
import {
  type DEFAULT_META,
  META_COLUMN_MAP,
  parseTurnOrdinal,
  type SessionDOContext,
} from './types'

/** Minimal tagged-template SQL interface used by free helpers in this module. */
type SqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[]

/**
 * Load turnCounter, assistantTurnCounter, and currentTurnMessageId from
 * assistant_config. Must be called AFTER Session table initialization
 * (e.g. getPathLength()) to ensure the assistant_config table exists.
 *
 * `assistantTurnCounter` is split from `turnCounter` so assistant-side
 * mid-stream rows (`msg-N` / `err-N`) advance independently from user-side
 * rows (`usr-N`); see SessionDO.assistantTurnCounter for the full
 * rationale. On legacy DOs that pre-date the split, the persisted
 * `turnCounter` doubled as the assistant ordinal — so we seed
 * `assistantTurnCounter` from the persisted `turnCounter` when its own
 * row is absent. That keeps cold-start IDs monotonic with the pre-split
 * history.
 */
export function loadTurnState(
  sql: SqlFn,
  pathLength: number,
): {
  turnCounter: number
  assistantTurnCounter: number
  currentTurnMessageId: string | null
} {
  let turnCounter = 0
  let currentTurnMessageId: string | null = null

  const configRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'turnCounter'
  `
  if (configRows.length > 0) {
    turnCounter = Number.parseInt(configRows[0].value, 10) || 0
  } else {
    // First use or data loss — seed from path length to avoid ID collisions
    turnCounter = pathLength + 1
  }

  // Read the split assistant counter; fall back to the persisted user-side
  // counter so legacy DOs continue minting monotonically increasing
  // assistant ids on the first wake post-migration.
  let assistantTurnCounter = 0
  const assistantRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'assistantTurnCounter'
  `
  if (assistantRows.length > 0) {
    assistantTurnCounter = Number.parseInt(assistantRows[0].value, 10) || 0
  } else {
    assistantTurnCounter = turnCounter
  }

  const turnIdRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'currentTurnMessageId'
  `
  if (turnIdRows.length > 0 && turnIdRows[0].value !== '') {
    currentTurnMessageId = turnIdRows[0].value
  }

  return { turnCounter, assistantTurnCounter, currentTurnMessageId }
}

/**
 * Rehydrate `state` from `session_meta` on onStart (#31 P5). Agent's
 * initialState seed runs once on first wake; on subsequent rehydrates the
 * setState JSON blob is lost if the DO was evicted without a setState
 * call in the final turn — restoring from SQLite keeps `project`,
 * `status`, `session_id`, etc. intact for the next caller.
 */
function hydrateMetaFromSql(ctx: SessionDOContext): void {
  try {
    const rows = ctx.do.sql<Record<string, unknown>>`SELECT * FROM session_meta WHERE id = 1`
    const row = rows[0]
    if (!row) return
    const patch: Partial<typeof DEFAULT_META> = {}
    for (const [key, col] of Object.entries(META_COLUMN_MAP) as Array<
      [keyof typeof DEFAULT_META, string]
    >) {
      if (!(col in row)) continue
      const raw = row[col]
      if (raw === null || raw === undefined) continue
      if (key === 'lastRunEnded') {
        // INTEGER 0/1 → boolean. GH#73.
        ;(patch as Record<string, unknown>)[key] = raw === 1 || raw === '1' || raw === true
      } else if (key === 'capabilities') {
        // Spec #101 P1.2 B7: capabilities_json is stored as TEXT JSON.
        // Parse on hydrate so the in-memory shape matches AdapterCapabilities.
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            ;(patch as Record<string, unknown>)[key] = JSON.parse(raw)
          } catch (err) {
            console.warn(
              `[SessionDO:${ctx.ctx.id}] hydrateMetaFromSql: capabilities_json parse failed`,
              err,
            )
          }
        }
      } else {
        ;(patch as Record<string, unknown>)[key] = raw
      }
    }
    if (Object.keys(patch).length > 0) {
      ctx.do.setState({
        ...ctx.state,
        ...patch,
      })
    }
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] hydrateMetaFromSql failed:`, err)
  }
}

/**
 * Mark the GH#65 oversized-row retrofit as applied so the scan does not
 * rerun on subsequent wakes. Idempotent.
 */
function markRetrofitApplied(ctx: SessionDOContext): void {
  const ts = new Date().toISOString()
  try {
    ctx.do.sql`
      UPDATE session_meta
      SET oversized_retrofit_applied_at = ${ts}
      WHERE id = 1
    `
  } catch (err) {
    console.warn(`[SessionDO:${ctx.ctx.id}] markRetrofitApplied failed:`, err)
  }
}

/**
 * GH#65 retrofit: on cold start, rewrite any pre-existing oversized rows
 * in `assistant_messages` so the SDK's replay paths (getHistory / cursor
 * replay) can SELECT `content` without hitting `SQLITE_TOOBIG` (CF Workers
 * SQLite caps parameters at ~2 MB).
 *
 * Idempotent via the `session_meta.oversized_retrofit_applied_at`
 * once-flag (migration v15). `LENGTH(content)` is metadata-level and does
 * NOT materialise the BLOB, so the scan works on rows we cannot SELECT.
 */
async function retrofitOversizedRows(ctx: SessionDOContext): Promise<void> {
  // Honour the once-flag first.
  try {
    const metaRows = ctx.do.sql<{ oversized_retrofit_applied_at: string | null }>`
      SELECT oversized_retrofit_applied_at FROM session_meta WHERE id = 1
    `
    if (metaRows[0]?.oversized_retrofit_applied_at) return
  } catch (err) {
    console.warn(
      `[SessionDO:${ctx.ctx.id}] retrofitOversizedRows: flag lookup failed, running scan anyway:`,
      err,
    )
  }

  let oversized: Array<{ id: string; len: number }> = []
  try {
    oversized = ctx.do.sql<{ id: string; len: number }>`
      SELECT id, LENGTH(content) AS len
      FROM assistant_messages
      WHERE session_id = '' AND LENGTH(content) > ${MAX_PARTS_JSON_BYTES}
    `
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.toLowerCase().includes('no such table')) {
      console.warn(`[SessionDO:${ctx.ctx.id}] retrofitOversizedRows: scan failed:`, err)
    }
    markRetrofitApplied(ctx)
    return
  }

  if (oversized.length === 0) {
    markRetrofitApplied(ctx)
    return
  }

  console.info(
    `[SessionDO:${ctx.ctx.id}] retrofitOversizedRows: found ${oversized.length} oversized row(s)`,
  )

  for (const row of oversized) {
    const originalBytes = row.len
    let newParts: SessionMessagePart[]
    try {
      const contentRows = ctx.do.sql<{ content: string }>`
        SELECT content FROM assistant_messages
        WHERE id = ${row.id} AND session_id = '' LIMIT 1
      `
      if (contentRows.length === 0) continue
      const parts = JSON.parse(contentRows[0].content) as SessionMessagePart[]
      await offloadOversizedImages(parts, {
        sessionId: ctx.do.name,
        messageId: row.id,
        r2Bucket: ctx.env.SESSION_MEDIA,
      })
      newParts = parts
    } catch (err) {
      console.warn(
        `[SessionDO:${ctx.ctx.id}] retrofitOversizedRows: row ${row.id} unreadable (${originalBytes} bytes), replacing with stub:`,
        err,
      )
      newParts = [
        {
          type: 'text',
          text: '[content dropped by GH#65 retrofit — row exceeded SQLite 2 MB cap]',
        },
      ]
    }

    let newContent: string
    try {
      const contentRows = ctx.do.sql<{ content: string; role: string }>`
        SELECT content, role FROM assistant_messages
        WHERE id = ${row.id} AND session_id = '' LIMIT 1
      `
      if (contentRows.length > 0) {
        let base: Record<string, unknown>
        try {
          base = JSON.parse(contentRows[0].content) as Record<string, unknown>
        } catch {
          base = { id: row.id, role: contentRows[0].role }
        }
        base.parts = newParts
        newContent = JSON.stringify(base)
      } else {
        newContent = JSON.stringify({ id: row.id, role: 'assistant', parts: newParts })
      }
    } catch {
      newContent = JSON.stringify({ id: row.id, role: 'assistant', parts: newParts })
    }

    try {
      ctx.do.sql`
        UPDATE assistant_messages
        SET content = ${newContent}
        WHERE id = ${row.id} AND session_id = ''
      `
      console.info(
        `[SessionDO:${ctx.ctx.id}] retrofitOversizedRows: rewrote ${row.id} (${originalBytes} → ${newContent.length} bytes)`,
      )
    } catch (err) {
      console.error(
        `[SessionDO:${ctx.ctx.id}] retrofitOversizedRows: UPDATE ${row.id} failed:`,
        err,
      )
    }
  }

  markRetrofitApplied(ctx)
}

/**
 * Belt-and-suspenders for migration v10: ensure `assistant_messages` has
 * the `modified_at` column. The v10 `up` runs in `runMigrations` BEFORE
 * `Session.create(this)`, so on DOs where the SDK hadn't yet lazy-created
 * `assistant_messages` at v10's runtime, the ALTER caught "no such table"
 * and silently skipped while `_schema_version` still marked v10 applied.
 * Re-apply here, AFTER Session.create has guaranteed the table exists.
 * Idempotent: swallows "duplicate column" on DOs where v10 already added
 * the column.
 */
function ensureModifiedAtColumn(ctx: SessionDOContext): void {
  try {
    ctx.ctx.storage.sql.exec(`ALTER TABLE assistant_messages ADD COLUMN modified_at TEXT`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.toLowerCase().includes('duplicate column')) {
      console.warn(`[SessionDO:${ctx.ctx.id}] ensure modified_at column failed`, err)
    }
  }
}

/**
 * Run the cold-start hydrate sequence — must be invoked from the facade's
 * `onStart()` AFTER `runMigrations` and `Session.create(this)` have run.
 *
 * Order matters:
 *   1. messageSeq restore (cheap typed-meta read).
 *   2. SessionMeta restore from `session_meta`.
 *   3. GH#65 retrofit (idempotent; runs before any `getHistory()` / cursor
 *      replay can hit SQLITE_TOOBIG on legacy oversized rows).
 *   4. Trigger Session lazy-init via `getPathLength()` (creates
 *      `assistant_config` etc.).
 *   5. Ensure `modified_at` column (belt-and-suspenders for v10).
 *   6. loadTurnState from `assistant_config`.
 *   7. Max-ordinal recovery scan (guards against eviction-stale counter).
 *   8. Populate gateway-conn-id cache.
 */
export async function runHydration(ctx: SessionDOContext): Promise<void> {
  // Rehydrate per-session monotonic seq from typed session_meta (B1). The
  // v6 migration INSERT OR IGNOREs row id=1 so the `?? 0` is belt-and-
  // suspenders. Must run before any code path that can broadcastMessages.
  const metaRows = ctx.do.sql<{
    message_seq: number
  }>`SELECT message_seq FROM session_meta WHERE id = 1`
  ctx.do.messageSeq = metaRows[0]?.message_seq ?? 0

  // Rehydrate ex-SessionState fields from `session_meta` (#31 B10).
  hydrateMetaFromSql(ctx)

  // GH#65: retrofit oversized rows BEFORE any code path reads `content`.
  await retrofitOversizedRows(ctx)

  // Trigger Session's lazy table initialization (creates assistant_config etc.)
  // before we query those tables directly via this.sql.
  const pathLength = ctx.session.getPathLength()

  // Belt-and-suspenders for migration v10 — see ensureModifiedAtColumn doc.
  ensureModifiedAtColumn(ctx)

  // Load persisted turn state from assistant_config
  const turnState = loadTurnState(ctx.do.sql.bind(ctx.do), pathLength)
  ctx.do.turnCounter = turnState.turnCounter
  ctx.do.assistantTurnCounter = turnState.assistantTurnCounter
  ctx.do.currentTurnMessageId = turnState.currentTurnMessageId

  // Guard against DO eviction: if SQLite history survived but the
  // persisted turnCounter is 0 or stale, scan user-turn IDs for the max
  // ordinal. Prevents canonical-ID collisions (GH#14 P3 B6).
  //
  // GH#57: lightweight ID-only query — replaces an old getHistory() call
  // that read every row's content BLOB and tripped DO storage timeouts on
  // large sessions. The query filters `role = 'user'` so it sees only
  // `usr-N` rows; widening parseTurnOrdinal to also match `msg-N` / `err-N`
  // is safe here — those id kinds are excluded by the WHERE clause.
  try {
    const userRows = ctx.do.sql<{ id: string }>`
      SELECT id FROM assistant_messages
      WHERE session_id = '' AND role = 'user'
    `
    let maxOrdinal = 0
    for (const row of userRows) {
      const ord = parseTurnOrdinal(row.id)
      if (ord !== undefined && ord > maxOrdinal) maxOrdinal = ord
    }
    if (maxOrdinal > ctx.do.turnCounter) {
      ctx.do.turnCounter = maxOrdinal
    }
  } catch {
    // History scan is best-effort; never fatal on cold start.
  }

  // Populate gateway connection ID cache (in case we're waking from hibernation)
  ctx.do.cachedGatewayConnId = getGatewayConnectionIdFromSql(ctx.do.sql.bind(ctx.do))
}
