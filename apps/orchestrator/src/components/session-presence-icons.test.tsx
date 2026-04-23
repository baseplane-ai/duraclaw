/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionPresenceCtxForTests } from '~/hooks/use-session-presence'
import { SessionPresenceIcons } from './session-presence-icons'

afterEach(() => cleanup())

function withPresence(map: Map<string, Array<{ id: string; name: string; color: string }>>) {
  return ({ children }: { children: React.ReactNode }) => (
    <SessionPresenceCtxForTests.Provider value={map}>
      {children}
    </SessionPresenceCtxForTests.Provider>
  )
}

describe('SessionPresenceIcons', () => {
  it('renders nothing when the session has no peers', () => {
    const { container } = render(<SessionPresenceIcons sessionId="s-none" />, {
      wrapper: withPresence(new Map()),
    })
    expect(container.innerHTML).toBe('')
  })

  it('renders one avatar for a single peer', () => {
    const map = new Map([['s-1', [{ id: 'u-alice', name: 'Alice', color: '#0f0' }]]])
    render(<SessionPresenceIcons sessionId="s-1" />, { wrapper: withPresence(map) })
    const avatars = screen.getAllByTestId('session-presence-avatar')
    expect(avatars.length).toBe(1)
    expect(avatars[0].textContent).toBe('A')
    expect(avatars[0].getAttribute('data-user-id')).toBe('u-alice')
  })

  it('collapses > max peers into avatars + overflow badge', () => {
    const map = new Map([
      [
        's-1',
        [
          { id: 'u-a', name: 'Alice', color: '#0f0' },
          { id: 'u-b', name: 'Bob', color: '#00f' },
          { id: 'u-c', name: 'Carol', color: '#f0f' },
          { id: 'u-d', name: 'Dan', color: '#ff0' },
        ],
      ],
    ])
    render(<SessionPresenceIcons sessionId="s-1" max={2} />, { wrapper: withPresence(map) })
    const avatars = screen.getAllByTestId('session-presence-avatar')
    // With max=2 and 4 peers, visible = max - 1 = 1 avatar, overflow = 3.
    expect(avatars.length).toBe(1)
    expect(screen.getByTestId('session-presence-overflow').textContent).toBe('+3')
  })

  it('exposes data-session-id on the wrapper for UI queries', () => {
    const map = new Map([['s-42', [{ id: 'u-a', name: 'A', color: '#000' }]]])
    render(<SessionPresenceIcons sessionId="s-42" />, { wrapper: withPresence(map) })
    const wrap = screen.getByTestId('session-presence-icons')
    expect(wrap.getAttribute('data-session-id')).toBe('s-42')
  })
})
