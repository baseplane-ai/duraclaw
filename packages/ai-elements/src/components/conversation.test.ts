import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Conversation component', () => {
  it('Conversation component exports exist', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('export const Conversation')
    expect(content).toContain('export const ConversationContent')
    expect(content).toContain('export const ConversationEmptyState')
    expect(content).toContain('export const ConversationScrollButton')
  })

  it('pin-to-bottom primitive is use-stick-to-bottom (not a custom hook)', () => {
    // Regression guard against re-rolling a custom ResizeObserver + scroll
    // + wheel/touch listener design. The library (StackBlitz, MIT, powers
    // bolt.new / Vercel AI Elements / shadcn / prompt-kit) owns spring
    // animation, text-selection guard, content-shrink anchoring, and a
    // scroll-value tokenizer for programmatic writes — all four are edge
    // cases the old in-tree design either missed or got wrong.
    // See planning/research/2026-04-24-chat-autoscroll-library-evaluation.md.
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain("from 'use-stick-to-bottom'")
    expect(content).toContain('useStickToBottom')
  })

  it('initial scroll uses `initial: instant` (pre-paint jump to bottom)', () => {
    // OPFS-cached history must render already-scrolled, not flash from the
    // top. The library's `initial: 'instant'` runs a useLayoutEffect that
    // writes scrollTop before the first paint — equivalent to the old
    // hand-rolled useLayoutEffect, minus the 430ms-refire Android WebView
    // failure mode, which the library's internal mount tracking avoids.
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toMatch(/initial:\s*['"]instant['"]/)
  })

  it('resize uses spring animation, not discrete jumps', () => {
    // Under fast streaming token bursts a raw `scrollTop = scrollHeight`
    // assignment on every delta reads as visible jitter. The library's
    // velocity-based spring animation (damping 0.7, stiffness 0.05, mass
    // 1.25) adapts to variable-size content and caps each resize response
    // at 350ms so it can't accumulate lag.
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toMatch(/resize:\s*['"]smooth['"]/)
  })

  it('exposes the stable `useAutoScrollContext` API', () => {
    // Consumers (ChatThread VirtualizedMessageList, ConversationScrollButton,
    // test mocks) read `{ scrollRef, contentRef, sentinelRef, isAtBottom,
    // scrollToBottom }`. Keep this surface stable across the migration.
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('export function useAutoScrollContext')
    for (const key of ['scrollRef', 'contentRef', 'sentinelRef', 'isAtBottom', 'scrollToBottom']) {
      expect(content).toContain(key)
    }
  })

  it('no in-tree ResizeObserver / IntersectionObserver / wheel+touch listeners', () => {
    // The library owns content observation, scroll-intent detection, and
    // the programmatic-vs-user scroll distinction. Re-adding our own
    // observers would fight the library's scroll writes and bring back
    // the race conditions this migration was meant to kill.
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).not.toContain('new ResizeObserver')
    expect(content).not.toContain('IntersectionObserver')
    expect(content).not.toMatch(/addEventListener\(\s*['"]wheel['"]/)
    expect(content).not.toMatch(/addEventListener\(\s*['"]touchstart['"]/)
    expect(content).not.toMatch(/addEventListener\(\s*['"]touchmove['"]/)
  })

  it('no stale custom programmatic-write guard (use-stick-to-bottom owns the tokenizer)', () => {
    // The library flags its own programmatic scrolls via a scroll-value
    // tokenizer (`state.ignoreScrollToTop`) — race-free regardless of main
    // thread contention. A rAF-cleared boolean `programmaticRef` of the
    // kind the old code used is strictly worse and should not come back.
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).not.toContain('programmaticRef')
  })
})
