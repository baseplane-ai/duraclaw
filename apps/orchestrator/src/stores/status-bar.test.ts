/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '~/lib/types'
import { useStatusBarStore } from './status-bar'

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
    ...overrides,
  }
}

describe('useStatusBarStore', () => {
  afterEach(() => {
    act(() => {
      useStatusBarStore.getState().clear()
    })
  })

  it('starts with null state and wsReadyState 3 (CLOSED)', () => {
    const { result } = renderHook(() => useStatusBarStore())
    expect(result.current.state).toBeNull()
    expect(result.current.wsReadyState).toBe(3)
    expect(result.current.contextUsage).toBeNull()
    expect(result.current.sessionResult).toBeNull()
    expect(result.current.onStop).toBeNull()
    expect(result.current.onInterrupt).toBeNull()
  })

  it('set() merges a partial patch into the store', () => {
    const { result } = renderHook(() => useStatusBarStore())
    const state = makeState({ status: 'running' })

    act(() => {
      result.current.set({ state, wsReadyState: 1 })
    })

    expect(result.current.state).toBe(state)
    expect(result.current.wsReadyState).toBe(1)
    // Other fields remain at defaults
    expect(result.current.contextUsage).toBeNull()
  })

  it('set() can update callbacks', () => {
    const { result } = renderHook(() => useStatusBarStore())
    const stopFn = vi.fn()
    const interruptFn = vi.fn()

    act(() => {
      result.current.set({ onStop: stopFn, onInterrupt: interruptFn })
    })

    expect(result.current.onStop).toBe(stopFn)
    expect(result.current.onInterrupt).toBe(interruptFn)
  })

  it('set() can update contextUsage and sessionResult', () => {
    const { result } = renderHook(() => useStatusBarStore())
    const ctx = { totalTokens: 5000, maxTokens: 200000, percentage: 2.5 }
    const res = { total_cost_usd: 0.123, duration_ms: 45000 }

    act(() => {
      result.current.set({ contextUsage: ctx, sessionResult: res })
    })

    expect(result.current.contextUsage).toEqual(ctx)
    expect(result.current.sessionResult).toEqual(res)
  })

  it('clear() resets all fields to defaults', () => {
    const { result } = renderHook(() => useStatusBarStore())

    act(() => {
      result.current.set({
        state: makeState(),
        wsReadyState: 1,
        contextUsage: { totalTokens: 100, maxTokens: 200000, percentage: 0.05 },
        sessionResult: { total_cost_usd: 1, duration_ms: 1000 },
        onStop: vi.fn(),
        onInterrupt: vi.fn(),
      })
    })

    // Verify something is set
    expect(result.current.state).not.toBeNull()

    act(() => {
      result.current.clear()
    })

    expect(result.current.state).toBeNull()
    expect(result.current.wsReadyState).toBe(3)
    expect(result.current.contextUsage).toBeNull()
    expect(result.current.sessionResult).toBeNull()
    expect(result.current.onStop).toBeNull()
    expect(result.current.onInterrupt).toBeNull()
  })

  it('set() does not clobber unrelated fields', () => {
    const { result } = renderHook(() => useStatusBarStore())
    const state = makeState()
    const stopFn = vi.fn()

    act(() => {
      result.current.set({ state, onStop: stopFn })
    })

    // Now update only wsReadyState
    act(() => {
      result.current.set({ wsReadyState: 1 })
    })

    // state and onStop should still be there
    expect(result.current.state).toBe(state)
    expect(result.current.onStop).toBe(stopFn)
    expect(result.current.wsReadyState).toBe(1)
  })
})
