/**
 * GH#119 P1.2: DuraclavSessionStore unit tests — adapter is a faithful
 * pass-through onto TranscriptRpc.call(method, {key, entries?}).
 *
 * Uses a manual MockRpc rather than `vi.fn()` so we can inspect the
 * captured method/params per call and pre-program a result or error.
 */

import { describe, expect, it } from 'vitest'
import { DuraclavSessionStore } from './session-store-adapter'
import type { TranscriptRpc, TranscriptRpcMethod } from './transcript-rpc'

class MockRpc implements TranscriptRpc {
  calls: Array<{
    method: TranscriptRpcMethod
    params: Record<string, unknown>
    opts?: { timeoutMs?: number }
  }> = []
  result: unknown = null
  error: Error | null = null
  async call<T>(
    method: TranscriptRpcMethod,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    this.calls.push({ method, params, opts })
    if (this.error) throw this.error
    return this.result as T
  }
}

const SAMPLE_KEY = { projectKey: '-data-projects-x', sessionId: 'sess-1' }

describe('DuraclavSessionStore', () => {
  it('append calls appendTranscript with {key, entries} payload', async () => {
    const mock = new MockRpc()
    const store = new DuraclavSessionStore(mock)
    const entries = [
      { type: 'user', uuid: 'u1', timestamp: 't1' },
      { type: 'assistant', uuid: 'u2', timestamp: 't2' },
    ]

    const result = await store.append(SAMPLE_KEY, entries)
    expect(result).toBeUndefined()
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe('appendTranscript')
    expect(mock.calls[0].params).toEqual({ key: SAMPLE_KEY, entries })
  })

  it('load returns rpc result verbatim — null on missing', async () => {
    const mock = new MockRpc()
    mock.result = null
    const store = new DuraclavSessionStore(mock)

    const got = await store.load(SAMPLE_KEY)
    expect(got).toBeNull()
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe('loadTranscript')
    expect(mock.calls[0].params).toEqual({ key: SAMPLE_KEY })
  })

  it('load passes 120s per-call timeout override so the RPC matches the SDK loadTimeoutMs', async () => {
    const mock = new MockRpc()
    mock.result = null
    const store = new DuraclavSessionStore(mock)

    await store.load(SAMPLE_KEY)
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].opts).toEqual({ timeoutMs: 120_000 })
  })

  it('append/delete/listSubkeys keep the RPC default timeout (no override passed)', async () => {
    const mock = new MockRpc()
    mock.result = []
    const store = new DuraclavSessionStore(mock)

    await store.append(SAMPLE_KEY, [{ type: 'user' }])
    await store.delete(SAMPLE_KEY)
    await store.listSubkeys(SAMPLE_KEY)

    expect(mock.calls).toHaveLength(3)
    expect(mock.calls[0].opts).toBeUndefined()
    expect(mock.calls[1].opts).toBeUndefined()
    expect(mock.calls[2].opts).toBeUndefined()
  })

  it('load returns rpc result verbatim — entries array passes through', async () => {
    const mock = new MockRpc()
    const entries = [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]
    mock.result = entries
    const store = new DuraclavSessionStore(mock)

    const got = await store.load(SAMPLE_KEY)
    expect(got).toBe(entries)
  })

  it('load propagates rpc throw — TranscriptRpc cancelled surfaces to caller', async () => {
    const mock = new MockRpc()
    mock.error = new Error('TranscriptRpc cancelled: ws-closed')
    const store = new DuraclavSessionStore(mock)

    await expect(store.load(SAMPLE_KEY)).rejects.toThrow('TranscriptRpc cancelled: ws-closed')
  })

  it('append propagates rpc throw — caller (SDK) drives retry', async () => {
    const mock = new MockRpc()
    mock.error = new Error('TranscriptRpc cancelled: ws-closed')
    const store = new DuraclavSessionStore(mock)

    await expect(store.append(SAMPLE_KEY, [{ type: 'user' }])).rejects.toThrow(
      'TranscriptRpc cancelled: ws-closed',
    )
  })

  it('delete calls deleteTranscript with key payload, returns void', async () => {
    const mock = new MockRpc()
    const store = new DuraclavSessionStore(mock)

    const result = await store.delete(SAMPLE_KEY)
    expect(result).toBeUndefined()
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe('deleteTranscript')
    expect(mock.calls[0].params).toEqual({ key: SAMPLE_KEY })
  })

  it('listSubkeys calls listTranscriptSubkeys with {projectKey, sessionId} and returns string[]', async () => {
    const mock = new MockRpc()
    mock.result = ['subagent-1', 'subagent-2']
    const store = new DuraclavSessionStore(mock)

    const got = await store.listSubkeys(SAMPLE_KEY)
    expect(got).toEqual(['subagent-1', 'subagent-2'])
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe('listTranscriptSubkeys')
    expect(mock.calls[0].params).toEqual({ key: SAMPLE_KEY })
  })
})
