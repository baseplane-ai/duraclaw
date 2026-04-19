/**
 * FilterChipBar — Horizontal filter chips for session list.
 * Workspace, Status, and Date Range chips with dropdown menus.
 */

import { useEffect, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import type { SessionRecord } from '~/db/agent-sessions-collection'
import type { ProjectInfo } from '~/lib/types'
import { useWorkspaceStore } from '~/stores/workspace'

// Date range options
export type DateRange = 'all' | 'today' | 'yesterday' | 'this-week' | 'this-month'

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  all: 'All',
  today: 'Today',
  yesterday: 'Yesterday',
  'this-week': 'This Week',
  'this-month': 'This Month',
}

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
]

interface FilterChipBarProps {
  statusFilter: string
  onStatusChange: (status: string) => void
  dateRange: DateRange
  onDateRangeChange: (range: DateRange) => void
}

// Workspace chip with its own data fetching
function WorkspaceChip() {
  const { activeWorkspace, setWorkspace } = useWorkspaceStore()
  const [workspaces, setWorkspaces] = useState<Array<{ name: string; projects: string[] }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/gateway/projects')
      .then((r) => r.json() as Promise<ProjectInfo[] | { error: string }>)
      .then((data) => {
        if (Array.isArray(data)) {
          // Group by repo_origin (simplified from WorkspaceSelector)
          const byOrigin = new Map<string | null, string[]>()
          for (const p of data) {
            const key = p.repo_origin ?? null
            if (!byOrigin.has(key)) byOrigin.set(key, [])
            byOrigin.get(key)?.push(p.name)
          }
          const ws = Array.from(byOrigin.entries()).map(([origin, projects]) => ({
            name: origin
              ? origin
                  .replace(/\.git$/, '')
                  .split(/[/:]/)
                  .pop() || 'Unknown'
              : 'Ungrouped',
            projects,
          }))
          setWorkspaces(ws)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          variant={activeWorkspace ? 'default' : 'outline'}
          className="cursor-pointer whitespace-nowrap"
        >
          {loading ? 'Workspace' : activeWorkspace || 'Workspace'}
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => setWorkspace(null, null)}>All</DropdownMenuItem>
        {workspaces.map((ws) => (
          <DropdownMenuItem key={ws.name} onClick={() => setWorkspace(ws.name, ws.projects)}>
            {ws.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FilterChipBar({
  statusFilter,
  onStatusChange,
  dateRange,
  onDateRangeChange,
}: FilterChipBarProps) {
  return (
    <div className="flex gap-2 overflow-x-auto px-3 py-2 sm:flex-wrap">
      <WorkspaceChip />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Badge
            variant={statusFilter !== 'all' ? 'default' : 'outline'}
            className="cursor-pointer whitespace-nowrap"
          >
            {STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label || 'Status'}
          </Badge>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUS_OPTIONS.map((opt) => (
            <DropdownMenuItem key={opt.value} onClick={() => onStatusChange(opt.value)}>
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Badge
            variant={dateRange !== 'this-week' ? 'default' : 'outline'}
            className="cursor-pointer whitespace-nowrap"
          >
            {DATE_RANGE_LABELS[dateRange]}
          </Badge>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(Object.entries(DATE_RANGE_LABELS) as [DateRange, string][]).map(([value, label]) => (
            <DropdownMenuItem key={value} onClick={() => onDateRangeChange(value)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function isInDateRange(dateStr: string, range: DateRange): boolean {
  if (range === 'all') return true
  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (range) {
    case 'today':
      return date >= today
    case 'yesterday': {
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      return date >= yesterday
    }
    case 'this-week': {
      const weekAgo = new Date(today)
      weekAgo.setDate(weekAgo.getDate() - 7)
      return date >= weekAgo
    }
    case 'this-month': {
      const monthAgo = new Date(today)
      monthAgo.setMonth(monthAgo.getMonth() - 1)
      return date >= monthAgo
    }
    default:
      return true
  }
}

/** Split sessions into recent (matching date range) and older (outside date range) */
export function getRecentAndOlder(
  sessions: SessionRecord[],
  dateRange: DateRange,
): { recent: SessionRecord[]; older: SessionRecord[] } {
  if (dateRange === 'all') return { recent: sessions, older: [] }
  const recent: SessionRecord[] = []
  const older: SessionRecord[] = []
  for (const s of sessions) {
    if (isInDateRange(s.createdAt, dateRange)) {
      recent.push(s)
    } else {
      older.push(s)
    }
  }
  return { recent, older }
}
