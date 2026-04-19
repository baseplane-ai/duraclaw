/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  sessionLiveStateCollection,
  upsertSessionLiveState,
} from '~/db/session-live-state-collection'
import type { SessionState } from '~/lib/types'
import { StatusBar } from './status-bar'

const TEST_ID = 'test-session'

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: 'idle',
    session_id: TEST_ID,
    project: 'my-project',
    project_path: '/tmp/project',
    model: 'claude-4',
    prompt: 'do stuff',
    userId: 'u1',
    started_at: null,
    completed_at: null,
    num_turns: 5,
    total_cost_usd: null,
    duration_ms: null,
    gate: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    result: null,
    error: null,
    summary: null,
    sdk_session_id: null,
    ...overrides,
  }
}

function clearRow() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLiveStateCollection as any
    if (coll.has?.(TEST_ID)) coll.delete(TEST_ID)
  } catch {
    // ignore
  }
}

describe('StatusBar', () => {
  beforeEach(() => {
    clearRow()
  })

  afterEach(() => {
    cleanup()
    clearRow()
  })

  it('renders nothing when sessionId is null', () => {
    const { container } = render(<StatusBar sessionId={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when collection has no row for sessionId', () => {
    const { container } = render(<StatusBar sessionId={TEST_ID} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when row exists but state is null', () => {
    upsertSessionLiveState(TEST_ID, { wsReadyState: 1 })
    const { container } = render(<StatusBar sessionId={TEST_ID} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows session data when collection has row', () => {
    upsertSessionLiveState(TEST_ID, {
      state: makeState({ status: 'running', project: 'duraclaw', model: 'opus-4', num_turns: 12 }),
      wsReadyState: 1,
    })

    render(<StatusBar sessionId={TEST_ID} />)

    expect(screen.getByText('running')).toBeDefined()
    expect(screen.getByText('duraclaw')).toBeDefined()
    expect(screen.getByText('opus-4')).toBeDefined()
    expect(screen.getByText('12 turns')).toBeDefined()
  })

  it('shows "--" for missing project and model', () => {
    upsertSessionLiveState(TEST_ID, {
      state: makeState({ project: '', model: null }),
    })

    render(<StatusBar sessionId={TEST_ID} />)

    const dashes = screen.getAllByText('--')
    expect(dashes.length).toBe(2)
  })

  it('shows WS dot with "Connected" title when wsReadyState is 1', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState(), wsReadyState: 1 })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Connected')).toBeDefined()
  })

  it('shows WS dot with "Connecting..." title when wsReadyState is 0', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState(), wsReadyState: 0 })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Connecting...')).toBeDefined()
  })

  it('shows WS dot with "Disconnected" title when wsReadyState is 3', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState(), wsReadyState: 3 })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Disconnected')).toBeDefined()
  })

  it('shows cost when sessionResult has total_cost_usd', () => {
    upsertSessionLiveState(TEST_ID, {
      state: makeState(),
      sessionResult: { total_cost_usd: 0.1234, duration_ms: 5000 },
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByText('$0.1234')).toBeDefined()
    expect(screen.getByText('5s')).toBeDefined()
  })

  it('shows context usage bar when contextUsage is provided', () => {
    upsertSessionLiveState(TEST_ID, {
      state: makeState(),
      contextUsage: { totalTokens: 50000, maxTokens: 200000, percentage: 25 },
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByText('25%')).toBeDefined()
    expect(screen.getByTitle('50,000 / 200,000 tokens (25%)')).toBeDefined()
  })

  it('does not show context bar when maxTokens is 0', () => {
    upsertSessionLiveState(TEST_ID, {
      state: makeState(),
      contextUsage: { totalTokens: 0, maxTokens: 0, percentage: 0 },
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('does not render stop or interrupt buttons (moved to composer footer)', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState({ status: 'running' }) })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByLabelText('Stop session')).toBeNull()
    expect(screen.queryByLabelText('Interrupt session')).toBeNull()
  })

  it('applies blue background classes when running', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState({ status: 'running' }) })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-info/20')
    expect(bar.className).toContain('border-info/50')
  })

  it('applies warning background classes when waiting_gate', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState({ status: 'waiting_gate' }) })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
    expect(bar.className).toContain('border-warning/50')
  })

  it('applies default background when failed (only aborted is styled red)', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState({ status: 'failed' }) })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-background')
  })

  it('applies default background when idle', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState({ status: 'idle' }) })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-background')
  })

  it('applies warning background for waiting_input', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState({ status: 'waiting_input' }) })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
  })

  it('has correct height', () => {
    upsertSessionLiveState(TEST_ID, { state: makeState() })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('py-1')
  })
})
