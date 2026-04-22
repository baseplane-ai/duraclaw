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

  it('auto-snap decision checks live scrollTop, not a sticky escape flag', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    // Regression guard (mobile WebView foreground-resume): the flag-based
    // `escaped.current` design raced repeated growth events and trapped the
    // user inside the 70px near-bottom zone. Live position is the source of
    // truth — `pinned` is computed inside the ResizeObserver callback and
    // no `escaped` ref exists.
    expect(content).not.toContain('escaped.current')
    expect(content).toContain('const pinned =')
    expect(content).toContain('PIN_THRESHOLD_PX')
  })

  it('ConversationContent scrolls to bottom on mount via useLayoutEffect', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('useLayoutEffect')
    expect(content).toContain('el.scrollTop = el.scrollHeight - el.clientHeight')
  })
})
