import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '~/db/sessions-collection'
import { isQualifyingSession } from '../ActiveStrip'

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'test-id',
    userId: null,
    project: 'test-project',
    status: 'idle',
    model: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived: false,
    ...overrides,
  }
}

describe('isQualifyingSession', () => {
  it('returns true for running sessions', () => {
    expect(isQualifyingSession(makeSession({ status: 'running' }))).toBe(true)
  })

  it('returns true for waiting_input sessions', () => {
    expect(isQualifyingSession(makeSession({ status: 'waiting_input' }))).toBe(true)
  })

  it('returns true for waiting_gate sessions', () => {
    expect(isQualifyingSession(makeSession({ status: 'waiting_gate' }))).toBe(true)
  })

  it('returns true for waiting_permission sessions', () => {
    expect(isQualifyingSession(makeSession({ status: 'waiting_permission' }))).toBe(true)
  })

  it('returns true for idle sessions updated within 2 hours', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    expect(isQualifyingSession(makeSession({ status: 'idle', updated_at: oneHourAgo }))).toBe(true)
  })

  it('returns false for idle sessions updated more than 2 hours ago', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    expect(isQualifyingSession(makeSession({ status: 'idle', updated_at: threeHoursAgo }))).toBe(
      false,
    )
  })

  it('returns false for completed sessions', () => {
    expect(isQualifyingSession(makeSession({ status: 'completed' as any }))).toBe(false)
  })

  it('returns false for failed sessions', () => {
    expect(isQualifyingSession(makeSession({ status: 'failed' }))).toBe(false)
  })
})
