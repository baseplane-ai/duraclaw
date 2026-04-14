/**
 * @vitest-environment jsdom
 *
 * ChatThread tests — verifies MessageBranch rendering and branch navigation.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock ai-elements to avoid complex dependency chain
vi.mock('@duraclaw/ai-elements', () => ({
  Conversation: ({ children, ...props }: Record<string, unknown>) => (
    <div data-testid="conversation" {...props}>
      {children as React.ReactNode}
    </div>
  ),
  ConversationContent: ({ children }: Record<string, unknown>) => (
    <div data-testid="conversation-content">{children as React.ReactNode}</div>
  ),
  ConversationEmptyState: ({ children, title }: Record<string, unknown>) => (
    <div data-testid="empty-state">
      {children ? (children as React.ReactNode) : (title as string)}
    </div>
  ),
  ConversationScrollButton: () => <div data-testid="scroll-button" />,
  Message: ({ children, from }: Record<string, unknown>) => (
    <div data-testid={`message-${from}`}>{children as React.ReactNode}</div>
  ),
  MessageContent: ({ children }: Record<string, unknown>) => (
    <div data-testid="message-content">{children as React.ReactNode}</div>
  ),
  MessageResponse: ({ children }: Record<string, unknown>) => (
    <span>{children as React.ReactNode}</span>
  ),
  Reasoning: ({ children }: Record<string, unknown>) => <div>{children as React.ReactNode}</div>,
  ReasoningContent: ({ children }: Record<string, unknown>) => (
    <div>{children as React.ReactNode}</div>
  ),
  ReasoningTrigger: () => <div />,
  Suggestion: ({ suggestion, onClick }: Record<string, unknown>) => (
    <button
      type="button"
      data-testid="suggestion"
      onClick={() => (onClick as (s: string) => void)?.(suggestion as string)}
    >
      {suggestion as string}
    </button>
  ),
  Suggestions: ({ children }: Record<string, unknown>) => (
    <div data-testid="suggestions">{children as React.ReactNode}</div>
  ),
  Tool: ({ children }: Record<string, unknown>) => <div>{children as React.ReactNode}</div>,
  ToolContent: ({ children }: Record<string, unknown>) => <div>{children as React.ReactNode}</div>,
  ToolHeader: () => <div />,
  ToolInput: () => <div />,
  ToolOutput: () => <div />,
}))

vi.mock('./GateResolver', () => ({
  GateResolver: () => <div data-testid="gate-resolver" />,
}))

import type { SessionMessage } from '~/lib/types'
import { ChatThread } from './ChatThread'

afterEach(() => {
  cleanup()
})

describe('ChatThread MessageBranch', () => {
  const defaultProps = {
    gate: null,
    status: 'running' as const,
    state: null,
    isConnecting: false,
    onResolveGate: vi.fn(),
    readOnly: false,
  }

  it('does not render branch arrows when branchInfo is empty', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={new Map()}
        onBranchNavigate={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('Previous branch')).toBeNull()
    expect(screen.queryByLabelText('Next branch')).toBeNull()
  })

  it('does not render branch arrows when total is 1', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([['usr-1', { current: 1, total: 1, siblings: ['usr-1'] }]])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('Previous branch')).toBeNull()
    expect(screen.queryByLabelText('Next branch')).toBeNull()
  })

  it('renders branch navigation when user message has siblings', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([
      ['usr-1', { current: 1, total: 3, siblings: ['usr-1', 'usr-3', 'usr-5'] }],
    ])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Previous branch')).toBeTruthy()
    expect(screen.getByLabelText('Next branch')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
  })

  it('disables prev button on first branch', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([['usr-1', { current: 1, total: 2, siblings: ['usr-1', 'usr-3'] }]])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={vi.fn()}
      />,
    )

    const prevBtn = screen.getByLabelText('Previous branch')
    expect(prevBtn.hasAttribute('disabled')).toBe(true)
    const nextBtn = screen.getByLabelText('Next branch')
    expect(nextBtn.hasAttribute('disabled')).toBe(false)
  })

  it('disables next button on last branch', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-3',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello v2' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([['usr-3', { current: 2, total: 2, siblings: ['usr-1', 'usr-3'] }]])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={vi.fn()}
      />,
    )

    const prevBtn = screen.getByLabelText('Previous branch')
    expect(prevBtn.hasAttribute('disabled')).toBe(false)
    const nextBtn = screen.getByLabelText('Next branch')
    expect(nextBtn.hasAttribute('disabled')).toBe(true)
  })

  it('calls onBranchNavigate with correct direction on click', () => {
    const onBranchNavigate = vi.fn()
    const messages: SessionMessage[] = [
      {
        id: 'usr-2',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello v2' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([
      ['usr-2', { current: 2, total: 3, siblings: ['usr-1', 'usr-2', 'usr-3'] }],
    ])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={onBranchNavigate}
      />,
    )

    fireEvent.click(screen.getByLabelText('Previous branch'))
    expect(onBranchNavigate).toHaveBeenCalledWith('usr-2', 'prev')

    fireEvent.click(screen.getByLabelText('Next branch'))
    expect(onBranchNavigate).toHaveBeenCalledWith('usr-2', 'next')
  })

  it('does not render branch arrows when onBranchNavigate is not provided', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([['usr-1', { current: 1, total: 2, siblings: ['usr-1', 'usr-2'] }]])

    render(<ChatThread {...defaultProps} messages={messages} branchInfo={branchInfo} />)

    expect(screen.queryByLabelText('Previous branch')).toBeNull()
  })

  it('does not render branch arrows on assistant messages', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi there' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([['msg-1', { current: 1, total: 2, siblings: ['msg-1', 'msg-2'] }]])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('Previous branch')).toBeNull()
  })

  it('still renders user message text alongside branch arrows', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'My question here' }],
        createdAt: new Date(),
      },
    ]

    const branchInfo = new Map([['usr-1', { current: 1, total: 2, siblings: ['usr-1', 'usr-3'] }]])

    render(
      <ChatThread
        {...defaultProps}
        messages={messages}
        branchInfo={branchInfo}
        onBranchNavigate={vi.fn()}
      />,
    )

    expect(screen.getByText('My question here')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
  })
})

describe('ChatThread Suggestions', () => {
  const defaultProps = {
    gate: null,
    status: 'running' as const,
    state: null,
    isConnecting: false,
    onResolveGate: vi.fn(),
    readOnly: false,
  }

  it('shows suggestions in empty state when onSendSuggestion is provided', () => {
    render(<ChatThread {...defaultProps} messages={[]} onSendSuggestion={vi.fn()} />)

    expect(screen.getByTestId('suggestions')).toBeTruthy()
    expect(screen.getByText('Explain this codebase')).toBeTruthy()
    expect(screen.getByText('Run the test suite')).toBeTruthy()
    expect(screen.getByText('What changed recently?')).toBeTruthy()
    expect(screen.getByText('Find and fix bugs')).toBeTruthy()
  })

  it('shows "Start a conversation" title when onSendSuggestion is provided', () => {
    render(<ChatThread {...defaultProps} messages={[]} onSendSuggestion={vi.fn()} />)

    expect(screen.getByText('Start a conversation')).toBeTruthy()
    expect(screen.getByText('Choose a suggestion or type your own message')).toBeTruthy()
  })

  it('shows "No messages yet" title when onSendSuggestion is not provided', () => {
    render(<ChatThread {...defaultProps} messages={[]} />)

    expect(screen.getByText('No messages yet')).toBeTruthy()
    expect(screen.getByText('The session will appear here as it runs')).toBeTruthy()
  })

  it('does not show suggestions when onSendSuggestion is not provided', () => {
    render(<ChatThread {...defaultProps} messages={[]} />)

    expect(screen.queryByTestId('suggestions')).toBeNull()
  })

  it('calls onSendSuggestion when a suggestion is clicked', () => {
    const onSendSuggestion = vi.fn()
    render(<ChatThread {...defaultProps} messages={[]} onSendSuggestion={onSendSuggestion} />)

    fireEvent.click(screen.getByText('Explain this codebase'))
    expect(onSendSuggestion).toHaveBeenCalledWith('Explain this codebase')
  })

  it('does not show suggestions when there are messages', () => {
    const messages: SessionMessage[] = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} onSendSuggestion={vi.fn()} />)

    expect(screen.queryByTestId('suggestions')).toBeNull()
  })
})
