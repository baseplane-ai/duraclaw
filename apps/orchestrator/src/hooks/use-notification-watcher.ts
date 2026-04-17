import { useEffect, useRef } from 'react'
import { useNotificationStore } from '~/stores/notifications'

interface SessionInfo {
  id: string
  status: string
  project?: string | null
  title?: string | null
}

/**
 * Watches a list of sessions and generates in-app notifications
 * when sessions transition to notification-worthy states.
 */
export function useNotificationWatcher(sessions: SessionInfo[]) {
  const addNotification = useNotificationStore((s) => s.addNotification)
  const prevStatusRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    const prev = prevStatusRef.current

    for (const session of sessions) {
      const prevStatus = prev.get(session.id)
      const name = session.title || session.project || 'Session'

      // Skip if we haven't seen this session before (initial load)
      if (prevStatus === undefined) {
        prev.set(session.id, session.status)
        continue
      }

      // Skip if status hasn't changed
      if (prevStatus === session.status) continue

      // Generate notification based on new status
      const project = session.project || undefined
      if (session.status === 'waiting_gate') {
        addNotification({
          type: 'gate',
          sessionId: session.id,
          sessionName: name,
          project,
          body: 'Session needs input',
          url: `/?session=${session.id}`,
        })
      } else if (session.status === 'idle' && prevStatus === 'running') {
        addNotification({
          type: 'completed',
          sessionId: session.id,
          sessionName: name,
          project,
          body: 'Session completed',
          url: `/?session=${session.id}`,
        })
      } else if (session.status === 'aborted' || session.status === 'failed') {
        addNotification({
          type: 'error',
          sessionId: session.id,
          sessionName: name,
          project,
          body: session.status === 'failed' ? 'Session failed' : 'Session aborted',
          url: `/?session=${session.id}`,
        })
      }

      prev.set(session.id, session.status)
    }
  }, [sessions, addNotification])
}
