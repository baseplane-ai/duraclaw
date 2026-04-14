'use client'

/**
 * WorkflowProgress Component
 *
 * Displays AI agent workflow progress with status indicators.
 * Used for showing: routing decisions, agent execution, tool calls.
 *
 * Semantic distinction:
 * - WorkflowProgress: What the AI is DOING (workflow steps)
 * - ChainOfThought: How the AI is THINKING (reasoning)
 * - Tool: Detailed tool invocation with input/output
 */

import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  BotIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  type LucideIcon,
  RouteIcon,
  WorkflowIcon,
  WrenchIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { createContext, memo, useContext, useMemo } from 'react'
import { cn } from '../lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

// ============================================================================
// Types
// ============================================================================

export type WorkflowTaskStatus = 'pending' | 'in_progress' | 'completed' | 'error'

export type WorkflowTaskType = 'routing' | 'agent' | 'tool' | 'generic'

export interface WorkflowTask {
  /** Display label for the task */
  label: string
  /** Optional description with more details */
  description?: string
  /** Current status of the task */
  status: WorkflowTaskStatus
  /** Type of workflow step (for icon selection) */
  type?: WorkflowTaskType
  /** Original identifier for matching (e.g., toolName) */
  identifier?: string
  /** Files associated with this task */
  files?: string[]
}

// ============================================================================
// Context
// ============================================================================

type WorkflowProgressContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  tasks: WorkflowTask[]
}

const WorkflowProgressContext = createContext<WorkflowProgressContextValue | null>(null)

const useWorkflowProgress = () => {
  const context = useContext(WorkflowProgressContext)
  if (!context) {
    throw new Error('WorkflowProgress components must be used within WorkflowProgress')
  }
  return context
}

// ============================================================================
// Status & Type Helpers
// ============================================================================

const statusIcons: Record<WorkflowTaskStatus, LucideIcon> = {
  pending: CircleIcon,
  in_progress: CircleDotIcon,
  completed: CircleCheckIcon,
  error: CircleXIcon,
}

const statusStyles: Record<WorkflowTaskStatus, string> = {
  pending: 'text-muted-foreground/50',
  in_progress: 'text-primary',
  completed: 'text-muted-foreground',
  error: 'text-destructive',
}

const typeIcons: Record<WorkflowTaskType, LucideIcon> = {
  routing: RouteIcon,
  agent: BotIcon,
  tool: WrenchIcon,
  generic: CircleDotIcon,
}

// ============================================================================
// Main Component
// ============================================================================

export type WorkflowProgressProps = ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  tasks?: WorkflowTask[]
}

export const WorkflowProgress = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    tasks = [],
    children,
    ...props
  }: WorkflowProgressProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    })

    const contextValue = useMemo(() => ({ isOpen, setIsOpen, tasks }), [isOpen, setIsOpen, tasks])

    return (
      <WorkflowProgressContext.Provider value={contextValue}>
        <div className={cn('not-prose max-w-prose space-y-4', className)} {...props}>
          {children}
        </div>
      </WorkflowProgressContext.Provider>
    )
  },
)

// ============================================================================
// Header with Progress Counter
// ============================================================================

export type WorkflowProgressHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  /** Custom title (default: "Workflow Progress") */
  title?: string
  /** Show progress counter (e.g., "2/5 completed") */
  showProgress?: boolean
}

