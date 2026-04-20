// UserSettingsDO /broadcast fanout tests — complements user-settings-do.test.ts
// with the focused scenarios from GH#32 phase p2b unit 4:
//   - Two WS clients on the same DO → POST /broadcast → both receive.
//   - Malformed body → 400.
//   - Missing bearer → 401.
//   - >256 KiB body → 413.
//   - Socket send() throws → that socket is removed, others still get the frame.

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => {},
      }),
    }),
    delete: () => ({
      where: async () => {},
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

import { UserSettingsDO } from './user-settings-do'

function makeCtx() {
  const sqlExec = vi.fn(() => ({ toArray: () => [] }))
  return {
    storage: { sql: { exec: sqlExec } },
    acceptWebSocket: vi.fn(),
    getWebSockets: () => [] as WebSocket[],
  }
}

function fakeSocket(): WebSocket {
  const sent: string[] = []
  return {
    send: vi.fn((msg: string) => {
      sent.push(msg)
    }),
    close: vi.fn(),
    _sent: sent,
  } as unknown as WebSocket
}

function makeDO() {
  const ctx = makeCtx()
  const env = {
    AUTH_DB: {} as any,
    SYNC_BROADCAST_SECRET: 'test-secret',
  } as any
  const instance = new UserSettingsDO(ctx as any, env)
  return { instance, ctx, env }
}

describe('UserSettingsDO /broadcast fanout (p2b unit 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fans the frame out to both connected WS clients on the same room', async () => {
    const { instance } = makeDO()
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    // @ts-expect-error — seed private set (matches existing harness in sibling file)
    instance.sockets.add(s1)
    // @ts-expect-error — seed private set
    instance.sockets.add(s2)

    const frame = {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      ops: [{ type: 'insert', value: { id: 't1', userId: 'u1', position: 0 } }],
    }
    const body = JSON.stringify(frame)
    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
        body,
      }),
    )

    expect(res.status).toBe(204)
    expect(s1.send as any).toHaveBeenCalledTimes(1)
    expect(s2.send as any).toHaveBeenCalledTimes(1)
    expect((s1.send as any).mock.calls[0][0]).toBe(body)
    expect((s2.send as any).mock.calls[0][0]).toBe(body)
  })

  it('returns 401 when Authorization header is missing', async () => {
    const { instance } = makeDO()
    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        body: JSON.stringify({ type: 'synced-collection-delta', collection: 'x', ops: [] }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for malformed frame shape (ops missing)', async () => {
    const { instance } = makeDO()
    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
        body: JSON.stringify({ type: 'synced-collection-delta', collection: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for malformed op (delete with value instead of key)', async () => {
    const { instance } = makeDO()
    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
        body: JSON.stringify({
          type: 'synced-collection-delta',
          collection: 'x',
          ops: [{ type: 'delete', value: { id: 'a' } }],
        }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 413 when Content-Length exceeds 256 KiB', async () => {
    const { instance } = makeDO()
    // Don't actually send 256KiB — advertise it via header. The DO
    // short-circuits before reading the body.
    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-secret',
          'Content-Length': String(256 * 1024 + 1),
        },
        body: '{}',
      }),
    )
    expect(res.status).toBe(413)
  })

  it('returns 413 when the JSON body exceeds 256 KiB (post-parse guard)', async () => {
    const { instance } = makeDO()
    // Build a frame whose serialised size exceeds the 256 KiB cap — each
    // op value carries a ~4 KiB padding string, so ~80 ops pushes past the
    // limit.
    const bigVal = 'x'.repeat(4096)
    const ops = Array.from({ length: 80 }, (_, i) => ({
      type: 'insert' as const,
      value: { id: `t${i}`, pad: bigVal },
    }))
    const frame = { type: 'synced-collection-delta', collection: 'x', ops }
    const body = JSON.stringify(frame)
    expect(body.length).toBeGreaterThan(256 * 1024)

    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
        // Intentionally omit Content-Length so we exercise the post-parse guard.
        body,
      }),
    )
    expect(res.status).toBe(413)
  })

  it('drops a throwing socket but still delivers to the rest', async () => {
    const { instance } = makeDO()
    const bad = fakeSocket()
    ;(bad.send as any).mockImplementation(() => {
      throw new Error('socket dead')
    })
    const good = fakeSocket()
    // @ts-expect-error — seed private set
    instance.sockets.add(bad)
    // @ts-expect-error — seed private set
    instance.sockets.add(good)

    const res = await instance.fetch(
      new Request('http://do/broadcast', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-secret' },
        body: JSON.stringify({ type: 'synced-collection-delta', collection: 'x', ops: [] }),
      }),
    )
    expect(res.status).toBe(204)
    // @ts-expect-error — private
    expect(instance.sockets.has(bad)).toBe(false)
    // @ts-expect-error — private
    expect(instance.sockets.has(good)).toBe(true)
    expect(good.send as any).toHaveBeenCalledTimes(1)
  })
})
