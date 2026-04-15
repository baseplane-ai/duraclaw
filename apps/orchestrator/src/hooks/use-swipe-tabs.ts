import { useDrag } from '@use-gesture/react'
import { useCallback } from 'react'
import { useTabStore } from '~/stores/tabs'

/**
 * Returns bind props for a swipeable container that switches tabs
 * on horizontal swipe. Attach the returned props to the element.
 *
 * Swipe left = next tab, swipe right = previous tab.
 */
export function useSwipeTabs(onSelectSession: (sessionId: string) => void) {
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
    ({ swipe: [swipeX], event }) => {
      if (swipeX === 0) return
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
