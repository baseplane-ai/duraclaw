import type { TranscriptEntry } from '@duraclaw/shared-types'
import { describe, expect, it, vi } from 'vitest'
import {
  appendTranscriptImpl,
  deleteTranscriptImpl,
  gcTranscript,
  listTranscriptSubkeysImpl,
  loadTranscriptImpl,
  transcriptCountImpl,
} from './transcript'
import type { SessionDOContext } from './types'

/**
 * GH#119 P1.1 — unit coverage for the DO-side transcript impls.
 *
 * Drives the impls through a hand-rolled in-memory `FakeSql` that knows
 * just enough SQL shapes to round-trip the queries `transcript.ts`
 * issues. Keeps the suite Workers-harness-free and fast — pure-fn
 * coverage, no wrangler boot, no better-sqlite3.
 */

interface Row {
  id: number
  project_key: string
  session_id: string
  subpath: string
  seq: number
  entry_json: string
  created_at: string // SQLite canonical: 'YYYY-MM-DD HH:MM:SS'
}

/** Format a Date as SQLite's canonical 'YYYY-MM-DD HH:MM:SS' (UTC). */
function sqliteNow(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

class FakeSql {
  rows: Row[] = []
  nextId = 1
  /** When set, every `exec` throws this error — used for error-path tests. */
  throwOnExec: Error | null = null

  exec<T = unknown>(query: string, ...bindings: unknown[]): { [Symbol.iterator](): Iterator<T> } {
    if (this.throwOnExec) throw this.throwOnExec

    const q = query.replace(/\s+/g, ' ').trim()

    // SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM session_transcript
    //   WHERE session_id = ? AND subpath = ?
    if (/COALESCE\(MAX\(seq\), 0\) \+ 1 AS next/.test(q)) {
      const [sessionId, subpath] = bindings as [string, string]
      const matching = this.rows.filter((r) => r.session_id === sessionId && r.subpath === subpath)
      const max = matching.reduce((acc, r) => (r.seq > acc ? r.seq : acc), 0)
      return iter([{ next: max + 1 } as unknown as T])
    }

    // SELECT entry_json FROM session_transcript
    //   WHERE session_id = ? AND subpath = ? ORDER BY seq ASC
    if (/SELECT entry_json FROM session_transcript/.test(q)) {
      const [sessionId, subpath] = bindings as [string, string]
      const matching = this.rows
        .filter((r) => r.session_id === sessionId && r.subpath === subpath)
        .sort((a, b) => a.seq - b.seq)
      return iter(matching.map((r) => ({ entry_json: r.entry_json }) as unknown as T))
    }

    // SELECT DISTINCT subpath FROM session_transcript
    //   WHERE session_id = ? AND subpath <> ''
    if (/SELECT DISTINCT subpath FROM session_transcript/.test(q)) {
      const [sessionId] = bindings as [string]
      const subs = new Set<string>()
      for (const r of this.rows) {
        if (r.session_id === sessionId && r.subpath !== '') subs.add(r.subpath)
      }
      return iter([...subs].map((s) => ({ subpath: s }) as unknown as T))
    }

    // SELECT count(*) AS c FROM session_transcript WHERE session_id = ?
    if (/SELECT count\(\*\) AS c FROM session_transcript/.test(q)) {
      const [sessionId] = bindings as [string]
      const c = this.rows.filter((r) => r.session_id === sessionId).length
      return iter([{ c } as unknown as T])
    }

    // INSERT INTO session_transcript (...) VALUES (?, ?, ?, ?, ?)
    if (/^INSERT INTO session_transcript/.test(q)) {
      const [project_key, session_id, subpath, seq, entry_json] = bindings as [
        string,
        string,
        string,
        number,
        string,
      ]
      this.rows.push({
        id: this.nextId++,
        project_key,
        session_id,
        subpath,
        seq,
        entry_json,
        created_at: sqliteNow(),
      })
      return iter<T>([])
    }

    // DELETE FROM session_transcript WHERE created_at < datetime('now', '-30 days')
    if (/DELETE FROM session_transcript WHERE created_at < datetime/.test(q)) {
      const cutoff = sqliteNow(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      this.rows = this.rows.filter((r) => r.created_at >= cutoff)
      return iter<T>([])
    }

    // DELETE FROM session_transcript WHERE session_id = ? AND subpath = ?
    if (/^DELETE FROM session_transcript WHERE session_id/.test(q)) {
      const [sessionId, subpath] = bindings as [string, string]
      this.rows = this.rows.filter((r) => !(r.session_id === sessionId && r.subpath === subpath))
      return iter<T>([])
    }

    throw new Error(`FakeSql: unrecognised query shape: ${q}`)
  }
}

function iter<T>(values: T[]): { [Symbol.iterator](): Iterator<T> } {
  return {
    [Symbol.iterator]() {
      let i = 0
      return {
        next(): IteratorResult<T> {
          if (i < values.length) return { value: values[i++], done: false }
          return { value: undefined as unknown as T, done: true }
        },
      }
    },
  }
}

function makeCtx(sql: FakeSql): SessionDOContext {
  return {
    sql: sql as unknown as SqlStorage,
    logEvent: vi.fn(),
  } as unknown as SessionDOContext
}

const E = (type: string, extra: Record<string, unknown> = {}): TranscriptEntry => ({
  type,
  ...extra,
})

describe('appendTranscriptImpl', () => {
  it('inserts entries with incrementing seq per (session_id, subpath)', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'proj', sessionId: 'sess-A' }, [
      E('user'),
      E('assistant'),
    ])
    appendTranscriptImpl(ctx, { projectKey: 'proj', sessionId: 'sess-A' }, [E('tool_use')])

    const seqs = sql.rows
      .filter((r) => r.session_id === 'sess-A' && r.subpath === '')
      .map((r) => r.seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('keeps independent seq counters per subpath under the same sessionId', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'proj', sessionId: 'sess-A' }, [
      E('user'),
      E('assistant'),
    ])
    appendTranscriptImpl(ctx, { projectKey: 'proj', sessionId: 'sess-A', subpath: 'subagent-A' }, [
      E('user'),
    ])

    const main = sql.rows
      .filter((r) => r.session_id === 'sess-A' && r.subpath === '')
      .map((r) => r.seq)
    const sub = sql.rows
      .filter((r) => r.session_id === 'sess-A' && r.subpath === 'subagent-A')
      .map((r) => r.seq)
    expect(main).toEqual([1, 2])
    expect(sub).toEqual([1])
  })

  it('logs and re-throws on SQL error', () => {
    const sql = new FakeSql()
    sql.throwOnExec = new Error('boom')
    const ctx = makeCtx(sql)
    const logEvent = ctx.logEvent as ReturnType<typeof vi.fn>

    expect(() =>
      appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 's' }, [E('user')]),
    ).toThrow('boom')

    expect(logEvent).toHaveBeenCalledWith(
      'error',
      'transcript',
      expect.stringContaining('appendTranscript failed'),
      expect.objectContaining({ sessionId: 's', subpath: '' }),
    )
  })
})

