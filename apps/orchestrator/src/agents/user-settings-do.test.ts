// UserSettingsDO unit tests — plain-DurableObject hibernation-API rewrite
// (GH#32 phase p2a). The DO now owns a Set<WebSocket>, fans out
// `synced-collection-delta` frames via POST /broadcast, and refcounts
// presence into the `user_presence` D1 table on 0→1 / N→0 transitions.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock cloudflare:workers DurableObject base class.
vi.mock('cloudflare:workers', () => {
  class DurableObject<T = unknown> {
    ctx: any
    env: T
    constructor(ctx: unknown, env: T) {
      this.ctx = ctx as any
      this.env = env
    }
  }
  return { DurableObject }
})

// Mock drizzle/d1 — the DO's only D1 interaction is presence insert/delete.
const insertCalls: any[] = []
const deleteCalls: any[] = []
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    insert: (table: unknown) => ({
      values: (vals: unknown) => ({
        onConflictDoNothing: async () => {
          insertCalls.push({ table, vals })
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (clause: unknown) => {
        deleteCalls.push({ table, clause })
      },
    }),
  }),
}))

vi.mock(import('drizzle-orm'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    eq: ((a: unknown, b: unknown) => ({ a, b })) as any,
  }
})

vi.mock('~/api/auth-session', () => ({
  getRequestSession: vi.fn(),
}))

import { getRequestSession } from '~/api/auth-session'
import { UserSettingsDO } from './user-settings-do'

const mockedGetRequestSession = vi.mocked(getRequestSession)

// ── Fake DurableObjectState ─────────────────────────────────────────────

function makeCtx() {
  const accepted: WebSocket[] = []
  const attachments = new WeakMap<WebSocket, unknown>()
  const sqlExec = vi.fn(() => ({ toArray: () => [] }))
  const ctx = {
    storage: { sql: { exec: sqlExec } },
    acceptWebSocket: vi.fn((ws: WebSocket) => {
      accepted.push(ws)
    }),
    getWebSockets: () => [] as WebSocket[],
    _accepted: accepted,
    _attachments: attachments,
  }
  return ctx
}

function fakeSocket(): WebSocket {
  const sent: string[] = []
  let attached: unknown = null
  const ws = {
    send: vi.fn((msg: string) => {
      sent.push(msg)
    }),
    close: vi.fn(),
    serializeAttachment: vi.fn((v: unknown) => {
      attached = v
    }),
    deserializeAttachment: vi.fn(() => attached),
    _sent: sent,
  } as unknown as WebSocket
  return ws
}

function makeDO(envOverrides: Record<string, unknown> = {}) {
  const ctx = makeCtx()
  const env = {
    AUTH_DB: {} as any,
    SYNC_BROADCAST_SECRET: 'test-secret',
    ...envOverrides,
  } as any
  // Patch WebSocketPair globally — test environment may not define it.
  if (typeof (globalThis as any).WebSocketPair === 'undefined') {
    ;(globalThis as any).WebSocketPair = class {
      0: WebSocket
      1: WebSocket
      constructor() {
        this[0] = fakeSocket()
        this[1] = fakeSocket()
      }
    }
  }
  const instance = new UserSettingsDO(ctx as any, env)
  return { instance, ctx, env }
}

describe('UserSettingsDO constructor', () => {
  it('drops the legacy y_state table on init', () => {
    const { ctx } = makeDO()
    const execCalls = (ctx.storage.sql.exec as any).mock.calls.map((c: any[]) => c[0])
    expect(execCalls.some((s: string) => /DROP TABLE IF EXISTS y_state/.test(s))).toBe(true)
  })

  it('rehydrates sockets and userId from hibernation store', () => {
    const ctx = makeCtx()
    const ws = fakeSocket()
    ;(ws.deserializeAttachment as any).mockReturnValue({ userId: 'rehydrated-user' })
    ctx.getWebSockets = () => [ws]
    const env = { AUTH_DB: {}, SYNC_BROADCAST_SECRET: 'x' } as any
    const instance = new UserSettingsDO(ctx as any, env)
    // @ts-expect-error — reach into private set for verification
    expect(instance.sockets.has(ws)).toBe(true)
    // @ts-expect-error — private
    expect(instance.userId).toBe('rehydrated-user')
  })
})

