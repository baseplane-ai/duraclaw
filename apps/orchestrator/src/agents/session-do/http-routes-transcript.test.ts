import type { TranscriptEntry } from '@duraclaw/shared-types'
import { describe, expect, it, vi } from 'vitest'
import { handleHttpRequest } from './http-routes'
import { appendTranscriptImpl } from './transcript'
import type { SessionDOContext } from './types'

/**
 * GH#119 regression: `/debug/transcript-count` was defaulting `session_id`
 * to `ctx.do.name` (the duraclaw session id) but `session_transcript`
 * stores the SDK runner_session_id. Caused the route to return 0 even
 * with rows present. Caught during VP execution. The fix is to default to
 * `ctx.state.runner_session_id`.
 */

interface Row {
  id: number
  project_key: string
  session_id: string
  subpath: string
  seq: number
  entry_json: string
  created_at: string
}

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

  exec<T = unknown>(query: string, ...bindings: unknown[]): { [Symbol.iterator](): Iterator<T> } {
    const q = query.replace(/\s+/g, ' ').trim()

    if (/COALESCE\(MAX\(seq\), 0\) \+ 1 AS next/.test(q)) {
      const [sessionId, subpath] = bindings as [string, string]
      const matching = this.rows.filter((r) => r.session_id === sessionId && r.subpath === subpath)
      const max = matching.reduce((acc, r) => (r.seq > acc ? r.seq : acc), 0)
      return iter([{ next: max + 1 } as unknown as T])
    }

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
      return iter([])
    }

    if (/^SELECT count\(\*\) AS c FROM session_transcript WHERE session_id = \?/.test(q)) {
      const [sessionId] = bindings as [string]
      const c = this.rows.filter((r) => r.session_id === sessionId).length
      return iter([{ c } as unknown as T])
    }

    return iter([])
  }
}

function iter<T>(arr: T[]): { [Symbol.iterator](): Iterator<T> } {
  return { [Symbol.iterator]: () => arr[Symbol.iterator]() }
}

function makeCtx(opts: {
  sql: FakeSql
  doName?: string
  runnerSessionId?: string | null
}): SessionDOContext {
  return {
    sql: opts.sql as unknown as SqlStorage,
    do: {
      name: opts.doName ?? 'duraclaw-session-id-aaaa',
    },
    state: {
      runner_session_id: opts.runnerSessionId ?? null,
    },
    logEvent: vi.fn(),
  } as unknown as SessionDOContext
}

const E = (type: string): TranscriptEntry => ({ type })

describe('GET /debug/transcript-count (handleHttpRequest)', () => {
  it('returns the count keyed by ctx.state.runner_session_id, NOT ctx.do.name', async () => {
    const sql = new FakeSql()
    // Seed 3 rows under the SDK runner_session_id (what the SDK actually
    // stores via SessionStore.append() — orch logs show this id).
    appendTranscriptImpl(
      { sql: sql as unknown as SqlStorage, logEvent: vi.fn() } as unknown as SessionDOContext,
      { projectKey: '-data-projects-duraclaw-dev2', sessionId: 'sdk-runner-uuid-bbbb' },
      [E('user'), E('assistant'), E('result')],
    )

    const ctx = makeCtx({
      sql,
      doName: 'duraclaw-session-id-aaaa',
      runnerSessionId: 'sdk-runner-uuid-bbbb',
    })

    const res = await handleHttpRequest(ctx, new Request('https://session/debug/transcript-count'))
    expect(res).not.toBeNull()
    const body = await res?.json()
    expect(body).toEqual({ count: 3 })
  })

  it('returns 0 with a reason when runner_session_id is not yet known', async () => {
    const sql = new FakeSql()
    const ctx = makeCtx({ sql, runnerSessionId: null })
    const res = await handleHttpRequest(ctx, new Request('https://session/debug/transcript-count'))
    const body = await res?.json()
    expect(body).toMatchObject({ count: 0, reason: 'no runner_session_id yet' })
  })

  it('honors an explicit ?session_id= override (test-affordance)', async () => {
    const sql = new FakeSql()
    appendTranscriptImpl(
      { sql: sql as unknown as SqlStorage, logEvent: vi.fn() } as unknown as SessionDOContext,
      { projectKey: 'p', sessionId: 'explicit-id' },
      [E('a'), E('b')],
    )
    const ctx = makeCtx({ sql, runnerSessionId: 'something-else' })
    const res = await handleHttpRequest(
      ctx,
      new Request('https://session/debug/transcript-count?session_id=explicit-id'),
    )
    const body = await res?.json()
    expect(body).toEqual({ count: 2 })
  })

  it('reproduces the original bug when default falls back to ctx.do.name (regression guard)', async () => {
    // Same seeding as the first test but runner_session_id is missing on
    // ctx.state — the OLD code path defaulted to ctx.do.name and returned
    // 0. Confirm we no longer leak that misleading value.
    const sql = new FakeSql()
    appendTranscriptImpl(
      { sql: sql as unknown as SqlStorage, logEvent: vi.fn() } as unknown as SessionDOContext,
      { projectKey: 'p', sessionId: 'sdk-runner-uuid-bbbb' },
      [E('a')],
    )
    const ctx = makeCtx({
      sql,
      doName: 'duraclaw-session-id-aaaa',
      runnerSessionId: null,
    })
    const res = await handleHttpRequest(ctx, new Request('https://session/debug/transcript-count'))
    const body = (await res?.json()) as { count: number; reason?: string }
    // Critical: do NOT silently return 0 from the wrong key — surface a
    // reason so callers can tell "no rows" from "no runner yet".
    expect(body.count).toBe(0)
    expect(body.reason).toBe('no runner_session_id yet')
  })
})
