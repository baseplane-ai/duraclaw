import type { SessionDOContext } from './types'

/** 7-day retention for event_log rows. */
const EVENT_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Persist a structured log event to SQLite + mirror to console for
 * wrangler tail. Every `[gate]` / `[conn]` / `[rpc]` log should flow
 * through here so the event is durable and queryable via `getEventLog`.
 */
export function logEvent(
  ctx: SessionDOContext,
  level: 'info' | 'warn' | 'error',
  tag: string,
  message: string,
  attrs?: Record<string, unknown>,
) {
  const ts = Date.now()
  try {
    ctx.sql.exec(
      'INSERT INTO event_log (ts, level, tag, message, attrs) VALUES (?, ?, ?, ?, ?)',
      ts,
      level,
      tag,
      message,
      attrs ? JSON.stringify(attrs) : null,
    )
  } catch {
    // Best-effort — never crash the DO for a log write.
  }
  const line = `[${tag}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** Delete event_log rows older than the retention window. */
export function gcEventLog(ctx: SessionDOContext) {
  try {
    const cutoff = Date.now() - EVENT_LOG_RETENTION_MS
    ctx.sql.exec('DELETE FROM event_log WHERE ts < ?', cutoff)
  } catch {
    // Best-effort — never fatal on cold start.
  }
}

export interface EventLogRow extends Record<string, SqlStorageValue> {
  seq: number
  ts: number
  level: string
  tag: string
  message: string
  attrs: string | null
}

/**
 * Query the durable event_log table (migration v17). Useful for
 * historical playback of gate lifecycle, connection events, etc.
 * Returns rows oldest-first for chronological replay.
 */
export function getEventLogImpl(
  ctx: SessionDOContext,
  opts?: { tag?: string; sinceTs?: number; limit?: number },
): EventLogRow[] {
  const limit = Math.min(opts?.limit ?? 1000, 10_000)
  const sinceTs = opts?.sinceTs ?? 0
  try {
    if (opts?.tag) {
      const cursor = ctx.sql.exec<EventLogRow>(
        'SELECT seq, ts, level, tag, message, attrs FROM event_log WHERE tag = ? AND ts >= ? ORDER BY seq DESC LIMIT ?',
        opts.tag,
        sinceTs,
        limit,
      )
      return [...cursor].reverse()
    }
    const cursor = ctx.sql.exec<EventLogRow>(
      'SELECT seq, ts, level, tag, message, attrs FROM event_log WHERE ts >= ? ORDER BY seq DESC LIMIT ?',
      sinceTs,
      limit,
    )
    return [...cursor].reverse()
  } catch {
    return []
  }
}
