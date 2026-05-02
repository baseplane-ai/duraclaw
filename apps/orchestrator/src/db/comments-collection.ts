/**
 * Comments collection factory — per-sessionId collections driven by the
 * session WS (GH#152 P1.2 B6/B7).
 *
 * Mirrors `messages-collection.ts` exactly: WS-driven, no REST `queryFn`,
 * upsert-by-key (so replays/snapshots reconcile in place via TanStack DB
 * deepEquals), per-sessionId memoisation for `useLiveQuery` identity
 * stability.
 *
 * Wire scope: `comments:<sessionId>`. Frame envelope is the standard
 * `SyncedCollectionFrame<CommentRow>` so the existing per-DO `messageSeq`
 * stamping in `broadcast.ts` (and the client's gap-detection +
 * cursor-replay) carries over with zero new infrastructure.
 *
 * Read-only at this layer (P1.2 WU-A). The optimistic write hook
 * (`onInsert` POSTing `/api/sessions/:sid/comments` with `clientCommentId`)
 * lands in P1.2 WU-D alongside the `use-comments-collection` hook —
 * keeping it out of the factory makes the cold-start path symmetric with
 * messages and avoids a half-wired POST surface before WU-B's RPC handlers
 * exist.
 */

import type { CommentRow, SyncedCollectionFrame } from '@duraclaw/shared-types'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import type { CollectionConfig, SyncConfig } from '@tanstack/db'
import { createCollection } from '@tanstack/db'
import {
  onSessionStreamReconnect,
  subscribeSessionStream,
} from '~/features/agent-orch/use-coding-agent'
import { dbReady } from './db-instance'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CommentsCollection = any

const persistence = await dbReady

/** Memoise per-sessionId so useMemo(() => createCommentsCollection(id)) is stable. */
const collectionsBySession = new Map<string, CommentsCollection>()

/**
 * Build the raw `CollectionConfig` for a comments collection keyed on
 * `sessionId`. Exposed as a separate fn for testing — the factory below
 * composes this with `persistedCollectionOptions` + `createCollection`.
 */
export function commentsCollectionOptions(sessionId: string): CollectionConfig<CommentRow> {
  const collectionName = `comments:${sessionId}`

  const sync: SyncConfig<CommentRow>['sync'] = (params) => {
    const { begin, write, commit, markReady, collection } = params

    const unsubFrame = subscribeSessionStream(
      sessionId,
      (frame: SyncedCollectionFrame<unknown>) => {
        if (frame.collection !== collectionName) return
        begin()
        for (const op of frame.ops) {
          if (op.type === 'delete') {
            // `value` is required at the type level; runtime ignores it on delete.
            write({ type: 'delete', key: op.key, value: undefined as never })
            continue
          }
          // Upsert-by-key: convert insert→update when the row already exists
          // so replays / snapshot frames don't throw DuplicateKeySyncError.
          // Same pattern as messages-collection.
          const row = op.value as CommentRow
          const hasFn = collection?.has as ((key: string) => boolean) | undefined
          const alreadyPresent =
            op.type === 'insert' && typeof hasFn === 'function' && hasFn.call(collection, row.id)
          write({ type: alreadyPresent ? 'update' : op.type, value: row })
        }
        commit()
      },
    )

    // Reconnect resync is driven by the WS-open hook (parallel to messages —
    // the subscribe frame is sent from the connection layer, not here).
    const unsubReconnect = onSessionStreamReconnect(sessionId, () => {})

    // Eager markReady — OPFS hydrate is synchronous and any cursor-aware
    // replay arrives shortly after WS open. Empty-thread sessions don't
    // hang on a frame that never arrives.
    markReady()

    return () => {
      unsubFrame()
      unsubReconnect()
    }
  }

  return {
    id: collectionName,
    getKey: (row) => row.id,
    sync: { sync },
  }
}

/**
 * Get-or-create a comments collection for the given `sessionId`.
 *
 * WS-driven sync: no REST `queryFn`. Cold load is served from the OPFS
 * persisted cache; the DO's onConnect replay populates a fresh collection
 * on first WS attach.
 */
export function createCommentsCollection(sessionId: string): CommentsCollection {
  const cached = collectionsBySession.get(sessionId)
  if (cached) return cached

  const options = commentsCollectionOptions(sessionId)
  const wrapped = persistence
    ? persistedCollectionOptions({
        ...options,
        persistence,
        schemaVersion: 1,
      })
    : options

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = createCollection(wrapped as any)
  collectionsBySession.set(sessionId, collection)
  return collection
}
