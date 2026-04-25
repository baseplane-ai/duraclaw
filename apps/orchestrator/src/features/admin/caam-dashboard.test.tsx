/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock theme provider for sonner Toaster (in case it ever loads)
vi.mock('~/context/theme-provider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

// Avoid sonner side effects in jsdom
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { CaamDashboard, type CaamProfile } from './caam-dashboard'

const samplePayload: { profiles: CaamProfile[] } = {
  profiles: [
    {
      name: 'primary',
      active: true,
      system: false,
      plan: 'max',
      util_7d_pct: 42.5,
      resets_at: '2026-04-25T18:00:00.000Z',
      cooldown_until: null,
    },
    {
      name: 'backup',
      active: false,
      system: false,
      plan: 'pro',
      util_7d_pct: 12.0,
      resets_at: null,
      cooldown_until: null,
    },
    {
      name: 'cooled',
      active: false,
      system: false,
      plan: 'pro',
      util_7d_pct: 88.7,
      resets_at: null,
      cooldown_until: '2026-04-25T22:00:00.000Z',
    },
  ],
}

describe('CaamDashboard', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    cleanup()
    fetchSpy.mockRestore()
    vi.clearAllMocks()
  })

  it('dashboard-renders-payload: shows rows with util %, disables Activate on the active profile', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(samplePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await act(async () => {
      render(<CaamDashboard />)
    })

    await waitFor(() => {
      expect(screen.getByText('primary')).toBeDefined()
    })

    expect(screen.getByText('backup')).toBeDefined()
    expect(screen.getByText('cooled')).toBeDefined()
    expect(screen.getByText('42.5%')).toBeDefined()
    expect(screen.getByText('12.0%')).toBeDefined()
    expect(screen.getByText('88.7%')).toBeDefined()

    // Activate buttons: one per row. The active profile's button is disabled.
    const buttons = screen.getAllByRole('button', { name: 'Activate' })
    expect(buttons).toHaveLength(3)
    // Find the row for `primary` and assert its Activate button is disabled.
    const primaryRow = screen.getByText('primary').closest('tr') as HTMLElement
    const primaryActivate = primaryRow.querySelector('button')
    expect(primaryActivate).not.toBeNull()
    expect((primaryActivate as HTMLButtonElement).disabled).toBe(true)

    // The non-active rows have an enabled Activate button.
    const backupRow = screen.getByText('backup').closest('tr') as HTMLElement
    const backupActivate = backupRow.querySelector('button') as HTMLButtonElement
    expect(backupActivate.disabled).toBe(false)
  })

  it('dashboard-degraded: 503 response shows inline error, leaves table empty', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'caam_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await act(async () => {
      render(<CaamDashboard />)
    })

    await waitFor(() => {
      expect(screen.getByText(/Failed to load profiles/)).toBeDefined()
    })

    // No data rows rendered.
    expect(screen.queryByText('primary')).toBeNull()
    expect(screen.queryByText('backup')).toBeNull()
    expect(screen.queryAllByRole('button', { name: 'Activate' })).toHaveLength(0)

    // No skeleton-loop spinner — only the explicit Refresh button (which
    // toggles between "Refresh" and "Refreshing…" while loading=true). Once
    // the failed fetch settles, loading should be false → label is "Refresh".
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined()
  })
})
