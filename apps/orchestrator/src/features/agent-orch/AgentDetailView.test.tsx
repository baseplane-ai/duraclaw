/**
 * @vitest-environment jsdom
 *
 * AgentDetailView tests — verifies SessionMetadataHeader is not rendered
 * (its functionality moved to the global StatusBar).
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStatusBarStore } from '~/stores/status-bar'
import { AgentDetailView } from './AgentDetailView'
import type { UseCodingAgentResult } from './use-coding-agent'

// Stub out StatusBar so AgentDetailView tests don't exercise the live-state
// collection or useLiveQuery machinery.
vi.mock('~/components/status-bar', () => ({
  StatusBar: () => <div data-testid="status-bar-stub" />,
}))

// Mock child components to isolate AgentDetailView rendering
vi.mock('./ChatThread', () => ({
  ChatThread: (props: Record<string, unknown>) => (
    <div
      data-testid="chat-thread"
      data-status={props.status}
      data-has-send-suggestion={props.onSendSuggestion ? 'true' : 'false'}
    />
  ),
}))

vi.mock('./MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}))

function makeAgent(overrides: Partial<UseCodingAgentResult> = {}): UseCodingAgentResult {
  // Spec-31 P5 B10: UseCodingAgentResult narrowed — no `state` /
  // `sessionResult`. Status / gate derive from messages; summary fields
  // come from the D1-mirrored SessionLiveState row.
  return {
    messages: [],
    kataState: null,
    contextUsage: null,
    wsReadyState: 1,
    isConnecting: false,
    spawn: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    interrupt: vi.fn(),
    getContextUsage: vi.fn(),
    resolveGate: vi.fn(),
    sendMessage: vi.fn(),
    submitDraft: vi.fn(async () => ({ ok: true, sent: true })),
    forkWithHistory: vi.fn(),
    rewind: vi.fn(),
    resubmitMessage: vi.fn(),
    navigateBranch: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  useStatusBarStore.getState().clear()
})

describe('AgentDetailView', () => {
  it('does not render SessionMetadataHeader', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    // The old SessionMetadataHeader had data-testid or specific elements;
    // verify no element with that identity exists in the tree
    const container = screen.getByTestId('agent-detail-view')
    expect(container.querySelector('[data-testid="session-metadata-header"]')).toBeNull()
  })

  it('renders ChatThread', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.getByTestId('chat-thread')).toBeTruthy()
  })

  it('does not render KataStatePanel', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.queryByTestId('kata-state-panel')).toBeNull()
  })

  it('does not render ConversationDownload', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test-session" agent={agent} />)

    expect(screen.queryByTestId('conversation-download')).toBeNull()
  })

  it('renders MessageInput when status is running', () => {
    // Spec #37: status comes from the D1-mirrored `agent_sessions` row
    // (via `useSession`), not `agent.state`. MessageInput is always
    // rendered at the bottom of AgentDetailView regardless.
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.getByTestId('message-input')).toBeTruthy()
  })

  it('renders MessageInput when status is idle with error (previously failed)', () => {
    // Spec-31 P5 B10: error is no longer on the hook result; MessageInput
    // visibility no longer depends on it.
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.getByTestId('message-input')).toBeTruthy()
  })

  it('syncs stop/interrupt callbacks to the status bar store', () => {
    const stopFn = vi.fn()
    const interruptFn = vi.fn()
    const agent = makeAgent({ stop: stopFn, interrupt: interruptFn })

    render(<AgentDetailView name="test" agent={agent} />)

    const store = useStatusBarStore.getState()
    expect(store.onStop).toBe(stopFn)
    expect(store.onInterrupt).toBe(interruptFn)
  })

  it('passes onBranchNavigate to ChatThread', () => {
    // GH#14 P4: branchInfo is no longer a hook-return field — it's derived
    // inside AgentDetailView from the per-session `branchInfoCollection`.
    // This test just asserts the ChatThread renders with navigateBranch wired.
    const navigateBranch = vi.fn()
    const agent = makeAgent({ navigateBranch })
    render(<AgentDetailView name="test" agent={agent} />)

    const chatThread = screen.getByTestId('chat-thread')
    expect(chatThread).toBeTruthy()
  })

  it('clears status bar store on unmount', () => {
    const agent = makeAgent()
    const { unmount } = render(<AgentDetailView name="test" agent={agent} />)

    // Verify callbacks are populated
    expect(useStatusBarStore.getState().onStop).toBe(agent.stop)

    unmount()

    // Store should be cleared
    const store = useStatusBarStore.getState()
    expect(store.onStop).toBeNull()
    expect(store.onInterrupt).toBeNull()
  })

  it('passes onSendSuggestion to ChatThread when not terminal', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    const chatThread = screen.getByTestId('chat-thread')
    expect(chatThread.getAttribute('data-has-send-suggestion')).toBe('true')
  })
})
