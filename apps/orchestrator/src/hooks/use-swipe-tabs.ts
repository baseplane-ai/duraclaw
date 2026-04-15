import { useCallback, useRef, useState } from 'react'
import { useTabStore } from '~/stores/tabs'

const EDGE_ZONE = 30
const SWIPE_DISTANCE = 60
const SWIPE_RATIO = 1.5 // horizontal must exceed vertical by this ratio

interface SwipeDebug {
  active: boolean
  startX: number
  dx: number
  dy: number
  dir: string
  rejected?: string
}

/**
 * Returns props to spread onto a container element + debug state.
 * Detects horizontal swipe gestures to switch tabs.
 *
 * Usage:
 *   const { swipeProps, debug } = useSwipeTabs(onSelectSession)
 *   <div {...swipeProps}>{children}</div>
 */
export function useSwipeTabs(onSelectSession: (sessionId: string) => void) {
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const [debug, setDebug] = useState<SwipeDebug | null>(null)
  const debugTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const handleSwipe = useCallback(
    (dir: 'left' | 'right') => {
      const { tabs, activeTabId, setActiveTab } = useTabStore.getState()
      if (tabs.length < 2 || !activeTabId) return
      const idx = tabs.findIndex((t) => t.id === activeTabId)
      const nextIdx = dir === 'left' ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= tabs.length) return
      const next = tabs[nextIdx]
      setActiveTab(next.id)
      onSelectSession(next.sessionId)
    },
    [onSelectSession],
  )

  const showDebug = useCallback((d: SwipeDebug) => {
    setDebug(d)
    if (debugTimer.current) clearTimeout(debugTimer.current)
    debugTimer.current = setTimeout(() => setDebug(null), 1500)
  }, [])

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }, [])

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStart.current) return
      const t = e.changedTouches[0]
      const dx = t.clientX - touchStart.current.x
      const dy = t.clientY - touchStart.current.y
      const sx = touchStart.current.x
      const absDx = Math.abs(dx)
      const absDy = Math.abs(dy)
      const dir = dx > 0 ? 'right' : 'left'
      touchStart.current = null

      // Check: target is input?
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable]')) {
        showDebug({ active: false, startX: sx, dx, dy, dir, rejected: 'input' })
        return
      }

      // Check: edge zone
      if (sx < EDGE_ZONE || sx > window.innerWidth - EDGE_ZONE) {
        showDebug({ active: false, startX: sx, dx, dy, dir, rejected: 'edge' })
        return
      }

      // Check: not enough horizontal distance
      if (absDx < SWIPE_DISTANCE) {
        showDebug({ active: false, startX: sx, dx, dy, dir, rejected: `dist:${absDx.toFixed(0)}` })
        return
      }

      // Check: not horizontal enough
      if (absDx < absDy * SWIPE_RATIO) {
        showDebug({ active: false, startX: sx, dx, dy, dir, rejected: 'vertical' })
        return
      }

      showDebug({ active: true, startX: sx, dx, dy, dir })
      handleSwipe(dir as 'left' | 'right')
    },
    [handleSwipe, showDebug],
  )

  const swipeProps = {
    onTouchStart,
    onTouchEnd,
    style: { touchAction: 'pan-y' } as React.CSSProperties,
  }

  return { swipeProps, debug }
}
