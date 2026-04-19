/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStatusBarStore } from './status-bar'

describe('useStatusBarStore', () => {
  afterEach(() => {
    act(() => {
      useStatusBarStore.getState().clear()
    })
  })

  it('starts with null onStop and onInterrupt', () => {
    const { result } = renderHook(() => useStatusBarStore())
    expect(result.current.onStop).toBeNull()
    expect(result.current.onInterrupt).toBeNull()
  })

  it('set() merges callbacks into the store', () => {
    const { result } = renderHook(() => useStatusBarStore())
    const stopFn = vi.fn()
    const interruptFn = vi.fn()

    act(() => {
      result.current.set({ onStop: stopFn, onInterrupt: interruptFn })
    })

    expect(result.current.onStop).toBe(stopFn)
    expect(result.current.onInterrupt).toBe(interruptFn)
  })

  it('set() does not clobber unrelated callback', () => {
    const { result } = renderHook(() => useStatusBarStore())
    const stopFn = vi.fn()
    const interruptFn = vi.fn()

    act(() => {
      result.current.set({ onStop: stopFn })
    })
    act(() => {
      result.current.set({ onInterrupt: interruptFn })
    })

    expect(result.current.onStop).toBe(stopFn)
    expect(result.current.onInterrupt).toBe(interruptFn)
  })

  it('clear() resets both callbacks to null', () => {
    const { result } = renderHook(() => useStatusBarStore())

    act(() => {
      result.current.set({ onStop: vi.fn(), onInterrupt: vi.fn() })
    })
    expect(result.current.onStop).not.toBeNull()

    act(() => {
      result.current.clear()
    })

    expect(result.current.onStop).toBeNull()
    expect(result.current.onInterrupt).toBeNull()
  })
})
