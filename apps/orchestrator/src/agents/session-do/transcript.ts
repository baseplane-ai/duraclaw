import type { TranscriptEntry, TranscriptSessionKey } from '@duraclaw/shared-types'
import type { SessionDOContext } from './types'

/**
 * GH#119 P1.1 — DO-side mirror of the Claude Agent SDK `SessionStore`.
 *
 * Pure-function handlers operating on a `SessionDOContext`. The runner
 * dials in over the dial-back WS and emits `transcript-rpc` events; the
 * gateway-event-handler dispatches to these impls and replies with a
 * `transcript-rpc-response` command carrying the result or error.
 *
 * `append` / `load` / `listSubkeys` / `delete` throw on SQL failure so
 * the dispatcher can surface a meaningful error string back to the
 * runner. `gcTranscript` is best-effort and never throws (mirrors the
 * `event-log.ts` GC pattern).
 */

interface NextSeqRow extends Record<string, SqlStorageValue> {
  next: number
}

interface EntryRow extends Record<string, SqlStorageValue> {
  entry_json: string
}

interface SubpathRow extends Record<string, SqlStorageValue> {
  subpath: string
}

interface CountRow extends Record<string, SqlStorageValue> {
  c: number
}

/**
 * Append `entries` to the transcript keyed by `(session_id, subpath)`.
 * Each entry is assigned a fresh per-key `seq`. Throws on SQL error
 * (logged via `event_log` for forensic replay before re-throw).
 */
export function appendTranscriptImpl(
  ctx: SessionDOContext,
  key: TranscriptSessionKey,
  entries: TranscriptEntry[],
): void {
  const subpath = key.subpath ?? ''
  try {
    // Per-key seq is assigned by reading the current MAX and incrementing
    // in a JS loop. This pattern relies on the Durable Object single-writer
    // invariant — DO event handlers run serially per-DO, so no two
    // `appendTranscriptImpl` calls can interleave between the SELECT and
    // the final INSERT. If we ever multiplex transcript writes across DOs
    // for the same session_id we'd need a real sequence (UPSERT with
    // `MAX(seq)+1` in a single statement, or an AUTOINCREMENT + ORDER BY
    // id at read time).
    const cursor = ctx.sql.exec<NextSeqRow>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM session_transcript
       WHERE session_id = ? AND subpath = ?`,
      key.sessionId,
      subpath,
    )
    const rows = [...cursor]
    let nextSeq = rows[0]?.next ?? 1
    for (const entry of entries) {
      ctx.sql.exec(
        `INSERT INTO session_transcript (project_key, session_id, subpath, seq, entry_json)
         VALUES (?, ?, ?, ?, ?)`,
        key.projectKey,
        key.sessionId,
        subpath,
        nextSeq,
        JSON.stringify(entry),
      )
      nextSeq++
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logEvent('error', 'transcript', `appendTranscript failed: ${msg}`, {
      sessionId: key.sessionId,
      subpath,
      entryCount: entries.length,
    })
    throw err
  }
}

/**
 * Load the transcript keyed by `(session_id, subpath)` in seq order.
 * Returns `null` when zero rows match — matches the SDK
 * `SessionStore.load` contract (the SDK uses `null` to signal "no
 * transcript", which triggers fresh-session behavior).
 */
export function loadTranscriptImpl(
  ctx: SessionDOContext,
  key: TranscriptSessionKey,
): TranscriptEntry[] | null {
  const subpath = key.subpath ?? ''
  try {
    const cursor = ctx.sql.exec<EntryRow>(
      `SELECT entry_json FROM session_transcript
       WHERE session_id = ? AND subpath = ?
       ORDER BY seq ASC`,
      key.sessionId,
      subpath,
    )
    const rows = [...cursor]
    if (rows.length === 0) return null
    return rows.map((r) => JSON.parse(r.entry_json) as TranscriptEntry)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logEvent('error', 'transcript', `loadTranscript failed: ${msg}`, {
      sessionId: key.sessionId,
      subpath,
    })
    throw err
  }
}

/**
 * List distinct non-empty subpath values for a session — i.e. subagent
 * transcripts only. The main transcript lives at the empty-string
 * subpath and is excluded from the listing (the SDK queries this RPC
 * specifically to enumerate subagents).
 */
export function listTranscriptSubkeysImpl(
  ctx: SessionDOContext,
  key: { projectKey: string; sessionId: string },
): string[] {
  try {
    const cursor = ctx.sql.exec<SubpathRow>(
      `SELECT DISTINCT subpath FROM session_transcript
       WHERE session_id = ? AND subpath <> ''`,
      key.sessionId,
    )
    return [...cursor].map((r) => r.subpath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logEvent('error', 'transcript', `listTranscriptSubkeys failed: ${msg}`, {
      sessionId: key.sessionId,
    })
    throw err
  }
}

/**
 * Delete all entries for `(session_id, subpath)`. Defaults `subpath` to
 * the empty string so the main-transcript delete works without an
 * explicit subpath in the wire payload.
 */
export function deleteTranscriptImpl(ctx: SessionDOContext, key: TranscriptSessionKey): void {
  const subpath = key.subpath ?? ''
  try {
    ctx.sql.exec(
      `DELETE FROM session_transcript WHERE session_id = ? AND subpath = ?`,
      key.sessionId,
      subpath,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.logEvent('error', 'transcript', `deleteTranscript failed: ${msg}`, {
      sessionId: key.sessionId,
      subpath,
    })
    throw err
  }
}

/** Total transcript-entry count for a session. Drives the debug endpoint. */
export function transcriptCountImpl(ctx: SessionDOContext, sessionId: string): number {
  try {
    const cursor = ctx.sql.exec<CountRow>(
      `SELECT count(*) AS c FROM session_transcript WHERE session_id = ?`,
      sessionId,
    )
    const rows = [...cursor]
    return rows[0]?.c ?? 0
  } catch {
    // Best-effort — debug endpoint should never crash the DO.
    return 0
  }
}

/**
 * Prune transcript rows older than the 30-day retention window.
 * Best-effort — never throws. Mirrors `gcEventLog`'s `onStart` pattern.
 *
 * Implementation note: the cutoff is computed by SQLite via
 * `datetime('now', '-30 days')` rather than a JS-side ISO string. The
 * column default is `(datetime('now'))` which produces the SQLite
 * canonical format `YYYY-MM-DD HH:MM:SS` — comparing that against an
 * ISO-8601 string (`YYYY-MM-DDTHH:MM:SS.sssZ`) is lexicographically
 * unsound at the position-10 separator (' ' < 'T'), so we keep both
 * sides in SQLite format.
 */
export function gcTranscript(ctx: SessionDOContext): void {
  try {
    ctx.sql.exec(`DELETE FROM session_transcript WHERE created_at < datetime('now', '-30 days')`)
  } catch {
    // Best-effort — never fatal on cold start.
  }
}
