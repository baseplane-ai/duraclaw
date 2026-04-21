/**
 * Notification watcher — observes session status transitions on the
 * `sessions` prop (sessionsCollection-backed) and fires in-app
 * notifications on running→idle and any→waiting_gate.
 *
 * Spec #37 P2b: no more reads from `sessionLiveStateCollection` — the
 * DO-authoritative `status` field on the sessionsCollection row is the
 * single source, so the caller just passes its live sessions array and
 * this hook diffs against the previous observed status.
 *
 * A `useRef<Map<sessionId, lastStatus>>` tracks the previous status per
 * session; on each sessions-prop update we compare and fire on genuine
 * transitions. The ref is seeded from the sessions prop on first observation
 * so known-at-mount statuses don't replay as transitions after a reload.
 */

import { useEffect, useRef } from 'react'
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

  // Seed the ref from the sessions prop so the initial render for a given
  // session doesn't count as a transition (e.g. post-reload when the
  // collection hydrates from OPFS and matches the sessions snapshot).
  useEffect(() => {
    const prev = prevStatusRef.current
    for (const s of sessions) {
      if (!prev.has(s.id)) prev.set(s.id, s.status)
    }
  }, [sessions])

  useEffect(() => {
    const prev = prevStatusRef.current
    const metaById = new Map(sessions.map((s) => [s.id, s] as const))

    for (const s of sessions) {
      const sessionId = s.id
      const currentStatus = s.status
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
  }, [sessions, addNotification])
}
