import { type RefObject, useCallback, useEffect, useRef } from 'react'
import { useTabStore } from '~/stores/tabs'

const SWIPE_THRESHOLD = 80

/**
 * Detects horizontal swipe gestures on the given element and switches
 * to the adjacent tab. Swipe left = next tab, swipe right = previous tab.
 */
export function useSwipeTabs(
  ref: RefObject<HTMLElement | null>,
  onSelectSession: (sessionId: string) => void,
) {
  const touchStart = useRef<{ x: number; y: number } | null>(null)

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

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]
      touchStart.current = { x: t.clientX, y: t.clientY }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (!touchStart.current) return
      const t = e.changedTouches[0]
      const dx = t.clientX - touchStart.current.x
      const dy = t.clientY - touchStart.current.y
      touchStart.current = null
      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
        handleSwipe(dx > 0 ? 'right' : 'left')
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [ref, handleSwipe])
}
