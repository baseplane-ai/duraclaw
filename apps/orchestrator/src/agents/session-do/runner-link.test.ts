import { describe, expect, it, vi } from 'vitest'
import { mapEffortPref, mapThinkingPref, sendToGateway } from './runner-link'
import type { SessionDOContext } from './types'

/**
 * D1 -> wire-shape converters for user_preferences columns. These are
 * the gatekeepers that translate the flat string columns the API
 * stores into the SDK-shaped fields on `ExecuteCommand`. Anything
 * unknown returns `undefined` so the caller skips the field rather
 * than passing garbage to the SDK; the runner-side defensive guards
 * (`resolvePermissionMode`, `resolveEffort`) only matter if these
 * gatekeepers are bypassed (e.g. a test harness sending raw cmds).
 */

describe('mapThinkingPref', () => {
  it('returns SDK discriminated-union for each known mode', () => {
    expect(mapThinkingPref('adaptive')).toEqual({ type: 'adaptive' })
    expect(mapThinkingPref('enabled')).toEqual({ type: 'enabled' })
    expect(mapThinkingPref('disabled')).toEqual({ type: 'disabled' })
  })

  it('returns undefined for null / undefined / unknown', () => {
    expect(mapThinkingPref(null)).toBeUndefined()
    expect(mapThinkingPref(undefined)).toBeUndefined()
    expect(mapThinkingPref('')).toBeUndefined()
    expect(mapThinkingPref('always')).toBeUndefined()
  })
})

describe('mapEffortPref', () => {
  it('passes SDK-known effort levels through as literals', () => {
    expect(mapEffortPref('low')).toBe('low')
    expect(mapEffortPref('medium')).toBe('medium')
    expect(mapEffortPref('high')).toBe('high')
    expect(mapEffortPref('max')).toBe('max')
  })

  it('passes through SDK-supported `xhigh` (added in SDK 0.2.119)', () => {
    expect(mapEffortPref('xhigh')).toBe('xhigh')
  })

  it('returns undefined for null / undefined / unknown', () => {
    expect(mapEffortPref(null)).toBeUndefined()
    expect(mapEffortPref(undefined)).toBeUndefined()
    expect(mapEffortPref('')).toBeUndefined()
    expect(mapEffortPref('extreme')).toBeUndefined()
  })
})

/**
 * Regression: orphan-user-message bug.
 *
 * Symptom — user POSTs `/messages`, the DO persists `usr-N` with an
 * `awaiting_response` placeholder, and `sendToGateway('stream-input', ...)`
 * runs. If `sendToGateway` silently drops the command (cached connection
 * id refers to a socket that's now stale: `.send()` throws OR id isn't in
 * `getConnections()`), the runner never receives the message AND
 * `planAwaitingTimeout` short-circuits on `connectionId !== null` so the
 * awaiting part never expires. The user sees a stuck "thinking…" bubble
 * forever and re-sends the message.
 *
 * Fix — clear the cached + persisted connection id on either silent-drop
 * path so the watchdog's next tick sees `connectionId === null`, ages the
 * awaiting part out after `RECOVERY_GRACE_MS`, and runs
 * `recoverFromDroppedConnection` (which surfaces a system row prompting
 * the user to retry).
 *
 * Production evidence: session sess-230935d5-...
 * (`/run/duraclaw/sessions/bb574402-....log`) had usr-8, usr-12, usr-16
 * stuck in `awaiting_response` with zero matches in the runner log for
 * any of their `usr-client-<uuid>` ids — the runner literally never
 * received them, and the DO never timed them out.
 */
describe('sendToGateway silent-drop recovery', () => {
  function makeCtx(opts: {
    gwConnId: string | null
    connections: Array<{ id: string; send?: (s: string) => void }>
  }): {
    ctx: SessionDOContext
    sqlExec: ReturnType<typeof vi.fn>
    sendCalls: string[][]
  } {
    const sendCalls: string[][] = []
    const sqlExec = vi.fn()
    const conns = opts.connections.map((c) => ({
      id: c.id,
      send: c.send ?? ((s: string) => sendCalls.push([c.id, s])),
    }))
    let cachedGatewayConnId: string | null = opts.gwConnId
    const ctx = {
      ctx: { id: 'do-test' },
      sql: { exec: sqlExec },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      do: {
        get cachedGatewayConnId() {
          return cachedGatewayConnId
        },
        set cachedGatewayConnId(v: string | null) {
          cachedGatewayConnId = v
        },
        sql: { bind: () => () => [] },
      } as any,
      getConnections: () => conns,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any as SessionDOContext
    return { ctx, sqlExec, sendCalls }
  }

  it('clears the cached + persisted connection id when conn.send throws', () => {
    const throwingConn = {
      id: 'conn-123',
      send: () => {
        throw new Error('socket closed')
      },
    }
    const { ctx, sqlExec } = makeCtx({
      gwConnId: 'conn-123',
      connections: [throwingConn],
    })

    sendToGateway(ctx, {
      type: 'stream-input',
      session_id: 's',
      message: { role: 'user', content: 'x' },
    })

    // Cached id cleared
    expect(ctx.do.cachedGatewayConnId).toBeNull()
    // Persisted id deleted
    expect(sqlExec).toHaveBeenCalledWith(`DELETE FROM kv WHERE key = 'gateway_conn_id'`)
  })

  it('clears the cached + persisted connection id when the recorded id is not in active connections', () => {
    const { ctx, sqlExec } = makeCtx({
      gwConnId: 'conn-stale',
      connections: [{ id: 'conn-other' }], // recorded id not present
    })

    sendToGateway(ctx, {
      type: 'stream-input',
      session_id: 's',
      message: { role: 'user', content: 'x' },
    })

    expect(ctx.do.cachedGatewayConnId).toBeNull()
    expect(sqlExec).toHaveBeenCalledWith(`DELETE FROM kv WHERE key = 'gateway_conn_id'`)
  })

  it('does NOT clear the connection id on a successful send', () => {
    const { ctx, sqlExec, sendCalls } = makeCtx({
      gwConnId: 'conn-ok',
      connections: [{ id: 'conn-ok' }],
    })

    sendToGateway(ctx, {
      type: 'stream-input',
      session_id: 's',
      message: { role: 'user', content: 'x' },
    })

    expect(sendCalls).toHaveLength(1)
    expect(ctx.do.cachedGatewayConnId).toBe('conn-ok')
    expect(sqlExec).not.toHaveBeenCalled()
  })
})
