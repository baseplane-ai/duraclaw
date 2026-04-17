'use client'

import type { UIMessage } from 'ai'
import { ArrowDownIcon, DownloadIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useLayoutEffect } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { cn } from '../lib/utils'
import { Button } from '../ui/button'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
)

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => {
  const { scrollRef, stopScroll } = useStickToBottomContext()

  // Scroll to bottom before first paint so the user never sees content at scrollTop=0.
  // StickToBottom's ResizeObserver fires asynchronously (after paint), causing a visible
  // one-frame flash of content scrolled to the top on remount. This layout effect runs
  // before paint on mount only — running on every render would override the library's
  // scroll-up escape and lock the user to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight - el.clientHeight
    }
  }, [scrollRef])

  // On mobile, the library detects scroll-up via handleWheel (deltaY < 0) which
  // doesn't fire for touch scrolling. The fallback handleScroll uses setTimeout(1ms)
  // which races against the resize="instant" animation loop (requestAnimationFrame).
  // Even calling stopScroll() on touchmove isn't enough — the library's handleScroll
  // setTimeout can re-engage the lock between touchmove events when the user is near
  // the bottom. We pump stopScroll() on every animation frame while the user is
  // actively touch-scrolling upward, keeping the lock broken continuously.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let startY = 0
    let scrollingUp = false
    let rafId = 0
    const tick = () => {
      if (scrollingUp) {
        stopScroll()
        rafId = requestAnimationFrame(tick)
      }
    }
    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY
      scrollingUp = false
    }
    const onTouchMove = (e: TouchEvent) => {
      // Dragging finger down → scrolling up through content
      if (e.touches[0].clientY > startY && !scrollingUp) {
        scrollingUp = true
        stopScroll()
        rafId = requestAnimationFrame(tick)
      }
    }
    const onTouchEnd = () => {
      scrollingUp = false
      cancelAnimationFrame(rafId)
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      cancelAnimationFrame(rafId)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [scrollRef, stopScroll])

  return <StickToBottom.Content className={cn('flex flex-col gap-8 p-4', className)} {...props} />
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
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted',
          className,
        )}
        onClick={handleScrollToBottom}
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
