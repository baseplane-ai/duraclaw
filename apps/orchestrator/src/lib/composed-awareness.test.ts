/**
 * GH#152 P1.6 (B16) — pure-function tests for `composeAwareness`.
 */

import { describe, expect, it } from 'vitest'
import { composeAwareness } from './composed-awareness'

function user(id: string, name = id, color = '#abc') {
  return { id, name, color }
}

describe('composeAwareness', () => {
  it('returns an empty array when both maps are null', () => {
    expect(composeAwareness(null, null)).toEqual([])
  })

  it('returns an empty array when both maps are empty', () => {
    expect(composeAwareness(new Map(), new Map())).toEqual([])
  })

  it('reads only session map → viewing=transcript when activeSessionId is set', () => {
    const session = new Map<number, unknown>([
      [1, { user: user('u-a', 'Alice'), typing: false, activeSessionId: 'sess-1' }],
    ])
    const out = composeAwareness(session, null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      userId: 'u-a',
      displayName: 'Alice',
      viewing: 'transcript',
      typing: false,
      sessionClientId: 1,
    })
    expect(out[0].arcClientId).toBeUndefined()
  })

  it('reads only session map → viewing=unknown when activeSessionId is missing', () => {
    const session = new Map<number, unknown>([[1, { user: user('u-a'), typing: false }]])
    const out = composeAwareness(session, null)
    expect(out[0]?.viewing).toBe('unknown')
  })

  it('reads only arc map → viewing comes straight from arc state', () => {
    const arc = new Map<number, unknown>([
      [10, { user: user('u-a', 'Alice'), typing: true, viewing: 'chat', activeArcId: 'arc-1' }],
    ])
    const out = composeAwareness(null, arc)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      userId: 'u-a',
      viewing: 'chat',
      typing: true,
      arcClientId: 10,
    })
  })

  it('arc viewing overrides session-derived viewing when both present', () => {
    const session = new Map<number, unknown>([
      [1, { user: user('u-a', 'Alice'), typing: false, activeSessionId: 'sess-1' }],
    ])
    const arc = new Map<number, unknown>([
      [10, { user: user('u-a', 'Alice'), typing: false, viewing: 'inbox' }],
    ])
    const out = composeAwareness(session, arc)
    expect(out).toHaveLength(1)
    expect(out[0].viewing).toBe('inbox')
    expect(out[0].sessionClientId).toBe(1)
    expect(out[0].arcClientId).toBe(10)
  })

  it("arc 'unknown' viewing keeps session 'transcript'", () => {
    const session = new Map<number, unknown>([
      [1, { user: user('u-a'), typing: false, activeSessionId: 'sess-1' }],
    ])
    const arc = new Map<number, unknown>([
      [10, { user: user('u-a'), typing: false, viewing: 'unknown' }],
    ])
    const out = composeAwareness(session, arc)
    expect(out[0].viewing).toBe('transcript')
  })

  it('typing is OR-ed across both DOs', () => {
    const sessTyping = new Map<number, unknown>([
      [1, { user: user('u-a'), typing: true, activeSessionId: 's' }],
    ])
    const arcQuiet = new Map<number, unknown>([
      [10, { user: user('u-a'), typing: false, viewing: 'chat' }],
    ])
    expect(composeAwareness(sessTyping, arcQuiet)[0]?.typing).toBe(true)

    const sessQuiet = new Map<number, unknown>([
      [1, { user: user('u-a'), typing: false, activeSessionId: 's' }],
    ])
    const arcTyping = new Map<number, unknown>([
      [10, { user: user('u-a'), typing: true, viewing: 'chat' }],
    ])
    expect(composeAwareness(sessQuiet, arcTyping)[0]?.typing).toBe(true)

    const sessNeither = new Map<number, unknown>([
      [1, { user: user('u-a'), typing: false, activeSessionId: 's' }],
    ])
    const arcNeither = new Map<number, unknown>([
      [10, { user: user('u-a'), typing: false, viewing: 'chat' }],
    ])
    expect(composeAwareness(sessNeither, arcNeither)[0]?.typing).toBe(false)
  })

  it('skips entries missing user.id', () => {
    const arc = new Map<number, unknown>([
      [10, { user: { name: 'Anonymous' }, typing: false, viewing: 'chat' }],
      [11, { user: user('u-a', 'Alice'), typing: false, viewing: 'chat' }],
    ])
    const out = composeAwareness(null, arc)
    expect(out).toHaveLength(1)
    expect(out[0].userId).toBe('u-a')
  })

  it('sorts by displayName then userId', () => {
    const arc = new Map<number, unknown>([
      [1, { user: user('u-z', 'Zoe'), viewing: 'chat' }],
      [2, { user: user('u-a', 'Alice'), viewing: 'chat' }],
      [3, { user: user('u-b', 'Alice'), viewing: 'chat' }],
    ])
    const out = composeAwareness(null, arc)
    expect(out.map((p) => p.userId)).toEqual(['u-a', 'u-b', 'u-z'])
  })

  it('does NOT filter the local user (caller is responsible)', () => {
    // The composer function returns ALL composed users, including
    // whoever the caller may consider "self". Filtering happens in
    // useArcPresence, not here.
    const arc = new Map<number, unknown>([
      [10, { user: user('u-self'), viewing: 'chat' }],
      [11, { user: user('u-other'), viewing: 'chat' }],
    ])
    const out = composeAwareness(null, arc)
    expect(out.map((p) => p.userId).sort()).toEqual(['u-other', 'u-self'])
  })

  it('arc name/color override session name/color when arc fields are non-empty', () => {
    const session = new Map<number, unknown>([
      [1, { user: user('u-a', 'OldName', '#000'), activeSessionId: 's' }],
    ])
    const arc = new Map<number, unknown>([
      [10, { user: user('u-a', 'NewName', '#fff'), viewing: 'chat' }],
    ])
    const out = composeAwareness(session, arc)
    expect(out[0].displayName).toBe('NewName')
    expect(out[0].color).toBe('#fff')
  })

  it('multiple users: merged entry per user id', () => {
    const session = new Map<number, unknown>([
      [1, { user: user('u-a', 'Alice'), typing: false, activeSessionId: 's1' }],
      [2, { user: user('u-b', 'Bob'), typing: true, activeSessionId: 's1' }],
    ])
    const arc = new Map<number, unknown>([
      [10, { user: user('u-a', 'Alice'), typing: true, viewing: 'chat' }],
    ])
    const out = composeAwareness(session, arc)
    expect(out).toHaveLength(2)
    const alice = out.find((p) => p.userId === 'u-a')
    const bob = out.find((p) => p.userId === 'u-b')
    expect(alice?.viewing).toBe('chat')
    expect(alice?.typing).toBe(true)
    expect(alice?.sessionClientId).toBe(1)
    expect(alice?.arcClientId).toBe(10)
    expect(bob?.viewing).toBe('transcript')
    expect(bob?.typing).toBe(true)
    expect(bob?.arcClientId).toBeUndefined()
  })
})
