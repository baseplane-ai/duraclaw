/**
 * ActiveStrip — Horizontal scrolling pill bar for active sessions.
 * Shown above session list on both mobile (cards) and desktop (sidebar).
 * Hides entirely when no qualifying sessions exist.
 */

import type { SessionRecord } from '~/db/sessions-collection'
import { cn } from '~/lib/utils'
import { getPreviewText, getProjectInitials } from './session-utils'

const ACTIVE_STATUSES = new Set(['running', 'waiting_gate', 'waiting_input', 'waiting_permission'])
const IDLE_RECENCY_MS = 2 * 60 * 60 * 1000 // 2 hours

export function isQualifyingSession(session: SessionRecord): boolean {
  if (ACTIVE_STATUSES.has(session.status || 'idle')) return true
  if (session.status === 'idle' && session.updatedAt) {
    const elapsed = Date.now() - new Date(session.updatedAt).getTime()
    return elapsed < IDLE_RECENCY_MS
  }
  return false
}

function getStatusColor(session: SessionRecord): string {
  const status = session.status || 'idle'
  const numTurns = session.numTurns ?? 0
  // Spawning: running with 0 turns
  if (status === 'running' && numTurns === 0) return 'bg-blue-500'
  if (status === 'running') return 'bg-green-500'
  if (status.startsWith('waiting')) return 'bg-yellow-500'
  return 'bg-gray-400'
}

interface ActiveStripProps {
  sessions: SessionRecord[]
  onSelectSession: (sessionId: string) => void
  selectedSessionId?: string | null
}

export function ActiveStrip({ sessions, onSelectSession, selectedSessionId }: ActiveStripProps) {
  const qualifying = sessions.filter(isQualifyingSession)
  if (qualifying.length === 0) return null

  return (
    <div
      role="toolbar"
      aria-label="Active sessions"
      className="flex gap-2 overflow-x-auto px-3 py-2"
      style={{
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}
    >
      {qualifying.map((session) => {
        const initials = getProjectInitials(session.project, session.title)
        const isSelected = selectedSessionId === session.id
        return (
          <button
            key={session.id}
            type="button"
            aria-label={`Switch to session: ${session.title || getPreviewText(session) || session.id.slice(0, 8)}`}
            onClick={() => onSelectSession(session.id)}
            className={cn(
              'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-white transition-opacity',
              getStatusColor(session),
              isSelected && 'ring-2 ring-primary ring-offset-1',
            )}
          >
            {initials}
          </button>
        )
      })}
    </div>
  )
}
