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

  it('respects user scroll-up via escaped ref', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    // The scroll handler should detect upward scrolling
    expect(content).toContain('escaped.current = true')
    // And re-engage when near bottom
    expect(content).toContain('escaped.current = false')
  })

  it('ConversationContent scrolls to bottom on mount via useLayoutEffect', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('useLayoutEffect')
    expect(content).toContain('el.scrollTop = el.scrollHeight - el.clientHeight')
  })
})
