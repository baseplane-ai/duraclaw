/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionRegistry } from '../registry'
import type { ManagedConnection } from '../types'

function makeConn(id: string): ManagedConnection {
  return {
    id,
    kind: 'partysocket',
    readyState: 1,
    lastSeenTs: Date.now(),
    reconnect: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

afterEach(() => {
  connectionRegistry.__resetForTests()
})

describe('connectionRegistry', () => {
  it('register + snapshot preserves insertion order', () => {
    const a = makeConn('a')
    const b = makeConn('b')
    connectionRegistry.register(a)
    connectionRegistry.register(b)
    expect(connectionRegistry.snapshot().map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('unregister removes and returns the prior entry', () => {
    const a = makeConn('a')
    connectionRegistry.register(a)
    const removed = connectionRegistry.unregister('a')
    expect(removed).toBe(a)
    expect(connectionRegistry.snapshot()).toHaveLength(0)
  })

  it('unregister of unknown id is a silent no-op returning undefined', () => {
    expect(connectionRegistry.unregister('nope')).toBeUndefined()
  })

  it('returned unregister fn removes the entry', () => {
    const a = makeConn('a')
    const unreg = connectionRegistry.register(a)
    expect(connectionRegistry.snapshot()).toHaveLength(1)
    unreg()
    expect(connectionRegistry.snapshot()).toHaveLength(0)
  })

  it('double-register of same id replaces prior; prior unreg fn becomes a no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a1 = makeConn('x')
      const a2 = makeConn('x')
      const unreg1 = connectionRegistry.register(a1)
      const unreg2 = connectionRegistry.register(a2)
      expect(connectionRegistry.snapshot()).toEqual([a2])
      unreg1() // should be a no-op
      expect(connectionRegistry.snapshot()).toEqual([a2])
      unreg2()
      expect(connectionRegistry.snapshot()).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('onChange fires once per register and once per unregister', () => {
    const fn = vi.fn()
    const unsub = connectionRegistry.onChange(fn)
    const a = makeConn('a')
    const unreg = connectionRegistry.register(a)
    expect(fn).toHaveBeenCalledTimes(1)
    unreg()
    expect(fn).toHaveBeenCalledTimes(2)
    unsub()
    connectionRegistry.register(a)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('onChange receives the post-change snapshot', () => {
    const seen: Array<string[]> = []
    connectionRegistry.onChange((snap) => {
      seen.push(snap.map((c) => c.id))
    })
    connectionRegistry.register(makeConn('a'))
    connectionRegistry.register(makeConn('b'))
    connectionRegistry.unregister('a')
    expect(seen).toEqual([['a'], ['a', 'b'], ['b']])
  })
})
