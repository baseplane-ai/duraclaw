import { useDrag } from '@use-gesture/react'
import { type RefObject, useCallback } from 'react'
import { useTabStore } from '~/stores/tabs'

/**
 * Detects horizontal swipe gestures on the given element and switches
 * to the adjacent tab. Swipe left = next tab, swipe right = previous tab.
 */
export function useSwipeTabs(
  ref: RefObject<HTMLElement | null>,
  onSelectSession: (sessionId: string) => void,
) {
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

  useDrag(
    ({ swipe: [swipeX], event }) => {
      if (swipeX === 0) return
      // Don't swipe if user is interacting with an input/textarea
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable]')) return
      handleSwipe(swipeX > 0 ? 'right' : 'left')
    },
    {
      target: ref,
      axis: 'x',
      swipe: { distance: 50, velocity: 0.3 },
      filterTaps: true,
      eventOptions: { passive: true },
    },
  )
}
