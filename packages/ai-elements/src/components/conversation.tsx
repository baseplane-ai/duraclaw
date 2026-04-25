'use client'

import type { UIMessage } from 'ai'
import { ArrowDownIcon, DownloadIcon } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  type RefCallback,
  useCallback,
  useContext,
} from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { cn } from '../lib/utils'
import { Button } from '../ui/button'

// ---------------------------------------------------------------------------
// Pin-to-bottom, backed by `use-stick-to-bottom` (StackBlitz, MIT).
//
// Replaces a hand-rolled ResizeObserver + scroll-event + wheel/touch-race
// design that accreted 8+ iterations of fixes and still had rough edges:
//   - no text-selection guard (cross-message highlight was yanked on every delta)
//   - no content-shrink anchoring (rewind / branch-navigate broke pinning)
//   - discrete `scrollTop = scrollHeight` jumps during streaming (jitter)
//   - rAF-cleared programmatic-write flag raced on contended main thread
//
// `use-stick-to-bottom` solves all four natively via velocity-based spring
// animation, selection detection, a scroll-value tokenizer for programmatic
// writes, and scroll-anchoring math for positive AND negative resize.
// See `planning/research/2026-04-24-chat-autoscroll-library-evaluation.md`.
//
// The public API (`useAutoScrollContext`, `<Conversation>`, `<ConversationContent>`,
// `<ConversationScrollButton>`) is preserved so no call-sites change.
// `sentinelRef` is retained as a no-op for legacy API compat.
// ---------------------------------------------------------------------------

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

function useAutoScroll(resize: 'smooth' | 'instant' = 'smooth'): AutoScrollContext {
  // `initial: 'instant'` — library jumps to bottom inside a useLayoutEffect
  //   before first paint, so OPFS-cached history renders already-scrolled.
  // `resize: 'smooth'` — spring animation for streaming deltas; avoids the
  //   visible discrete jitter of a raw scrollTop assignment under fast token
  //   bursts. The library caps its resize animation at 350ms so it won't
  //   accumulate lag under sustained high-frequency growth.
  // The `resize` arg is a controlled override: virtualized callers (see
  //   ChatThread) pin it to `'instant'` during the mount-time measurement
  //   flurry — when the virtualizer replaces 160px estimates with real row
  //   heights, each measurement fires a ResizeObserver tick that would
  //   otherwise spring back to bottom for up to 350ms per tick, layering
  //   into a visible glide on stale-tab reopens. Once measurements settle,
  //   the caller flips back to `'smooth'` so streaming retains the spring.
  //   Because `useStickToBottom` reads its options through a ref updated on
  //   every render (optionsRef.current = options), the toggle is reactive
  //   without remounting the hook.
  const stb = useStickToBottom({ initial: 'instant', resize })

  // Library's scrollToBottom returns Promise<boolean>|boolean — our API is
  // fire-and-forget, so discard.
  const scrollToBottom = useCallback(() => {
    stb.scrollToBottom()
  }, [stb])

  // Library's refs are MutableRefObject & RefCallback — pass through the
  // callback surface, which is what our consumers (including the composite
  // ref in ChatThread's VirtualizedMessageList) expect.
  const scrollRef: RefCallback<HTMLDivElement> = useCallback(
    (node) => {
      stb.scrollRef(node)
    },
    [stb.scrollRef],
  )
  const contentRef: RefCallback<HTMLDivElement> = useCallback(
    (node) => {
      stb.contentRef(node)
    },
    [stb.contentRef],
  )

  // Legacy API surface — older call-sites may pass a sentinel div's ref
  // callback. The library tracks bottom position via scrollHeight math,
  // not a DOM sentinel, so this is a harmless no-op.
  const sentinelRef: RefCallback<HTMLDivElement> = useCallback(() => {}, [])

  return {
    scrollRef,
    contentRef,
    sentinelRef,
    isAtBottom: stb.isAtBottom,
    scrollToBottom,
  }
}

// ---------------------------------------------------------------------------
// Public components — same API as before
// ---------------------------------------------------------------------------

export type ConversationProps = ComponentProps<'div'> & {
  /**
   * Override the spring-vs-instant behavior for content-resize-driven
   * scroll anchoring. Defaults to `'smooth'`, which preserves the
   * streaming-delta spring animation. Virtualized callers may flip to
   * `'instant'` during the mount-time measurement flurry to suppress
   * the per-row glide as estimates are replaced with real heights.
   * `initial` (first-paint pre-scroll) is always `'instant'` and is
   * not configurable here.
   */
  resize?: 'smooth' | 'instant'
}

export const Conversation = ({ className, children, resize, ...props }: ConversationProps) => {
  const ctx = useAutoScroll(resize)
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
