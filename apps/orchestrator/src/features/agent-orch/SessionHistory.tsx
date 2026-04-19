/**
 * SessionHistory — Full history page with sortable, filterable session table.
 * Uses TanStackDB sessions collection for client-side sort/filter/search.
 */

import { useNavigate } from '@tanstack/react-router'
import { ArrowDownIcon, ArrowUpIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import { seedSessionLiveStateFromSummary } from '~/db/session-live-state-collection'
import type { SessionRecord } from '~/db/session-record'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import type { SessionSummary } from '~/lib/types'

type SortField = 'updatedAt' | 'createdAt' | 'totalCostUsd' | 'durationMs' | 'numTurns'
type SortDir = 'asc' | 'desc'

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

/**
 * Module-level guard so the one-shot REST hydrate fires once per page load
 * no matter how many SessionHistory mounts race (tab close/reopen, StrictMode
 * double-mount). On first mount the hook POSTs nothing — it just GETs
 * /api/sessions and seeds the live-state collection so rows for sessions
 * never opened in this browser are visible.
 */
let hydratedOnce = false

async function hydrateSessionHistoryFromRest(): Promise<void> {
  if (hydratedOnce) return
  hydratedOnce = true
  try {
    const resp = await fetch('/api/sessions')
    if (!resp.ok) return
    const json = (await resp.json()) as { sessions?: SessionSummary[] }
    if (!json.sessions) return
    for (const summary of json.sessions) {
      seedSessionLiveStateFromSummary(summary)
    }
  } catch {
    // silent — next mount will retry (module flag already flipped, but a
    // full page reload or error boundary recovery re-evaluates the module)
  }
}

export function SessionHistory() {
  const navigate = useNavigate()

  const [sortBy, setSortBy] = useState<SortField>('updatedAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [projectFilter, setProjectFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')

  // Include archived so the history surface shows the full set.
  const { sessions: allSessions, isLoading } = useSessionsCollection({ includeArchived: true })

  // One-shot REST hydrate on first mount so never-opened sessions appear.
  useEffect(() => {
    void hydrateSessionHistoryFromRest()
  }, [])

  const filtered = useMemo(() => {
    let result = [...allSessions] as SessionRecord[]

    // Status filter
    if (statusFilter) result = result.filter((s) => s.status === statusFilter)
    // Project filter
    if (projectFilter) result = result.filter((s) => s.project === projectFilter)
    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter((s) =>
        [s.title, s.prompt, s.summary].some((f) => f?.toLowerCase().includes(q)),
      )
    }
    // Sort
    result.sort((a, b) => {
      const aVal = a[sortBy] ?? 0
      const bVal = b[sortBy] ?? 0
      const cmp =
        typeof aVal === 'string'
          ? new Date(aVal).getTime() - new Date(bVal as string).getTime()
          : (aVal as number) - (bVal as number)
      return sortDir === 'asc' ? cmp : -cmp
    })

    return result
  }, [allSessions, statusFilter, projectFilter, searchQuery, sortBy, sortDir])

  const projects = useMemo(() => {
    return [...new Set(allSessions.map((s) => s.project).filter(Boolean))]
  }, [allSessions])

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(field)
      setSortDir('desc')
    }
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortBy !== field) return null
    return sortDir === 'asc' ? (
      <ArrowUpIcon className="ml-1 inline size-3" />
    ) : (
      <ArrowDownIcon className="ml-1 inline size-3" />
    )
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="history-search"
          />
        </div>
        <Select
          value={statusFilter || 'all'}
          onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}
        >
          <SelectTrigger className="w-[140px]" data-testid="history-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="idle">Idle</SelectItem>
            <SelectItem value="failed">Aborted</SelectItem>
          </SelectContent>
        </Select>
        {projects.length > 1 && (
          <Select
            value={projectFilter || 'all'}
            onValueChange={(v) => setProjectFilter(v === 'all' ? '' : v)}
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
              onClick={() => toggleSort('createdAt')}
            >
              Created
              <SortIcon field="createdAt" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('durationMs')}
            >
              Duration
              <SortIcon field="durationMs" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('totalCostUsd')}
            >
              Cost
              <SortIcon field="totalCostUsd" />
            </TableHead>
            <TableHead
              className="cursor-pointer select-none"
              onClick={() => toggleSort('numTurns')}
            >
              Turns
              <SortIcon field="numTurns" />
            </TableHead>
            <TableHead className="w-[80px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                Loading...
              </TableCell>
            </TableRow>
          ) : filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                No sessions found
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((session) => {
              const primary =
                session.title ?? session.summary ?? session.prompt ?? session.id.slice(0, 12)
              return (
                <TableRow
                  key={session.id}
                  className="cursor-pointer"
                  onClick={() => navigate({ to: '/', search: { session: session.id } })}
                  data-testid="history-row"
                >
                  <TableCell>
                    <div className="max-w-[250px]">
                      <span className="block truncate font-medium">{primary}</span>
                      {session.prompt && session.prompt !== primary && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {session.prompt}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {session.agent ? (
                      <Badge variant="secondary" className="text-xs">
                        {session.agent}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>{session.project}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[session.status] ?? 'outline'}>
                      {session.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(session.createdAt)}</TableCell>
                  <TableCell>{formatDuration(session.durationMs)}</TableCell>
                  <TableCell>{formatCost(session.totalCostUsd)}</TableCell>
                  <TableCell>{session.numTurns ?? session.messageCount ?? '-'}</TableCell>
                  <TableCell>
                    {session.sdkSessionId &&
                      session.agent === 'claude' &&
                      session.origin === 'discovered' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async (e) => {
                            e.stopPropagation()
                            try {
                              const resp = await fetch('/api/sessions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  project: session.project,
                                  prompt: 'resume',
                                  sdk_session_id: session.sdkSessionId,
                                  agent: session.agent ?? 'claude',
                                }),
                              })
                              if (!resp.ok) return
                              const data = (await resp.json()) as { session_id: string }
                              navigate({ to: '/', search: { session: data.session_id } })
                            } catch (err) {
                              console.error('[SessionHistory] Resume failed:', err)
                            }
                          }}
                        >
                          Resume
                        </Button>
                      )}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}
