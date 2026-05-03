/**
 * @vitest-environment jsdom
 *
 * GH#152 P1.4 B12 — ReactionsBar component tests.
 *
 * Mocks `~/features/arc-orch/use-arc-reactions` so the collection / WS /
 * TanStack DB layer never has to spin up in jsdom. Mocks the Radix
 * Popover wrapper to bare divs so tests don't depend on portal +
 * animate-presence behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '~/test-utils'

// ── Shared mock state, mutated per-test before render ─────────────────

interface ReactionsForTargetReturn {
  chips: Array<{ emoji: string; count: number; users: string[] }>
  userReacted: Set<string>
}

const mockState: {
  reactionsForTarget: ReactionsForTargetReturn
  currentUserId: string | null
  toggleReaction: ReturnType<typeof vi.fn>
} = {
  reactionsForTarget: { chips: [], userReacted: new Set() },
  currentUserId: 'user-me',
  toggleReaction: vi.fn(),
}

vi.mock('~/features/arc-orch/use-arc-reactions', async () => {
  const actual = await vi.importActual<typeof import('~/features/arc-orch/use-arc-reactions')>(
    '~/features/arc-orch/use-arc-reactions',
  )
  return {
    ...actual,
    useReactionsForTarget: () => mockState.reactionsForTarget,
    useReactionActions: () => ({
      toggleReaction: mockState.toggleReaction,
      currentUserId: mockState.currentUserId,
    }),
  }
})

// Replace the Radix Popover with bare divs. The component only uses
// Popover for trigger/content layout + open/close semantics; under
// jsdom we render the content unconditionally so picker click tests
// don't require portal mounting + open-state propagation.
vi.mock('~/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover">{children}</div>
  ),
  PopoverTrigger: ({
    children,
    ...rest
  }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: React.PropsWithChildren<unknown>) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))

import { ReactionsBar } from './ReactionsBar'
import { EMOJI_SET } from './use-arc-reactions'

function renderBar() {
  return render(<ReactionsBar arcId="arc-1" targetKind="comment" targetId="cmt-1" />)
}

beforeEach(() => {
  mockState.reactionsForTarget = { chips: [], userReacted: new Set() }
  mockState.currentUserId = 'user-me'
  mockState.toggleReaction = vi.fn().mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('ReactionsBar — empty state', () => {
  it('renders no chips and shows just the add button', () => {
    renderBar()
    expect(document.querySelectorAll('[data-reaction-chip]')).toHaveLength(0)
    expect(screen.getByLabelText('Add reaction')).toBeTruthy()
  })
})

describe('ReactionsBar — chip rendering', () => {
  it('renders one pill per chip with the correct count', () => {
    mockState.reactionsForTarget = {
      chips: [
        { emoji: '👍', count: 2, users: ['user-A', 'user-B'] },
        { emoji: '🎉', count: 1, users: ['user-C'] },
      ],
      userReacted: new Set(),
    }
    renderBar()
    const chips = document.querySelectorAll('[data-reaction-chip]')
    expect(chips).toHaveLength(2)
    expect(chips[0].getAttribute('data-reaction-chip')).toBe('👍')
    expect(chips[0].textContent).toContain('👍')
    expect(chips[0].textContent).toContain('2')
    expect(chips[1].getAttribute('data-reaction-chip')).toBe('🎉')
    expect(chips[1].textContent).toContain('1')
  })

  it('marks pressed=true when the current user has that emoji', () => {
    mockState.reactionsForTarget = {
      chips: [
        { emoji: '👍', count: 2, users: ['user-me', 'user-B'] },
        { emoji: '🎉', count: 1, users: ['user-C'] },
      ],
      userReacted: new Set(['👍']),
    }
    renderBar()
    // Use attribute iteration rather than querySelector with an emoji
    // value — jsdom's CSS-attribute matching handles multi-codepoint
    // Unicode inconsistently across versions.
    const all = Array.from(document.querySelectorAll('[data-reaction-chip]'))
    const pressedChip = all.find((el) => el.getAttribute('data-reaction-chip') === '👍')
    const unpressedChip = all.find((el) => el.getAttribute('data-reaction-chip') === '🎉')
    expect(pressedChip?.getAttribute('data-reaction-pressed')).toBe('true')
    expect(unpressedChip?.getAttribute('data-reaction-pressed')).toBe('false')
  })
})

describe('ReactionsBar — toggle interactions', () => {
  it('clicking a chip calls toggleReaction with that emoji', async () => {
    mockState.reactionsForTarget = {
      chips: [{ emoji: '🚀', count: 1, users: ['user-A'] }],
      userReacted: new Set(),
    }
    renderBar()
    const chip = Array.from(document.querySelectorAll('[data-reaction-chip]')).find(
      (el) => el.getAttribute('data-reaction-chip') === '🚀',
    ) as HTMLButtonElement | undefined
    expect(chip).toBeTruthy()
    if (!chip) return
    await act(async () => {
      fireEvent.click(chip)
    })
    expect(mockState.toggleReaction).toHaveBeenCalledTimes(1)
    expect(mockState.toggleReaction).toHaveBeenCalledWith({
      targetKind: 'comment',
      targetId: 'cmt-1',
      emoji: '🚀',
    })
  })

  it('add-button popover renders all EMOJI_SET emojis; clicking one calls toggleReaction', async () => {
    renderBar()
    // The mocked Popover renders content unconditionally — assert the
    // picker buttons exist for every entry in the canonical set.
    const allPicks = Array.from(document.querySelectorAll('[data-reaction-pick]'))
    const pickByEmoji = (e: string) =>
      allPicks.find((el) => el.getAttribute('data-reaction-pick') === e)
    for (const emoji of EMOJI_SET) {
      expect(pickByEmoji(emoji)).toBeTruthy()
    }

    const heart = pickByEmoji('❤️') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(heart)
    })
    expect(mockState.toggleReaction).toHaveBeenCalledTimes(1)
    expect(mockState.toggleReaction).toHaveBeenCalledWith({
      targetKind: 'comment',
      targetId: 'cmt-1',
      emoji: '❤️',
    })
  })
})
