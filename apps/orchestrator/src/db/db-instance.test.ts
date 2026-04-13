/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('db-instance', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports queryClient instance', async () => {
    const mod = await import('./db-instance')
    expect(mod.queryClient).toBeDefined()
    expect(typeof mod.queryClient.fetchQuery).toBe('function')
  })

  it('exports persistence as null initially', async () => {
    const mod = await import('./db-instance')
    // Before dbReady resolves, persistence starts null
    expect(mod.persistence).toBeNull()
  })

  it('exports dbReady as a promise', async () => {
    const mod = await import('./db-instance')
    expect(mod.dbReady).toBeInstanceOf(Promise)
  })

  it('falls back to null persistence in jsdom (no OPFS)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await import('./db-instance')

    const result = await mod.dbReady

    // jsdom does not support OPFS, so persistence should be null
    expect(result).toBeNull()
    expect(mod.persistence).toBeNull()
    // Should have warned about fallback
    expect(warnSpy).toHaveBeenCalledWith(
      '[duraclaw-db] OPFS not available, using memory-only storage',
    )
  })

  it('is SSR-safe when navigator is undefined', async () => {
    const originalNavigator = globalThis.navigator
    // @ts-expect-error -- simulating SSR environment
    delete globalThis.navigator

    try {
      vi.resetModules()
      const mod = await import('./db-instance')
      const result = await mod.dbReady

      expect(result).toBeNull()
      expect(mod.persistence).toBeNull()
    } finally {
      globalThis.navigator = originalNavigator
    }
  })
})
