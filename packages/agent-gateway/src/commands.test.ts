import { describe, expect, it, vi } from 'vitest'
import type { QueueableCommand } from './commands.js'
import { handleQueryCommand } from './commands.js'
import type { GatewaySessionContext } from './types.js'

/** Create a mock WebSocket that captures sent messages */
function createMockWs() {
  const sent: string[] = []
  return {
    ws: {
      send(data: string) {
        sent.push(data)
      },
      data: { project: 'test' },
    } as any,
    sent,
    parseLast() {
      return JSON.parse(sent[sent.length - 1])
    },
  }
}

/** Create a mock GatewaySessionContext */
function createMockCtx(overrides?: Partial<GatewaySessionContext>): GatewaySessionContext {
  return {
    sessionId: 'test-session',
    orgId: null,
    userId: null,
    adapterName: null,
    abortController: new AbortController(),
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue: null,
    query: null,
    commandQueue: [],
    ...overrides,
  }
}

describe('handleQueryCommand', () => {
  it('returns error when query is null', async () => {
    const { ws, parseLast } = createMockWs()
    const ctx = createMockCtx({ query: null })
    const cmd: QueueableCommand = { type: 'interrupt', session_id: 'test-session' }

    await handleQueryCommand(ctx, cmd, ws)

    const msg = parseLast()
    expect(msg.type).toBe('error')
    expect(msg.error).toContain('no active Query object')
  })

  it('calls query.interrupt() for interrupt command', async () => {
    const interruptFn = vi.fn().mockResolvedValue(undefined)
    const { ws, sent } = createMockWs()
    const ctx = createMockCtx({
      query: { interrupt: interruptFn } as any,
    })

    await handleQueryCommand(ctx, { type: 'interrupt', session_id: 's1' }, ws)

    expect(interruptFn).toHaveBeenCalledTimes(1)
    expect(sent.length).toBe(0) // no response event for interrupt
  })

  it('calls query.getContextUsage() and sends context_usage event', async () => {
    const usageData = { totalTokens: 5000, maxTokens: 100000, percentage: 5 }
    const getContextUsageFn = vi.fn().mockResolvedValue(usageData)
    const { ws, parseLast } = createMockWs()
    const ctx = createMockCtx({
      query: { getContextUsage: getContextUsageFn } as any,
    })

    await handleQueryCommand(ctx, { type: 'get-context-usage', session_id: 's1' }, ws)

    expect(getContextUsageFn).toHaveBeenCalledTimes(1)
    const msg = parseLast()
    expect(msg.type).toBe('context_usage')
    expect(msg.session_id).toBe('test-session')
    expect(msg.usage.totalTokens).toBe(5000)
  })

  it('calls query.setModel() for set-model command', async () => {
    const setModelFn = vi.fn().mockResolvedValue(undefined)
    const { ws, sent } = createMockWs()
    const ctx = createMockCtx({
      query: { setModel: setModelFn } as any,
    })

    await handleQueryCommand(
      ctx,
      { type: 'set-model', session_id: 's1', model: 'claude-haiku-4-6' },
      ws,
    )

    expect(setModelFn).toHaveBeenCalledTimes(1)
    expect(setModelFn).toHaveBeenCalledWith('claude-haiku-4-6')
    expect(sent.length).toBe(0)
  })

  it('calls query.setModel(undefined) when model is omitted', async () => {
    const setModelFn = vi.fn().mockResolvedValue(undefined)
    const { ws } = createMockWs()
    const ctx = createMockCtx({
      query: { setModel: setModelFn } as any,
    })

    await handleQueryCommand(ctx, { type: 'set-model', session_id: 's1' }, ws)

    expect(setModelFn).toHaveBeenCalledWith(undefined)
  })

  it('calls query.setPermissionMode() for set-permission-mode command', async () => {
    const setPermFn = vi.fn().mockResolvedValue(undefined)
    const { ws, sent } = createMockWs()
    const ctx = createMockCtx({
      query: { setPermissionMode: setPermFn } as any,
    })

    await handleQueryCommand(
      ctx,
      { type: 'set-permission-mode', session_id: 's1', mode: 'acceptEdits' },
      ws,
    )

    expect(setPermFn).toHaveBeenCalledTimes(1)
    expect(setPermFn).toHaveBeenCalledWith('acceptEdits')
    expect(sent.length).toBe(0)
  })
})

describe('command queue drain', () => {
  it('queued commands execute in order when query becomes available', async () => {
    const callOrder: string[] = []
    const { ws } = createMockWs()
    const ctx = createMockCtx({
      query: null,
      commandQueue: [
        { type: 'set-model', session_id: 's1', model: 'claude-haiku-4-6' },
        { type: 'interrupt', session_id: 's1' },
      ],
    })

    // Simulate query becoming available
    ctx.query = {
      setModel: vi.fn().mockImplementation(async () => {
        callOrder.push('set-model')
      }),
      interrupt: vi.fn().mockImplementation(async () => {
        callOrder.push('interrupt')
      }),
    } as any

    // Drain the queue (same pattern as sessions.ts:316-320)
    for (const queuedCmd of ctx.commandQueue) {
      await handleQueryCommand(ctx, queuedCmd, ws)
    }
    ctx.commandQueue = []

    expect(callOrder).toEqual(['set-model', 'interrupt'])
    expect(ctx.commandQueue).toEqual([])
  })

  it('queued commands with null query emit errors', async () => {
    const { ws, sent } = createMockWs()
    const ctx = createMockCtx({ query: null })

    const cmds: QueueableCommand[] = [
      { type: 'interrupt', session_id: 's1' },
      { type: 'get-context-usage', session_id: 's1' },
    ]

    for (const cmd of cmds) {
      await handleQueryCommand(ctx, cmd, ws)
    }

    expect(sent.length).toBe(2)
    expect(JSON.parse(sent[0]).type).toBe('error')
    expect(JSON.parse(sent[1]).type).toBe('error')
  })
})
