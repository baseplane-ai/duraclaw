'use client'

import { CheckCircleIcon, ChevronDownIcon, Loader2, WrenchIcon, XCircleIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { createContext, memo, useContext, useMemo, useState } from 'react'
import { useControllableState } from '../hooks/use-controllable-state'
import { getToolDisplayName, summarizeToolArgs, summarizeToolResult } from '../lib/tool-display'
import { cn } from '../lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { CodeBlock } from './code-block'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type ToolCallListContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
}

const ToolCallListContext = createContext<ToolCallListContextValue | null>(null)

const useToolCallList = () => {
  const ctx = useContext(ToolCallListContext)
  if (!ctx) throw new Error('ToolCallList components must be used within ToolCallList')
  return ctx
}

// ---------------------------------------------------------------------------
// ToolCallList (container)
// ---------------------------------------------------------------------------

export type ToolCallListProps = ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ToolCallList = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ToolCallListProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    })

    const ctx = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen])

    return (
      <ToolCallListContext.Provider value={ctx}>
        <div className={cn('not-prose', className)} {...props}>
          {children}
        </div>
      </ToolCallListContext.Provider>
    )
  },
)

// ---------------------------------------------------------------------------
// ToolCallListHeader
// ---------------------------------------------------------------------------

export type ToolCallListHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  count: number
}

export const ToolCallListHeader = memo(
  ({ className, count, ...props }: ToolCallListHeaderProps) => {
    const { isOpen, setIsOpen } = useToolCallList()

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
            className,
          )}
          {...props}
        >
          <WrenchIcon className="size-4" />
          <span className="flex-1 text-left">
            Used {count} tool{count !== 1 ? 's' : ''}
          </span>
          <ChevronDownIcon
            className={cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')}
          />
        </CollapsibleTrigger>
      </Collapsible>
    )
  },
)

// ---------------------------------------------------------------------------
// ToolCallListContent
// ---------------------------------------------------------------------------

export type ToolCallListContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolCallListContent = memo(
  ({ className, children, ...props }: ToolCallListContentProps) => {
    const { isOpen } = useToolCallList()

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            'mt-2',
            'data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-open:slide-in-from-top-2 text-popover-foreground outline-none data-closed:animate-out data-open:animate-in',
            className,
          )}
          {...props}
        >
          <ul
            className="flex flex-wrap gap-1.5 list-none p-0 m-0"
            aria-label="Tool calls used in this response"
          >
            {children}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    )
  },
)

// ---------------------------------------------------------------------------
// ToolCallItem
// ---------------------------------------------------------------------------

export type ToolCallItemProps = {
  toolName: string
  status: 'completed' | 'error' | 'running'
  args?: unknown
  result?: unknown
  error?: string | null
  className?: string
}

const StatusIcon = ({ status }: { status: ToolCallItemProps['status'] }) => {
  switch (status) {
    case 'completed':
      return <CheckCircleIcon className="size-3.5 text-green-600" />
    case 'error':
      return <XCircleIcon className="size-3.5 text-destructive" />
    case 'running':
      return <Loader2 className="size-3.5 animate-spin" />
  }
}

export const ToolCallItem = memo(
  ({ toolName, status, args, result, error, className }: ToolCallItemProps) => {
    const [expanded, setExpanded] = useState(status === 'error')
    const [showRaw, setShowRaw] = useState(false)

    const displayName = getToolDisplayName(toolName)
    const argsSummary = summarizeToolArgs(toolName, args)
    const resultSummary = status === 'error' ? null : summarizeToolResult(toolName, result)

    return (
      <li className={cn('inline-flex flex-col list-none', expanded && 'basis-full', className)}>
        {/* Tier 1: Chip */}
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
            'bg-secondary text-secondary-foreground hover:bg-secondary/80',
            status === 'error' && 'bg-destructive/10 text-destructive hover:bg-destructive/20',
          )}
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={`${displayName}, ${status}`}
        >
          <StatusIcon status={status} />
          <span>{displayName}</span>
        </button>

        {/* Tier 2: Expanded summary */}
        {expanded && (
          <div className="mt-1.5 space-y-1 pl-2.5">
            {argsSummary && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Input:</span> {argsSummary}
              </p>
            )}
            {resultSummary && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Result:</span> {resultSummary}
              </p>
            )}
            {status === 'error' && error && <p className="text-xs text-destructive">{error}</p>}
            <button
              type="button"
              className="text-xs underline cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => setShowRaw((prev) => !prev)}
            >
              {showRaw ? 'Hide details' : 'Show details'}
            </button>

            {/* Tier 3: Raw JSON */}
            {showRaw && (
              <div className="mt-1.5 max-w-lg space-y-2">
                {args != null && <CodeBlock code={JSON.stringify(args, null, 2)} language="json" />}
                {result != null && (
                  <CodeBlock code={JSON.stringify(result, null, 2)} language="json" />
                )}
              </div>
            )}
          </div>
        )}
      </li>
    )
  },
)

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

ToolCallList.displayName = 'ToolCallList'
ToolCallListHeader.displayName = 'ToolCallListHeader'
ToolCallListContent.displayName = 'ToolCallListContent'
ToolCallItem.displayName = 'ToolCallItem'
