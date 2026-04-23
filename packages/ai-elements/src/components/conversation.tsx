'use client'

import type { UIMessage } from 'ai'
import { ArrowDownIcon, DownloadIcon } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  type RefCallback,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/utils'
import { Button } from '../ui/button'

// ---------------------------------------------------------------------------
// Pin-to-bottom with explicit user-intent tracking.
//
// Single source of truth: `pinnedRef`. Transitions on exactly three paths:
//   1. Mount — starts true. A `useLayoutEffect` jumps `scrollTop` to the
//      bottom before first paint so OPFS-cached history renders already-
//      scrolled rather than flashing from the top.
//   2. User scroll — a `scroll` event listener on the scroll container
//      recomputes distance-from-bottom and flips `pinnedRef`. This is the
//      one signal that fires uniformly across every input path: wheel,
//      trackpad, touch-swipe, scrollbar drag, arrow/PageUp keys.
//   3. Scroll-button click — `scrollToBottom()` snaps and re-pins.
//
// Our own auto-scroll writes are gated via `programmaticRef` so they don't
// flip the user-intent signal off. A ResizeObserver on the content pins to
// bottom on every growth tick while `pinnedRef` is true — this covers
// streaming deltas, OPFS hydration bursts, and late history arrivals
// without needing an observer-sentinel or settle-window hacks.
// ---------------------------------------------------------------------------

const NEAR_BOTTOM_PX = 70

interface AutoScrollContext {
  scrollRef: RefCallback<HTMLDivElement>
  contentRef: RefCallback<HTMLDivElement>
  sentinelRef: RefCallback<HTMLDivElement>
  isAtBottom: boolean
  scrollToBottom: () => void
}

const Ctx = createContext<AutoScrollContext | null>(null)

export function useAutoScrollContext() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAutoScrollContext must be used within <Conversation>')
  return ctx
}

function useAutoScroll() {
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Mirror of `isAtBottom` for synchronous reads in imperative callbacks.
  const pinnedRef = useRef(true)
  // Set to true around our own `scrollTop` writes so the scroll listener
  // doesn't mistake auto-scroll for user scroll. Instant writes dispatch
  // their scroll event synchronously on the same element, so by the time
  // the rAF clear runs the event has already been filtered.
  const programmaticRef = useRef(false)
  const scrollEl = useRef<HTMLDivElement | null>(null)
  const contentEl = useRef<HTMLDivElement | null>(null)
  const prevHeightRef = useRef(0)
  const lastScrollTopRef = useRef(0)

  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next
    setIsAtBottom((cur) => (cur === next ? cur : next))
  }, [])

  const pinNow = useCallback(() => {
    const el = scrollEl.current
    if (!el) return
    programmaticRef.current = true
    el.scrollTop = el.scrollHeight - el.clientHeight
    requestAnimationFrame(() => {
      programmaticRef.current = false
    })
  }, [])

  const scrollToBottom = useCallback(() => {
    pinNow()
    setPinned(true)
  }, [pinNow, setPinned])

  // Scroll listener — fires for every user input path (wheel, trackpad,
  // touch-swipe, scrollbar drag, keyboard). Our own writes are gated out
  // by `programmaticRef`. Direction-aware: only re-pins when the user
  // scrolls *down* and lands near the bottom. Scrolling up while near
  // the bottom (common during streaming, since `pinNow` just wrote
  // `scrollTop` to the bottom) unpins immediately.
  const onScroll = useCallback(() => {
    if (programmaticRef.current) return
    const el = scrollEl.current
    if (!el) return
    const scrollTop = el.scrollTop
    const distance = el.scrollHeight - scrollTop - el.clientHeight
    const scrolledDown = scrollTop >= lastScrollTopRef.current
    lastScrollTopRef.current = scrollTop
    if (!scrolledDown) {
      // User scrolled up — unpin unconditionally.
      setPinned(false)
    } else if (distance <= NEAR_BOTTOM_PX) {
      // User scrolled down and landed near bottom — re-pin.
      setPinned(true)
    }
  }, [setPinned])

  // Direct user-input listeners. Wheel / touchstart / touchmove fire
  // synchronously with the actual user action — before the browser
  // updates scrollTop and before the scroll event. This lets us flip
  // pinnedRef off the instant the user expresses intent to scroll up,
  // winning the race against any programmatic pin that's in flight.
  // On mobile WebViews the scroll event also lags the compositor,
  // making these listeners the only reliable signal during active drag.
  const touchStartYRef = useRef(0)

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (e.deltaY < 0) setPinned(false)
    },
    [setPinned],
  )

  const onTouchStart = useCallback((e: TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0
  }, [])

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (y === undefined) return
      // Finger moving downward (y grows) = content scrolling up = unpin.
      // 8px threshold absorbs micro-jitter / tap-recognition slop.
      if (y - touchStartYRef.current > 8) setPinned(false)
    },
    [setPinned],
  )

  // Initial pin: on first mount / tab-switch remount, jump to the bottom
  // before paint so OPFS-cached messages render already-scrolled. The
  // `el.scrollTop === 0` guard protects against an Android WebView
  // concurrent-commit edge case where this effect re-invokes on a
  // persisted fiber+DOM roughly every 430ms — without the guard each
  // re-fire snaps the user back down while they're trying to scroll up.
  // At genuine first-mount `scrollTop` is 0; after that the guard makes
  // every re-fire a no-op.
  useLayoutEffect(() => {
    const el = scrollEl.current
    if (!el) return
    if (el.scrollTop === 0) {
      programmaticRef.current = true
      el.scrollTop = el.scrollHeight - el.clientHeight
      requestAnimationFrame(() => {
        programmaticRef.current = false
      })
    }
  })

  // ResizeObserver — content growth (streaming deltas, OPFS hydration,
  // history burst) pins to bottom while `pinnedRef` is true. `pinnedRef`
  // is the sole gate — the old `userWasNearBottom` fallback read
  // `scrollTop` that `pinNow` had just clobbered to the bottom, so it
  // always evaluated true and re-pinned a user who had scrolled up.
  useEffect(() => {
    const content = contentEl.current
    if (!content) return
    let rafId: number | null = null
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const newHeight = entry.contentRect.height
      const growth = newHeight - prevHeightRef.current
      prevHeightRef.current = newHeight
      if (growth <= 0) return
      if (!pinnedRef.current) return

      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        // Re-check: wheel / touch / scroll handlers may have flipped
        // pinnedRef off between the RO callback and this rAF tick.
        if (!pinnedRef.current) return
        pinNow()
      })
    })
    ro.observe(content)
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [pinNow])

  // Scroll-element ref callback: stores the node AND attaches the scroll
  // listener plus the direct user-input listeners. Swapping nodes
  // (rare — only on full remount) cleans up the previous listeners
  // first.
  const scrollRef: RefCallback<HTMLDivElement> = useCallback(
    (node) => {
      const prev = scrollEl.current
      if (prev && prev !== node) {
        prev.removeEventListener('scroll', onScroll)
        prev.removeEventListener('wheel', onWheel)
        prev.removeEventListener('touchstart', onTouchStart)
        prev.removeEventListener('touchmove', onTouchMove)
      }
      scrollEl.current = node
      if (node) {
        node.addEventListener('scroll', onScroll, { passive: true })
        node.addEventListener('wheel', onWheel, { passive: true })
        node.addEventListener('touchstart', onTouchStart, { passive: true })
        node.addEventListener('touchmove', onTouchMove, { passive: true })
      }
    },
    [onScroll, onWheel, onTouchStart, onTouchMove],
  )

  const contentRef: RefCallback<HTMLDivElement> = useCallback((node) => {
    contentEl.current = node
  }, [])

  // Retained for API compatibility — the old IO-based design needed a
  // DOM sentinel; the new scroll-listener design reads distance from the
  // scroll element directly. Callers that still pass a `sentinelRef` to
  // a zero-height div get a harmless no-op.
  const sentinelRef: RefCallback<HTMLDivElement> = useCallback(() => {}, [])

  return { scrollRef, contentRef, sentinelRef, isAtBottom, scrollToBottom }
}

