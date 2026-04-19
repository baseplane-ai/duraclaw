/**
 * Notification watcher — observes `sessionLiveStateCollection` for status
 * transitions (running→idle, any→waiting_gate) and fires in-app notifications.
 *
 * The `sessions` argument is retained as the metadata lookup (title / project
 * for notification text); the status comes from the live-state collection via
 * useLiveQuery so cards in the background still trigger notifications even
 * when the sessions query collection hasn't refetched yet.
 *
 * A `useRef<Map<sessionId, lastStatus>>` tracks the previous status per
 * session; on each live-state update we compare and fire on genuine
 * transitions. The ref is seeded from the sessions prop on first observation
 * so known-at-mount statuses don't replay as transitions after a reload.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useRef } from 'react'
import {
  type SessionLiveState,
  sessionLiveStateCollection,
} from '~/db/session-live-state-collection'
import { useNotificationStore } from '~/stores/notifications'

interface SessionInfo {
  id: string
  status: string
  project?: string | null
  title?: string | null
}

export function useNotificationWatcher(sessions: SessionInfo[]) {
  const addNotification = useNotificationStore((s) => s.addNotification)
  const prevStatusRef = useRef<Map<string, string>>(new Map())

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: liveRows } = useLiveQuery((q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.from({ live_state: sessionLiveStateCollection as any }),
  )

  // Seed the ref from the sessions prop so the initial render for a given
  // session doesn't count as a transition (e.g. post-reload when the live
  // state collection hydrates from OPFS and matches the sessions snapshot).
  useEffect(() => {
    const prev = prevStatusRef.current
    for (const s of sessions) {
      if (!prev.has(s.id)) prev.set(s.id, s.status)
    }
  }, [sessions])

  useEffect(() => {
    const prev = prevStatusRef.current
    const metaById = new Map(sessions.map((s) => [s.id, s] as const))

    // Status source is the collection row's state.status when available, and
    // falls back to the sessions prop's status so cards that haven't received
    // a live update yet still participate in transition detection.
    const statusById = new Map<string, string>()
    if (liveRows) {
      for (const r of liveRows as unknown as SessionLiveState[]) {
        if (r.state?.status) statusById.set(r.id, r.state.status)
      }
    }
    for (const s of sessions) {
      if (!statusById.has(s.id)) statusById.set(s.id, s.status)
    }

    for (const [sessionId, currentStatus] of statusById) {
      const prevStatus = prev.get(sessionId)
      if (prevStatus === undefined) {
        prev.set(sessionId, currentStatus)
        continue
      }
      if (prevStatus === currentStatus) continue

      const meta = metaById.get(sessionId)
      const name = meta?.title || meta?.project || 'Session'
      const project = meta?.project || undefined

      if (currentStatus === 'waiting_gate') {
        addNotification({
          type: 'gate',
          sessionId,
          sessionName: name,
          project,
          body: 'Session needs input',
          url: `/?session=${sessionId}`,
        })
      } else if (currentStatus === 'idle' && prevStatus === 'running') {
        addNotification({
          type: 'completed',
          sessionId,
          sessionName: name,
          project,
          body: 'Session completed',
          url: `/?session=${sessionId}`,
        })
      }

      prev.set(sessionId, currentStatus)
    }
  }, [liveRows, sessions, addNotification])
}
