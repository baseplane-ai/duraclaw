/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationStore } from './notifications'

describe('useNotificationStore', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Date.now()}` })
    // Reset store state
    act(() => {
      useNotificationStore.setState({ notifications: [] })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts with empty notifications', () => {
    const { result } = renderHook(() => useNotificationStore())
    expect(result.current.notifications).toEqual([])
  })

  it('addNotification adds a notification with id, read=false, timestamp', () => {
    const { result } = renderHook(() => useNotificationStore())

    act(() => {
      result.current.addNotification({
        type: 'gate',
        sessionId: 's1',
        sessionName: 'Test',
        body: 'Needs input',
        url: '/sessions/s1',
      })
    })

    expect(result.current.notifications).toHaveLength(1)
    const n = result.current.notifications[0]
    expect(n.type).toBe('gate')
    expect(n.read).toBe(false)
    expect(n.id).toBeTruthy()
    expect(n.timestamp).toBeTruthy()
  })

  it('addNotification prepends (newest first)', () => {
    const { result } = renderHook(() => useNotificationStore())

    act(() => {
      result.current.addNotification({
        type: 'completed',
        sessionId: 's1',
        sessionName: 'First',
        body: 'Done',
        url: '/sessions/s1',
      })
    })

    act(() => {
      result.current.addNotification({
        type: 'error',
        sessionId: 's2',
        sessionName: 'Second',
        body: 'Failed',
        url: '/sessions/s2',
      })
    })

    expect(result.current.notifications[0].sessionName).toBe('Second')
    expect(result.current.notifications[1].sessionName).toBe('First')
  })

  it('markRead marks a single notification as read', () => {
    const { result } = renderHook(() => useNotificationStore())

    act(() => {
      result.current.addNotification({
        type: 'gate',
        sessionId: 's1',
        sessionName: 'Test',
        body: 'body',
        url: '/sessions/s1',
      })
    })

    const id = result.current.notifications[0].id

    act(() => {
      result.current.markRead(id)
    })

    expect(result.current.notifications[0].read).toBe(true)
  })

  it('markAllRead marks all notifications as read', () => {
    const { result } = renderHook(() => useNotificationStore())

    act(() => {
      result.current.addNotification({
        type: 'gate',
        sessionId: 's1',
        sessionName: 'A',
        body: 'a',
        url: '/a',
      })
      result.current.addNotification({
        type: 'completed',
        sessionId: 's2',
        sessionName: 'B',
        body: 'b',
        url: '/b',
      })
    })

    act(() => {
      result.current.markAllRead()
    })

    expect(result.current.notifications.every((n) => n.read)).toBe(true)
  })

  it('clearAll removes all notifications', () => {
    const { result } = renderHook(() => useNotificationStore())

    act(() => {
      result.current.addNotification({
        type: 'gate',
        sessionId: 's1',
        sessionName: 'A',
        body: 'a',
        url: '/a',
      })
    })

    act(() => {
      result.current.clearAll()
    })

    expect(result.current.notifications).toEqual([])
  })
})
