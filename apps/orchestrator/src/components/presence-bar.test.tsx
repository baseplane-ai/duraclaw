/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Awareness } from 'y-protocols/awareness'
import { PresenceBar } from './presence-bar'

function fakeAwareness(
  states: Map<number, { user?: { id?: string; name?: string; color?: string } }>,
): Awareness {
  const listeners: Array<() => void> = []
  return {
    getStates: () => states,
    on: (_evt: string, cb: () => void) => {
      listeners.push(cb)
    },
    off: (_evt: string, cb: () => void) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    // Test-only helper for firing awareness changes.
    __emit: () => {
      for (const cb of listeners) cb()
    },
  } as unknown as Awareness
}

afterEach(() => cleanup())

describe('PresenceBar', () => {
  it('renders one avatar for the only connected user (self)', () => {
    const aw = fakeAwareness(new Map([[1, { user: { id: 'u-self', name: 'Me', color: '#f00' } }]]))
    render(<PresenceBar awareness={aw} selfClientId={1} />)
    const avatars = screen.getAllByTestId('presence-avatar')
    expect(avatars.length).toBe(1)
    expect(avatars[0].textContent).toBe('M')
  })

  it('renders three avatars for three connected users', () => {
    const aw = fakeAwareness(
      new Map([
        [1, { user: { id: 'u-self', name: 'Me', color: '#f00' } }],
        [2, { user: { id: 'u-alice', name: 'Alice', color: '#0f0' } }],
        [3, { user: { id: 'u-bob', name: 'Bob', color: '#00f' } }],
      ]),
    )
    render(<PresenceBar awareness={aw} selfClientId={1} />)
    const avatars = screen.getAllByTestId('presence-avatar')
    expect(avatars.length).toBe(3)
    expect(screen.queryByTestId('presence-overflow')).toBeNull()
  })

  it('collapses > 5 users to first 4 + overflow badge', () => {
    const entries: Array<[number, { user: { id: string; name: string; color: string } }]> = []
    for (let i = 1; i <= 6; i++) {
      entries.push([i, { user: { id: `u-${i}`, name: `User${i}`, color: '#abc' } }])
    }
    const aw = fakeAwareness(new Map(entries))
    render(<PresenceBar awareness={aw} selfClientId={1} />)
    const avatars = screen.getAllByTestId('presence-avatar')
    expect(avatars.length).toBe(4)
    const overflow = screen.getByTestId('presence-overflow')
    expect(overflow.textContent).toBe('+2')
  })

  it('dedupes multiple tabs from the same user.id', () => {
    const aw = fakeAwareness(
      new Map([
        [1, { user: { id: 'u-self', name: 'Me', color: '#f00' } }],
        [2, { user: { id: 'u-self', name: 'Me', color: '#f00' } }],
      ]),
    )
    render(<PresenceBar awareness={aw} selfClientId={1} />)
    const avatars = screen.getAllByTestId('presence-avatar')
    expect(avatars.length).toBe(1)
  })

  it('treats multi-tab self as self regardless of clientId iteration order', () => {
    // Two awareness entries share user.id = "u-self", but the non-self
    // clientId (99) comes *before* the self clientId (100) in iteration
    // order. Self must still render exactly once and be treated as self.
    const aw = fakeAwareness(
      new Map([
        [99, { user: { id: 'u-self', name: 'Me', color: '#f00' } }],
        [100, { user: { id: 'u-self', name: 'Me', color: '#f00' } }],
        [101, { user: { id: 'u-alice', name: 'Alice', color: '#0f0' } }],
      ]),
    )
    render(<PresenceBar awareness={aw} selfClientId={100} />)
    const avatars = screen.getAllByTestId('presence-avatar')
    // Exactly one avatar for self, plus Alice.
    const selfAvatars = avatars.filter((el) => el.getAttribute('data-user-id') === 'u-self')
    expect(selfAvatars.length).toBe(1)
    // Self is first (self-before-peers ordering).
    expect(avatars[0].getAttribute('data-user-id')).toBe('u-self')
    expect(avatars.length).toBe(2)
  })

  it('renders nothing when there are no users with identity', () => {
    const aw = fakeAwareness(new Map())
    const { container } = render(<PresenceBar awareness={aw} selfClientId={1} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps a departed peer rendered as a ghost with "Left recently" tooltip', () => {
    const states = new Map<number, { user?: { id?: string; name?: string; color?: string } }>([
      [1, { user: { id: 'u-self', name: 'Me', color: '#f00' } }],
      [2, { user: { id: 'u-alice', name: 'Alice', color: '#0f0' } }],
    ])
    const aw = fakeAwareness(states)
    render(<PresenceBar awareness={aw} selfClientId={1} />)
    expect(screen.getAllByTestId('presence-avatar').length).toBe(2)

    // Alice leaves.
    act(() => {
      states.delete(2)
      ;(aw as unknown as { __emit: () => void }).__emit()
    })

    const avatars = screen.getAllByTestId('presence-avatar')
    expect(avatars.length).toBe(2)
    const ghost = avatars.find((el) => el.getAttribute('data-user-id') === 'u-alice')
    expect(ghost).toBeTruthy()
    expect(ghost?.getAttribute('data-ghost')).toBe('true')
  })
})
