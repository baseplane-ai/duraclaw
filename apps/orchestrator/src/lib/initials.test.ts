import { describe, expect, it } from 'vitest'
import { deriveInitials } from './initials'

describe('deriveInitials', () => {
  it('returns "?" for null / undefined / empty / whitespace-only input', () => {
    expect(deriveInitials(null)).toBe('?')
    expect(deriveInitials(undefined)).toBe('?')
    expect(deriveInitials('')).toBe('?')
    expect(deriveInitials('   ')).toBe('?')
  })

  it('takes the first letter of two name tokens, uppercased', () => {
    expect(deriveInitials('Ben Carter')).toBe('BC')
    expect(deriveInitials('ada lovelace')).toBe('AL')
    expect(deriveInitials('  Ada   Lovelace  ')).toBe('AL')
  })

  it('uses the first two letters of a single-token name', () => {
    expect(deriveInitials('ben')).toBe('BE')
    expect(deriveInitials('A')).toBe('A')
  })

  it('caps multi-token names at two initials', () => {
    expect(deriveInitials('Mary Ada Lovelace King')).toBe('MA')
  })

  it('falls back to the local part of an email', () => {
    expect(deriveInitials('ben@baseplane.ai')).toBe('BE')
    expect(deriveInitials('ada.lovelace@example.com')).toBe('AD')
  })

  it('skips non-letter characters when picking initials', () => {
    expect(deriveInitials('@codevibesmatter')).toBe('CO')
    expect(deriveInitials('123 hello')).toBe('HE')
  })

  it('handles all-numeric / no-letter input by uppercasing the first 2 chars', () => {
    expect(deriveInitials('1234')).toBe('12')
    expect(deriveInitials('!')).toBe('!')
  })
})
