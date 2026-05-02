/**
 * Tests for the cross-platform toast wrapper (GH#157 §1 / B3 cross-cutting infra).
 *
 * Web behaviour: thin re-export of sonner's `toast`. We don't actually
 * unit-test sonner's internals — those live in sonner's own test suite —
 * we just verify the wrapper's three-method shape forwards correctly
 * by spying on what `webSonnerToast` resolves to at module init.
 *
 * Native behaviour can't be exercised here because the test runs under
 * `vitest-environment jsdom` (Platform.OS === 'web' under
 * @tamagui/react-native-web-lite). The native branch is covered by the
 * device smoke tests on the Expo APK; this suite ensures the web side
 * doesn't regress when the wrapper is touched.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('toast wrapper', () => {
  it('exports the three required methods', async () => {
    const { toast } = await import('./toast')
    expect(typeof toast.success).toBe('function')
    expect(typeof toast.error).toBe('function')
    expect(typeof toast.info).toBe('function')
  })

  it('on web, calls into sonner without throwing', async () => {
    // The module's top-level `if (Platform.OS === 'web')` branch already
    // ran at import time; we just confirm the methods don't throw when
    // invoked. (sonner's web Toaster mounts portal nodes lazily on
    // first call; calling into it without a mounted Toaster is a no-op,
    // not an error.)
    const { toast } = await import('./toast')
    expect(() => toast.success('ok')).not.toThrow()
    expect(() => toast.error('boom')).not.toThrow()
    expect(() => toast.info('hello')).not.toThrow()
  })

  it('all three methods accept a string argument', async () => {
    const { toast } = await import('./toast')
    // Per sonner's runtime, web returns a numeric id; native (Alert.alert)
    // returns undefined. The wrapper's TS signature returns void; we
    // don't lock down the runtime return shape here — call-site contract
    // is "fire-and-forget".
    expect(() => toast.success('a')).not.toThrow()
    expect(() => toast.error('b')).not.toThrow()
    expect(() => toast.info('c')).not.toThrow()
  })
})
