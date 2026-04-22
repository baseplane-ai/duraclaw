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
  // Ref callbacks are no-ops in jsdom — VirtualizedMessageList calls
  // `scrollRef(node)` / `contentRef(node)` during ref-callback attach.
  // `sentinelRef` retained as a no-op for API back-compat.
  useAutoScrollContext: () => ({
    scrollToBottom: () => {},
    isAtBottom: true,
    scrollRef: () => {},
    contentRef: () => {},
    sentinelRef: () => {},
  }),
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

// jsdom has no layout, so @tanstack/react-virtual's real `useVirtualizer`
// sees a 0×0 viewport and renders zero items. The tests assert on rendered
// message rows, so stub it to render every item flat.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 160,
        size: 160,
        end: (i + 1) * 160,
        key: i,
        lane: 0,
      })),
    getTotalSize: () => count * 160,
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
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

/**
 * Regression-guard suite for the "collapse consecutive thoughts into a reasoning
 * chip" feature (commits 87778dd, 0059046, 6ae1f96, 02589e3). These scenarios
 * are the exact shapes that competing worktree merges have broken in the past:
 * a silent regression here ships as every thought rendering as its own block
 * again, which we explicitly moved away from.
 */
describe('ChatThread reasoning consolidation', () => {
  const defaultProps = {
    state: null,
    isConnecting: false,
    onResolveGate: vi.fn(),
    readOnly: false,
  }

  it('renders one chip with no count for a single reasoning part', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'one thought', state: 'done' },
          { type: 'text', text: 'answer', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    const chipLabels = screen.getAllByText('Thought for a few seconds')
    expect(chipLabels).toHaveLength(1)
    expect(screen.queryByText(/^×/)).toBeNull()
  })

  it('collapses consecutive reasoning parts into a single ×N chip', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'r1', state: 'done' },
          { type: 'reasoning', text: 'r2', state: 'done' },
          { type: 'reasoning', text: 'r3', state: 'done' },
          { type: 'text', text: 'ok', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    expect(screen.getAllByText('Thought for a few seconds')).toHaveLength(1)
    expect(screen.getByText('×3')).toBeTruthy()
  })

  it('keeps one reasoning chip even when tool calls interleave', () => {
    // [r, t, r, t, r, text] previously fragmented into 3 "Thought" chips.
    // With 0059046 the reasoning buffer survives tool arrivals and only
    // flushes on the text break.
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'think a', state: 'done' },
          {
            type: 'tool-Bash',
            toolCallId: 't1',
            toolName: 'Bash',
            input: { command: 'ls' },
            state: 'output-available',
            output: 'README.md',
          },
          { type: 'reasoning', text: 'think b', state: 'done' },
          {
            type: 'tool-Bash',
            toolCallId: 't2',
            toolName: 'Bash',
            input: { command: 'pwd' },
            state: 'output-available',
            output: '/',
          },
          { type: 'reasoning', text: 'think c', state: 'done' },
          { type: 'text', text: 'done', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    // Exactly ONE reasoning chip spanning all three thoughts.
    expect(screen.getAllByText('Thought for a few seconds')).toHaveLength(1)
    expect(screen.getByText('×3')).toBeTruthy()
  })

  it('does not let data-file-changed parts fragment the reasoning chip', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'r1', state: 'done' },
          // data-file-changed is a loosely-typed narration row; the renderer
          // skips it without flushing buffered reasoning.
          {
            type: 'data-file-changed',
            data: { path: '/x' },
          } as unknown as SessionMessage['parts'][number],
          { type: 'reasoning', text: 'r2', state: 'done' },
          { type: 'text', text: 'done', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    expect(screen.getAllByText('Thought for a few seconds')).toHaveLength(1)
    expect(screen.getByText('×2')).toBeTruthy()
  })

  it('renders separate chips when reasoning is split by a text part (real boundary)', () => {
    // Text is a real message break — the feature collapses WITHIN a contiguous
    // group, not across the whole message.
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'r1', state: 'done' },
          { type: 'reasoning', text: 'r2', state: 'done' },
          { type: 'text', text: 'intermediate answer', state: 'done' },
          { type: 'reasoning', text: 'r3', state: 'done' },
          { type: 'text', text: 'final', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    // Two separate reasoning chips — one for [r1,r2] (×2), one for [r3] (no count).
    expect(screen.getAllByText('Thought for a few seconds')).toHaveLength(2)
    expect(screen.getByText('×2')).toBeTruthy()
  })
})

/**
 * Paired Q/A render for resolved `tool-ask_user` parts. The server persists
 * the output as `{ answers: StructuredAnswer[] }` (issue #63); rows
 * persisted before that landed stored a flat string. The resolved render
 * must handle both — and surface "Declined" for gates the user refused.
 */
