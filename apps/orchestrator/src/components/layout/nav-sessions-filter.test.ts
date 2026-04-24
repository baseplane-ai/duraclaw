import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '~/db/session-record'
import { filterSessionsByMode } from './nav-sessions-filter'

function mkSession(id: string, userId: string | null): SessionRecord {
  return {
    id,
    userId,
    project: 'demo',
    status: 'idle',
    model: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastActivity: null,
    durationMs: null,
    totalCostUsd: null,
    numTurns: 0,
    prompt: null,
    summary: null,
    title: null,
    tag: null,
    archived: false,
    origin: null,
    agent: null,
    sdkSessionId: null,
    kataMode: null,
    kataIssue: null,
    kataPhase: null,
  } as SessionRecord
}

describe('filterSessionsByMode', () => {
  const sessions = [mkSession('a', 'user-A'), mkSession('b', 'user-B'), mkSession('c', null)]

  it('returns everything in "all" mode', () => {
    const out = filterSessionsByMode(sessions, 'all', 'user-A')
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns only sessions owned by currentUserId in "mine" mode', () => {
    const out = filterSessionsByMode(sessions, 'mine', 'user-A')
    expect(out.map((s) => s.id)).toEqual(['a'])
  })

  it('no-ops "mine" when currentUserId is null', () => {
    const out = filterSessionsByMode(sessions, 'mine', null)
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array when the user owns nothing', () => {
    const out = filterSessionsByMode(sessions, 'mine', 'user-Z')
    expect(out).toEqual([])
  })
})
