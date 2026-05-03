/**
 * @vitest-environment jsdom
 *
 * GH#152 P1.6 (B16) — ArcPresenceBar render tests. Mocks `useArcPresence`
 * so we control the composed-presence array directly without standing up
 * the two underlying providers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposedPresence } from '~/lib/composed-awareness'
import { cleanup, render, screen } from '~/test-utils'

const mockState: { presence: ComposedPresence[] } = { presence: [] }

vi.mock('~/hooks/use-arc-presence', () => ({
  useArcPresence: () => mockState.presence,
}))

import { ArcPresenceBar } from './arc-presence-bar'

function presence(overrides: Partial<ComposedPresence> = {}): ComposedPresence {
  return {
    userId: 'u-1',
    displayName: 'Alice',
    color: '#ef4444',
    viewing: 'chat',
    typing: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockState.presence = []
})
afterEach(() => cleanup())

describe('ArcPresenceBar', () => {
  it('renders nothing on empty presence array', () => {
    mockState.presence = []
    render(<ArcPresenceBar arcId="arc-1" sessionId={null} />)
    expect(screen.queryByTestId('arc-presence-bar')).toBeNull()
    expect(screen.queryAllByTestId('arc-presence-avatar')).toHaveLength(0)
  })

  it('renders one avatar per user with viewing in title', () => {
    mockState.presence = [
      presence({ userId: 'u-1', displayName: 'Alice', viewing: 'chat' }),
      presence({ userId: 'u-2', displayName: 'Bob', viewing: 'transcript' }),
      presence({ userId: 'u-3', displayName: 'Carol', viewing: 'inbox' }),
    ]
    render(<ArcPresenceBar arcId="arc-1" sessionId={null} />)
    const avatars = screen.getAllByTestId('arc-presence-avatar')
    expect(avatars).toHaveLength(3)
    expect(avatars[0].getAttribute('title')).toMatch(/viewing: chat/)
    expect(avatars[1].getAttribute('title')).toMatch(/viewing: transcript/)
    expect(avatars[2].getAttribute('title')).toMatch(/viewing: inbox/)
  })

  it('renders the typing indicator when any user is typing', () => {
    mockState.presence = [
      presence({ userId: 'u-1', displayName: 'Alice', typing: false }),
      presence({ userId: 'u-2', displayName: 'Bob', typing: true }),
    ]
    render(<ArcPresenceBar arcId="arc-1" sessionId={null} />)
    expect(screen.getByTestId('arc-presence-typing')).toBeTruthy()
    // The typing avatar carries data-typing="true" (handy for styling).
    const bob = screen
      .getAllByTestId('arc-presence-avatar')
      .find((el) => el.getAttribute('data-user-id') === 'u-2')
    expect(bob?.getAttribute('data-typing')).toBe('true')
  })

  it('does NOT render the typing indicator when nobody is typing', () => {
    mockState.presence = [presence({ userId: 'u-1', typing: false })]
    render(<ArcPresenceBar arcId="arc-1" sessionId={null} />)
    expect(screen.queryByTestId('arc-presence-typing')).toBeNull()
  })

  it('caps visible avatars at 5 and renders +N overflow chip', () => {
    mockState.presence = Array.from({ length: 8 }, (_, i) =>
      presence({ userId: `u-${i + 1}`, displayName: `User${i + 1}` }),
    )
    render(<ArcPresenceBar arcId="arc-1" sessionId={null} />)
    const avatars = screen.getAllByTestId('arc-presence-avatar')
    expect(avatars).toHaveLength(5)
    const overflow = screen.getByTestId('arc-presence-overflow')
    expect(overflow.textContent).toBe('+3')
  })

  it('does not render the overflow chip when count <= 5', () => {
    mockState.presence = Array.from({ length: 5 }, (_, i) =>
      presence({ userId: `u-${i + 1}`, displayName: `User${i + 1}` }),
    )
    render(<ArcPresenceBar arcId="arc-1" sessionId={null} />)
    expect(screen.getAllByTestId('arc-presence-avatar')).toHaveLength(5)
    expect(screen.queryByTestId('arc-presence-overflow')).toBeNull()
  })
})