// ---------------------------------------------------------------------------
// Public components — same API as before
// ---------------------------------------------------------------------------

export type ConversationProps = ComponentProps<'div'>

export const Conversation = ({ className, children, ...props }: ConversationProps) => {
  const ctx = useAutoScroll()
  return (
    <Ctx.Provider value={ctx}>
      <div className={cn('relative flex-1 overflow-y-clip', className)} role="log" {...props}>
        {children}
      </div>
    </Ctx.Provider>
  )
}

export type ConversationContentProps = ComponentProps<'div'>

export const ConversationContent = ({
  className,
  children,
  ...props
}: ConversationContentProps) => {
  const { scrollRef, contentRef } = useAutoScrollContext()

  return (
    <div ref={scrollRef} style={{ height: '100%', width: '100%', overflowY: 'auto' }}>
      <div ref={contentRef} className={cn('flex flex-col gap-8 p-4', className)} {...props}>
        {children}
      </div>
    </div>
  )
}

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export const ConversationEmptyState = ({
  className,
  title = 'No messages yet',
  description = 'Start a conversation to see messages here',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
)

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useAutoScrollContext()

  return (
    !isAtBottom && (
      <Button
        className={cn(
          // `bottom-20` (80px) keeps the floating button clearly clear of
          // the StatusBar + MessageInput stack that sits directly below the
          // Conversation in ChatThread's flex column. The old `bottom-4`
          // (and the subsequent `bottom-6` bump) left the button visually
          // overlapping the status / input panel below.
          'absolute bottom-20 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted',
          className,
        )}
        onClick={scrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  )
}

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')

export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  messages: UIMessage[]
  filename?: string
  formatMessage?: (message: UIMessage, index: number) => string
}

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1)
  return `**${roleLabel}:** ${getMessageText(message)}`
}

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (message: UIMessage, index: number) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join('\n\n')

export const ConversationDownload = ({
  messages,
  filename = 'conversation.md',
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage)
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [messages, filename, formatMessage])

  return (
    <Button
      className={cn(
        'absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted',
        className,
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  )
}
