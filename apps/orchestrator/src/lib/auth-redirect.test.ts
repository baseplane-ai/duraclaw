/**
 * Tests for redirectToLogin (B7 — centralised 401 → /login redirect).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redirectToLogin } from './auth-redirect'

// jsdom's window.location is read-only; replace it with a writable stub.
let originalLocation: Location

beforeEach(() => {
  originalLocation = window.location
  // @ts-expect-error — overriding read-only for test
  delete (window as unknown as { location?: Location }).location
  ;(window as unknown as { location: { href: string } }).location = { href: '' }
  sessionStorage.clear()
})

afterEach(() => {
  ;(window as unknown as { location: Location }).location = originalLocation
})

describe('redirectToLogin', () => {
  it("writes 'expired' to sessionStorage by default and redirects to /login", () => {
    redirectToLogin()
    expect(sessionStorage.getItem('auth.redirect.reason')).toBe('expired')
    expect(window.location.href).toBe('/login')
  })

  it("supports the 'unauthorized' reason", () => {
    redirectToLogin('unauthorized')
    expect(sessionStorage.getItem('auth.redirect.reason')).toBe('unauthorized')
    expect(window.location.href).toBe('/login')
  })

  it('does not throw when sessionStorage.setItem throws', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => redirectToLogin('expired')).not.toThrow()
    expect(window.location.href).toBe('/login')
    setItemSpy.mockRestore()
  })
})
