import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiBaseUrl, apiUrl, isNative } from './platform'

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

describe('apiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns empty string when VITE_API_BASE_URL is unset', () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    expect(apiBaseUrl()).toBe('')
  })

  it('returns the configured value when VITE_API_BASE_URL is set', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://duraclaw.example.com')
    expect(apiBaseUrl()).toBe('https://duraclaw.example.com')
  })
})

describe('apiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the path unchanged when base is empty (web build)', () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    expect(apiUrl('/api/sessions')).toBe('/api/sessions')
  })

  it('prefixes with the base URL when set', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://duraclaw.example.com')
    expect(apiUrl('/api/sessions')).toBe('https://duraclaw.example.com/api/sessions')
  })

  it('avoids double-slash when base ends with / and path starts with /', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://duraclaw.example.com/')
    expect(apiUrl('/api/sessions')).toBe('https://duraclaw.example.com/api/sessions')
  })

  it('inserts slash when path is missing the leading slash', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://duraclaw.example.com')
    expect(apiUrl('api/sessions')).toBe('https://duraclaw.example.com/api/sessions')
  })
})
