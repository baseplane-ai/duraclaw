/**
 * SessionHistory — Full history page with sortable, filterable session table.
 */

import { useNavigate } from '@tanstack/react-router'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import type { SessionSummary } from '~/lib/types'

type SortField = 'updated_at' | 'created_at' | 'total_cost_usd' | 'duration_ms' | 'num_turns'
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 25

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  failed: 'destructive',
  aborted: 'destructive',
  idle: 'outline',
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '-'
  return `$${usd.toFixed(2)}`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SessionHistory() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  const [sortBy, setSortBy] = useState<SortField>('updated_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [projectFilter, setProjectFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(0)

  const fetchHistory = useCallback(async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('sortBy', sortBy)
      params.set('sortDir', sortDir)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(page * PAGE_SIZE))
      if (statusFilter) params.set('status', statusFilter)
      if (projectFilter) params.set('project', projectFilter)

      const resp = await fetch(`/api/sessions/history?${params}`)
      if (resp.ok) {
        const data = (await resp.json()) as { sessions: SessionSummary[]; total: number }
        setSessions(data.sessions)
        setTotal(data.total)
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [sortBy, sortDir, statusFilter, projectFilter, page])

  const fetchSearch = useCallback(async () => {
    if (!searchQuery.trim()) return
    setIsLoading(true)
    try {
      const resp = await fetch(`/api/sessions/search?q=${encodeURIComponent(searchQuery.trim())}`)
      if (resp.ok) {
        const data = (await resp.json()) as { sessions: SessionSummary[] }
        setSessions(data.sessions)
        setTotal(data.sessions.length)
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [searchQuery])

  useEffect(() => {
    if (searchQuery.trim()) {
      const timeout = setTimeout(fetchSearch, 300)
      return () => clearTimeout(timeout)
    }
    fetchHistory()
  }, [fetchHistory, fetchSearch, searchQuery])

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(field)
      setSortDir('desc')
    }
    setPage(0)
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortBy !== field) return null
    return sortDir === 'asc' ? (
      <ArrowUpIcon className="ml-1 inline size-3" />
    ) : (
      <ArrowDownIcon className="ml-1 inline size-3" />
    )
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const isSearching = !!searchQuery.trim()

  const projects = [...new Set(sessions.map((s) => s.project).filter(Boolean))]

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setPage(0)
            }}
            className="pl-9"
            data-testid="history-search"
          />
        </div>
        <Select
          value={statusFilter || 'all'}
          onValueChange={(v) => {
            setStatusFilter(v === 'all' ? '' : v)
            setPage(0)
          }}
        >
          <SelectTrigger className="w-[140px]" data-testid="history-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="idle">Idle</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="aborted">Aborted</SelectItem>
          </SelectContent>
        </Select>
        {projects.length > 1 && (
          <Select
            value={projectFilter || 'all'}
            onValueChange={(v) => {
              setProjectFilter(v === 'all' ? '' : v)
              setPage(0)
            }}
          >
            <SelectTrigger className="w-[160px]" data-testid="history-project-filter">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Status</TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('created_at')}
            >
              Created
              <SortIcon field="created_at" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('duration_ms')}
            >
              Duration
              <SortIcon field="duration_ms" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('total_cost_usd')}
            >
              Cost
              <SortIcon field="total_cost_usd" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('num_turns')}
            >
              Turns
              <SortIcon field="num_turns" />
            </TableHead>
            <TableHead className="w-[80px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && sessions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                Loading...
              </TableCell>
            </TableRow>
          ) : sessions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                No sessions found
              </TableCell>
            </TableRow>
          ) : (
            sessions.map((session) => (
              <TableRow
                key={session.id}
                className="cursor-pointer"
                onClick={() => navigate({ to: '/', search: { session: session.id } })}
                data-testid="history-row"
              >
                <TableCell>
                  {(() => {
                    const primary =
                      session.title ?? session.summary ?? session.prompt ?? session.id.slice(0, 12)
                    return (
                      <div className="max-w-[250px]">
                        <span className="block truncate font-medium">{primary}</span>
                        {session.prompt && session.prompt !== primary && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {session.prompt}
                          </span>
                        )}
                      </div>
                    )
                  })()}
                </TableCell>
                <TableCell>
                  {session.agent ? (
                    <Badge variant="secondary" className="text-xs">
                      {session.agent}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{session.project}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANTS[session.status] ?? 'outline'}>
                    {session.status}
                  </Badge>
                </TableCell>
                <TableCell>{formatDate(session.created_at)}</TableCell>
                <TableCell>{formatDuration(session.duration_ms)}</TableCell>
                <TableCell>{formatCost(session.total_cost_usd)}</TableCell>
                <TableCell>{session.num_turns ?? session.message_count ?? '—'}</TableCell>
                <TableCell>
                  {session.sdk_session_id &&
                    session.agent === 'claude' &&
                    session.origin === 'discovered' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate({ to: '/', search: { session: session.id } })
                        }}
                      >
                        Resume
                      </Button>
                    )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      {!isSearching && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {total} session{total !== 1 ? 's' : ''} total
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="text-sm">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
