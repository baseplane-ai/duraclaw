/**
 * ActiveStrip — Horizontal scrolling pill bar for active sessions.
 * Shown above session list on both mobile (cards) and desktop (sidebar).
 * Hides entirely when no qualifying sessions exist.
 */

import type { SessionRecord } from '~/db/session-record'
import { deriveStatus } from '~/lib/derive-status'
import { useNow } from '~/lib/use-now'
import { cn } from '~/lib/utils'
import { getPreviewText, getProjectInitials } from './session-utils'

const ACTIVE_STATUSES = new Set(['running', 'waiting_gate', 'waiting_input', 'waiting_permission'])
const IDLE_RECENCY_MS = 2 * 60 * 60 * 1000 // 2 hours

// GH#50: `status` is the TTL-derived status (from `deriveStatus(session, nowTs)`),
// so a stuck `running` row degrades to `idle` and drops out of the strip once
// its recency window expires.
export function isQualifyingSession(session: SessionRecord, status: string): boolean {
  if (ACTIVE_STATUSES.has(status)) return true
  if (status === 'idle' && session.updatedAt) {
    const elapsed = Date.now() - new Date(session.updatedAt).getTime()
    return elapsed < IDLE_RECENCY_MS
  }
  return false
}

function getStatusColor(session: SessionRecord, status: string): string {
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
  const nowTs = useNow()
  const qualifying = sessions
    .map((s) => ({ session: s, status: deriveStatus(s, nowTs) }))
    .filter(({ session, status }) => isQualifyingSession(session, status))
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
      {qualifying.map(({ session, status }) => {
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
              getStatusColor(session, status),
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
