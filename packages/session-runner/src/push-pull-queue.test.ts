/**
 * Verification spike for PushPullQueue<T> — load-bearing utility for
 * Reduction B in spec 102-sdk-peelback.md (one Query per session via
 * lifetime AsyncIterable).
 *
 * The spec calls out: if `q.interrupt()` between two pushed messages
 * closes the prompt iterable, B's design is wrong. These tests pin the
 * queue side of the contract; the SDK Query side is verified empirically
 * via live-trace per spec.
 */

import { describe, expect, it } from 'vitest'
import { PushPullQueue } from './push-pull-queue'

describe('PushPullQueue', () => {
  // spec test_case: spike-push-then-iterate
  it('push then iterate yields the pushed item', async () => {
    const q = new PushPullQueue<string>()
    q.push('hello')
    const iter = q[Symbol.asyncIterator]()
    const result = await iter.next()
    expect(result).toEqual({ value: 'hello', done: false })
  })

  // spec test_case: spike-multi-push-fifo
  it('multi-push FIFO order', async () => {
    const q = new PushPullQueue<number>()
    q.push(1)
    q.push(2)
    q.push(3)
    const iter = q[Symbol.asyncIterator]()
    expect((await iter.next()).value).toBe(1)
    expect((await iter.next()).value).toBe(2)
    expect((await iter.next()).value).toBe(3)
  })

  // spec test_case: spike-close-flushes-buffered
  it('close after items flushes buffered then ends', async () => {
    const q = new PushPullQueue<string>()
    q.push('a')
    q.push('b')
    q.close()
    const collected: string[] = []
    for await (const v of q) {
      collected.push(v)
    }
    expect(collected).toEqual(['a', 'b'])
  })

  // spec test_case: spike-close-while-awaiting
  it('close while iterator awaits ends iteration', async () => {
    const q = new PushPullQueue<string>()
    const iter = q[Symbol.asyncIterator]()
    // Buffer is empty; this next() must register a resolver and park.
    const pending = iter.next()
    // Give the microtask queue a tick so the resolver is registered.
    await Promise.resolve()
    q.close()
    const result = await pending
    expect(result.done).toBe(true)
    expect(result.value).toBeUndefined()
  })

  // spec test_case: spike-push-after-close-throws
  it('push after close throws', () => {
    const q = new PushPullQueue<string>()
    q.close()
    expect(() => q.push('x')).toThrow('PushPullQueue: push after close')
  })

  // spec test_case: spike-interrupt-survives-lifetime-iterable
  // This is the load-bearing test. We simulate the contract from
  // Reduction B: between two pushed messages, `q.interrupt()` is invoked
  // on the SDK Query — but it must NOT touch the prompt iterable. We
  // model that here by calling a noop in place of `query.interrupt()`
  // and verifying the queue/iterator survive: the next push is consumed
  // by the *same* iterator, which has not ended.
  //
  // This proves the queue side of the contract; the SDK Query side
  // (that `interrupt()` does not close the prompt iterable) is verified
  // empirically via live-trace per spec.
  it("lifetime simulation — interrupt-doesn't-touch-queue", async () => {
    const q = new PushPullQueue<{ id: number }>()
    const iter = q[Symbol.asyncIterator]()

    q.push({ id: 1 })
    const r1 = await iter.next()
    expect(r1.done).toBe(false)
    expect(r1.value).toEqual({ id: 1 })

    // Stand-in for `query.interrupt()` — the SDK call that the spec's
    // load-bearing assumption says MUST NOT close the prompt iterable.
    const fakeQueryInterrupt = (): void => {
      /* noop — interrupt targets the Query, not the queue */
    }
    fakeQueryInterrupt()

    q.push({ id: 2 })
    const r2 = await iter.next()
    expect(r2.done).toBe(false)
    expect(r2.value).toEqual({ id: 2 })
  })
})