describe('ChatThread ResolvedAskUser paired Q/A render', () => {
  const defaultProps = {
    state: null,
    isConnecting: false,
    onResolveGate: vi.fn(),
    readOnly: false,
  }

  it('renders paired Q/A when output is structured answers object', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ga1',
            state: 'output-available',
            input: {
              questions: [
                { question: 'Which color?', header: 'color', options: [], multiSelect: false },
                { question: 'Which size?', header: 'size', options: [], multiSelect: false },
              ],
            },
            output: {
              answers: [{ label: 'Blue' }, { label: 'Small', note: 'prefer tight' }],
            },
          } as unknown as SessionMessage['parts'][number],
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    expect(screen.getByText('Which color?')).toBeTruthy()
    expect(screen.getByText('Which size?')).toBeTruthy()
    expect(screen.getByText('Blue')).toBeTruthy()
    expect(screen.getByText('Small')).toBeTruthy()
    // Note is rendered as "(note: prefer tight)" in its own span.
    expect(screen.getByText('(note: prefer tight)')).toBeTruthy()
  })

  it('renders legacy joined string answer at bottom when output is a string', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ga1',
            state: 'output-available',
            input: {
              questions: [
                { question: 'Which color?', header: 'color', options: [], multiSelect: false },
                { question: 'Which size?', header: 'size', options: [], multiSelect: false },
              ],
            },
            output: 'Blue; Small (note: prefer tight)',
          } as unknown as SessionMessage['parts'][number],
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    // Questions still listed.
    expect(screen.getByText('Which color?')).toBeTruthy()
    expect(screen.getByText('Which size?')).toBeTruthy()
    // Legacy joined answer rendered once, at the bottom.
    expect(screen.getByText('Blue; Small (note: prefer tight)')).toBeTruthy()
  })

  it('renders "Declined" when state is output-denied', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-ask_user',
            toolCallId: 'ga1',
            state: 'output-denied',
            input: {
              questions: [
                { question: 'Which color?', header: 'color', options: [], multiSelect: false },
                { question: 'Which size?', header: 'size', options: [], multiSelect: false },
              ],
            },
            output: undefined,
          } as unknown as SessionMessage['parts'][number],
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    expect(screen.getByText('Declined')).toBeTruthy()
  })
})

/**
 * Bug #63 D: pending gates are hoisted to the bottom of their assistant
 * turn so the user's attention lands on the prompt, regardless of where
 * the `tool-ask_user`/`tool-permission` part landed in `msg.parts`.
 * Resolved (non-pending) ask_user parts still render inline at their
 * natural position to preserve conversational order in history.
 */
describe('ChatThread pending-gate position', () => {
  const defaultProps = {
    state: null,
    isConnecting: false,
    onResolveGate: vi.fn(),
    readOnly: false,
  }

  it('renders a pending gate at the bottom of the assistant turn even when it is not the last part', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'text-before-gate', state: 'done' },
          {
            type: 'tool-ask_user',
            toolCallId: 'ga-pending',
            state: 'approval-requested',
            input: {
              questions: [
                { question: 'Proceed?', header: 'proceed', options: [], multiSelect: false },
              ],
            },
          } as unknown as SessionMessage['parts'][number],
          { type: 'text', text: 'text-after-gate', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    const gate = screen.getByTestId('gate-resolver')
    const textAfter = screen.getByText('text-after-gate')

    // Gate must render AFTER the text part that originally followed it.
    // DOCUMENT_POSITION_FOLLOWING (0x04) means textAfter precedes gate.
    expect(textAfter.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves resolved (non-pending) ask_user parts in their natural order', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'text-before', state: 'done' },
          {
            type: 'tool-ask_user',
            toolCallId: 'ga-resolved',
            state: 'output-available',
            input: {
              questions: [
                { question: 'Resolved question?', header: 'q', options: [], multiSelect: false },
              ],
            },
            output: { answers: [{ label: 'Yes' }] },
          } as unknown as SessionMessage['parts'][number],
          { type: 'text', text: 'text-after', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    render(<ChatThread {...defaultProps} messages={messages} />)

    const textBefore = screen.getByText('text-before')
    const resolvedQuestion = screen.getByText('Resolved question?')
    const textAfter = screen.getByText('text-after')

    // text-before → resolved Q/A → text-after (natural order).
    expect(
      textBefore.compareDocumentPosition(resolvedQuestion) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      resolvedQuestion.compareDocumentPosition(textAfter) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

/**
 * Bug #63 A: the ChatMessageRow memo comparator must scan every part for
 * type / state / toolCallId changes — not just the trailing part — so that
 * `promoteToolPartToGate` flipping an interior part from
 * `tool-AskUserQuestion`/`input-available` to `tool-ask_user`/
 * `approval-requested` causes a re-render. Without the full-parts scan
 * the memo returns true and the gate stays invisible until a refresh.
 */
describe('ChatThread message memo — interior part state change', () => {
  const defaultProps = {
    state: null,
    isConnecting: false,
    onResolveGate: vi.fn(),
    readOnly: false,
  }

  it('re-renders when an interior part flips to approval-requested after initial render', () => {
    const initialMessages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'text-A', state: 'done' },
          {
            type: 'tool-AskUserQuestion',
            toolCallId: 'ga-promo',
            toolName: 'AskUserQuestion',
            state: 'input-available',
            input: {
              questions: [
                { question: 'Proceed?', header: 'proceed', options: [], multiSelect: false },
              ],
            },
          } as unknown as SessionMessage['parts'][number],
          { type: 'text', text: 'text-B', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    const { rerender } = render(<ChatThread {...defaultProps} messages={initialMessages} />)

    // Gate prompt NOT shown initially — part is input-available, not
    // approval-requested, so isPendingGate returns false.
    expect(screen.queryByTestId('gate-resolver')).toBeNull()

    // Flip the interior part to the promoted gate shape. Same message id,
    // same parts length — only the interior part's type+state change.
    const updatedMessages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'text-A', state: 'done' },
          {
            type: 'tool-ask_user',
            toolCallId: 'ga-promo',
            toolName: 'ask_user',
            state: 'approval-requested',
            input: {
              questions: [
                { question: 'Proceed?', header: 'proceed', options: [], multiSelect: false },
              ],
            },
          } as unknown as SessionMessage['parts'][number],
          { type: 'text', text: 'text-B', state: 'done' },
        ],
        createdAt: new Date(),
      },
    ]

    rerender(<ChatThread {...defaultProps} messages={updatedMessages} />)

    // Memo comparator's full-parts scan must catch the interior promotion.
    expect(screen.getByTestId('gate-resolver')).toBeTruthy()
  })
})
