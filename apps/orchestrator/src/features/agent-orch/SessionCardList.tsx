/**
 * SessionCardList — Full-width card layout for mobile session list.
 *
 * Swipe-left to reveal archive action, powered by @use-gesture/react + @react-spring/web.
 */

import { animated, useSpring } from '@react-spring/web'
import { useDrag } from '@use-gesture/react'
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { useSessionLocalState, useSessionStatus } from '~/db/session-local-collection'
import type { SessionRecord } from '~/db/session-record'
import { useSession } from '~/hooks/use-sessions-collection'
import { deriveDisplayStateFromStatus } from '~/lib/display-state'
import type { SessionStatus } from '~/lib/types'
import { cn } from '~/lib/utils'
import { useWorkspaceStore } from '~/stores/workspace'
import { ActiveStrip } from './ActiveStrip'
import { type DateRange, FilterChipBar, getRecentAndOlder } from './FilterChipBar'
import { DATE_GROUP_ORDER, getDateGroup } from './SessionSidebar'
import { formatTimeAgo, getPreviewText, StatusDot } from './session-utils'

interface SessionCardListProps {
  sessions: SessionRecord[]
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onArchiveSession?: (sessionId: string, archived: boolean) => void
}

function KataBadge({ session }: { session: SessionRecord }) {
  const mode = session.kataMode
  const issue = session.kataIssue
  const phase = session.kataPhase
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

  const liveSession = useSession(session.id)
  const local = useSessionLocalState(session.id)
  const doStatus = useSessionStatus(session.id)
  const numTurns = liveSession?.numTurns ?? session.numTurns ?? 0
  const isLive = local?.wsReadyState === 1
  // Post-ea01ca5: D1 `agent_sessions.status` is no longer mid-run authoritative
  // (only seeded to 'idle' at result-time). Prefer the DO-pushed
  // `useSessionStatus` and fall back to the D1 row only for cold-start.
  const rawStatus = doStatus ?? ((liveSession ?? session).status as SessionStatus)
  const display = deriveDisplayStateFromStatus(
    rawStatus,
    local?.wsReadyState ?? 3,
    local?.wsCloseTs ?? null,
  )
  const status = display.status !== 'unknown' ? display.status : rawStatus
  const displayName = session.title || getPreviewText(session) || session.id.slice(0, 8)

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
        aria-label={`${displayName}, ${status}, ${session.updatedAt ? formatTimeAgo(session.updatedAt) : ''}`}
        className={cn(
          'relative z-10 w-full rounded-lg border bg-card p-3 text-left transition-colors',
          isSelected && 'border-primary bg-accent',
        )}
      >
        {/* Row 1: status dot + title + time-ago */}
        <div className="flex items-center gap-2">
          <span className={cn(!isLive && 'opacity-60')}>
            <StatusDot status={status} numTurns={numTurns} />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{displayName}</span>
          {session.updatedAt && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTimeAgo(session.updatedAt)}
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

function OlderSessionRow({ session, onClick }: { session: SessionRecord; onClick: () => void }) {
  const liveSession = useSession(session.id)
  const local = useSessionLocalState(session.id)
  const doStatus = useSessionStatus(session.id)
  const numTurns = liveSession?.numTurns ?? session.numTurns ?? 0
  const isLive = local?.wsReadyState === 1
  // See RecentSessionCard for the rationale on preferring the DO-pushed status.
  const rawStatus = doStatus ?? ((liveSession ?? session).status as SessionStatus)
  const display = deriveDisplayStateFromStatus(
    rawStatus,
    local?.wsReadyState ?? 3,
    local?.wsCloseTs ?? null,
  )
  const status = display.status !== 'unknown' ? display.status : rawStatus
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      <span className={cn(!isLive && 'opacity-60')}>
        <StatusDot status={status} numTurns={numTurns} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {session.title || getPreviewText(session) || session.id.slice(0, 8)}
      </span>
      {session.updatedAt && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatTimeAgo(session.updatedAt)}
        </span>
      )}
    </button>
  )
}

export function SessionCardList({
  sessions,
  selectedSessionId,
  onSelectSession,
  onArchiveSession,
}: SessionCardListProps) {
  const workspaceProjects = useWorkspaceStore((s) => s.workspaceProjects)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [dateRange, setDateRange] = useState<DateRange>('this-week')
  const [showOlder, setShowOlder] = useState(false)

  const filteredSessions = sessions.filter((s) => {
    if (workspaceProjects && !workspaceProjects.includes(s.project)) return false
    if (s.archived) return false
    const derived = s.status as SessionStatus
    // Spec #80 P1: `pending` sessions (runner stamped, pre-first-event)
    // stay grouped with running in the card-list filter.
    if (statusFilter === 'running') return derived === 'running' || derived === 'pending'
    if (statusFilter === 'completed') return derived === 'idle'
    return true
  })

  const { recent: recentSessions, older: olderSessions } = getRecentAndOlder(
    filteredSessions,
    dateRange,
  )

  // Group by date
  const groups = new Map<string, SessionRecord[]>()
  for (const session of recentSessions) {
    const key = getDateGroup(session.createdAt)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)?.push(session)
  }
  const sortedGroupKeys = DATE_GROUP_ORDER.filter((k) => groups.has(k))

  const handleCardClick = (sessionId: string) => {
    onSelectSession(sessionId)
  }

  return (
    <div className="flex-1 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
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
      <ul className="flex flex-col gap-4 p-4 pb-10 list-none">
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
              <div className="flex flex-col gap-2">
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
              <div className="mt-2 flex flex-col gap-1">
                {olderSessions.map((session) => (
                  <OlderSessionRow
                    key={session.id}
                    session={session}
                    onClick={() => handleCardClick(session.id)}
                  />
                ))}
              </div>
            )}
          </li>
        )}
      </ul>
    </div>
  )
}
