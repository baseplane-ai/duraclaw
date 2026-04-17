/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUserDefaults } from './use-user-defaults'

const DEFAULTS = {
  permission_mode: 'default',
  model: 'claude-opus-4-7',
  max_budget: null,
  thinking_mode: 'adaptive',
  effort: 'xhigh',
}

describe('useUserDefaults', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns defaults initially', () => {
    const { result } = renderHook(() => useUserDefaults())

    expect(result.current.preferences).toEqual(DEFAULTS)
    expect(result.current.loading).toBe(true)
  })

  it('loads cached preferences from localStorage', async () => {
    const cached = { ...DEFAULTS, model: 'claude-sonnet-4-20250514', effort: 'low' }
    localStorage.setItem('user-preferences', JSON.stringify(cached))

    const { result } = renderHook(() => useUserDefaults())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.preferences.model).toBe('claude-sonnet-4-20250514')
    expect(result.current.preferences.effort).toBe('low')
  })

  it('fetches preferences from server and merges with defaults', async () => {
    const serverPrefs = {
      permission_mode: 'bypassPermissions',
      model: 'claude-sonnet-4-20250514',
      max_budget: 10,
      thinking_mode: 'enabled',
      effort: 'medium',
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(serverPrefs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { result } = renderHook(() => useUserDefaults())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.preferences).toEqual(serverPrefs)
    expect(result.current.loading).toBe(false)

    // Should cache in localStorage
    const cached = JSON.parse(localStorage.getItem('user-preferences')!)
    expect(cached.model).toBe('claude-sonnet-4-20250514')
  })

  it('sets loading to false even when fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useUserDefaults())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.preferences).toEqual(DEFAULTS)
  })

  it('keeps defaults when server returns empty object', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { result } = renderHook(() => useUserDefaults())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.preferences).toEqual(DEFAULTS)
    expect(result.current.loading).toBe(false)
  })

  it('updatePreferences optimistically updates state and calls server', async () => {
    const { result } = renderHook(() => useUserDefaults())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      await result.current.updatePreferences({ model: 'claude-sonnet-4-20250514' })
    })

    expect(result.current.preferences.model).toBe('claude-sonnet-4-20250514')
    // Other fields remain default
    expect(result.current.preferences.effort).toBe('xhigh')

    // Should have called PUT
    expect(fetch).toHaveBeenCalledWith('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514' }),
    })

    // Should update localStorage
    const cached = JSON.parse(localStorage.getItem('user-preferences')!)
    expect(cached.model).toBe('claude-sonnet-4-20250514')
  })

  it('ignores invalid localStorage cache gracefully', async () => {
    localStorage.setItem('user-preferences', 'not-valid-json')

    const { result } = renderHook(() => useUserDefaults())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Should still have defaults, not crash
    expect(result.current.preferences).toEqual(DEFAULTS)
  })
})
