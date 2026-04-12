/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationWatcher } from './use-notification-watcher'

const mockAddNotification = vi.fn()

vi.mock('~/stores/notifications', () => ({
  useNotificationStore: (
    selector: (s: { addNotification: typeof mockAddNotification }) => unknown,
  ) => selector({ addNotification: mockAddNotification }),
}))

describe('useNotificationWatcher', () => {
  beforeEach(() => {
    mockAddNotification.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not notify on initial load', () => {
    const sessions = [
      { id: 's1', status: 'running', project: 'proj' },
      { id: 's2', status: 'completed', project: 'proj' },
    ]

    renderHook(() => useNotificationWatcher(sessions))

    expect(mockAddNotification).not.toHaveBeenCalled()
  })

  it('notifies when session transitions to waiting_gate', () => {
    const { rerender } = renderHook(({ sessions }) => useNotificationWatcher(sessions), {
      initialProps: { sessions: [{ id: 's1', status: 'running', project: 'proj' }] },
    })

    rerender({ sessions: [{ id: 's1', status: 'waiting_gate', project: 'proj' }] })

    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gate', sessionId: 's1' }),
    )
  })

  it('notifies when session transitions to completed', () => {
    const { rerender } = renderHook(({ sessions }) => useNotificationWatcher(sessions), {
      initialProps: { sessions: [{ id: 's1', status: 'running', project: 'proj' }] },
    })

    rerender({ sessions: [{ id: 's1', status: 'completed', project: 'proj' }] })

    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'completed', sessionId: 's1' }),
    )
  })

  it('notifies when session transitions to failed', () => {
    const { rerender } = renderHook(({ sessions }) => useNotificationWatcher(sessions), {
      initialProps: { sessions: [{ id: 's1', status: 'running', project: 'proj' }] },
    })

    rerender({ sessions: [{ id: 's1', status: 'failed', project: 'proj' }] })

    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', sessionId: 's1' }),
    )
  })

  it('does not notify when status does not change', () => {
    const sessions = [{ id: 's1', status: 'running', project: 'proj' }]
    const { rerender } = renderHook(({ sessions }) => useNotificationWatcher(sessions), {
      initialProps: { sessions },
    })

    rerender({ sessions: [{ id: 's1', status: 'running', project: 'proj' }] })

    expect(mockAddNotification).not.toHaveBeenCalled()
  })

  it('uses title over project for sessionName', () => {
    const { rerender } = renderHook(({ sessions }) => useNotificationWatcher(sessions), {
      initialProps: {
        sessions: [{ id: 's1', status: 'running', project: 'proj', title: 'My Session' }],
      },
    })

    rerender({
      sessions: [{ id: 's1', status: 'completed', project: 'proj', title: 'My Session' }],
    })

    expect(mockAddNotification).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'My Session' }),
    )
  })
})
