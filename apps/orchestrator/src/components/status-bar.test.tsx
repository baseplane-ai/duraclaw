/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '~/lib/types'
import { useStatusBarStore } from '~/stores/status-bar'
import { StatusBar } from './status-bar'

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: 'idle',
    session_id: 'test-session',
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

describe('StatusBar', () => {
  beforeEach(() => {
    act(() => {
      useStatusBarStore.getState().clear()
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when store has no state', () => {
    const { container } = render(<StatusBar />)
    expect(container.firstChild).toBeNull()
  })

  it('shows session data when store has state', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({
          status: 'running',
          project: 'duraclaw',
          model: 'opus-4',
          num_turns: 12,
        }),
        wsReadyState: 1,
      })
    })

    render(<StatusBar />)

    expect(screen.getByText('running')).toBeDefined()
    expect(screen.getByText('duraclaw')).toBeDefined()
    expect(screen.getByText('opus-4')).toBeDefined()
    expect(screen.getByText('12 turns')).toBeDefined()
  })

  it('shows "--" for missing project and model', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ project: '', model: null }),
      })
    })

    render(<StatusBar />)

    const dashes = screen.getAllByText('--')
    expect(dashes.length).toBe(2)
  })

  it('shows WS dot with "Connected" title when wsReadyState is 1', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
        wsReadyState: 1,
      })
    })

    render(<StatusBar />)
    expect(screen.getByTitle('Connected')).toBeDefined()
  })

  it('shows WS dot with "Connecting..." title when wsReadyState is 0', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
        wsReadyState: 0,
      })
    })

    render(<StatusBar />)
    expect(screen.getByTitle('Connecting...')).toBeDefined()
  })

  it('shows WS dot with "Disconnected" title when wsReadyState is 3', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
        wsReadyState: 3,
      })
    })

    render(<StatusBar />)
    expect(screen.getByTitle('Disconnected')).toBeDefined()
  })

  it('shows cost when sessionResult has total_cost_usd', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
        sessionResult: { total_cost_usd: 0.1234, duration_ms: 5000 },
      })
    })

    render(<StatusBar />)
    expect(screen.getByText('$0.1234')).toBeDefined()
    expect(screen.getByText('5s')).toBeDefined()
  })

  it('shows context usage bar when contextUsage is provided', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
        contextUsage: { totalTokens: 50000, maxTokens: 200000, percentage: 25 },
      })
    })

    render(<StatusBar />)
    expect(screen.getByText('25%')).toBeDefined()
    expect(screen.getByTitle('50,000 / 200,000 tokens (25%)')).toBeDefined()
  })

  it('does not show context bar when maxTokens is 0', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
        contextUsage: { totalTokens: 0, maxTokens: 0, percentage: 0 },
      })
    })

    render(<StatusBar />)
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('shows stop and interrupt buttons when running', () => {
    const stopFn = vi.fn()
    const interruptFn = vi.fn()

    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'running' }),
        onStop: stopFn,
        onInterrupt: interruptFn,
      })
    })

    render(<StatusBar />)
    expect(screen.getByLabelText('Stop session')).toBeDefined()
    expect(screen.getByLabelText('Interrupt session')).toBeDefined()
  })

  it('shows stop and interrupt buttons when waiting_gate', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'waiting_gate' }),
        onStop: vi.fn(),
        onInterrupt: vi.fn(),
      })
    })

    render(<StatusBar />)
    expect(screen.getByLabelText('Stop session')).toBeDefined()
    expect(screen.getByLabelText('Interrupt session')).toBeDefined()
  })

  it('does not show stop/interrupt buttons when idle', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'idle' }),
        onStop: vi.fn(),
        onInterrupt: vi.fn(),
      })
    })

    render(<StatusBar />)
    expect(screen.queryByLabelText('Stop session')).toBeNull()
    expect(screen.queryByLabelText('Interrupt session')).toBeNull()
  })

  it('does not show stop/interrupt buttons when failed', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'failed' }),
        onStop: vi.fn(),
        onInterrupt: vi.fn(),
      })
    })

    render(<StatusBar />)
    expect(screen.queryByLabelText('Stop session')).toBeNull()
    expect(screen.queryByLabelText('Interrupt session')).toBeNull()
  })

  it('calls onStop with reason when stop button clicked', () => {
    const stopFn = vi.fn()

    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'running' }),
        onStop: stopFn,
      })
    })

    render(<StatusBar />)
    fireEvent.click(screen.getByLabelText('Stop session'))

    expect(stopFn).toHaveBeenCalledWith('Stopped by user')
  })

  it('calls onInterrupt when interrupt button clicked', () => {
    const interruptFn = vi.fn()

    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'running' }),
        onInterrupt: interruptFn,
      })
    })

    render(<StatusBar />)
    fireEvent.click(screen.getByLabelText('Interrupt session'))

    expect(interruptFn).toHaveBeenCalledOnce()
  })

  it('does not show interrupt button when onInterrupt is null', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'running' }),
        onStop: vi.fn(),
        onInterrupt: null,
      })
    })

    render(<StatusBar />)
    expect(screen.getByLabelText('Stop session')).toBeDefined()
    expect(screen.queryByLabelText('Interrupt session')).toBeNull()
  })

  it('applies blue background classes when running', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'running' }),
      })
    })

    render(<StatusBar />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-info/20')
    expect(bar.className).toContain('border-info/50')
  })

  it('applies warning background classes when waiting_gate', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'waiting_gate' }),
      })
    })

    render(<StatusBar />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
    expect(bar.className).toContain('border-warning/50')
  })

  it('applies default background when failed (only aborted is styled red)', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'failed' }),
      })
    })

    render(<StatusBar />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-background')
  })

  it('applies default background when idle', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'idle' }),
      })
    })

    render(<StatusBar />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-background')
  })

  it('applies warning background for waiting_input', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState({ status: 'waiting_input' }),
      })
    })

    render(<StatusBar />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('bg-warning/20')
  })

  it('has correct height', () => {
    act(() => {
      useStatusBarStore.getState().set({
        state: makeState(),
      })
    })

    render(<StatusBar />)
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('py-1')
  })
})
