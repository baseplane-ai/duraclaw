/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDeltaLogForTests, logDelta, refreshDeltaLogFlag } from '../delta-log'

describe('delta-log', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    __resetDeltaLogForTests()
    window.localStorage.clear()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('no-ops when the flag is unset', () => {
    logDelta('session', { agent: 'abc', kind: 'messages:delta', seq: 1 })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('logs a grep-friendly line when the flag is set to "1"', () => {
    window.localStorage.setItem('duraclaw.debug.deltaLog', '1')
    refreshDeltaLogFlag()
    logDelta('session', { agent: 'abc', kind: 'messages:delta', seq: 42 })
    expect(logSpy).toHaveBeenCalledTimes(1)
    const line = logSpy.mock.calls[0]?.[0] as string
    expect(line).toMatch(/^\[delta\] /)
    expect(line).toContain('ch=session')
    expect(line).toContain('agent=abc')
    expect(line).toContain('kind=messages:delta')
    expect(line).toContain('seq=42')
    expect(line).toMatch(/ts=\d+/)
  })

  it('does not log when flag is set to a non-"1" value', () => {
    window.localStorage.setItem('duraclaw.debug.deltaLog', 'true')
    refreshDeltaLogFlag()
    logDelta('session', { kind: 'messages:delta' })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('skips undefined fields and serialises objects', () => {
    window.localStorage.setItem('duraclaw.debug.deltaLog', '1')
    refreshDeltaLogFlag()
    logDelta('user-stream', {
      collection: 'projects',
      ops: 3,
      missing: undefined,
      nested: { a: 1 },
    })
    const line = logSpy.mock.calls[0]?.[0] as string
    expect(line).toContain('collection=projects')
    expect(line).toContain('ops=3')
    expect(line).not.toContain('missing=')
    expect(line).toContain('nested={"a":1}')
  })

  it('refreshes the cache after a flag toggle', () => {
    logDelta('session', { kind: 'messages:delta' })
    expect(logSpy).not.toHaveBeenCalled()

    window.localStorage.setItem('duraclaw.debug.deltaLog', '1')
    refreshDeltaLogFlag()

    logDelta('session', { kind: 'messages:delta' })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })
})
