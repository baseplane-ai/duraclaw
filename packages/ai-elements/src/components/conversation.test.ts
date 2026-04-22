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

  it('uses custom auto-scroll context (not use-stick-to-bottom)', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    // Should NOT depend on use-stick-to-bottom
    expect(content).not.toContain("from 'use-stick-to-bottom'")
    // Should use our own context
    expect(content).toContain('useAutoScroll')
    expect(content).toContain('useAutoScrollContext')
  })

  it('auto-scroll uses ResizeObserver for content growth', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('ResizeObserver')
  })

  it('no `escaped` ref (regression guard for the flag-based snap-back trap)', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    // Regression guard (mobile WebView foreground-resume): the flag-based
    // `escaped.current` design raced repeated growth events and trapped
    // the user inside the 70px near-bottom zone. The new design either
    // uses live scrollTop (pinned check) or disables RO snap entirely —
    // both are acceptable; what's NOT acceptable is re-introducing a
    // sticky escape flag.
    expect(content).not.toContain('escaped.current')
  })

  it('ConversationContent mount layout-effect is guarded against re-fire', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    // On Android WebView, a React concurrent-commit edge case re-invokes
    // this effect on a persisted fiber+DOM roughly every 430ms. Without
    // the `scrollTop === 0` guard, each re-fire writes scrollTop back to
    // the bottom and fights the user's drag. The guard turns every
    // re-invocation into a no-op while still handling the genuine first-
    // mount case where scrollTop starts at 0.
    expect(content).toContain('useLayoutEffect')
    expect(content).toContain('el.scrollTop === 0')
    expect(content).toContain('el.scrollTop = el.scrollHeight - el.clientHeight')
  })
})
