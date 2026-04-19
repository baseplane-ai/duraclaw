/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChainCheckout } from './use-chain-checkout'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('useChainCheckout', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('checkout resolves with { ok: true, reservation } on 200', async () => {
    const reservation = {
      issueNumber: 42,
      worktree: 'duraclaw-dev2',
      ownerId: 'user-a',
      heldSince: '2026-04-18T00:00:00Z',
      lastActivityAt: '2026-04-19T00:00:00Z',
      modeAtCheckout: 'impl',
      stale: false,
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { reservation }))

    const { result } = renderHook(() => useChainCheckout())

    let out: Awaited<ReturnType<typeof result.current.checkout>> | undefined
    await act(async () => {
      out = await result.current.checkout(42, 'duraclaw-dev2', 'impl')
    })

    expect(out).toEqual({ ok: true, reservation })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chains/42/checkout',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ worktree: 'duraclaw-dev2', modeAtCheckout: 'impl' }),
      }),
    )
  })

  it('checkout resolves with { ok: false, conflict } on 409', async () => {
    const conflict = {
      issueNumber: 42,
      worktree: 'duraclaw-dev2',
      ownerId: 'user-b',
      heldSince: '2026-04-17T00:00:00Z',
      lastActivityAt: '2026-04-18T00:00:00Z',
      modeAtCheckout: 'impl',
      stale: false,
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(409, { conflict, message: 'Worktree held' }),
    )

    const { result } = renderHook(() => useChainCheckout())

    let out: Awaited<ReturnType<typeof result.current.checkout>> | undefined
    await act(async () => {
      out = await result.current.checkout(43, 'duraclaw-dev2')
    })

    expect(out?.ok).toBe(false)
    expect(out?.conflict).toEqual(conflict)
    expect(out?.error).toBe('Worktree held')
  })

  it('release resolves with count on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { released: true, count: 1 }))

    const { result } = renderHook(() => useChainCheckout())

    let out: Awaited<ReturnType<typeof result.current.release>> | undefined
    await act(async () => {
      out = await result.current.release(42)
    })

    expect(out).toEqual({ ok: true, count: 1 })
  })

  it('forceRelease surfaces 403 error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(403, { message: 'not stale yet', staleAfterDays: 7 }),
    )

    const { result } = renderHook(() => useChainCheckout())

    let out: Awaited<ReturnType<typeof result.current.forceRelease>> | undefined
    await act(async () => {
      out = await result.current.forceRelease(42, 'duraclaw-dev2')
    })

    expect(out).toEqual({ ok: false, error: 'not stale yet' })
  })
})
