import { describe, expect, it } from 'vitest'
import { mapEffortPref, mapThinkingPref } from './runner-link'

/**
 * D1 -> wire-shape converters for user_preferences columns. These are
 * the gatekeepers that translate the flat string columns the API
 * stores into the SDK-shaped fields on `ExecuteCommand`. Anything
 * unknown returns `undefined` so the caller skips the field rather
 * than passing garbage to the SDK; the runner-side defensive guards
 * (`resolvePermissionMode`, `resolveEffort`) only matter if these
 * gatekeepers are bypassed (e.g. a test harness sending raw cmds).
 */

describe('mapThinkingPref', () => {
  it('returns SDK discriminated-union for each known mode', () => {
    expect(mapThinkingPref('adaptive')).toEqual({ type: 'adaptive' })
    expect(mapThinkingPref('enabled')).toEqual({ type: 'enabled' })
    expect(mapThinkingPref('disabled')).toEqual({ type: 'disabled' })
  })

  it('returns undefined for null / undefined / unknown', () => {
    expect(mapThinkingPref(null)).toBeUndefined()
    expect(mapThinkingPref(undefined)).toBeUndefined()
    expect(mapThinkingPref('')).toBeUndefined()
    expect(mapThinkingPref('always')).toBeUndefined()
  })
})

describe('mapEffortPref', () => {
  it('passes SDK-known effort levels through as literals', () => {
    expect(mapEffortPref('low')).toBe('low')
    expect(mapEffortPref('medium')).toBe('medium')
    expect(mapEffortPref('high')).toBe('high')
    expect(mapEffortPref('max')).toBe('max')
  })

  it('drops legacy `xhigh` (codex-only) so it never reaches Claude SDK', () => {
    expect(mapEffortPref('xhigh')).toBeUndefined()
  })

  it('returns undefined for null / undefined / unknown', () => {
    expect(mapEffortPref(null)).toBeUndefined()
    expect(mapEffortPref(undefined)).toBeUndefined()
    expect(mapEffortPref('')).toBeUndefined()
    expect(mapEffortPref('extreme')).toBeUndefined()
  })
})
