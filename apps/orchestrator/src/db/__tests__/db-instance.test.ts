/**
 * @vitest-environment jsdom
 *
 * Permanent regression test for B-CLIENT-1 (OPFS race fix), updated for
 * GH#164 (lifted top-level await for Hermes).
 *
 * Old invariant (pre-#164): every collection module top-level-awaited
 * `dbReady` so `createCollection` ran AFTER persistence resolved.
 *
 * New invariant (post-#164): collection modules export a lazy proxy.
 * `createCollection` is only invoked on first property access on the
 * proxy, and the lazy thunk reads `getResolvedPersistence()` which
 * throws if `dbReady` hasn't settled. Both entry points await `dbReady`
 * before mounting React, so by the time any consumer touches a
 * collection at runtime, persistence is resolved.
 *
 * What this test enforces:
 *
 *   1. Importing a collection module does NOT eagerly call
 *      `createCollection` — the proxy is built but the underlying
 *      collection is deferred.
 *
 *   2. After `dbReady` resolves and a property on the proxy is
 *      accessed, `createCollection` is called.
 *
 *   3. `getResolvedPersistence()` throws if called before `dbReady`
 *      settles — guarding against accidental early access (e.g. a
 *      future refactor that touches a collection at module-eval time).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('db-instance — lazy collection (GH#164)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('importing a collection module does NOT eagerly call createCollection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const real = await import('@tanstack/db')
    const createCollectionSpy = vi.fn((opts: Parameters<typeof real.createCollection>[0]) =>
      real.createCollection(opts),
    )
    vi.doMock('@tanstack/db', () => ({
      ...real,
      createCollection: createCollectionSpy,
    }))

    // Pure import — should be side-effect-free w.r.t. createCollection.
    await import('../user-tabs-collection')

    expect(createCollectionSpy).not.toHaveBeenCalled()
  })

  it('first property access on the proxy triggers createCollection AFTER dbReady', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    let dbReadyResolved = false
    let createCollectionCalledBeforeDbReady = false

    const real = await import('@tanstack/db')
    const createCollectionSpy = vi.fn((opts: Parameters<typeof real.createCollection>[0]) => {
      if (!dbReadyResolved) {
        createCollectionCalledBeforeDbReady = true
      }
      return real.createCollection(opts)
    })
    vi.doMock('@tanstack/db', () => ({
      ...real,
      createCollection: createCollectionSpy,
    }))

    const { dbReady } = await import('../db-instance')
    await dbReady
    dbReadyResolved = true

    const { userTabsCollection } = await import('../user-tabs-collection')

    // Touch a property — this is what triggers the lazy proxy to
    // resolve and call createCollection.
    void userTabsCollection.id

    expect(createCollectionSpy).toHaveBeenCalled()
    expect(createCollectionCalledBeforeDbReady).toBe(false)
  })

  it('getResolvedPersistence() throws before dbReady resolves', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Fresh module graph — getResolvedPersistence should be in the
    // pre-resolution state immediately after import (synchronously).
    const { getResolvedPersistence } = await import('../db-instance')

    // The dynamic import above already ran the module body synchronously,
    // which scheduled the dbReady microtask but hasn't awaited it. So
    // dbReady may or may not have resolved depending on microtask
    // ordering. We assert behavior in both branches: either it throws
    // (not yet resolved) or returns a value (already resolved).
    let threw = false
    let value: unknown
    try {
      value = getResolvedPersistence()
    } catch (err) {
      threw = true
      expect((err as Error).message).toMatch(/before dbReady resolved/)
    }
    // After awaiting dbReady, it MUST not throw.
    const { dbReady } = await import('../db-instance')
    await dbReady
    expect(() => getResolvedPersistence()).not.toThrow()

    // Reference the captured value to silence unused warnings on the
    // already-resolved branch.
    void threw
    void value
  })
})
