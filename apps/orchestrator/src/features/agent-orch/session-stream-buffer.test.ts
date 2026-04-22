/**
 * Regression test for the pre-subscribe frame buffer in
 * `subscribeSessionStream` / `dispatchSessionFrame`.
 *
 * Bug: on session switch the DO's onConnect history burst can arrive before
 * the messages-collection's inner sync registers its subscriber (because
 * `persistedCollectionOptions` queues the inner sync behind an `await
 * runtime.ensureStartupMetadataLoaded()`). Without a buffer those frames
 * were silently dropped by `dispatchSessionFrame` and the message list
 * only populated on a later WS reconnect cycle.
 *
 * Contract under test: frames dispatched while no subscriber is attached
 * are delivered to the first subscriber that registers for that sessionId,
 * in order, modulo the 5s TTL.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  __dispatchSessionFrameForTests,
  __resetSessionStreamForTests,
  subscribeSessionStream,
} from './use-coding-agent'

const sid = 'sess-buf-test'

const frame = (collection: string, id: string): SyncedCollectionFrame<unknown> => ({
  type: 'synced-collection-delta',
  collection,
  ops: [{ type: 'insert', value: { id } }],
})

afterEach(() => {
  __resetSessionStreamForTests()
  vi.useRealTimers()
})

describe('session-stream pre-subscribe buffer', () => {
  test('delivers frames dispatched before subscribe to the first subscriber', () => {
    __dispatchSessionFrameForTests(sid, frame(`messages:${sid}`, 'm1'))
    __dispatchSessionFrameForTests(sid, frame(`messages:${sid}`, 'm2'))

    const received: string[] = []
    const unsub = subscribeSessionStream(sid, (f) => {
      const op = f.ops[0]
      if (op && op.type === 'insert') {
        received.push((op.value as { id: string }).id)
      }
    })

    expect(received).toEqual(['m1', 'm2'])
    unsub()
  })

  test('drains buffer only once — a second subscriber sees only live frames', () => {
    __dispatchSessionFrameForTests(sid, frame(`messages:${sid}`, 'pre'))

    const a: string[] = []
    const b: string[] = []
    const unsubA = subscribeSessionStream(sid, (f) => {
      const op = f.ops[0]
      if (op && op.type === 'insert') a.push((op.value as { id: string }).id)
    })
    const unsubB = subscribeSessionStream(sid, (f) => {
      const op = f.ops[0]
      if (op && op.type === 'insert') b.push((op.value as { id: string }).id)
    })

    expect(a).toEqual(['pre'])
    expect(b).toEqual([])

    __dispatchSessionFrameForTests(sid, frame(`messages:${sid}`, 'live'))
    expect(a).toEqual(['pre', 'live'])
    expect(b).toEqual(['live'])

    unsubA()
    unsubB()
  })

  test('drops buffered frames older than the 5s TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    __dispatchSessionFrameForTests(sid, frame(`messages:${sid}`, 'stale'))
    vi.setSystemTime(6000)
    __dispatchSessionFrameForTests(sid, frame(`messages:${sid}`, 'fresh'))

    const received: string[] = []
    const unsub = subscribeSessionStream(sid, (f) => {
      const op = f.ops[0]
      if (op && op.type === 'insert') received.push((op.value as { id: string }).id)
    })

    // 'stale' pre-dates the TTL (6000 - 0 > 5000) and must be dropped during
    // the dispatch-side prune inside dispatchSessionFrame, leaving only
    // 'fresh' to drain into the subscriber.
    expect(received).toEqual(['fresh'])
    unsub()
  })

  test('buffer is per-sessionId — subscribing to A does not drain B', () => {
    __dispatchSessionFrameForTests('sess-a', frame('messages:sess-a', 'a1'))
    __dispatchSessionFrameForTests('sess-b', frame('messages:sess-b', 'b1'))

    const a: string[] = []
    const unsubA = subscribeSessionStream('sess-a', (f) => {
      const op = f.ops[0]
      if (op && op.type === 'insert') a.push((op.value as { id: string }).id)
    })
    expect(a).toEqual(['a1'])

    // B's frame must still be waiting for its own subscriber.
    const b: string[] = []
    const unsubB = subscribeSessionStream('sess-b', (f) => {
      const op = f.ops[0]
      if (op && op.type === 'insert') b.push((op.value as { id: string }).id)
    })
    expect(b).toEqual(['b1'])

    unsubA()
    unsubB()
  })
})
