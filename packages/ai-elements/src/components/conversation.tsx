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
// Auto-scroll context. Live scroll position is the source of truth, not a
// sticky escape flag:
//   1. ResizeObserver auto-scrolls ONLY when scrollTop is pinned to the
//      bottom (within PIN_THRESHOLD_PX). Any user-initiated scroll-up by
//      more than that disables auto-snap until they scroll back.
//   2. `isAtBottom` uses the wider NEAR_BOTTOM_PX zone — it drives the
//      scroll-to-bottom button visibility only, not the snap decision.
//
// The previous flag-based design lost a race on mobile WebView foreground
// resume: repeated async re-layout (markdown rehighlight, image reload)
// fired many ResizeObserver growth events while the user's drag sat inside
// the 70px near-bottom zone, so the escape flag never flipped and every
// growth snapped them back. Checking live scrollTop removes that window.
// ---------------------------------------------------------------------------

const NEAR_BOTTOM_PX = 70
const PIN_THRESHOLD_PX = 4

interface AutoScrollContext {
  scrollRef: RefCallback<HTMLDivElement>
  contentRef: RefCallback<HTMLDivElement>
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
  const scrollEl = useRef<HTMLDivElement | null>(null)
  const contentEl = useRef<HTMLDivElement | null>(null)

  // Scroll listener — track `isAtBottom` for the scroll-to-bottom button.
  useEffect(() => {
    const el = scrollEl.current
    if (!el) return

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const nearBottom = scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX
      setIsAtBottom(nearBottom)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ResizeObserver — auto-scroll on content growth only while scrollTop is
  // actually pinned to the bottom. Tracks prev content height so we scroll
  // on growth (new messages) and skip shrinks (e.g. mobile keyboard opening).
  useEffect(() => {
    const content = contentEl.current
    const scroll = scrollEl.current
    if (!content || !scroll) return

    let prevHeight = content.getBoundingClientRect().height

    const ro = new ResizeObserver(() => {
      const currentHeight = content.getBoundingClientRect().height
      const grew = currentHeight > prevHeight
      prevHeight = currentHeight
      if (!grew) return
      const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < PIN_THRESHOLD_PX
      if (pinned) {
        scroll.scrollTop = scroll.scrollHeight
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollEl.current
    if (el) {
      el.scrollTop = el.scrollHeight
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

  return { scrollRef, contentRef, isAtBottom, scrollToBottom }
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
  const scrollNode = useRef<HTMLDivElement | null>(null)

  // Wire up the ref callback and keep a local ref for the layout effect
  const mergedScrollRef: RefCallback<HTMLDivElement> = useCallback(
    (node) => {
      scrollNode.current = node
      scrollRef(node)
    },
    [scrollRef],
  )

  // Scroll to bottom before first paint to avoid a flash of content at scrollTop=0
  useLayoutEffect(() => {
    const el = scrollNode.current
    if (el) {
      el.scrollTop = el.scrollHeight - el.clientHeight
    }
  }, [])

  return (
    <div ref={mergedScrollRef} style={{ height: '100%', width: '100%', overflowY: 'auto' }}>
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
