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

  it('Conversation has initial="instant" to prevent scroll animation on load', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toMatch(/initial\s*=\s*["']instant["']/)
  })

  it('Conversation has resize="instant" to prevent scroll animation on content resize', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    // This is critical to prevent animated scrolling when messages load
    expect(content).toMatch(/resize\s*=\s*["']instant["']/)
  })

  it('StickToBottom is imported from use-stick-to-bottom', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain("from 'use-stick-to-bottom'")
    expect(content).toContain('StickToBottom')
  })

  it('ConversationContent uses StickToBottom.Content', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('StickToBottom.Content')
  })

  it('ConversationScrollButton uses useStickToBottomContext', () => {
    const conversationPath = join(__dirname, 'conversation.tsx')
    const content = readFileSync(conversationPath, 'utf-8')

    expect(content).toContain('useStickToBottomContext')
  })
})