describe('loadTranscriptImpl', () => {
  it('returns entries in seq order', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'proj', sessionId: 'sess-A' }, [
      E('user', { uuid: 'u1' }),
      E('assistant', { uuid: 'a1' }),
    ])

    const out = loadTranscriptImpl(ctx, { projectKey: 'proj', sessionId: 'sess-A' })
    expect(out).not.toBeNull()
    expect(out!.map((e) => e.uuid)).toEqual(['u1', 'a1'])
  })

  it('orders by seq even when rows are inserted out of order in storage', () => {
    const sql = new FakeSql()
    // Inject directly to simulate storage that has rows with seq=3,1,2.
    sql.rows.push(
      {
        id: 1,
        project_key: 'p',
        session_id: 'sess-A',
        subpath: '',
        seq: 3,
        entry_json: JSON.stringify(E('a3', { tag: 'third' })),
        created_at: sqliteNow(),
      },
      {
        id: 2,
        project_key: 'p',
        session_id: 'sess-A',
        subpath: '',
        seq: 1,
        entry_json: JSON.stringify(E('a1', { tag: 'first' })),
        created_at: sqliteNow(),
      },
      {
        id: 3,
        project_key: 'p',
        session_id: 'sess-A',
        subpath: '',
        seq: 2,
        entry_json: JSON.stringify(E('a2', { tag: 'second' })),
        created_at: sqliteNow(),
      },
    )
    const ctx = makeCtx(sql)
    const out = loadTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' })
    expect(out).not.toBeNull()
    expect(out!.map((e) => e.tag)).toEqual(['first', 'second', 'third'])
  })

  it('returns null for an unknown sessionId (matches SDK contract)', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    expect(loadTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'nope' })).toBeNull()
  })

  it('treats subpath as keyed — main vs subagent are isolated', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess' }, [E('main')])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess', subpath: 'sa-1' }, [E('sub')])

    const main = loadTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess' })
    const sub = loadTranscriptImpl(ctx, {
      projectKey: 'p',
      sessionId: 'sess',
      subpath: 'sa-1',
    })
    expect(main!.map((e) => e.type)).toEqual(['main'])
    expect(sub!.map((e) => e.type)).toEqual(['sub'])
  })
})

