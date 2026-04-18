import { useCallback, useRef, useState } from 'react'
import { getTabSyncSnapshot } from '~/hooks/use-tab-sync'

const EDGE_ZONE = 30
const SWIPE_DISTANCE = 60
const SWIPE_RATIO = 1.5

/** Direction of the last successful swipe, cleared after animation. */
export type SwipeDir = 'left' | 'right' | null

/**
 * Returns true if `el` is inside (or is itself) an element that can be
 * horizontally scrolled — i.e. an ancestor has `overflow-x: auto|scroll`
 * AND actual horizontal overflow. Used to exempt streamdown tables, code
 * blocks, and other horiz-scrollable content from the tab-swipe gesture.
 */
function isInsideHorizontalScroller(el: HTMLElement | null): boolean {
  let node: HTMLElement | null = el
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.scrollWidth > node.clientWidth) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

/**
 * Returns props to spread onto a container element + swipe animation state.
 * Detects horizontal swipe gestures to switch tabs.
 *
 * `swipeDir` is set briefly on successful swipe for CSS animation,
 * then cleared after the transition completes.
 */
export function useSwipeTabs(
  onSelectSession: (sessionId: string) => void,
  activeSessionId?: string | null,
) {
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const [swipeDir, setSwipeDir] = useState<SwipeDir>(null)
  const animTimer = useRef<ReturnType<typeof setTimeout>>(null)

  const handleSwipe = useCallback(
    (dir: 'left' | 'right') => {
      const { openTabs } = getTabSyncSnapshot()
      if (openTabs.length < 2) return false

      const idx = activeSessionId ? openTabs.indexOf(activeSessionId) : -1
      if (idx === -1) return false

      const nextIdx = dir === 'left' ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= openTabs.length) return false
      const nextSessionId = openTabs[nextIdx]

      // Trigger slide-out animation
      setSwipeDir(dir)
      if (animTimer.current) clearTimeout(animTimer.current)

      // After slide-out, switch tab and slide-in
      animTimer.current = setTimeout(() => {
        onSelectSession(nextSessionId)
        // Brief delay then clear for slide-in
        setTimeout(() => setSwipeDir(null), 20)
      }, 150)

      return true
    },
    [onSelectSession, activeSessionId],
  )

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStart.current = { x: t.clientX, y: t.clientY }
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
      touchStart.current = null

      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable], [data-testid="tab-bar"]')) return
      if (isInsideHorizontalScroller(target)) return
      if (sx < EDGE_ZONE || sx > window.innerWidth - EDGE_ZONE) return
      if (absDx < SWIPE_DISTANCE) return
      if (absDx < absDy * SWIPE_RATIO) return

      handleSwipe(dx > 0 ? 'right' : 'left')
    },
    [handleSwipe],
  )

  const swipeProps = {
    onTouchStart,
    onTouchEnd,
    style: { touchAction: 'pan-x pan-y' } as React.CSSProperties,
  }

  return { swipeProps, swipeDir }
}
