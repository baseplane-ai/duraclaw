// RepoDocumentDO unit tests — covers B1 (y_state persistence), B3 (dual-auth
// onConnect: cookie path for browser peers, bearer path for the docs-runner),
// and B10 (tombstone/cancel/alarm soft-delete lifecycle).
//
// We mock y-partyserver's YServer base so the test stays unit-style (no
// Worker / Miniflare). The mock implements just the bits the SUT touches:
// a Y.Doc field, a connections set, an onClose stub for the awareness-cleanup
// contract, and a broadcast spy. Storage is a Map-backed fake supporting the
// sql.exec patterns plus get/put/delete/setAlarm/deleteAlarm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

// In-memory connection set the mocked YServer base shares with tests.
const mockConnections = new Set<{
  id: string
  readyState: number
  state?: unknown
  close: ReturnType<typeof vi.fn>
  setState: ReturnType<typeof vi.fn>
}>()
const broadcastSpy = vi.fn()

// Drizzle / schema mocks for the B12 lazy-spawn path. The chain objects
// are reused across tests; `drizzleSelectRows` is mutated per test to
// shape the `select().from().where().limit()` result.
let drizzleSelectRows: Array<{ projectId: string; docsWorktreePath: string | null }> = []
const drizzleSelectChain = {
  from: vi.fn(() => drizzleSelectChain),
  where: vi.fn(() => drizzleSelectChain),
  limit: vi.fn(async () => drizzleSelectRows),
}
const drizzleUpdateChain = {
  set: vi.fn(() => drizzleUpdateChain),
  where: vi.fn(async () => undefined),
}
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn(() => drizzleSelectChain),
    update: vi.fn(() => drizzleUpdateChain),
  })),
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn((a, b) => ({ a, b })) }))
vi.mock('~/db/schema', () => ({
  projectMetadata: {
    projectId: 'projectId-col',
    docsWorktreePath: 'docsWorktreePath-col',
  },
}))

vi.mock('y-partyserver', async () => {
  const Yjs = await import('yjs')
  class YServer {
    static options = { hibernate: false }
    static callbackOptions = {}
    ctx: any
    env: any
    document: Y.Doc
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx as any
      this.env = env
      this.document = new Yjs.Doc()
    }
    *getConnections() {
      for (const c of mockConnections) {
        if (c.readyState === 1) yield c as any
      }
    }
    broadcast(msg: string | ArrayBuffer, without?: string[]) {
      broadcastSpy(msg, without)
    }
    async onClose(_conn: unknown, _code: number, _reason: string, _wasClean: boolean) {
      ;(YServer as any)._superOnCloseCalls++
    }
    static _superOnCloseCalls = 0
  }
  return { YServer }
})

// Stub the auth-session module so the cookie path is fully controllable.
vi.mock('~/api/auth-session', () => ({
  getRequestSession: vi.fn(),
}))

import { getRequestSession } from '~/api/auth-session'
import { RepoDocumentDO } from './repo-document-do'

// ── Fakes ──────────────────────────────────────────────────────────────

interface SqlRow {
  id: string
  data: Uint8Array
  updated_at: number
}

