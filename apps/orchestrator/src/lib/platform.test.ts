import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNative } from './platform'

describe('isNative', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns false when VITE_PLATFORM is unset', () => {
    vi.stubEnv('VITE_PLATFORM', '')
    expect(isNative()).toBe(false)
  })

  it("returns true when VITE_PLATFORM is 'capacitor'", () => {
    vi.stubEnv('VITE_PLATFORM', 'capacitor')
    expect(isNative()).toBe(true)
  })

  it('returns false for any other VITE_PLATFORM value', () => {
    vi.stubEnv('VITE_PLATFORM', 'electron')
    expect(isNative()).toBe(false)
  })
})
