/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sessionLiveStateCollection,
  upsertSessionLiveState,
} from '~/db/session-live-state-collection'
import type { SessionStatus } from '~/lib/types'

// Spec-31 P5 B10: StatusBar derives `status` from messages via
// `useDerivedStatus`; summary fields (project / model / numTurns /
// totalCostUsd / durationMs) come from the D1-mirrored top-level
// SessionLiveState row. The old `state: SessionState` blob is gone.
let derivedStatusValue: SessionStatus = 'idle'
function setDerivedStatus(s: SessionStatus) {
  derivedStatusValue = s
}
vi.mock('~/hooks/use-derived-status', () => ({
  useDerivedStatus: () => derivedStatusValue,
}))

import { StatusBar } from './status-bar'

const TEST_ID = 'test-session'

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
    setDerivedStatus('idle')
  })

  afterEach(() => {
    cleanup()
    clearRow()
  })

  it('renders nothing when sessionId is null', () => {
    const { container } = render(<StatusBar sessionId={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows session data when collection has row', () => {
    setDerivedStatus('running')
    upsertSessionLiveState(TEST_ID, {
      project: 'duraclaw',
      model: 'opus-4',
      numTurns: 12,
      wsReadyState: 1,
      status: 'running',
    })

    render(<StatusBar sessionId={TEST_ID} />)

    expect(screen.getByText('running')).toBeDefined()
    expect(screen.getByText('duraclaw')).toBeDefined()
    expect(screen.getByText('opus-4')).toBeDefined()
    expect(screen.getByText('12 turns')).toBeDefined()
  })

  it('shows "--" for missing project and model', () => {
    upsertSessionLiveState(TEST_ID, {
      project: '',
      model: null,
      status: 'idle',
    })

    render(<StatusBar sessionId={TEST_ID} />)

    const dashes = screen.getAllByText('--')
    expect(dashes.length).toBe(2)
  })

  it('shows WS dot with "Connected" title when wsReadyState is 1', () => {
    upsertSessionLiveState(TEST_ID, { wsReadyState: 1, status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Connected')).toBeDefined()
  })

  it('shows WS dot with "Connecting..." title when wsReadyState is 0', () => {
    upsertSessionLiveState(TEST_ID, { wsReadyState: 0, status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Connecting...')).toBeDefined()
  })

  it('shows WS dot with "Disconnected" title when wsReadyState is 3', () => {
    upsertSessionLiveState(TEST_ID, { wsReadyState: 3, status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Disconnected')).toBeDefined()
  })

  it('shows cost and duration from top-level SessionLiveState fields', () => {
    upsertSessionLiveState(TEST_ID, {
      totalCostUsd: 0.1234,
      durationMs: 5000,
      status: 'idle',
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByText('$0.1234')).toBeDefined()
    expect(screen.getByText('5s')).toBeDefined()
  })

  it('shows context usage bar when contextUsage is provided', () => {
    upsertSessionLiveState(TEST_ID, {
      contextUsage: { totalTokens: 50000, maxTokens: 200000, percentage: 25 },
      status: 'idle',
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByText('25%')).toBeDefined()
    expect(screen.getByTitle('50,000 / 200,000 tokens (25%)')).toBeDefined()
  })

  it('does not show context bar when maxTokens is 0', () => {
    upsertSessionLiveState(TEST_ID, {
      contextUsage: { totalTokens: 0, maxTokens: 0, percentage: 0 },
      status: 'idle',
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('does not render stop or interrupt buttons (moved to composer footer)', () => {
    setDerivedStatus('running')
    upsertSessionLiveState(TEST_ID, { status: 'running' })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByLabelText('Stop session')).toBeNull()
    expect(screen.queryByLabelText('Interrupt session')).toBeNull()
  })

  it('applies blue background classes when running', () => {
    setDerivedStatus('running')
    upsertSessionLiveState(TEST_ID, { status: 'running' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-info/20')
    expect(bar.className).toContain('border-info/50')
  })

  it('applies warning background classes when waiting_gate', () => {
    setDerivedStatus('waiting_gate')
    upsertSessionLiveState(TEST_ID, { status: 'waiting_gate' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
    expect(bar.className).toContain('border-warning/50')
  })

  it('applies default background when idle', () => {
    upsertSessionLiveState(TEST_ID, { status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-background')
  })

  it('applies warning background for waiting_input', () => {
    setDerivedStatus('waiting_input')
    upsertSessionLiveState(TEST_ID, { status: 'waiting_input' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
  })

  it('has correct height', () => {
    upsertSessionLiveState(TEST_ID, { status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('py-1')
  })
})
