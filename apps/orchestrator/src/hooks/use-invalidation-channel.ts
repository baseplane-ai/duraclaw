/**
 * useInvalidationChannel — root-level WS subscription that wakes
 * collections when the server-side UserSettingsDO broadcasts an
 * `{type:'invalidate', collection, keys?}` message (B-CLIENT-5).
 *
 * - One singleton WS per app load (keyed on userId).
 * - Auto-reconnect handled by `partysocket`'s `usePartySocket` hook.
 * - On message, looks up the named collection and triggers a full refetch.
 *   (TanStack DB current version exposes only whole-collection refetch —
 *   `keys` is sent for forward compatibility but ignored client-side.)
 *
 * No-op render when there is no authenticated session (party socket should
 * never connect anonymously).
 */

import usePartySocket from 'partysocket/react'
import { useCallback } from 'react'
import { agentSessionsCollection } from '~/db/agent-sessions-collection'
import { userPreferencesCollection } from '~/db/user-preferences-collection'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { useSession } from '~/lib/auth-client'

interface InvalidatableCollection {
  utils: { refetch: () => Promise<unknown> }
}

const COLLECTIONS_BY_NAME: Record<string, InvalidatableCollection> = {
  user_tabs: userTabsCollection as unknown as InvalidatableCollection,
  agent_sessions: agentSessionsCollection as unknown as InvalidatableCollection,
  user_preferences: userPreferencesCollection as unknown as InvalidatableCollection,
}

interface InvalidateMessage {
  type: 'invalidate'
  collection: string
  keys?: string[]
}

export function useInvalidationChannel() {
  const { data: session } = useSession() as { data?: { user?: { id?: string } } }
  const userId = session?.user?.id

  const onMessage = useCallback((ev: MessageEvent) => {
    let msg: InvalidateMessage
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as InvalidateMessage
    } catch {
      return
    }
    if (msg?.type !== 'invalidate') return
    const target = COLLECTIONS_BY_NAME[msg.collection]
    if (!target) return
    void target.utils.refetch()
  }, [])

  usePartySocket({
    host: typeof window === 'undefined' ? '' : window.location.host,
    party: 'user-settings',
    room: userId ?? '',
    // Do not open the socket until we have a userId — the DO room is
    // userId-keyed and an empty room would route to a phantom DO.
    enabled: Boolean(userId),
    onMessage,
  })
}
