/**
 * Hook that connects the browser to an `ArcCollabDO` via y-partyserver.
 *
 * Each arc has its own collab room keyed by arcId. The shared Y.Doc has
 * two top-level keys established lazily on first access:
 *   - `chatDraft = doc.getText('arc:chat-draft')` — multiplayer draft
 *     for the team-chat composer (so reload-mid-typing is non-destructive
 *     and multiple devices show the same draft).
 *   - `meta = doc.getMap('arc:meta')` — small key/value map reserved for
 *     future arc-scoped collab flags (sending state, etc.).
 *
 * Awareness payload (per spec B16):
 *   { user: CollabUser
 *     viewing: 'transcript' | 'chat' | 'inbox' | 'unknown'
 *     typing: boolean
 *     activeArcId: string }
 *
 * The `viewing` field is the arc-level analogue of session-collab's
 * `activeSessionId` — it records which arc surface the user is currently
 * looking at so peers can render rich presence ("Alice is in chat").
 *
 * GH#152 P1.6 (B16). Mirrors `use-session-collab.ts` in shape and
 * lifecycle; the two coexist (both providers attach for any arc surface
 * that owns a session).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'
import { createYProviderAdapter } from '~/lib/connection-manager/adapters/yprovider-adapter'
import { useManagedConnection } from '~/lib/connection-manager/hooks'
import { partyHost } from '~/lib/platform'
import { colorForUserId } from '~/lib/presence-colors'
import {
  type CollabUser,
  TYPING_DEBOUNCE_MS,
  TYPING_LEADING_THROTTLE_MS,
} from './use-session-collab'

export type ArcCollabStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed'

export type ArcViewing = 'transcript' | 'chat' | 'inbox' | 'unknown'

export interface UseArcCollabResult {
  doc: Y.Doc
  provider: ReturnType<typeof useYProvider> | null
  status: ArcCollabStatus
  /** Shared chat-draft Y.Text. Bound to the team-chat composer. */
  chatDraft: Y.Text
  /** Arc-scoped Y.Map for ad-hoc shared flags. */
  meta: Y.Map<unknown>
  awareness: Awareness | null
  selfClientId: number | null
  /**
   * Flip the local `typing` awareness field to true and auto-reset after
   * `TYPING_DEBOUNCE_MS` of quiet. Safe to call on every keystroke.
   */
  notifyTyping: () => void
  /**
   * Flip the local `viewing` awareness field. Surfaces switch context
   * (e.g. user opens the Team chat tab → `setViewing('chat')`).
   */
  setViewing: (viewing: ArcViewing) => void
}

// Re-export the constants so consumers (and tests) can import them from
// either hook without picking a winner.
export { TYPING_DEBOUNCE_MS, TYPING_LEADING_THROTTLE_MS }

export function useArcCollab(opts: { arcId: string }): UseArcCollabResult {
  const { arcId } = opts

  // Fresh Y.Doc per arcId; recreated on arc switch so state from the
  // prior arc can't leak into the new room.
  const doc = useMemo(() => {
    const d = new Y.Doc()
    d.guid = `arc-collab:${arcId}`
    return d
  }, [arcId])
  const chatDraft = useMemo(() => doc.getText('arc:chat-draft'), [doc])
  const meta = useMemo(() => doc.getMap<unknown>('arc:meta'), [doc])

  const host = partyHost()

  // `routePartykitRequest` kebab-cases the binding name (`ARC_COLLAB_DO`
  // -> `arc-collab-do`), so the room path is `/parties/arc-collab-do/<arcId>`.
  const provider = useYProvider({
    host,
    room: arcId,
    party: 'arc-collab-do',
    doc,
  })

  // Register with the connection-manager so global reconnect coordination
  // (foreground / online events) covers the arc-collab WS too.
  const collabAdapter = useMemo(
    () => (provider ? createYProviderAdapter(provider, `arc-collab:${arcId}`) : null),
    [provider, arcId],
  )
  useManagedConnection(collabAdapter, `arc-collab:${arcId}`)

  const [status, setStatus] = useState<ArcCollabStatus>('connecting')

  useEffect(() => {
    if (!provider) return
    const onStatus = (payload: { status?: string } | undefined) => {
      const next = payload?.status
      if (next === 'connected' || next === 'connecting' || next === 'disconnected') {
        setStatus(next)
      }
    }
    provider.on('status', onStatus as never)
    return () => {
      provider.off('status', onStatus as never)
    }
  }, [provider])

  const { data: session } = useSession() as {
    data: { user?: { id?: string; name?: string } } | null | undefined
  }
  const userId = session?.user?.id ?? null
  const userName = session?.user?.name ?? null

  useEffect(() => {
    if (!provider) return
    if (!userId) return
    const awareness = provider.awareness
    const user: CollabUser = {
      id: userId,
      name: userName ?? 'Anonymous',
      color: colorForUserId(userId),
    }
    // Seed full local state — y-protocols' setLocalStateField is a no-op
    // while getLocalState() is null, so subsequent typing/viewing toggles
    // would never propagate without this initial setLocalState.
    awareness.setLocalState({
      user,
      typing: false,
      viewing: 'unknown' as ArcViewing,
      activeArcId: arcId,
    })
    return () => {
      awareness.setLocalState(null)
    }
  }, [provider, userId, userName, arcId])

  // Typing-indicator debounce — same shape as use-session-collab.
  const typingTrailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingTrailingDeadlineRef = useRef<number>(0)
  const typingLeadingThrottleRef = useRef<number>(0)

  const notifyTyping = useCallback(() => {
    if (!provider) return
    const awareness = provider.awareness
    const now = Date.now()

    if (now - typingLeadingThrottleRef.current >= TYPING_LEADING_THROTTLE_MS) {
      const cur = awareness.getLocalState() as { typing?: boolean } | null
      if (!cur?.typing) {
        awareness.setLocalStateField('typing', true)
      }
      typingLeadingThrottleRef.current = now
    }

    typingTrailingDeadlineRef.current = now + TYPING_DEBOUNCE_MS
    if (typingTrailingTimerRef.current === null) {
      const arm = (delay: number) => {
        typingTrailingTimerRef.current = setTimeout(() => {
          const remaining = typingTrailingDeadlineRef.current - Date.now()
          if (remaining > 0) {
            arm(remaining)
            return
          }
          awareness.setLocalStateField('typing', false)
          typingTrailingTimerRef.current = null
          typingLeadingThrottleRef.current = 0
        }, delay)
      }
      arm(TYPING_DEBOUNCE_MS)
    }
  }, [provider])

  useEffect(() => {
    return () => {
      if (typingTrailingTimerRef.current) {
        clearTimeout(typingTrailingTimerRef.current)
        typingTrailingTimerRef.current = null
      }
    }
  }, [])

  const setViewing = useCallback(
    (viewing: ArcViewing) => {
      if (!provider) return
      const awareness = provider.awareness
      const cur = awareness.getLocalState() as { viewing?: ArcViewing } | null
      if (cur?.viewing === viewing) return
      awareness.setLocalStateField('viewing', viewing)
    },
    [provider],
  )

  // Same destroy-discipline note as use-session-collab: do NOT call
  // doc.destroy() in cleanup — under StrictMode the cascade through
  // awareness.destroy() wipes y-partyserver's internal broadcast handler.
  // The doc is scoped to the arcId-keyed useMemo and GC'd on switch.

  const awareness = provider?.awareness ?? null
  const selfClientId = provider?.awareness?.clientID ?? null

  return {
    doc,
    provider,
    status,
    chatDraft,
    meta,
    awareness,
    selfClientId,
    notifyTyping,
    setViewing,
  }
}