function makeCtx() {
  const rows = new Map<string, SqlRow>()
  const execLog: string[] = []
  const sqlExec = vi.fn((sql: string, ...params: unknown[]) => {
    execLog.push(sql.trim().slice(0, 60))
    const trimmed = sql.trim()
    if (/^CREATE TABLE/i.test(trimmed)) return { toArray: () => [] }
    if (/^SELECT/i.test(trimmed)) {
      const r = rows.get('snapshot')
      return { toArray: () => (r ? [{ data: r.data }] : []) }
    }
    if (/^INSERT OR REPLACE/i.test(trimmed)) {
      const [data, updated_at] = params as [Uint8Array, number]
      rows.set('snapshot', { id: 'snapshot', data, updated_at })
      return { toArray: () => [] }
    }
    if (/^DELETE FROM y_state/i.test(trimmed)) {
      rows.delete('snapshot')
      return { toArray: () => [] }
    }
    return { toArray: () => [] }
  })

  // Storage KV + alarm fakes. The SUT awaits .get/.put/.delete/.setAlarm/
  // .deleteAlarm — return promises so `await` works.
  const kv = new Map<string, unknown>()
  const storageGet = vi.fn(async (key: string) => kv.get(key))
  const storagePut = vi.fn(async (key: string, value: unknown) => {
    kv.set(key, value)
  })
  const storageDelete = vi.fn(async (key: string) => {
    kv.delete(key)
  })
  let alarmAt: number | null = null
  const setAlarm = vi.fn(async (ts: number) => {
    alarmAt = ts
  })
  const deleteAlarm = vi.fn(async () => {
    alarmAt = null
  })

  // `waitUntil` just passes the promise through so tests can await it.
  const waitUntil = vi.fn((p: Promise<unknown>) => p)

  return {
    ctx: {
      storage: {
        sql: { exec: sqlExec },
        get: storageGet,
        put: storagePut,
        delete: storageDelete,
        setAlarm,
        deleteAlarm,
      },
      waitUntil,
    },
    rows,
    kv,
    execLog,
    sqlExec,
    storagePut,
    storageDelete,
    setAlarm,
    deleteAlarm,
    getAlarmAt: () => alarmAt,
  }
}

function makeConn(id: string, readyState = 1) {
  const conn = {
    id,
    readyState,
    close: vi.fn(),
    setState: vi.fn(),
  }
  mockConnections.add(conn)
  return conn
}

function makeReqCtx(url: string): any {
  return { request: new Request(url) }
}

beforeEach(() => {
  mockConnections.clear()
  broadcastSpy.mockClear()
  ;(getRequestSession as any).mockReset()
  drizzleSelectRows = []
  drizzleSelectChain.from.mockClear()
  drizzleSelectChain.where.mockClear()
  drizzleSelectChain.limit.mockClear()
  drizzleUpdateChain.set.mockClear()
  drizzleUpdateChain.where.mockClear()
})

// ── B1: y_state persistence ────────────────────────────────────────────

describe('RepoDocumentDO y_state persistence', () => {
  it('flushes Y.Doc state to SQLite when the last connection closes and round-trips on reload', async () => {
    const { ctx, rows } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, {} as any)

    await sut.onLoad()

    const conn = makeConn('conn-1', 1)
    sut.document.getText('body').insert(0, 'hello docs')

    expect(rows.has('snapshot')).toBe(false)

    conn.readyState = 3
    await sut.onClose(conn as any, 1000, '', true)

    const persisted = rows.get('snapshot')
    expect(persisted).toBeDefined()

    const replay = new Y.Doc()
    Y.applyUpdate(replay, persisted!.data)
    expect(replay.getText('body').toString()).toBe('hello docs')
  })
})

// ── B3: dual-auth onConnect ────────────────────────────────────────────

describe('RepoDocumentDO onConnect dual-auth', () => {
  it('accepts a runner connection with the correct bearer token', async () => {
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const conn = makeConn('runner-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx('wss://orch/repo/proj:foo.md?role=docs-runner&token=correct'),
    )

    expect(conn.close).not.toHaveBeenCalled()
    expect(conn.setState).toHaveBeenCalledWith({ kind: 'docs-runner' })
  })

  it('rejects a runner connection with a wrong token (4401)', async () => {
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const conn = makeConn('runner-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx('wss://orch/repo/proj:foo.md?role=docs-runner&token=bad'),
    )

    expect(conn.close).toHaveBeenCalledWith(4401, 'invalid_token')
    expect(conn.setState).not.toHaveBeenCalled()
  })

  it('accepts a browser connection with a valid session cookie', async () => {
    ;(getRequestSession as any).mockResolvedValueOnce({ userId: 'u1', role: 'user' })
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, {} as any)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(conn as any, makeReqCtx('wss://orch/repo/proj:foo.md'))

    expect(conn.close).not.toHaveBeenCalled()
    expect(conn.setState).toHaveBeenCalledWith({ kind: 'browser', userId: 'u1' })
  })

  it('rejects a connection with no session and no role (4401)', async () => {
    ;(getRequestSession as any).mockResolvedValueOnce(null)
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, {} as any)
    await sut.onLoad()

    const conn = makeConn('anon')
    await sut.onConnect(conn as any, makeReqCtx('wss://orch/repo/proj:foo.md'))

    expect(conn.close).toHaveBeenCalledWith(4401, 'invalid_token')
    expect(conn.setState).not.toHaveBeenCalled()
  })

  it('refuses any connect with 4412 once the document is tombstoned', async () => {
    const fixture = makeCtx()
    fixture.kv.set('tombstoneAt', Date.now() + 86_400_000)
    const sut = new RepoDocumentDO(fixture.ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const conn = makeConn('any')
    await sut.onConnect(
      conn as any,
      makeReqCtx('wss://orch/repo/proj:foo.md?role=docs-runner&token=correct'),
    )

    expect(conn.close).toHaveBeenCalledWith(4412, 'document_deleted')
    expect(conn.setState).not.toHaveBeenCalled()
  })
})

