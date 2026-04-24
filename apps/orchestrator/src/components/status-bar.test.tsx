/**
 * @vitest-environment jsdom
 *
 * StatusBar derives `status` from `useSession(sessionId)` (sessionsCollection
 * row) and `wsReadyState` from `useSessionLocalState(sessionId)`. Tests mock
 * both hooks directly; no collection writes required.
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let sessionRow: Partial<SessionSummary> | undefined
let localRow: { id: string; wsReadyState: number; wsCloseTs: number | null } | undefined

vi.mock('~/hooks/use-sessions-collection', () => ({
  useSession: () => sessionRow,
}))

vi.mock('~/db/session-local-collection', () => ({
  useSessionLocalState: () => localRow,
}))

import { StatusBar } from './status-bar'

const TEST_ID = 'test-session'

function setSession(overrides: Partial<SessionSummary> = {}) {
  sessionRow = {
    id: TEST_ID,
    status: 'idle',
    ...overrides,
  } as Partial<SessionSummary>
}

function setLocal(wsReadyState: number) {
  localRow = { id: TEST_ID, wsReadyState, wsCloseTs: null }
}

describe('StatusBar', () => {
  beforeEach(() => {
    sessionRow = undefined
    localRow = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when sessionId is null', () => {
    const { container } = render(<StatusBar sessionId={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows session data when collection has row', () => {
    setSession({
      project: 'duraclaw',
      model: 'opus-4',
      numTurns: 12,
      status: 'running',
    })
    setLocal(1)

    render(<StatusBar sessionId={TEST_ID} />)

    expect(screen.getByText('Running')).toBeDefined()
    expect(screen.getByText('duraclaw')).toBeDefined()
    expect(screen.getByText('opus-4')).toBeDefined()
  })

  it('does not render turns, cost, or duration (removed from status bar)', () => {
    setSession({
      project: 'duraclaw',
      model: 'opus-4',
      numTurns: 12,
      totalCostUsd: 0.1234,
      durationMs: 5000,
      status: 'idle',
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByText('12 turns')).toBeNull()
    expect(screen.queryByText('$0.1234')).toBeNull()
    expect(screen.queryByText('5s')).toBeNull()
  })

  it('shows "--" for missing project and model', () => {
    setSession({ project: '', model: null, status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)

    const dashes = screen.getAllByText('--')
    expect(dashes.length).toBe(2)
  })

  it('shows WS dot with "Connected" title when wsReadyState is 1', () => {
    setSession({ status: 'idle' })
    setLocal(1)
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Connected')).toBeDefined()
  })

  it('shows WS dot with "Reconnecting…" title when wsReadyState is 0', () => {
    setSession({ status: 'idle' })
    setLocal(0)
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Reconnecting…')).toBeDefined()
  })

  it('shows WS dot with "Reconnecting…" title when wsReadyState is 3', () => {
    setSession({ status: 'idle' })
    setLocal(3)
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByTitle('Reconnecting…')).toBeDefined()
  })

  it('shows context usage bar when contextUsage is provided via JSON column', () => {
    setSession({
      contextUsageJson: JSON.stringify({
        totalTokens: 50000,
        maxTokens: 200000,
        percentage: 25,
      }),
      status: 'idle',
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.getByText('25%')).toBeDefined()
    expect(screen.getByTitle('50,000 / 200,000 tokens (25%)')).toBeDefined()
  })

  it('does not show context bar when maxTokens is 0', () => {
    setSession({
      contextUsageJson: JSON.stringify({ totalTokens: 0, maxTokens: 0, percentage: 0 }),
      status: 'idle',
    })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('does not render stop or interrupt buttons (moved to composer footer)', () => {
    setSession({ status: 'running' })
    render(<StatusBar sessionId={TEST_ID} />)
    expect(screen.queryByLabelText('Stop session')).toBeNull()
    expect(screen.queryByLabelText('Interrupt session')).toBeNull()
  })

  it('applies blue background classes when running', () => {
    setSession({ status: 'running' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-info/20')
    expect(bar.className).toContain('border-info/50')
  })

  it('applies warning background classes when waiting_gate', () => {
    setSession({ status: 'waiting_gate' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
    expect(bar.className).toContain('border-warning/50')
  })

  it('applies default background when idle', () => {
    setSession({ status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-background')
  })

  it('applies warning background for waiting_input', () => {
    setSession({ status: 'waiting_input' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
  })

  it('has correct height', () => {
    setSession({ status: 'idle' })
    render(<StatusBar sessionId={TEST_ID} />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('py-1')
  })
})
