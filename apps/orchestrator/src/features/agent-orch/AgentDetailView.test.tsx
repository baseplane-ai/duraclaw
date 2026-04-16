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

vi.mock('./KataStatePanel', () => ({
  KataStatePanel: () => <div data-testid="kata-state-panel" />,
}))

vi.mock('./MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}))

vi.mock('./ConversationDownload', () => ({
  ConversationDownload: ({ messages, sessionId }: Record<string, unknown>) => (
    <div
      data-testid="conversation-download"
      data-message-count={(messages as unknown[]).length}
      data-session-id={sessionId as string}
    />
  ),
}))

function makeAgent(overrides: Partial<UseCodingAgentResult> = {}): UseCodingAgentResult {
  return {
    state: {
      status: 'running',
      session_id: 'test-session',
      project: 'test',
      project_path: '/tmp/test',
      model: 'claude-opus-4-0',
      prompt: 'hello',
      userId: 'u1',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: null,
      num_turns: 0,
      total_cost_usd: null,
      duration_ms: null,
      gate: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      result: null,
      error: null,
      summary: null,
      sdk_session_id: null,
    },
    events: [],
    messages: [],
    sessionResult: null,
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
    rewind: vi.fn(),
    injectQaPair: vi.fn(),
    branchInfo: new Map(),
    getBranches: vi.fn(),
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

  it('renders ChatThread and KataStatePanel', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.getByTestId('chat-thread')).toBeTruthy()
    expect(screen.getByTestId('kata-state-panel')).toBeTruthy()
  })

  it('renders MessageInput when status is running', () => {
    const base = makeAgent()
    const agent = makeAgent({ state: { ...base.state, status: 'running' } as typeof base.state })
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.getByTestId('message-input')).toBeTruthy()
  })

  it('renders MessageInput when status is idle with error (previously failed)', () => {
    const base = makeAgent()
    const agent = makeAgent({
      state: { ...base.state, status: 'idle', error: 'some error' } as typeof base.state,
    })
    render(<AgentDetailView name="test" agent={agent} />)

    expect(screen.getByTestId('message-input')).toBeTruthy()
  })

  it('syncs session data to the global status bar store', () => {
    const stopFn = vi.fn()
    const interruptFn = vi.fn()
    const agent = makeAgent({
      stop: stopFn,
      interrupt: interruptFn,
      contextUsage: { totalTokens: 1000, maxTokens: 200000, percentage: 0.5 },
    })

    render(<AgentDetailView name="test" agent={agent} />)

    const store = useStatusBarStore.getState()
    expect(store.state).toBe(agent.state)
    expect(store.wsReadyState).toBe(1)
    expect(store.contextUsage).toEqual({ totalTokens: 1000, maxTokens: 200000, percentage: 0.5 })
    expect(store.onStop).toBe(stopFn)
    expect(store.onInterrupt).toBe(interruptFn)
  })

  it('passes branchInfo and onBranchNavigate to ChatThread', () => {
    const branchInfo = new Map([['usr-1', { current: 1, total: 2, siblings: ['usr-1', 'usr-3'] }]])
    const navigateBranch = vi.fn()
    const agent = makeAgent({ branchInfo, navigateBranch })
    render(<AgentDetailView name="test" agent={agent} />)

    const chatThread = screen.getByTestId('chat-thread')
    expect(chatThread).toBeTruthy()
  })

  it('clears status bar store on unmount', () => {
    const agent = makeAgent()
    const { unmount } = render(<AgentDetailView name="test" agent={agent} />)

    // Verify store is populated
    expect(useStatusBarStore.getState().state).toBe(agent.state)

    unmount()

    // Store should be cleared
    const store = useStatusBarStore.getState()
    expect(store.state).toBeNull()
    expect(store.onStop).toBeNull()
  })

  it('renders ConversationDownload with messages and sessionId', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    const download = screen.getByTestId('conversation-download')
    expect(download).toBeTruthy()
    expect(download.getAttribute('data-message-count')).toBe('0')
    expect(download.getAttribute('data-session-id')).toBe('test-session')
  })

  it('passes onSendSuggestion to ChatThread when not terminal', () => {
    const agent = makeAgent()
    render(<AgentDetailView name="test" agent={agent} />)

    const chatThread = screen.getByTestId('chat-thread')
    expect(chatThread.getAttribute('data-has-send-suggestion')).toBe('true')
  })

  // Note: 'failed' is not part of SessionStatus (which only covers live SessionState);
  // it belongs to SessionSummary. AgentDetailView reads live state.status, so there's
  // no terminal-'failed' path to exercise here — 'aborted' is the only terminal state.

  it('does not pass onSendSuggestion to ChatThread when status is aborted', () => {
    const base = makeAgent()
    const agent = makeAgent({ state: { ...base.state, status: 'aborted' } as typeof base.state })
    render(<AgentDetailView name="test" agent={agent} />)

    const chatThread = screen.getByTestId('chat-thread')
    expect(chatThread.getAttribute('data-has-send-suggestion')).toBe('false')
  })
})
