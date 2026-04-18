import { useCallback, useRef, useState } from 'react'
import { getUserSettings } from '~/hooks/use-user-settings'

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
      const { tabs, setActiveTab } = getUserSettings()
      if (tabs.length < 2) return false

      // Find current tab by session being viewed, not by activeTabId
      const idx = activeSessionId ? tabs.findIndex((t) => t.sessionId === activeSessionId) : -1
      if (idx === -1) return false

      const nextIdx = dir === 'left' ? idx + 1 : idx - 1
      if (nextIdx < 0 || nextIdx >= tabs.length) return false
      const next = tabs[nextIdx]

      // Trigger slide-out animation
      setSwipeDir(dir)
      if (animTimer.current) clearTimeout(animTimer.current)

      // After slide-out, switch tab and slide-in
      animTimer.current = setTimeout(() => {
        setActiveTab(next.id)
        onSelectSession(next.sessionId)
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
      // Don't steal horizontal swipes from streamdown tables, code blocks, or
      // any other horiz-scrollable content inside the message stream.
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
    // `pan-y` alone forbids browser-native horizontal pan on ALL descendants
    // (touch-action intersects down the tree), which breaks horizontal scroll
    // inside streamdown tables / code blocks. `pan-x pan-y` keeps vertical
    // page scroll working AND lets horiz-scrollable children scroll natively;
    // the JS handler still sees the touch events to drive tab swipes on
    // non-scrollable areas.
    style: { touchAction: 'pan-x pan-y' } as React.CSSProperties,
  }

  return { swipeProps, swipeDir }
}
