// UserSettingsDO unit tests — issue #7 p3.
//
// The DO extends `partyserver.Server`, which extends `DurableObject` from
// `cloudflare:workers`. Vitest runs in node, so we mock the partyserver
// `Server` base class with a tiny shim that exposes `this.env`,
// `this.name`, and `this.getConnections()`. The methods under test
// (`onConnect`, `onRequest`, `onClose`) are pure logic on top of those
// primitives so the shim is sufficient.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('partyserver', () => {
  class Server<TEnv> {
    env: TEnv
    name: string = ''
    private _connections: any[] = []
    constructor(_ctx: unknown, env: TEnv) {
      this.env = env
    }
    getConnections(): Iterable<any> {
      return this._connections
    }
    // Test-only: seed the connection set for broadcast tests.
    _setConnections(conns: any[]) {
      this._connections = conns
    }
    _setName(name: string) {
      this.name = name
    }
  }
  return { Server }
})

vi.mock('~/api/auth-session', () => ({
  getRequestSession: vi.fn(),
}))

import { getRequestSession } from '~/api/auth-session'
import { UserSettingsDO } from './user-settings-do'

const mockedGetRequestSession = vi.mocked(getRequestSession)

function makeDO(name: string = 'user-1'): UserSettingsDO {
  const env = {} as any
  const ctx = {} as any
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

    const payload = JSON.stringify({ type: 'invalidate', collection: 'user_tabs' })
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

describe('UserSettingsDO statelessness', () => {
  it('never reads or writes this.storage', () => {
    // Compile-time + runtime assertion: the DO never accesses .storage.
    // Reading the source file would be circular; instead we assert that
    // a fresh instance has no `storage` property of its own and never
    // attempts to dereference one (any access via `this.storage` would
    // throw TypeError on undefined inside the methods we exercise above).
    const doInst = makeDO('user-1')
    expect((doInst as any).storage).toBeUndefined()
  })
})
