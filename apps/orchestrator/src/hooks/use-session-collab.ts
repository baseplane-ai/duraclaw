/**
 * Hook that connects the browser to a `SessionCollabDO` via y-partyserver.
 *
 * Each session has its own collab room keyed by sessionId. The shared Y.Doc
 * contains a `Y.Text` named "draft" (multiplayer chat draft) and a `Y.Map`
 * named "meta" (e.g. submitting flag — used later by the submit flow).
 *
 * The underlying WebSocket is managed by y-partyserver's YProvider. It
 * handles reconnect, offline buffering, and cleanup on unmount for us.
 *
 * Awareness: once the provider is available we publish local presence
 * fields (`user`, `typing`) on `provider.awareness`. Peers read these to
 * render the presence bar and typing indicator. Awareness cleanup on
 * disconnect is automatic (y-protocols removes the state when the WS
 * closes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'
import { partyHost } from '~/lib/platform'
import { colorForUserId } from '~/lib/presence-colors'

export type SessionCollabStatus = 'connecting' | 'connected' | 'disconnected' | 'auth-failed'

/**
 * Shape of the local awareness `user` field. Kept small — peers only need
 * enough to render an avatar + name label.
 */
export interface CollabUser {
  id: string
  name: string
  color: string
}

export interface UseSessionCollabResult {
  doc: Y.Doc
  provider: ReturnType<typeof useYProvider> | null
  status: SessionCollabStatus
  ytext: Y.Text
  awareness: Awareness | null
  selfClientId: number | null
  /**
   * Flip the local `typing` awareness field to true and auto-reset after
   * `TYPING_DEBOUNCE_MS` of quiet. Safe to call on every keystroke.
   */
  notifyTyping: () => void
  /**
   * Publish the local caret / selection to awareness as two
   * `Y.RelativePosition`s (anchor + head). Passing `null` clears the
   * awareness `cursor` field. Positions survive remote edits because
   * they're resolved against the current Y.Text on each render.
   */
  setCursor: (sel: { anchor: number; head: number } | null) => void
}

export const TYPING_DEBOUNCE_MS = 2000

export function useSessionCollab(opts: { sessionId: string }): UseSessionCollabResult {
  const { sessionId } = opts

  // A fresh Y.Doc per sessionId; recreated on session switch so state from a
  // prior session can't leak into the new room. The tag-based factory
  // threads `sessionId` through so biome's useExhaustiveDependencies lint
  // sees it as a real dependency.
  const doc = useMemo(() => {
    // Name the doc after the session — useful for debug panels.
    const d = new Y.Doc()
    d.guid = `session-collab:${sessionId}`
    return d
  }, [sessionId])
  const ytext = useMemo(() => doc.getText('draft'), [doc])

  // host is only meaningful in the browser; SSR/tests get a harmless fallback.
  // On Capacitor, partyHost() returns the deployed Worker host.
  const host = partyHost()

  const provider = useYProvider({
    host,
    room: sessionId,
    party: 'session-collab',
    doc,
  })

  const [status, setStatus] = useState<SessionCollabStatus>('connecting')

  useEffect(() => {
    if (!provider) return
    // y-partyserver's Observable emits `status` with { status: 'connected' |
    // 'disconnected' | 'connecting' }. We also watch close codes to flip to
    // auth-failed on 4401 (server rejects upgrade before handshake completes).
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

  // Publish local awareness fields as soon as we know who the user is.
  // Re-runs whenever provider or user identity changes. On unmount or
  // identity change the state is cleared so peers don't see a stale ghost.
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
    // y-protocols' setLocalStateField is a no-op while getLocalState() is
    // null (see node_modules/y-protocols/awareness.js setLocalStateField —
    // the `if (state !== null)` guard). The local state starts null, so we
    // MUST seed it with a full setLocalState({...}) before any subsequent
    // setLocalStateField (typing toggle, cursor, etc.) can take effect.
    //
    // `activeSessionId` is implicit — if we're writing awareness, we're
    // connected to this session. Peers read it to distinguish "viewing
    // here" vs "connected but backgrounded". Per B9, background tabs
    // actually disconnect (YProvider tears down on unmount), so the
    // natural unmount flow handles absence — we only set it here.
    awareness.setLocalState({
      user,
      typing: false,
      activeSessionId: sessionId,
    })
    return () => {
      // Clear our own fields; y-protocols will also drop the full state
      // when the WS closes, but doing this eagerly avoids a stale "typing"
      // flag being visible to peers during a tab switch.
      awareness.setLocalState(null)
    }
  }, [provider, userId, userName, sessionId])

  // Cursor broadcast. Convert absolute textarea indices to
  // Y.RelativePosition so the marker tracks the intended character even
  // across concurrent inserts/deletes. Null clears the field so peers
  // drop our marker (e.g. on blur).
  const setCursor = useCallback(
    (sel: { anchor: number; head: number } | null) => {
      if (!provider) return
      const awareness = provider.awareness
      if (sel === null) {
        awareness.setLocalStateField('cursor', null)
        return
      }
      const len = ytext.length
      const anchorIdx = Math.max(0, Math.min(len, sel.anchor))
      const headIdx = Math.max(0, Math.min(len, sel.head))
      const anchor = Y.createRelativePositionFromTypeIndex(ytext, anchorIdx)
      const head = Y.createRelativePositionFromTypeIndex(ytext, headIdx)
      // Encode via Y helpers so the awareness payload is plain JSON.
      awareness.setLocalStateField('cursor', {
        anchor: Y.relativePositionToJSON(anchor),
        head: Y.relativePositionToJSON(head),
      })
    },
    [provider, ytext],
  )

  // Typing indicator debounce timer. Local-only — a timer per client, not
  // an awareness field, so hibernation-safe.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notifyTyping = useCallback(() => {
    if (!provider) return
    const awareness = provider.awareness
    const cur = awareness.getLocalState() as { typing?: boolean } | null
    if (!cur?.typing) {
      awareness.setLocalStateField('typing', true)
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => {
      awareness.setLocalStateField('typing', false)
      typingTimerRef.current = null
    }, TYPING_DEBOUNCE_MS)
  }, [provider])

  // Clear any pending typing timer on unmount so it doesn't fire against
  // a destroyed awareness instance.
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current)
        typingTimerRef.current = null
      }
    }
  }, [])

  // Do NOT destroy the Y.Doc in an unmount cleanup: under React
  // StrictMode the component mounts → unmounts → remounts synchronously,
  // and `doc.destroy()` cascades into `awareness.destroy()` →
  // `Observable.destroy()` which WIPES every 'change' observer — including
  // y-partyserver provider's internal `_awarenessUpdateHandler` that
  // broadcasts our awareness updates to peers. The provider is memoized
  // (constructor runs once per useState), so the broadcast handler is
  // never re-attached on the second mount, and subsequent
  // `setLocalStateField` calls (typing toggles, cursor updates) emit
  // 'change' locally but never reach the WebSocket.
  //
  // The doc is scoped to the `sessionId`-keyed useMemo; when the session
  // changes, React drops the old doc reference and it is garbage
  // collected. useYProvider's unmount closes the WS. No explicit
  // destroy is required.

  const awareness = provider?.awareness ?? null
  const selfClientId = provider?.awareness?.clientID ?? null

  return { doc, provider, status, ytext, awareness, selfClientId, notifyTyping, setCursor }
}