describe('UserSettingsDO /broadcast', () => {
  beforeEach(() => {
    insertCalls.length = 0
    deleteCalls.length = 0
  })

  it('rejects with 401 when Authorization header mismatches', async () => {
    const { instance } = makeDO()
    const req = new Request('http://do/broadcast', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: JSON.stringify({ type: 'synced-collection-delta', collection: 'x', ops: [] }),
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(401)
  })

  it('rejects with 405 when method is not POST', async () => {
    const { instance } = makeDO()
    const req = new Request('http://do/broadcast', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-secret' },
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(405)
  })

  it('rejects invalid JSON with 400', async () => {
    const { instance } = makeDO()
    const req = new Request('http://do/broadcast', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(400)
  })

  it('rejects invalid frame shape with 400', async () => {
    const { instance } = makeDO()
    const req = new Request('http://do/broadcast', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret' },
      body: JSON.stringify({ type: 'other' }),
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(400)
  })

  it('broadcasts a valid frame to every live socket', async () => {
    const { instance } = makeDO()
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    // @ts-expect-error — seed private set
    instance.sockets.add(s1)
    // @ts-expect-error — seed private set
    instance.sockets.add(s2)

    const frame = {
      type: 'synced-collection-delta',
      collection: 'agent_sessions',
      ops: [{ type: 'insert', value: { id: 's1' } }],
    }
    const payload = JSON.stringify(frame)
    const req = new Request('http://do/broadcast', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret' },
      body: payload,
    })

    const res = await instance.fetch(req)
    expect(res.status).toBe(204)
    expect(s1.send as any).toHaveBeenCalledWith(payload)
    expect(s2.send as any).toHaveBeenCalledWith(payload)
  })

  it('removes sockets whose send() throws and continues', async () => {
    const { instance } = makeDO()
    const s1 = fakeSocket()
    ;(s1.send as any).mockImplementationOnce(() => {
      throw new Error('gone')
    })
    const s2 = fakeSocket()
    // @ts-expect-error — seed private set
    instance.sockets.add(s1)
    // @ts-expect-error — seed private set
    instance.sockets.add(s2)

    const frame = { type: 'synced-collection-delta', collection: 'x', ops: [] }
    const req = new Request('http://do/broadcast', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret' },
      body: JSON.stringify(frame),
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(204)
    // @ts-expect-error — private
    expect(instance.sockets.has(s1)).toBe(false)
    // @ts-expect-error — private
    expect(instance.sockets.has(s2)).toBe(true)
  })

  it('returns 404 for unknown paths', async () => {
    const { instance } = makeDO()
    const req = new Request('http://do/other', { method: 'GET' })
    const res = await instance.fetch(req)
    expect(res.status).toBe(404)
  })
})

describe('UserSettingsDO WebSocket upgrade', () => {
  beforeEach(() => {
    mockedGetRequestSession.mockReset()
    insertCalls.length = 0
    deleteCalls.length = 0
  })

  it('rejects unauthenticated upgrades with 401', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const { instance } = makeDO()
    const req = new Request('http://do/parties/user-settings/u1', {
      headers: { Upgrade: 'websocket' },
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(401)
  })

  it('rejects cross-user upgrades with 403 when ?userId mismatches', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'attacker',
      role: 'user',
      session: {},
      user: {},
    })
    const { instance } = makeDO()
    const req = new Request('http://do/ws?userId=victim', {
      headers: { Upgrade: 'websocket' },
    })
    const res = await instance.fetch(req)
    expect(res.status).toBe(403)
  })

  it('accepts the socket and inserts presence on 0→1 transition', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'u1',
      role: 'user',
      session: {},
      user: {},
    })
    const { instance, ctx } = makeDO()
    const req = new Request('http://do/parties/user-settings/u1', {
      headers: { Upgrade: 'websocket' },
    })
    // The DO returns `new Response(null, { status: 101, webSocket })` which
    // the CF Workers runtime permits but the undici Response constructor in
    // the vitest env does not — we swallow the constructor error since the
    // side effects we care about (acceptWebSocket, presence insert) have
    // already fired by the time the Response is constructed.
    try {
      await instance.fetch(req)
    } catch (err) {
      if (!/status/.test(String(err))) throw err
    }
    expect(ctx.acceptWebSocket).toHaveBeenCalledOnce()
    // @ts-expect-error — private
    expect(instance.sockets.size).toBe(1)
    expect(insertCalls.length).toBe(1)
    expect((insertCalls[0].vals as any).userId).toBe('u1')
  })

  it('does NOT re-insert presence when sockets set was already non-empty', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'u1',
      role: 'user',
      session: {},
      user: {},
    })
    const { instance } = makeDO()
    // Pre-seed an existing socket so the new upgrade is the 1→2 transition.
    // @ts-expect-error — private
    instance.sockets.add(fakeSocket())
    const req = new Request('http://do/ws', { headers: { Upgrade: 'websocket' } })
    try {
      await instance.fetch(req)
    } catch (err) {
      if (!/status/.test(String(err))) throw err
    }
    expect(insertCalls.length).toBe(0)
  })
})

describe('UserSettingsDO.webSocketClose / webSocketError', () => {
  beforeEach(() => {
    insertCalls.length = 0
    deleteCalls.length = 0
  })

  it('removes socket and clears presence on N→0 transition', async () => {
    const { instance } = makeDO()
    const ws = fakeSocket()
    // @ts-expect-error — private
    instance.sockets.add(ws)
    // @ts-expect-error — private
    instance.userId = 'u1'
    await instance.webSocketClose(ws, 1000, '', true)
    // @ts-expect-error — private
    expect(instance.sockets.size).toBe(0)
    expect(deleteCalls.length).toBe(1)
  })

  it('does NOT clear presence while other sockets remain', async () => {
    const { instance } = makeDO()
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    // @ts-expect-error — private
    instance.sockets.add(s1)
    // @ts-expect-error — private
    instance.sockets.add(s2)
    // @ts-expect-error — private
    instance.userId = 'u1'
    await instance.webSocketClose(s1, 1000, '', true)
    expect(deleteCalls.length).toBe(0)
  })

  it('also cleans up on webSocketError', async () => {
    const { instance } = makeDO()
    const ws = fakeSocket()
    // @ts-expect-error — private
    instance.sockets.add(ws)
    // @ts-expect-error — private
    instance.userId = 'u1'
    await instance.webSocketError(ws, new Error('boom'))
    // @ts-expect-error — private
    expect(instance.sockets.size).toBe(0)
    expect(deleteCalls.length).toBe(1)
  })
})
