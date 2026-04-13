/**
 * SessionCardList — Full-width card layout for mobile session list.
 *
 * Swipe-left to reveal archive action, powered by @use-gesture/react + @react-spring/web.
 */

import { animated, useSpring } from '@react-spring/web'
import { useNavigate } from '@tanstack/react-router'
import { useDrag } from '@use-gesture/react'
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { ScrollArea } from '~/components/ui/scroll-area'
import { cn } from '~/lib/utils'
import { useWorkspaceStore } from '~/stores/workspace'
import { ActiveStrip } from './ActiveStrip'
import { type DateRange, FilterChipBar, getRecentAndOlder } from './FilterChipBar'
import { DATE_GROUP_ORDER, getDateGroup } from './SessionSidebar'
import { formatTimeAgo, StatusDot } from './session-utils'
import type { SessionRecord } from './use-agent-orch-sessions'

interface SessionCardListProps {
  sessions: SessionRecord[]
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onArchiveSession?: (sessionId: string, archived: boolean) => void
}

function KataBadge({ session }: { session: SessionRecord }) {
  const mode = session.kata_mode
  const issue = session.kata_issue
  const phase = session.kata_phase
  if (!mode) return null
  const label = [mode, issue != null ? `#${issue}` : null, phase?.toUpperCase()]
    .filter(Boolean)
    .join(' ')
  return (
    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
      {label}
    </Badge>
  )
}

const SWIPE_THRESHOLD = 80

function SwipeableCard({
  session,
  isSelected,
  onCardClick,
  onArchive,
}: {
  session: SessionRecord
  isSelected: boolean
  onCardClick: () => void
  onArchive?: (archived: boolean) => void
}) {
  const [{ x }, api] = useSpring(() => ({ x: 0, config: { tension: 250, friction: 26 } }))
  const [revealed, setRevealed] = useState(false)

  const bind = useDrag(
    ({ movement: [mx], velocity: [vx], active, tap, direction: [dx] }) => {
      if (tap) {
        onCardClick()
        return
      }
      if (!active) {
        // Velocity-based flick: fast swipe left triggers archive even below threshold
        const flickLeft = vx > 0.5 && dx < 0
        if (mx < -SWIPE_THRESHOLD || flickLeft) {
          api.start({ x: -SWIPE_THRESHOLD })
          setRevealed(true)
        } else {
          api.start({ x: 0 })
          setRevealed(false)
        }
        return
      }
      const clamped = Math.min(mx, 0)
      api.start({ x: clamped, immediate: true })
    },
    { axis: 'x', filterTaps: true, rubberband: 0.15 },
  )

  const handleArchive = () => {
    onArchive?.(!session.archived)
    api.start({ x: 0 })
    setRevealed(false)
  }

  const status = session.status || 'idle'
  const numTurns = session.num_turns ?? 0
  const displayName = session.title || session.id.slice(0, 12)

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Archive action behind the card */}
      {revealed && (
        <button
          type="button"
          onClick={handleArchive}
          className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-destructive text-destructive-foreground text-xs font-medium"
        >
          <ArchiveIcon className="mr-1 size-3.5" />
          {session.archived ? 'Restore' : 'Archive'}
        </button>
      )}

      {/* Swipeable card */}
      <animated.div
        {...bind()}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') onCardClick()
        }}
        style={{ x, touchAction: 'pan-y' }}
        data-session-card
        role="button"
        tabIndex={0}
        aria-label={`${displayName}, ${status}, ${session.updated_at ? formatTimeAgo(session.updated_at) : ''}`}
        className={cn(
          'relative z-10 w-full rounded-lg border bg-card p-3 text-left transition-colors',
          isSelected && 'border-primary bg-accent',
        )}
      >
        {/* Row 1: status dot + title + time-ago */}
        <div className="flex items-center gap-2">
          <StatusDot status={status} numTurns={numTurns} />
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{displayName}</span>
          {session.updated_at && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTimeAgo(session.updated_at)}
            </span>
          )}
        </div>
        {/* Row 2: kata badge */}
        <div className="mt-1 pl-4">
          <KataBadge session={session} />
        </div>
      </animated.div>
    </div>
  )
}

export function SessionCardList({
  sessions,
  selectedSessionId,
  onSelectSession,
  onArchiveSession,
}: SessionCardListProps) {
  const navigate = useNavigate()
  const workspaceProjects = useWorkspaceStore((s) => s.workspaceProjects)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [dateRange, setDateRange] = useState<DateRange>('this-week')
  const [showOlder, setShowOlder] = useState(false)

  const filteredSessions = sessions.filter((s) => {
    if (workspaceProjects && !workspaceProjects.includes(s.project)) return false
    if (s.archived) return false
    if (statusFilter === 'running') return s.status === 'running'
    if (statusFilter === 'completed') return s.status === 'idle'
    if (statusFilter === 'failed') return s.status === 'failed' || s.status === 'aborted'
    return true
  })

  const { recent: recentSessions, older: olderSessions } = getRecentAndOlder(
    filteredSessions,
    dateRange,
  )

  // Group by date
  const groups = new Map<string, SessionRecord[]>()
  for (const session of recentSessions) {
    const key = getDateGroup(session.created_at)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)?.push(session)
  }
  const sortedGroupKeys = DATE_GROUP_ORDER.filter((k) => groups.has(k))

  const handleCardClick = (sessionId: string) => {
    onSelectSession(sessionId)
    navigate({ to: '/session/$id', params: { id: sessionId } })
  }

  return (
    <ScrollArea className="flex-1" style={{ overscrollBehavior: 'none' }}>
      <ActiveStrip
        sessions={sessions}
        onSelectSession={handleCardClick}
        selectedSessionId={selectedSessionId}
      />
      <FilterChipBar
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
      />
      <ul className="space-y-4 p-4 list-none" style={{ overscrollBehavior: 'none' }}>
        {recentSessions.length === 0 && olderSessions.length === 0 && (
          <li className="list-none">
            <p className="p-4 text-center text-sm text-muted-foreground">
              {sessions.length === 0 ? 'No sessions yet' : 'No sessions match your filters'}
            </p>
          </li>
        )}
        {sortedGroupKeys.map((groupKey) => {
          const groupSessions = groups.get(groupKey) ?? []
          return (
            <li key={groupKey} aria-labelledby={`group-${groupKey}`}>
              <h3
                id={`group-${groupKey}`}
                className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide"
              >
                {groupKey}
              </h3>
              <div className="space-y-2">
                {groupSessions.map((session) => (
                  <SwipeableCard
                    key={session.id}
                    session={session}
                    isSelected={selectedSessionId === session.id}
                    onCardClick={() => handleCardClick(session.id)}
                    onArchive={
                      onArchiveSession
                        ? (archived) => onArchiveSession(session.id, archived)
                        : undefined
                    }
                  />
                ))}
              </div>
            </li>
          )
        })}
        {olderSessions.length > 0 && (
          <li className="border-t pt-4">
            <button
              type="button"
              onClick={() => setShowOlder(!showOlder)}
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
            >
              {showOlder ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
              Older Sessions ({olderSessions.length})
            </button>
            {showOlder && (
              <div className="mt-2 space-y-1">
                {olderSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleCardClick(session.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <StatusDot
                      status={session.status || 'idle'}
                      numTurns={session.num_turns ?? 0}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {session.title || session.id.slice(0, 12)}
                    </span>
                    {session.updated_at && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatTimeAgo(session.updated_at)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </li>
        )}
      </ul>
    </ScrollArea>
  )
}
