// UserSettingsDO unit tests — updated for YServer-based implementation.
//
// The DO now extends y-partyserver's `YServer` (which extends
// partyserver's `Server`). We mock both to provide the test shim with
// `this.env`, `this.name`, `this.getConnections()`, and `this.document`.
// Auth and /notify are pure logic on top of those primitives.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

// Mock y-partyserver's YServer with a shim that exposes what our DO needs.
vi.mock('y-partyserver', () => {
  class YServer {
    env: any
    name: string = ''
    document: Y.Doc = new Y.Doc()
    ctx: any
    private _connections: any[] = []
    constructor(ctx: unknown, env: any) {
      this.env = env
      this.ctx = ctx
    }
    getConnections(): Iterable<any> {
      return this._connections
    }
    // Test-only helpers
    _setConnections(conns: any[]) {
      this._connections = conns
    }
    _setName(name: string) {
      this.name = name
    }
    // onConnect stub — YServer's base does nothing we need for tests
    async onConnect(_conn: any, _ctx: any) {}
  }
  return { YServer }
})

vi.mock('~/api/auth-session', () => ({
  getRequestSession: vi.fn(),
}))

import { getRequestSession } from '~/api/auth-session'
import { UserSettingsDO } from './user-settings-do'

const mockedGetRequestSession = vi.mocked(getRequestSession)

function makeDO(name: string = 'user-1'): UserSettingsDO {
  const env = {} as any
  // Provide a ctx with storage.sql for the ensureTable/onLoad/onSave path.
  const sqlExec = vi.fn(() => ({ toArray: () => [] }))
  const ctx = { storage: { sql: { exec: sqlExec } } } as any
  const instance = new UserSettingsDO(ctx, env)
  ;(instance as any)._setName(name)
  return instance
}

function makeConn() {
  const closed: Array<{ code: number; reason: string }> = []
  const sent: string[] = []
  const conn = {
    close: vi.fn((code: number, reason: string) => {
      closed.push({ code, reason })
    }),
    send: vi.fn((msg: string) => {
      sent.push(msg)
    }),
    closed,
    sent,
  }
  return conn
}

describe('UserSettingsDO.onConnect', () => {
  beforeEach(() => {
    mockedGetRequestSession.mockReset()
  })

  it('closes 4401 when no auth session', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const doInst = makeDO('user-1')
    const conn = makeConn()
    const ctx = { request: new Request('http://x/parties/user-settings/user-1') }

    await doInst.onConnect(conn as any, ctx as any)

    expect(conn.close).toHaveBeenCalledOnce()
    expect(conn.closed[0]).toEqual({ code: 4401, reason: 'unauthenticated' })
  })

  it('closes 4403 when room userId does not match session userId', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'attacker',
      role: 'user',
      session: {},
      user: {},
    })
    const doInst = makeDO('victim')
    const conn = makeConn()
    const ctx = { request: new Request('http://x/parties/user-settings/victim') }

    await doInst.onConnect(conn as any, ctx as any)

    expect(conn.close).toHaveBeenCalledOnce()
    expect(conn.closed[0]).toEqual({ code: 4403, reason: 'forbidden' })
  })

  it('does not close when room userId equals session userId', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      session: {},
      user: {},
    })
    const doInst = makeDO('user-1')
    const conn = makeConn()
    const ctx = { request: new Request('http://x/parties/user-settings/user-1') }

    await doInst.onConnect(conn as any, ctx as any)

    expect(conn.close).not.toHaveBeenCalled()
  })
})

describe('UserSettingsDO.onRequest', () => {
  it('broadcasts /notify body verbatim to every connection', async () => {
    const doInst = makeDO('user-1')
    const c1 = makeConn()
    const c2 = makeConn()
    ;(doInst as any)._setConnections([c1, c2])

    const payload = JSON.stringify({ type: 'invalidate', collection: 'agent_sessions' })
    const req = new Request('http://do/notify', { method: 'POST', body: payload })

    const res = await doInst.onRequest(req)

    expect(res.status).toBe(204)
    expect(c1.send).toHaveBeenCalledWith(payload)
    expect(c2.send).toHaveBeenCalledWith(payload)
  })

  it('swallows send() errors and continues to remaining connections', async () => {
    const doInst = makeDO('user-1')
    const c1 = makeConn()
    c1.send = vi.fn(() => {
      throw new Error('socket gone')
    })
    const c2 = makeConn()
    ;(doInst as any)._setConnections([c1, c2])

    const req = new Request('http://do/notify', { method: 'POST', body: 'x' })
    const res = await doInst.onRequest(req)

    expect(res.status).toBe(204)
    expect(c2.send).toHaveBeenCalledWith('x')
  })

  it('returns 404 for non-/notify paths', async () => {
    const doInst = makeDO('user-1')
    const req = new Request('http://do/other', { method: 'POST' })
    const res = await doInst.onRequest(req)
    expect(res.status).toBe(404)
  })

  it('returns 404 for /notify with non-POST method', async () => {
    const doInst = makeDO('user-1')
    const req = new Request('http://do/notify', { method: 'GET' })
    const res = await doInst.onRequest(req)
    expect(res.status).toBe(404)
  })
})

describe('UserSettingsDO Y.Doc', () => {
  it('has a Y.Doc with openTabs array and workspace map', async () => {
    const doInst = makeDO('user-1')
    // onLoad creates the y_state table and restores from snapshot
    await doInst.onLoad()
    const doc = (doInst as any).document as Y.Doc
    expect(doc.getArray('openTabs')).toBeDefined()
    expect(doc.getMap('workspace')).toBeDefined()
  })

  it('onSave snapshots the Y.Doc to SQL', async () => {
    const doInst = makeDO('user-1')
    const sqlExec = (doInst as any).ctx.storage.sql.exec
    await doInst.onLoad()
    // Add a tab to the doc
    const doc = (doInst as any).document as Y.Doc
    doc.getArray<string>('openTabs').push(['session-1'])
    await doInst.onSave()
    // Should have called exec with INSERT OR REPLACE
    const lastCall = sqlExec.mock.calls[sqlExec.mock.calls.length - 1]
    expect(lastCall[0]).toContain('INSERT OR REPLACE')
  })
})
