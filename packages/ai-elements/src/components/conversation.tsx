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
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/utils'
import { Button } from '../ui/button'

// ---------------------------------------------------------------------------
// Auto-scroll is driven entirely by asynchronous observers — no synchronous
// scroll-geometry reads from JS:
//   1. IntersectionObserver on a zero-height bottom sentinel tells us when
//      the user is within NEAR_BOTTOM_PX of the end. Replaces a scroll-event
//      handler that used to read `scrollTop/scrollHeight/clientHeight` on
//      every scroll tick.
//   2. ResizeObserver on the content container fires on growth; when the
//      IO says we're at the bottom we pin by calling
//      `sentinel.scrollIntoView({block:'end'})` — the browser handles the
//      math without us forcing layout.
//
// Why this shape: the prior design synchronously read layout props inside
// both the scroll handler AND the RO callback, and wrote `scrollTop` in
// between. On tab-switch mount (parent uses `key={activeSessionId}`),
// Shiki + Streamdown async highlighting fired the RO dozens of times per
// second; each growth tick was a read-write-read reflow cascade that
// DevTools flagged as 35–63ms `[Violation] Forced reflow` chains. The
// visual symptom was mis-aligned first-paint + a jumpy catch-up scroll.
// IO + scrollIntoView removes every synchronous read from the hot path.
// ---------------------------------------------------------------------------

const NEAR_BOTTOM_PX = 70
const SETTLE_MS = 500

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
  // Mirror of `isAtBottom` for synchronous read inside the RO callback.
  // Reading React state from an imperative callback is stale-by-design;
  // the ref tracks the latest IO signal without triggering a re-render.
  const isAtBottomRef = useRef(true)
  const scrollEl = useRef<HTMLDivElement | null>(null)
  const contentEl = useRef<HTMLDivElement | null>(null)
  const sentinelEl = useRef<HTMLDivElement | null>(null)

  // IntersectionObserver — drives `isAtBottom` asynchronously. The
  // sentinel is a zero-height div at the end of the content; the IO's
  // bottom `rootMargin` extends the viewport so the sentinel registers
  // as "intersecting" while the user is still NEAR_BOTTOM_PX away. No
  // synchronous layout reads in our code — the browser batches.
  useEffect(() => {
    const scroll = scrollEl.current
    const sentinel = sentinelEl.current
    if (!scroll || !sentinel) return

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        isAtBottomRef.current = entry.isIntersecting
        setIsAtBottom(entry.isIntersecting)
      },
      {
        root: scroll,
        rootMargin: `0px 0px ${NEAR_BOTTOM_PX}px 0px`,
        threshold: 0,
      },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [])

  // ResizeObserver — auto-scroll on content growth when the user was
  // already pinned to the bottom (per the IO signal). We read `height`
  // from `entry.contentRect` (no forced layout) and write via
  // `sentinel.scrollIntoView` (the browser schedules the scroll without
  // us computing offsets).
  //
  // Multiple sequential growth ticks (Shiki async-highlight bursts,
  // Streamdown rehydrating code blocks, etc.) are coalesced through a
  // single requestAnimationFrame so we never queue N overlapping scroll
  // writes per animation frame.
  //
  // Smooth scroll is gated behind a post-mount settle window. Tab
  // switches remount this component (parent uses `key={activeSessionId}`),
  // and the first ~500ms of life is dominated by layout settling — async
  // font load, code highlighting, child useEffects growing height — none
  // of which is streaming. Animating those growths visibly looked like
  // "jump up then smooth scroll down" because each successive growth
  // restarted the animation chasing a moving target. After SETTLE_MS the
  // only thing growing the content is real streaming, where smooth reads
  // as polish.
  useEffect(() => {
    const content = contentEl.current
    const sentinel = sentinelEl.current
    if (!content || !sentinel) return

    let prevHeight = 0
    let isInitialSettle = true
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let rafId: number | null = null

    const armSettle = () => {
      if (settleTimer) clearTimeout(settleTimer)
      isInitialSettle = true
      settleTimer = setTimeout(() => {
        isInitialSettle = false
      }, SETTLE_MS)
    }
    armSettle()

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const currentHeight = entry.contentRect.height
      const growth = currentHeight - prevHeight
      // Detect the 0 → N transition: OPFS hydration (or the WS onConnect
      // history burst) can land after the initial mount-time settle window
      // has expired. In that case the RO fires against an empty baseline;
      // a `behavior: 'smooth'` scroll would animate visibly through a
      // suddenly-tall list. Re-arm the instant-scroll window so the first
      // real content arrival reads as "already at the bottom" regardless
      // of whether hydration came from OPFS or the network.
      const wasEmpty = prevHeight === 0 && currentHeight > 0
      prevHeight = currentHeight
      if (growth <= 0) return

      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (wasEmpty) {
          armSettle()
          sentinel.scrollIntoView({ block: 'end', inline: 'nearest' })
          return
        }
        if (isAtBottomRef.current) {
          sentinel.scrollIntoView({
            block: 'end',
            inline: 'nearest',
            behavior: isInitialSettle ? 'auto' : 'smooth',
          })
        }
      })
    })
    ro.observe(content)
    return () => {
      if (settleTimer) clearTimeout(settleTimer)
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    const sentinel = sentinelEl.current
    if (sentinel) {
      sentinel.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'smooth' })
      isAtBottomRef.current = true
      setIsAtBottom(true)
    }
  }, [])

  // Ref callbacks that wire up the elements
  const scrollRef: RefCallback<HTMLDivElement> = useCallback((node) => {
    scrollEl.current = node
  }, [])

  const contentRef: RefCallback<HTMLDivElement> = useCallback((node) => {
    contentEl.current = node
  }, [])

  const sentinelRef: RefCallback<HTMLDivElement> = useCallback((node) => {
    sentinelEl.current = node
  }, [])

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
  const { scrollRef, contentRef, sentinelRef } = useAutoScrollContext()

  return (
    <div ref={scrollRef} style={{ height: '100%', width: '100%', overflowY: 'auto' }}>
      <div ref={contentRef} className={cn('flex flex-col gap-8 p-4', className)} {...props}>
        {children}
        {/* Zero-height sentinel for the IntersectionObserver + target for
         * `scrollIntoView({block:'end'})`. Sits inside the content container
         * so it participates in the flex-column layout but contributes no
         * height. `aria-hidden` so SR users don't see a stray landmark. */}
        <div ref={sentinelRef} aria-hidden="true" style={{ height: 0 }} />
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
          'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted',
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
