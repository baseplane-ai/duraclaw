/**
 * session_viewers synced collection — "who else has this session open as
 * a tab?" One row per sessionId the current user has as a live tab;
 * `viewers` lists other users who also hold that session.
 *
 * Read-only from the client's perspective: there are no onInsert /
 * onUpdate / onDelete handlers because the source of truth is the
 * server's `user_tabs` table — mutations flow through the `user_tabs`
 * REST endpoints, which trigger cross-user fanout via
 * `fanoutSessionViewerChange`. The WS push channel + reconnect resync
 * keep this collection eventually consistent.
 */

import { apiUrl } from '~/lib/platform'
import type { SessionViewerRow } from '~/lib/types'
import { getResolvedPersistence } from './db-instance'
import { lazyCollection } from './lazy-collection'
import { createSyncedCollection } from './synced-collection'

function createSessionViewersCollection() {
  return createSyncedCollection<SessionViewerRow, string>({
    id: 'session_viewers',
    queryKey: ['session_viewers'] as const,
    syncFrameType: 'session_viewers',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/session-viewers'))
      if (!resp.ok) return [] as SessionViewerRow[]
      const json = (await resp.json()) as { viewers: SessionViewerRow[] }
      return json.viewers
    },
    getKey: (item) => item.sessionId,
    persistence: getResolvedPersistence(),
    schemaVersion: 1,
  })
}

/**
 * GH#164: lifted top-level await for Hermes. Lazy proxy resolves on
 * first property access, which is always post-bootstrap.
 */
export const sessionViewersCollection = lazyCollection(createSessionViewersCollection)
