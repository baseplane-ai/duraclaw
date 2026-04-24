/**
 * @vitest-environment jsdom
 *
 * CaamDashboard tests — happy-path render with cooldown countdown, plus
 * the degraded `caam_configured: false` path.
 */

import type { CaamStatus } from '@duraclaw/shared-types'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaamDashboard } from './caam-dashboard'

function jsonResponse(body: CaamStatus): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CaamDashboard', () => {
  it('ui-admin-caam-renders — shows active profile and per-profile cards with countdown', async () => {
    const cooldownUntil = Date.now() + 10 * 60 * 1000
    const payload: CaamStatus = {
      caam_configured: true,
      active_profile: 'work1',
      profiles: [
        {
          name: 'work1',
          active: true,
          system: 'claude',
          health: { status: 'ok', error_count: 0 },
        },
        {
          name: 'work2',
          active: false,
          system: 'claude',
          health: { status: 'ok', error_count: 0 },
          cooldown_until: cooldownUntil,
        },
        {
          name: 'work3',
          active: false,
          system: 'claude',
          health: { status: 'ok', error_count: 0 },
        },
      ],
      warnings: [],
      last_rotation: null,
      fetched_at_ms: Date.now(),
    }

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    render(<CaamDashboard />)

    // First fetch resolves on a microtask — wait until profile cards land.
    await waitFor(() => {
      expect(screen.getAllByText('work1').length).toBeGreaterThan(0)
    })

    // Confirm the component hits the admin status endpoint with cookie
    // credentials (admin gate relies on Better Auth session cookie).
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/caam/status',
      expect.objectContaining({ credentials: 'include' }),
    )

    expect(screen.getByText('work2')).toBeTruthy()
    expect(screen.getByText('work3')).toBeTruthy()

    // work1's profile-card row contains the active badge.
    const activeBadges = screen.getAllByText('Active')
    expect(activeBadges.length).toBeGreaterThan(0)

    // Cooldown countdown for work2 should read roughly 9–10 minutes.
    const countdown = await screen.findByText(/\b(9m|10m)\b/)
    expect(countdown.textContent).toMatch(/\b(9m|10m)\b/)

    // Degraded info card is NOT rendered.
    expect(screen.queryByText(/caam is not installed/i)).toBeNull()
  })

  it('ui-admin-caam-degraded — shows muted info card and hides profile grid', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const payload: CaamStatus = {
      caam_configured: false,
      active_profile: null,
      profiles: [],
      warnings: ['caam binary not found on PATH'],
      last_rotation: null,
      fetched_at_ms: Date.now(),
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))

    render(<CaamDashboard />)

    await waitFor(() => {
      expect(screen.getByText(/caam is not installed/i)).toBeTruthy()
    })

    // Active-profile card and profile grid should not be present.
    expect(screen.queryByText('Active profile')).toBeNull()

    // Warnings still surface.
    expect(screen.getByText('caam binary not found on PATH')).toBeTruthy()

    // No console errors emitted by the component itself.
    expect(errorSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})
