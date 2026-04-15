import { useDrag } from '@use-gesture/react'
import { useCallback, useRef } from 'react'
import { useTabStore } from '~/stores/tabs'

const EDGE_ZONE = 30 // px from screen edge to ignore (iOS back gesture)

/**
 * Returns bind props for a swipeable container that switches tabs
 * on horizontal swipe. Attach the returned props to the element.
 *
 * Ignores swipes starting within EDGE_ZONE px of screen edges
 * to avoid conflicting with iOS back/forward navigation.
 *
 * Swipe left = next tab, swipe right = previous tab.
 */
export function useSwipeTabs(onSelectSession: (sessionId: string) => void) {
  const startX = useRef(0)

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

  return useDrag(
    ({ first, xy: [x], swipe: [swipeX], event }) => {
      if (first) {
        startX.current = x
        return
      }
      if (swipeX === 0) return
      // Ignore swipes that started near screen edges
      if (startX.current < EDGE_ZONE || startX.current > window.innerWidth - EDGE_ZONE) return
      // Don't swipe from inputs
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable]')) return
      handleSwipe(swipeX > 0 ? 'right' : 'left')
    },
    {
      axis: 'lock',
      swipe: { distance: 50, velocity: 0.3 },
      filterTaps: true,
    },
  )
}
