// SessionCollabDOv2 unit tests — covers the "draft text vanishes after
// switching tabs" bug. Repro: a single client connects, types into the
// shared Y.Doc, then disconnects. With y-partyserver's debounced onSave
// (2s wait), zero remaining connections → DO is hibernation-eligible and
// the pending setTimeout is evicted before it fires. The fix overrides
// onClose so the last departing connection flushes synchronously to
// SQLite before hibernation can drop the in-memory state.
//
// We mock the y-partyserver YServer base so the test stays unit-style —
// no Worker / Miniflare required. The mock implements the bits the SUT
// touches: a Y.Doc field, a connections set, and the base onClose's
// awareness-cleanup contract (a no-op stub is sufficient).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

// In-memory connection set the mocked YServer base shares with tests.
const mockConnections = new Set<{ id: string; readyState: number }>()

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
    // Mirrors partyserver's getConnections(): OPEN-only iterator.
    *getConnections() {
      for (const c of mockConnections) {
        if (c.readyState === 1) yield c as any
      }
    }
    // Base onClose: y-partyserver cleans up awareness state. Tests don't
    // need that bookkeeping; just record that super was called.
    async onClose(_conn: unknown, _code: number, _reason: string, _wasClean: boolean) {
      ;(YServer as any)._superOnCloseCalls++
    }
    static _superOnCloseCalls = 0
  }
  return { YServer }
})

import { SessionCollabDOv2 } from './session-collab-do'

// ── Fake DurableObjectState ────────────────────────────────────────────

interface SqlRow {
  id: string
  data: Uint8Array
  updated_at: number
}

function makeCtx() {
  // Minimal in-memory stand-in for `ctx.storage.sql.exec`. Recognises just
  // the three statements the SUT issues: CREATE TABLE, SELECT, INSERT OR
  // REPLACE. Anything else is logged as an unhandled exec for visibility.
  const rows = new Map<string, SqlRow>()
  const execLog: string[] = []
  const sqlExec = vi.fn((sql: string, ...params: unknown[]) => {
    execLog.push(sql.trim().slice(0, 60))
    const trimmed = sql.trim()
    if (/^CREATE TABLE/i.test(trimmed)) {
      return { toArray: () => [] }
    }
    if (/^SELECT/i.test(trimmed)) {
      const r = rows.get('snapshot')
      return { toArray: () => (r ? [{ data: r.data }] : []) }
    }
    if (/^INSERT OR REPLACE/i.test(trimmed)) {
      const [data, updated_at] = params as [Uint8Array, number]
      rows.set('snapshot', { id: 'snapshot', data, updated_at })
      return { toArray: () => [] }
    }
    return { toArray: () => [] }
  })
  return {
    ctx: { storage: { sql: { exec: sqlExec } } },
    rows,
    execLog,
  }
}

function makeConn(id: string, readyState = 1) {
  const conn = { id, readyState }
  mockConnections.add(conn)
  return conn
}

beforeEach(() => {
  mockConnections.clear()
})

// ── Tests ──────────────────────────────────────────────────────────────

describe('SessionCollabDOv2 draft persistence', () => {
  it('flushes the latest Y.Doc state to SQLite when the last connection closes', async () => {
    const { ctx, rows } = makeCtx()
    const sut = new SessionCollabDOv2(ctx as any, {} as any)

    // (a) Bootstrap — onLoad runs CREATE TABLE; no prior snapshot.
    await sut.onLoad()

    // (b) One connection.
    const conn = makeConn('conn-1', /* OPEN */ 1)

    // (c) Y.Doc update applied (simulate user typing into a Y.Text).
    const text = sut.document.getText('draft')
    text.insert(0, 'unsaved draft text')

    // Sanity: nothing persisted yet — debounce hasn't fired and we haven't
    // flushed manually. Snapshot row is empty.
    expect(rows.has('snapshot')).toBe(false)

    // (d) Connection closes. Mark socket as no-longer-OPEN before invoking
    // onClose so getConnections() reflects the post-close active set —
    // matches partyserver's real ordering (webSocketClose fires after
    // the underlying socket has transitioned away from OPEN).
    conn.readyState = 3 // CLOSED

    await sut.onClose(conn as any, 1000, 'tab switch', true)

    // Assertion: y_state row reflects the in-memory Y.Doc *now*, without
    // waiting for the 2s debounce. This is the regression guard.
    const persisted = rows.get('snapshot')
    expect(persisted).toBeDefined()

    // Round-trip the bytes — applying the snapshot to a fresh Doc must
    // recover the typed text.
    const replay = new Y.Doc()
    Y.applyUpdate(replay, persisted!.data)
    expect(replay.getText('draft').toString()).toBe('unsaved draft text')
  })

  it('does NOT flush when other connections remain after a close', async () => {
    const { ctx, rows } = makeCtx()
    const sut = new SessionCollabDOv2(ctx as any, {} as any)
    await sut.onLoad()

    const conn1 = makeConn('conn-1', 1)
    makeConn('conn-2', 1) // peer stays OPEN

    sut.document.getText('draft').insert(0, 'still being edited')

    conn1.readyState = 3
    await sut.onClose(conn1 as any, 1000, '', true)

    // Peer is still connected — we let the existing debounced onSave handle
    // it. No extra synchronous flush on close.
    expect(rows.has('snapshot')).toBe(false)
  })

  it('still calls super.onClose so awareness cleanup runs', async () => {
    // Pull the mocked YServer back out so we can read its call counter.
    const { YServer } = (await import('y-partyserver')) as any
    YServer._superOnCloseCalls = 0

    const { ctx } = makeCtx()
    const sut = new SessionCollabDOv2(ctx as any, {} as any)
    await sut.onLoad()

    const conn = makeConn('conn-1', 1)
    conn.readyState = 3
    await sut.onClose(conn as any, 1000, '', true)

    expect(YServer._superOnCloseCalls).toBe(1)
  })
})
