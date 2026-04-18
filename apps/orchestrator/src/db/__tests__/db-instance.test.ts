/**
 * @vitest-environment jsdom
 *
 * Permanent regression test for B-CLIENT-1 (OPFS race fix).
 *
 * Asserts that `createCollection` is only invoked AFTER `dbReady` resolves —
 * i.e. every collection module top-level-awaits `dbReady` before constructing
 * its TanStack DB collection. The original bug was that collection modules
 * read a mutable `let persistence` export at module load (when the import
 * graph evaluated synchronously, before `dbReady` had resolved), so the
 * persistence handle was always null and the OPFS branch was silently
 * skipped.
 *
 * If a future refactor removes the top-level await from a collection module,
 * this test should fail because `createCollection` would be observed
 * BEFORE the dbReady promise resolves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('db-instance — OPFS race regression', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('createCollection is only called after dbReady resolves (userTabsCollection)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    let dbReadyResolved = false
    let createCollectionCalledBeforeDbReady = false
    const calledAt: number[] = []
    const dbReadyResolvedAt: number[] = []

    // Wrap the real createCollection to record the order of resolution
    // vs. createCollection invocation.
    const real = await import('@tanstack/db')
    const createCollectionSpy = vi.fn((opts: unknown) => {
      calledAt.push(performance.now())
      if (!dbReadyResolved) {
        createCollectionCalledBeforeDbReady = true
      }
      // Defer to the real implementation so the collection is functional.
      return real.createCollection(opts as Parameters<typeof real.createCollection>[0])
    })

    vi.doMock('@tanstack/db', () => ({
      ...real,
      createCollection: createCollectionSpy,
    }))

    const { dbReady } = await import('../db-instance')

    // Tap dbReady to flag the resolution moment.
    void dbReady.then(() => {
      dbReadyResolved = true
      dbReadyResolvedAt.push(performance.now())
    })

    // Importing a collection should top-level-await dbReady internally —
    // so by the time `await import(...)` returns, dbReady has resolved
    // AND createCollection has been called.
    await import('../user-tabs-collection')

    expect(dbReadyResolved).toBe(true)
    expect(createCollectionSpy).toHaveBeenCalled()
    expect(createCollectionCalledBeforeDbReady).toBe(false)
  })
})