describe('listTranscriptSubkeysImpl', () => {
  it('returns distinct non-empty subpath values for a session', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' }, [E('user')])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A', subpath: 'subagent-A' }, [
      E('user'),
    ])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A', subpath: 'subagent-B' }, [
      E('user'),
      E('assistant'),
    ])

    const subs = listTranscriptSubkeysImpl(ctx, {
      projectKey: 'p',
      sessionId: 'sess-A',
    })
    expect(subs.sort()).toEqual(['subagent-A', 'subagent-B'])
  })

  it('returns an empty array when only the main transcript exists', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' }, [E('user')])

    expect(listTranscriptSubkeysImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' })).toEqual([])
  })
})

describe('deleteTranscriptImpl', () => {
  it('removes only matching rows for the (session, subpath) key', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' }, [E('a'), E('b')])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-B' }, [E('c')])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A', subpath: 'sa-1' }, [E('d')])

    deleteTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' })

    // Main transcript for sess-A is gone, sess-B and the sa-1 subpath survive.
    expect(loadTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' })).toBeNull()
    expect(
      loadTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-B' })!.map((e) => e.type),
    ).toEqual(['c'])
    expect(
      loadTranscriptImpl(ctx, {
        projectKey: 'p',
        sessionId: 'sess-A',
        subpath: 'sa-1',
      })!.map((e) => e.type),
    ).toEqual(['d'])
  })
})

describe('transcriptCountImpl', () => {
  it('counts entries across all subpaths for a session', () => {
    const sql = new FakeSql()
    const ctx = makeCtx(sql)
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A' }, [E('a'), E('b')])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-A', subpath: 'sa-1' }, [E('c')])
    appendTranscriptImpl(ctx, { projectKey: 'p', sessionId: 'sess-B' }, [E('z')])

    expect(transcriptCountImpl(ctx, 'sess-A')).toBe(3)
    expect(transcriptCountImpl(ctx, 'sess-B')).toBe(1)
    expect(transcriptCountImpl(ctx, 'unknown')).toBe(0)
  })

  it('returns 0 on SQL error (best-effort, never crashes the DO)', () => {
    const sql = new FakeSql()
    sql.throwOnExec = new Error('storage offline')
    const ctx = makeCtx(sql)
    expect(transcriptCountImpl(ctx, 'sess-A')).toBe(0)
  })
})

describe('gcTranscript', () => {
  it('deletes only rows older than 30 days', () => {
    const sql = new FakeSql()
    const old = sqliteNow(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))
    const fresh = sqliteNow(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000))
    sql.rows.push(
      {
        id: 1,
        project_key: 'p',
        session_id: 'sess-old',
        subpath: '',
        seq: 1,
        entry_json: JSON.stringify(E('a')),
        created_at: old,
      },
      {
        id: 2,
        project_key: 'p',
        session_id: 'sess-fresh',
        subpath: '',
        seq: 1,
        entry_json: JSON.stringify(E('b')),
        created_at: fresh,
      },
    )
    const ctx = makeCtx(sql)
    gcTranscript(ctx)
    expect(sql.rows.map((r) => r.session_id)).toEqual(['sess-fresh'])
  })

  it('swallows SQL errors silently (best-effort, mirrors event-log GC)', () => {
    const sql = new FakeSql()
    sql.throwOnExec = new Error('disk full')
    const ctx = makeCtx(sql)
    expect(() => gcTranscript(ctx)).not.toThrow()
  })
})
