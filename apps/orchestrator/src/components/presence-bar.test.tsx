/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Awareness } from 'y-protocols/awareness'
import { PresenceBar } from './presence-bar'

function fakeAwareness(
  states: Map<number, { user?: { id?: string; name?: string; color?: string } }>,
): Awareness {
  return {
    getStates: () => states,
    on: () => {},
    off: () => {},
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

  it('renders nothing when there are no users with identity', () => {
    const aw = fakeAwareness(new Map())
    const { container } = render(<PresenceBar awareness={aw} selfClientId={1} />)
    expect(container.innerHTML).toBe('')
  })
})
