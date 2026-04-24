/**
 * Sessions SyncedCollection — wraps GET /api/sessions with TanStack DB and
 * subscribes to `agent_sessions` delta frames pushed by SessionDO +
 * REST write handlers (via `broadcastSessionRow`).
 *
 * Sole source of session list data for the client. Optimistic onInsert /
 * onUpdate / onDelete handlers hit the REST endpoints so user-initiated
 * writes reconcile via the server echo through the synced-collection
 * deep-equals loopback guard.
 *
 * Spec #37 P2a — replaces the old `sessionLiveStateCollection`
 * (local-only) + REST backfill hybrid. See spec B10 / B12.
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { dbReady } from '~/db/db-instance'
import { createSyncedCollection } from '~/db/synced-collection'
import { apiUrl } from '~/lib/platform'

const persistence = await dbReady

export const sessionsCollection = createSyncedCollection<SessionSummary, string>({
  id: 'sessions',
  queryKey: ['sessions'] as const,
  syncFrameType: 'agent_sessions',
  queryFn: async () => {
    const resp = await fetch(apiUrl('/api/sessions'), { credentials: 'include' })
    if (!resp.ok) throw new Error(`sessions fetch failed: ${resp.status}`)
    const { sessions } = (await resp.json()) as { sessions: SessionSummary[] }
    return sessions
  },
  getKey: (row) => row.id,
  persistence,
  schemaVersion: 4, // GH#76 P4: removed lastEventTs field (TTL predicate retired)

  onInsert: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(apiUrl('/api/sessions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`Session insert failed: ${resp.status}`)
    }
  },

  onUpdate: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(apiUrl(`/api/sessions/${m.key}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(m.changes),
      })
      if (!resp.ok) throw new Error(`Session update failed: ${resp.status}`)
    }
  },

  onDelete: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(apiUrl(`/api/sessions/${m.key}`), {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!resp.ok) throw new Error(`Session delete failed: ${resp.status}`)
    }
  },
})
