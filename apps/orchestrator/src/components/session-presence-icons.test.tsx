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

  it('renders a single dot for one peer, tinted with their color', () => {
    const map = new Map([['s-1', [{ id: 'u-alice', name: 'Alice', color: '#00ff00' }]]])
    render(<SessionPresenceIcons sessionId="s-1" />, { wrapper: withPresence(map) })
    const dot = screen.getByTestId('session-presence-dot')
    expect(dot.getAttribute('data-peer-count')).toBe('1')
    expect(dot.getAttribute('aria-label')).toBe('Alice')
    // style is inline; jsdom normalizes to rgb()
    expect(dot.getAttribute('style')).toContain('background-color')
  })

  it('still renders a single dot for multiple peers and summarizes them in the label', () => {
    const map = new Map([
      [
        's-1',
        [
          { id: 'u-a', name: 'Alice', color: '#0f0' },
          { id: 'u-b', name: 'Bob', color: '#00f' },
          { id: 'u-c', name: 'Carol', color: '#f0f' },
        ],
      ],
    ])
    render(<SessionPresenceIcons sessionId="s-1" />, { wrapper: withPresence(map) })
    const dots = screen.getAllByTestId('session-presence-dot')
    expect(dots.length).toBe(1)
    expect(dots[0].getAttribute('data-peer-count')).toBe('3')
    expect(dots[0].getAttribute('aria-label')).toBe('3 others: Alice, Bob, Carol')
  })

  it('exposes data-session-id on the dot for UI queries', () => {
    const map = new Map([['s-42', [{ id: 'u-a', name: 'A', color: '#000' }]]])
    render(<SessionPresenceIcons sessionId="s-42" />, { wrapper: withPresence(map) })
    const dot = screen.getByTestId('session-presence-dot')
    expect(dot.getAttribute('data-session-id')).toBe('s-42')
  })
})
