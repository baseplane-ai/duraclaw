/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Awareness } from 'y-protocols/awareness'
import { TypingIndicator } from './typing-indicator'

/**
 * Minimal Awareness-shaped fake — we only call `getStates`, `on`,
 * `off` from the component so the rest is unimplemented. Tests don't
 * exercise the "change" event here; a static snapshot at render time
 * is enough to prove the render branches.
 */
function fakeAwareness(
  states: Map<number, { user?: { id?: string; name?: string }; typing?: boolean }>,
): Awareness {
  return {
    getStates: () => states,
    on: () => {},
    off: () => {},
  } as unknown as Awareness
}

afterEach(() => cleanup())

describe('TypingIndicator', () => {
  it('renders nothing when no one is typing', () => {
    const aw = fakeAwareness(new Map([[1, { user: { id: 'self', name: 'Me' }, typing: false }]]))
    const { container } = render(<TypingIndicator awareness={aw} selfClientId={1} />)
    expect(container.innerHTML).toBe('')
  })

  it('hides self even if self.typing is true', () => {
    const aw = fakeAwareness(new Map([[1, { user: { id: 'self', name: 'Me' }, typing: true }]]))
    const { container } = render(<TypingIndicator awareness={aw} selfClientId={1} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders single-user "is typing" label', () => {
    const aw = fakeAwareness(
      new Map([
        [1, { user: { id: 'self', name: 'Me' }, typing: false }],
        [2, { user: { id: 'u-alice', name: 'Alice' }, typing: true }],
      ]),
    )
    render(<TypingIndicator awareness={aw} selfClientId={1} />)
    expect(screen.getByText(/Alice is typing/)).toBeTruthy()
  })

  it('renders two-user "and" label', () => {
    const aw = fakeAwareness(
      new Map([
        [1, { user: { id: 'self', name: 'Me' }, typing: false }],
        [2, { user: { id: 'u-alice', name: 'Alice' }, typing: true }],
        [3, { user: { id: 'u-bob', name: 'Bob' }, typing: true }],
      ]),
    )
    render(<TypingIndicator awareness={aw} selfClientId={1} />)
    expect(screen.getByText(/Alice and Bob are typing/)).toBeTruthy()
  })

  it('renders "N people are typing" for 3+', () => {
    const aw = fakeAwareness(
      new Map([
        [1, { user: { id: 'self', name: 'Me' }, typing: false }],
        [2, { user: { id: 'u-alice', name: 'Alice' }, typing: true }],
        [3, { user: { id: 'u-bob', name: 'Bob' }, typing: true }],
        [4, { user: { id: 'u-carol', name: 'Carol' }, typing: true }],
      ]),
    )
    render(<TypingIndicator awareness={aw} selfClientId={1} />)
    expect(screen.getByText(/3 people are typing/)).toBeTruthy()
  })

  it('dedupes multiple client tabs for the same user.id', () => {
    const aw = fakeAwareness(
      new Map([
        [1, { user: { id: 'self', name: 'Me' }, typing: false }],
        [2, { user: { id: 'u-alice', name: 'Alice' }, typing: true }],
        [3, { user: { id: 'u-alice', name: 'Alice' }, typing: true }],
      ]),
    )
    render(<TypingIndicator awareness={aw} selfClientId={1} />)
    expect(screen.getByText(/Alice is typing/)).toBeTruthy()
  })
})