export const WorkflowProgressHeader = memo(
  ({ className, children, title, showProgress = true, ...props }: WorkflowProgressHeaderProps) => {
    const { isOpen, setIsOpen, tasks } = useWorkflowProgress()

    // Calculate progress
    const completed = tasks.filter((t) => t.status === 'completed').length
    const total = tasks.length
    const hasError = tasks.some((t) => t.status === 'error')
    const isProcessing = tasks.some((t) => t.status === 'in_progress')

    // Determine header text
    const headerText = children ?? title ?? (isProcessing ? 'Processing...' : 'Workflow')

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
            hasError && 'text-destructive hover:text-destructive',
            className,
          )}
          {...props}
        >
          <WorkflowIcon className={cn('size-4', isProcessing && 'animate-pulse')} />
          <span className="flex-1 text-left">{headerText}</span>
          {showProgress && total > 0 && (
            <span
              className={cn('text-xs', hasError ? 'text-destructive' : 'text-muted-foreground')}
            >
              {completed}/{total}
            </span>
          )}
          <ChevronDownIcon
            className={cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')}
          />
        </CollapsibleTrigger>
      </Collapsible>
    )
  },
)

// ============================================================================
// Content Container
// ============================================================================

export type WorkflowProgressContentProps = ComponentProps<typeof CollapsibleContent>

export const WorkflowProgressContent = memo(
  ({ className, children, ...props }: WorkflowProgressContentProps) => {
    const { isOpen } = useWorkflowProgress()

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            'mt-2 space-y-3',
            'data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-open:slide-in-from-top-2 text-popover-foreground outline-none data-closed:animate-out data-open:animate-in',
            className,
          )}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    )
  },
)

// ============================================================================
// Individual Task Step
// ============================================================================

export type WorkflowProgressTaskProps = ComponentProps<'div'> & {
  /** Task label */
  label: ReactNode
  /** Optional description */
  description?: ReactNode
  /** Task status */
  status?: WorkflowTaskStatus
  /** Task type (for icon selection) */
  type?: WorkflowTaskType
  /** Override icon */
  icon?: LucideIcon
  /** Files associated with this task */
  files?: string[]
}

export const WorkflowProgressTask = memo(
  ({
    className,
    icon,
    label,
    description,
    status = 'completed',
    type = 'generic',
    files,
    children,
    ...props
  }: WorkflowProgressTaskProps) => {
    // Use status icon, or type icon, or custom icon
    const StatusIcon = statusIcons[status]
    const TypeIcon = icon ?? typeIcons[type]

    return (
      <div
        className={cn(
          'flex gap-2 text-sm',
          statusStyles[status],
          'fade-in-0 slide-in-from-top-2 animate-in',
          className,
        )}
        {...props}
      >
        <div className="relative mt-0.5 flex flex-col items-center">
          {/* Status indicator */}
          <StatusIcon className={cn('size-4', status === 'in_progress' && 'animate-pulse')} />
          {/* Connecting line */}
          <div className="-mx-px absolute top-7 bottom-0 left-1/2 w-px bg-border" />
        </div>
        <div className="flex-1 space-y-1">
          {/* Label with optional type icon */}
          <div className="flex items-center gap-1.5">
            <TypeIcon className="size-3.5 opacity-60" />
            <span>{label}</span>
          </div>
          {/* Description */}
          {description && <div className="text-muted-foreground text-xs">{description}</div>}
          {/* Files */}
          {files && files.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {files.map((file) => (
                <WorkflowProgressFile key={file}>{file}</WorkflowProgressFile>
              ))}
            </div>
          )}
          {/* Custom children */}
          {children}
        </div>
      </div>
    )
  },
)

// ============================================================================
// File Badge (for code generation, etc.)
// ============================================================================

export type WorkflowProgressFileProps = ComponentProps<'div'>

export const WorkflowProgressFile = ({
  children,
  className,
  ...props
}: WorkflowProgressFileProps) => (
  <div
    className={cn(
      'inline-flex items-center gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-foreground text-xs font-mono',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

// ============================================================================
// Display Names
// ============================================================================

WorkflowProgress.displayName = 'WorkflowProgress'
WorkflowProgressHeader.displayName = 'WorkflowProgressHeader'
WorkflowProgressContent.displayName = 'WorkflowProgressContent'
WorkflowProgressTask.displayName = 'WorkflowProgressTask'
WorkflowProgressFile.displayName = 'WorkflowProgressFile'