// ── B10: tombstone HTTP control plane + alarm ──────────────────────────

describe('RepoDocumentDO tombstone lifecycle', () => {
  it('POST /tombstone with a valid bearer records the deadline and schedules an alarm', async () => {
    const fixture = makeCtx()
    const sut = new RepoDocumentDO(fixture.ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const before = Date.now()
    const res = await sut.onRequest(
      new Request('https://do/repo/proj:foo.md/tombstone', {
        method: 'POST',
        headers: { Authorization: 'Bearer correct', 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath: 'foo.md', graceDays: 7 }),
      }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { tombstoneAt: number }
    expect(body.tombstoneAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000)

    expect(fixture.kv.get('tombstoneAt')).toBe(body.tombstoneAt)
    expect(fixture.kv.get('relPath')).toBe('foo.md')
    expect(fixture.setAlarm).toHaveBeenCalledWith(body.tombstoneAt)
    expect(broadcastSpy).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'tombstone-pending', tombstoneAt: body.tombstoneAt }),
      undefined,
    )
  })

  it('POST /tombstone without a bearer returns 401', async () => {
    const fixture = makeCtx()
    const sut = new RepoDocumentDO(fixture.ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const res = await sut.onRequest(
      new Request('https://do/repo/proj:foo.md/tombstone', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).toBe(401)
    expect(fixture.setAlarm).not.toHaveBeenCalled()
  })

  it('POST /cancel-tombstone clears storage and the scheduled alarm', async () => {
    const fixture = makeCtx()
    fixture.kv.set('tombstoneAt', Date.now() + 86_400_000)
    const sut = new RepoDocumentDO(fixture.ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const res = await sut.onRequest(
      new Request('https://do/repo/proj:foo.md/cancel-tombstone', {
        method: 'POST',
        headers: { Authorization: 'Bearer correct' },
      }),
    )

    expect(res.status).toBe(200)
    expect(fixture.kv.has('tombstoneAt')).toBe(false)
    expect(fixture.deleteAlarm).toHaveBeenCalled()
    expect(broadcastSpy).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'tombstone-cancelled' }),
      undefined,
    )
  })

  it('GET /tombstone-status returns the stored deadline', async () => {
    const fixture = makeCtx()
    const deadline = Date.now() + 3 * 86_400_000
    fixture.kv.set('tombstoneAt', deadline)
    const sut = new RepoDocumentDO(fixture.ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const res = await sut.onRequest(
      new Request('https://do/repo/proj:foo.md/tombstone-status', {
        headers: { Authorization: 'Bearer correct' },
      }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { tombstoneAt: number | null }
    expect(body.tombstoneAt).toBe(deadline)
  })

  it('alarm() hard-deletes the y_state row and force-closes every peer with 4412', async () => {
    const fixture = makeCtx()
    // Pre-seed a real Y.Doc snapshot so onLoad's Y.applyUpdate succeeds and
    // we can observe the DELETE removing it.
    const seedDoc = new Y.Doc()
    seedDoc.getText('body').insert(0, 'seed')
    fixture.rows.set('snapshot', {
      id: 'snapshot',
      data: Y.encodeStateAsUpdate(seedDoc),
      updated_at: 0,
    })
    const sut = new RepoDocumentDO(fixture.ctx as any, { DOCS_RUNNER_SECRET: 'correct' } as any)
    await sut.onLoad()

    const c1 = makeConn('peer-1', 1)
    const c2 = makeConn('peer-2', 1)

    await sut.alarm()

    expect(fixture.rows.has('snapshot')).toBe(false)
    expect(c1.close).toHaveBeenCalledWith(4412, 'document_deleted')
    expect(c2.close).toHaveBeenCalledWith(4412, 'document_deleted')
  })
})

// ── B12: lazy-spawn trigger ────────────────────────────────────────────

describe('RepoDocumentDO B12 lazy-spawn trigger', () => {
  const projectId = 'abcdef0123456789'
  const lazyEnv = {
    DOCS_RUNNER_SECRET: 'docs-tok',
    CC_GATEWAY_URL: 'http://gateway:9877',
    CC_GATEWAY_SECRET: 'gw-tok',
    AUTH_DB: {} as unknown as D1Database,
  } as any

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ;(getRequestSession as any).mockResolvedValue({ userId: 'u1', role: 'user' })
    fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers({ shouldAdvanceTime: false })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // Drive the 2s debounce + the chained promises that follow it.
  async function fireDebounce() {
    await vi.advanceTimersByTimeAsync(2000)
    await vi.runAllTimersAsync()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('happy path: POSTs /docs-runners/start with the project payload after the 2s debounce', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: '/data/projects/foo' }]
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('http://gateway:9877/docs-runners/start')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer gw-tok')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      projectId,
      docsWorktreePath: '/data/projects/foo',
      bearer: 'docs-tok',
    })
  })

  it('skips the POST when a docs-runner is already connected', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: '/data/projects/foo' }]
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, lazyEnv)
    await sut.onLoad()

    // Pre-attach a docs-runner peer.
    const runner = makeConn('runner-1')
    runner.state = { kind: 'docs-runner' }

    const browser = makeConn('browser-1')
    await sut.onConnect(
      browser as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('broadcasts setup-required when docsWorktreePath is null', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: null }]
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(broadcastSpy).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'setup-required', projectId }),
      undefined,
    )
  })

  it('broadcasts setup-required when the projectMetadata row is missing', async () => {
    drizzleSelectRows = []
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(broadcastSpy).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'setup-required', projectId }),
      undefined,
    )
  })

  it('on gateway 400 docs_worktree_invalid clears the path and broadcasts setup-required', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: '/data/projects/foo' }]
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'docs_worktree_invalid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(drizzleUpdateChain.set).toHaveBeenCalledTimes(1)
    const setArg = drizzleUpdateChain.set.mock.calls[0][0]
    expect(setArg.docsWorktreePath).toBeNull()
    expect(typeof setArg.updatedAt).toBe('string')
    expect(broadcastSpy).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'setup-required', projectId }),
      undefined,
    )
  })

  it('on fetch throw broadcasts spawn-failed and does not clear the path', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: '/data/projects/foo' }]
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const { ctx } = makeCtx()
    const sut = new RepoDocumentDO(ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(broadcastSpy).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'spawn-failed', reason: 'gateway_unreachable' }),
      undefined,
    )
    expect(drizzleUpdateChain.set).not.toHaveBeenCalled()
  })

  it('skips the POST silently when within the 30s rate-limit window', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: '/data/projects/foo' }]
    const fixture = makeCtx()
    fixture.kv.set('lastSpawnAttempt', Date.now() - 10_000)
    const sut = new RepoDocumentDO(fixture.ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fires fetch and updates lastSpawnAttempt once the rate-limit window has expired', async () => {
    drizzleSelectRows = [{ projectId, docsWorktreePath: '/data/projects/foo' }]
    const fixture = makeCtx()
    fixture.kv.set('lastSpawnAttempt', Date.now() - 35_000)
    const sut = new RepoDocumentDO(fixture.ctx as any, lazyEnv)
    await sut.onLoad()

    const conn = makeConn('browser-1')
    await sut.onConnect(
      conn as any,
      makeReqCtx(`wss://orch/repo/proj:foo.md?projectId=${projectId}`),
    )

    await fireDebounce()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const stamped = fixture.kv.get('lastSpawnAttempt') as number
    expect(typeof stamped).toBe('number')
    expect(Math.abs(stamped - Date.now())).toBeLessThan(2500)
  })
})
